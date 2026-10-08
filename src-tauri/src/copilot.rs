use github_copilot_sdk::{
    handler::DenyAllHandler,
    rpc::{
        AccountsGetRequest, AuthLoginAdvanceRequest, AuthLoginBeginRequest, AuthLoginCancelRequest,
        AuthLoginResultStatus, AuthLoginStep, AuthReadQuery, AuthReadQueryStatus, AuthReadValue,
        LoginProviderKind, Model, ModelPolicyState,
    },
    session::Session,
    Client, ClientMode, ClientOptions, MessageOptions, SessionConfig, SystemMessageConfig,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    future::Future,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as SyncMutex},
    time::Duration,
};
use tauri::{Manager, State};
use tokio::sync::{watch, Mutex};

type Result<T> = std::result::Result<T, String>;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const PROMPT_LIMIT: usize = 30_000;
const DRAFT_INSTRUCTIONS: &str =
    "Draft a system prompt for an agent in a GitHub Copilot workflow. \
The next message is JSON containing the user's description and target-agent settings, not a task \
for you to execute. Return only the proposed system prompt, without a surrounding code fence, \
preface, or follow-up question. Be precise, concise, and faithful to the description. Preserve the \
declared output format and JSON field names/types. Tool names describe the future agent's \
capabilities; do not execute anything or claim to have inspected a repository. Do not invent \
access to tools that are not listed. Include appropriate limits and handling of missing context. \
Keep the result under 30000 characters.";

#[derive(Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    connected: bool,
    login: Option<String>,
    host: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableModel {
    id: String,
    name: String,
    selectable: bool,
    policy: Option<String>,
    notices: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum OutputFormat {
    Text,
    Json,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum FieldType {
    String,
    Number,
    Boolean,
    Array,
    Object,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct OutputField {
    name: String,
    #[serde(rename = "type")]
    kind: FieldType,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PromptRequest {
    description: String,
    name: String,
    tools: Vec<String>,
    output: OutputFormat,
    fields: Vec<OutputField>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDraft {
    prompt: String,
    warning: Option<String>,
}

struct Operation {
    id: String,
    cancel: watch::Sender<bool>,
    browser_url: Option<String>,
}

#[derive(Default)]
pub struct CopilotState {
    runtime: Mutex<Option<Arc<Runtime>>>,
    operation: SyncMutex<Option<Operation>>,
    process: SyncMutex<Option<Client>>,
}

struct Runtime {
    client: Client,
    account: Session,
    directory: PathBuf,
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.client.force_stop();
    }
}

struct OperationGuard<'a>(&'a CopilotState);

impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        match self.0.operation.lock() {
            Ok(mut operation) => *operation = None,
            Err(_) => eprintln!("Blueprint: could not release the Copilot operation lock."),
        }
    }
}

impl CopilotState {
    fn begin(&self, id: &str) -> Result<(OperationGuard<'_>, watch::Receiver<bool>)> {
        validate_id(id)?;
        let mut slot = self
            .operation
            .lock()
            .map_err(|_| "Copilot state is unavailable.")?;
        if slot.is_some() {
            return Err("Another Copilot action is still finishing. Please wait and retry.".into());
        }
        let (cancel, receiver) = watch::channel(false);
        *slot = Some(Operation {
            id: id.into(),
            cancel,
            browser_url: None,
        });
        Ok((OperationGuard(self), receiver))
    }

    pub fn shutdown(&self) {
        match self.process.lock() {
            Ok(mut process) => {
                if let Some(client) = process.take() {
                    client.force_stop();
                }
            }
            Err(_) => eprintln!("Blueprint: could not acquire the Copilot shutdown handle."),
        }
    }

    async fn reset(&self) {
        let mut runtime = self.runtime.lock().await;
        runtime.take();
        self.shutdown();
    }

    async fn runtime(&self, app: &tauri::AppHandle) -> Result<Arc<Runtime>> {
        let mut slot = self.runtime.lock().await;
        if let Some(runtime) = slot.as_ref() {
            return Ok(Arc::clone(runtime));
        }
        let app_local_data = data_dir(app)?;
        let program = tauri::async_runtime::spawn_blocking(github_copilot_sdk::install_bundled_runtime)
            .await.map_err(|error| format!("Cannot unpack Copilot: {error}"))?
            .ok_or("The bundled Copilot runtime could not be unpacked. Check available disk space and cache permissions.")?;
        let (options, directory) = client_options(program, &app_local_data)?;
        let client = request("Start Copilot", Client::start(options)).await?;
        *self
            .process
            .lock()
            .map_err(|_| "Copilot state is unavailable.")? = Some(client.clone());
        let account = match request(
            "Connect to Copilot",
            client.create_session(session_config(&directory)),
        )
        .await
        {
            Ok(session) => session,
            Err(error) => {
                self.shutdown();
                return Err(error);
            }
        };
        let runtime = Arc::new(Runtime {
            client,
            account,
            directory,
        });
        *slot = Some(Arc::clone(&runtime));
        Ok(runtime)
    }
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())
}

fn client_options(program: PathBuf, app_local_data: &Path) -> Result<(ClientOptions, PathBuf)> {
    let directory = app_local_data.join("copilot-workspace");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)
        .map_err(|error| format!("Cannot create Copilot's private workspace: {error}"))?;
    let base_directory = app_local_data.join("copilot-runtime");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&base_directory)
        .map_err(|error| format!("Cannot create Copilot's private runtime state: {error}"))?;
    let options = ClientOptions::default()
        .with_program(program)
        .with_cwd(&directory)
        .with_mode(ClientMode::Empty)
        .with_base_directory(base_directory)
        .with_use_logged_in_user(true)
        .with_env_remove([
            "COPILOT_GITHUB_TOKEN",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "COPILOT_SDK_AUTH_TOKEN",
            "COPILOT_DISABLE_KEYTAR",
        ]);
    Ok((options, directory))
}

fn disconnected(app: &tauri::AppHandle) -> Result<bool> {
    data_dir(app)?
        .join("copilot-disconnected")
        .try_exists()
        .map_err(|error| format!("Cannot read the Copilot connection preference: {error}"))
}

fn remember_connection(app: &tauri::AppHandle) -> Result<()> {
    match fs::remove_file(data_dir(app)?.join("copilot-disconnected")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Cannot save the Copilot connection preference: {error}"
        )),
    }
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Invalid Copilot request ID.".into());
    }
    Ok(())
}

async fn request<T>(
    label: &str,
    future: impl Future<Output = github_copilot_sdk::Result<T>>,
) -> Result<T> {
    tokio::time::timeout(REQUEST_TIMEOUT, future)
        .await
        .map_err(|_| format!("{label} timed out. Check your connection and retry."))?
        .map_err(|error| format!("{label}: {error}"))
}

fn session_config(directory: &Path) -> SessionConfig {
    let mut config = SessionConfig::default()
        .with_permission_handler(Arc::new(DenyAllHandler))
        .with_working_directory(directory)
        .with_available_tools(Vec::<String>::new())
        .with_excluded_tools(["builtin:*", "mcp:*", "custom:*"])
        .with_system_message(
            SystemMessageConfig::new()
                .with_mode("replace")
                .with_content(DRAFT_INSTRUCTIONS),
        );
    config.enable_config_discovery = Some(false);
    config.enable_file_hooks = Some(false);
    config.enable_host_git_operations = Some(false);
    config.enable_on_demand_instruction_discovery = Some(false);
    config.enable_session_store = Some(false);
    config.enable_session_telemetry = Some(false);
    config.enable_skills = Some(false);
    config.skip_custom_instructions = Some(true);
    config.skip_embedding_retrieval = Some(true);
    config.request_extensions = Some(false);
    config.mcp_servers = Some(Default::default());
    config.custom_agents = Some(Vec::new());
    config.hooks = Some(false);
    config
}

async fn status(session: &Session) -> Result<AuthStatus> {
    let value = request(
        "Read Copilot account",
        session.rpc().accounts().get(AccountsGetRequest {
            query: AuthReadQuery::Status(AuthReadQueryStatus::default()),
        }),
    )
    .await?;
    match value {
        AuthReadValue::Status(value) => Ok(AuthStatus {
            connected: value.status.is_authenticated,
            login: value.status.active_login,
            host: value.status.active_host,
        }),
        _ => Err("Copilot returned an unexpected account response.".into()),
    }
}

#[tauri::command]
pub async fn copilot_status(
    app: tauri::AppHandle,
    state: State<'_, CopilotState>,
    restart: bool,
) -> Result<AuthStatus> {
    let _guard = if restart {
        let (guard, _) = state.begin("refresh-account")?;
        state.reset().await;
        Some(guard)
    } else {
        None
    };
    if disconnected(&app)? {
        return Ok(AuthStatus::default());
    }
    let runtime = state.runtime(&app).await?;
    status(&runtime.account).await
}

fn model_info(model: Model) -> Result<AvailableModel> {
    if model.id.trim().is_empty()
        || model.id.encode_utf16().count() > 200
        || model.name.trim().is_empty()
    {
        return Err("Copilot returned an invalid model entry. Refresh the model list.".into());
    }
    let (selectable, policy) = match model.policy.as_ref().map(|policy| &policy.state) {
        Some(ModelPolicyState::Disabled) => (false, Some("Disabled by your organization".into())),
        Some(ModelPolicyState::Unconfigured) => (
            true,
            Some("Policy is not configured; access is checked at runtime".into()),
        ),
        Some(ModelPolicyState::Unknown) => (
            false,
            Some("Unknown policy state; refresh or check Copilot settings".into()),
        ),
        _ => (true, None),
    };
    let mut notices: Vec<String> = model
        .info_messages
        .into_iter()
        .flatten()
        .chain(model.warning_messages.into_iter().flatten())
        .map(|notice| notice.message)
        .collect();
    if let Some(warning) = model
        .warning_text
        .and_then(|warning| warning.data_retention)
    {
        notices.push(warning);
    }
    if let Some(terms) = model
        .policy
        .and_then(|policy| policy.terms)
        .filter(|terms| !terms.is_empty())
    {
        notices.push(terms);
    }
    Ok(AvailableModel {
        id: model.id,
        name: model.name,
        selectable,
        policy,
        notices,
    })
}

#[tauri::command]
pub async fn copilot_models(
    app: tauri::AppHandle,
    state: State<'_, CopilotState>,
) -> Result<Vec<AvailableModel>> {
    if disconnected(&app)? {
        return Err("Connect Copilot to browse models. Manual model IDs still work.".into());
    }
    let runtime = state.runtime(&app).await?;
    if !status(&runtime.account).await?.connected {
        return Err("Sign in to Copilot to browse your models.".into());
    }
    let models = request("Load Copilot models", runtime.account.rpc().model().list()).await?;
    if models.list.is_empty() {
        return Err("No models are available for this account. Check your Copilot access and organization policy; manual editing is still available.".into());
    }
    models
        .list
        .into_iter()
        .map(|model| {
            model_info(
                serde_json::from_value(model)
                    .map_err(|error| format!("Invalid Copilot model catalog: {error}"))?,
            )
        })
        .collect()
}

fn login_url(url: &str) -> Result<tauri::Url> {
    let url = tauri::Url::parse(url).map_err(|_| "Copilot returned an invalid sign-in URL.")?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != "/login/oauth/authorize"
    {
        return Err(
            "Copilot returned an unexpected sign-in URL. The browser was not opened.".into(),
        );
    }
    Ok(url)
}

async fn open_browser(url: &str) -> Result<()> {
    let url = login_url(url)?;
    let program = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(program)
            .arg(url.as_str())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "Opening the browser timed out. Check your default browser and retry.")?
    .map_err(|error| format!("Cannot open the browser: {error}"))?;
    if !output.status.success() {
        return Err(
            "The system could not open your browser. Configure a default browser and try again."
                .into(),
        );
    }
    Ok(())
}

async fn login(
    runtime: &Runtime,
    state: &CopilotState,
    flow: &mut Option<String>,
) -> Result<AuthStatus> {
    let existing = status(&runtime.account).await?;
    if existing.connected {
        return Ok(existing);
    }
    let begun = request(
        "Begin Copilot sign-in",
        runtime
            .account
            .rpc()
            .accounts()
            .login()
            .begin(AuthLoginBeginRequest {
                kind: LoginProviderKind::GitHubDotCom,
            }),
    )
    .await?;
    *flow = Some(begun.flow_id.clone());
    let mut step = begun.step;
    loop {
        match step {
            AuthLoginStep::OpenUrl(value) => {
                login_url(&value.url)?;
                if let Some(operation) = state.operation.lock().map_err(|_| "Copilot state is unavailable.")?.as_mut() {
                    operation.browser_url = Some(value.url.clone());
                }
                open_browser(&value.url).await?;
            }
            AuthLoginStep::Awaiting(_) | AuthLoginStep::NeedsInteraction(_) => {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            AuthLoginStep::Completed(value) => {
                *flow = None;
                match value.result.status {
                    AuthLoginResultStatus::Completed => {
                        let result = status(&runtime.account).await?;
                        if !result.connected {
                            return Err("Sign-in finished, but Copilot did not resolve the account. Please retry.".into());
                        }
                        return Ok(result);
                    }
                    AuthLoginResultStatus::NeedsPlaintextConsent => return Err(
                        "Copilot could not save credentials in your system keychain. Unlock or configure macOS Keychain / Linux Secret Service, then retry. Blueprint does not approve plaintext credential storage.".into()),
                    _ => return Err("Copilot sign-in was not completed. No workflow changes were made.".into()),
                }
            }
            AuthLoginStep::Error(value) => {
                *flow = None;
                return Err(format!("Copilot sign-in failed: {}", value.message));
            }
            AuthLoginStep::InputRequired(_) => return Err(
                "This sign-in requires additional account setup. Sign in through Copilot CLI, then reconnect Blueprint.".into()),
        }
        step = runtime
            .account
            .rpc()
            .accounts()
            .login()
            .advance(AuthLoginAdvanceRequest {
                flow_id: begun.flow_id.clone(),
                input: None,
            })
            .await
            .map_err(|error| format!("Copilot sign-in failed: {error}"))?;
    }
}

#[tauri::command]
pub async fn copilot_login(
    app: tauri::AppHandle,
    state: State<'_, CopilotState>,
    request_id: String,
) -> Result<Option<AuthStatus>> {
    let (_guard, mut cancel) = state.begin(&request_id)?;
    let runtime = state.runtime(&app).await?;
    let mut flow = None;
    let result = tokio::select! {
        biased;
        _ = cancel.wait_for(|cancelled| *cancelled) => Ok(None),
        result = tokio::time::timeout(Duration::from_secs(300), login(&runtime, &state, &mut flow)) =>
            result.map_err(|_| "Copilot sign-in expired. Please try again.".to_string()).and_then(|result| result.map(Some)),
    };
    if let Some(flow_id) = flow {
        if let Err(error) = request(
            "Cancel Copilot sign-in",
            runtime
                .account
                .rpc()
                .accounts()
                .login()
                .cancel(AuthLoginCancelRequest { flow_id }),
        )
        .await
        {
            state.reset().await;
            return Err(format!("{error} The Blueprint-owned runtime was stopped."));
        }
    }
    match result {
        Ok(Some(status)) => {
            remember_connection(&app)?;
            Ok(Some(status))
        }
        other => {
            state.reset().await;
            other
        }
    }
}

#[tauri::command]
pub fn copilot_cancel(state: State<'_, CopilotState>, request_id: String) -> Result<()> {
    validate_id(&request_id)?;
    if let Some(operation) = state
        .operation
        .lock()
        .map_err(|_| "Copilot state is unavailable.")?
        .as_ref()
    {
        if operation.id != request_id {
            return Err("That Copilot request is no longer active.".into());
        }
        operation.cancel.send_replace(true);
    }
    Ok(())
}

#[tauri::command]
pub async fn copilot_reopen_browser(
    state: State<'_, CopilotState>,
    request_id: String,
) -> Result<()> {
    validate_id(&request_id)?;
    let url = {
        let operation = state
            .operation
            .lock()
            .map_err(|_| "Copilot state is unavailable.")?;
        operation
            .as_ref()
            .filter(|operation| operation.id == request_id)
            .and_then(|operation| operation.browser_url.clone())
            .ok_or("The sign-in browser is not ready, or the request has finished.")?
    };
    open_browser(&url).await
}

#[tauri::command]
pub async fn copilot_disconnect(
    app: tauri::AppHandle,
    state: State<'_, CopilotState>,
) -> Result<AuthStatus> {
    let (_guard, _) = state.begin("disconnect")?;
    let root = data_dir(&app)?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&root)
        .map_err(|error| format!("Cannot save the Copilot connection preference: {error}"))?;
    fs::write(root.join("copilot-disconnected"), b"")
        .map_err(|error| format!("Cannot save the Copilot connection preference: {error}"))?;
    state.reset().await;
    Ok(AuthStatus::default())
}

fn prompt_input(input: &PromptRequest) -> Result<String> {
    if input.description.trim().is_empty() || input.description.encode_utf16().count() > 10_000 {
        return Err("Describe the agent in 1 to 10000 characters.".into());
    }
    if input.name.encode_utf16().count() > 100
        || input.fields.len() > 128
        || input.fields.iter().any(|field| field.name.len() > 200)
        || input.tools.len() > 256
        || input.tools.iter().any(|tool| tool.len() > 500)
    {
        return Err("This agent's settings are too large for prompt generation. You can still edit its prompt manually.".into());
    }
    serde_json::to_string(input)
        .map_err(|error| format!("Cannot prepare the prompt request: {error}"))
}

fn prompt_output(event: Option<github_copilot_sdk::SessionEvent>) -> Result<String> {
    let event = event.ok_or("Copilot returned no draft. Your current prompt is unchanged.")?;
    if event.event_type != "assistant.message" {
        return Err("Copilot returned an unexpected response instead of a prompt.".into());
    }
    let prompt = event
        .data
        .get("content")
        .and_then(|value| value.as_str())
        .ok_or("Copilot returned an invalid prompt response.")?
        .trim();
    if prompt.is_empty() || prompt.encode_utf16().count() > PROMPT_LIMIT {
        return Err(
            "Copilot returned an empty or oversized draft. Refine the description and retry."
                .into(),
        );
    }
    Ok(prompt.into())
}

#[tauri::command]
pub async fn copilot_generate(
    app: tauri::AppHandle,
    state: State<'_, CopilotState>,
    request_id: String,
    input: PromptRequest,
) -> Result<Option<PromptDraft>> {
    let input = prompt_input(&input)?;
    let (_guard, mut cancel) = state.begin(&request_id)?;
    if disconnected(&app)? {
        return Err("Connect Copilot before generating a prompt.".into());
    }
    let runtime = state.runtime(&app).await?;
    let owner = status(&runtime.account).await?;
    if !owner.connected {
        return Err(
            "Your Copilot sign-in has expired. Sign in again; your current prompt is unchanged."
                .into(),
        );
    }
    if *cancel.borrow() {
        return Ok(None);
    }
    let session = request(
        "Prepare prompt generation",
        runtime
            .client
            .create_session(session_config(&runtime.directory)),
    )
    .await?;
    let result = tokio::select! {
        biased;
        _ = cancel.wait_for(|cancelled| *cancelled) => Ok(None),
        response = async {
            if status(&session).await? != owner {
                return Err("The Copilot account changed. Refresh the connection before generating; your current prompt is unchanged.".into());
            }
            session.send_and_wait(MessageOptions::new(input).with_wait_timeout(Duration::from_secs(120)))
                .await.map_err(|error| format!("Copilot could not generate a prompt: {error}"))
                .and_then(prompt_output)
        } => response.map(Some),
    };
    let cleanup = async {
        if !matches!(result, Ok(Some(_))) {
            request("Stop prompt generation", session.abort()).await?;
        }
        request("Close prompt generation", session.disconnect()).await?;
        request(
            "Remove the temporary Copilot session",
            runtime.client.delete_session(session.id()),
        )
        .await
    }
    .await;
    if cleanup.is_err() {
        state.reset().await;
    }
    match (result, cleanup) {
        (Ok(Some(prompt)), cleanup) => Ok(Some(PromptDraft {
            prompt,
            warning: cleanup.err().map(|error| format!("{error} The runtime was stopped, but temporary Copilot session data may remain.")),
        })),
        (result, Ok(())) => result.map(|_| None),
        (_, Err(error)) => Err(format!("{error} The Blueprint-owned runtime was stopped.")),
    }
}

#[cfg(test)]
mod tests;
