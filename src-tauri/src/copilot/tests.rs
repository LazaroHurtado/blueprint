use super::*;
use serde_json::json;

fn input() -> PromptRequest {
    serde_json::from_value(json!({
        "description": "Review Python changes without editing files.",
        "name": "Review", "tools": ["read", "search"], "output": "json",
        "fields": [{"name": "needsChanges", "type": "boolean"}]
    }))
    .unwrap()
}

#[test]
fn drafting_has_no_tools_discovery_or_host_access() {
    let config = session_config(Path::new("/private/blueprint"));
    assert_eq!(config.available_tools, Some(Vec::new()));
    assert_eq!(
        config.excluded_tools,
        Some(vec!["builtin:*".into(), "mcp:*".into(), "custom:*".into()])
    );
    assert_eq!(config.enable_config_discovery, Some(false));
    assert_eq!(config.enable_file_hooks, Some(false));
    assert_eq!(config.enable_host_git_operations, Some(false));
    assert_eq!(config.enable_skills, Some(false));
    assert_eq!(config.skip_custom_instructions, Some(true));
    assert_eq!(config.request_extensions, Some(false));
    assert!(config.mcp_servers.unwrap().is_empty());
    assert!(config.custom_agents.unwrap().is_empty());
    assert!(config.permission_handler.is_some());
    assert!(
        config.model.is_none(),
        "drafting must not inherit the workflow agent's model"
    );
}

#[test]
fn prompt_boundary_rejects_extra_secrets_and_bounds_input_and_output() {
    let request = input();
    let serialized = prompt_input(&request).unwrap();
    assert!(serialized.contains("needsChanges"));
    assert!(!serialized.contains("mcpServers"));
    let mut injected = serde_json::to_value(&request).unwrap();
    injected["mcpServers"] = json!({"private": {"env": {"TOKEN": "not-a-real-token"}}});
    assert!(serde_json::from_value::<PromptRequest>(injected).is_err());
    let mut empty = input();
    empty.description = " ".into();
    assert!(prompt_input(&empty).is_err());
    empty.description = "a".repeat(10_001);
    assert!(prompt_input(&empty).is_err());
    assert!(prompt_output(None).is_err());
    for (text, valid) in [
        ("Draft text", true),
        ("  ", false),
        (&"a".repeat(30_001), false),
    ] {
        let event = serde_json::from_value(json!({
            "id": "reply", "timestamp": "", "parentId": null,
            "type": "assistant.message", "data": {"content": text}
        }))
        .unwrap();
        assert_eq!(prompt_output(Some(event)).is_ok(), valid);
    }
}

#[test]
fn model_policy_is_visible_and_unknown_policy_is_not_assumed_safe() {
    let mut model = Model {
        id: "example-model".into(),
        name: "Example model".into(),
        ..Default::default()
    };
    assert!(model_info(model.clone()).unwrap().selectable);
    model.policy = Some(github_copilot_sdk::rpc::ModelPolicy {
        state: ModelPolicyState::Disabled,
        terms: None,
    });
    let unavailable = model_info(model.clone()).unwrap();
    assert!(!unavailable.selectable);
    assert_eq!(
        unavailable.policy.as_deref(),
        Some("Disabled by your organization")
    );
    model.policy.as_mut().unwrap().state = ModelPolicyState::Unknown;
    assert!(!model_info(model).unwrap().selectable);
}

#[test]
fn browser_launch_accepts_only_the_github_authorization_endpoint() {
    assert!(login_url("https://github.com/login/oauth/authorize?client_id=example").is_ok());
    for url in [
        "file:///etc/passwd",
        "http://github.com/login/oauth/authorize",
        "https://github.com.evil.test/login/oauth/authorize",
        "https://github.com@evil.test/login/oauth/authorize",
        "https://github.com:8443/login/oauth/authorize",
        "https://github.com/other",
    ] {
        assert!(login_url(url).is_err(), "{url}");
    }
}

#[tokio::test]
async fn cancellation_is_retained_before_waiting_and_operations_are_exclusive() {
    let state = CopilotState::default();
    let (guard, mut cancelled) = state.begin("request-one").unwrap();
    assert!(state.begin("request-two").is_err());
    state
        .operation
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .cancel
        .send_replace(true);
    cancelled.wait_for(|value| *value).await.unwrap();
    drop(guard);
    assert!(state.begin("request-two").is_ok());
    assert!(validate_id("../not-an-id").is_err());
}

#[tokio::test]
async fn bundled_runtime_starts_a_restricted_unauthenticated_session_without_inference() {
    let directory = std::env::temp_dir().join(format!(
        "blueprint-copilot-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&directory).unwrap();
    let program = github_copilot_sdk::install_bundled_runtime().expect("bundled runtime");
    let (options, workspace) = client_options(program, &directory).unwrap();
    let client = Client::start(options.with_use_logged_in_user(false))
        .await
        .expect("start bundled runtime");
    let result = async {
        let account = request(
            "Create restricted session",
            client.create_session(session_config(&workspace)),
        )
        .await?;
        let auth = request(
            "Read isolated account",
            account.rpc().accounts().get(AccountsGetRequest {
                query: AuthReadQuery::Status(AuthReadQueryStatus::default()),
            }),
        )
        .await?;
        match auth {
            AuthReadValue::Status(value) if !value.status.is_authenticated => {}
            _ => return Err("Unexpected authentication in an isolated test session.".into()),
        }
        let denied = request(
            "Verify tool exclusion",
            account
                .rpc()
                .tools()
                .execute(github_copilot_sdk::rpc::ToolsExecuteRequest {
                    name: "bash".into(),
                    arguments: json!({
                        "command": "printf blueprint-restriction-check",
                        "description": "Verify drafting cannot execute commands"
                    }),
                    tool_call_id: None,
                }),
        )
        .await?;
        match denied {
            github_copilot_sdk::rpc::ToolResult::ToolResultExpanded(result)
                if result.result_type == github_copilot_sdk::rpc::ToolResultType::Failure
                    && result.text_result_for_llm
                        == "Tool 'bash' does not exist. Available tools that can be called are ." => {}
            _ => return Err("The drafting session unexpectedly offered tools.".into()),
        }
        let begun = request(
            "Prepare browser sign-in",
            account
                .rpc()
                .accounts()
                .login()
                .begin(AuthLoginBeginRequest {
                    kind: LoginProviderKind::GitHubDotCom,
                }),
        )
        .await?;
        match &begun.step {
            AuthLoginStep::OpenUrl(value) => {
                login_url(&value.url)?;
            }
            _ => return Err("Expected the bundled runtime's browser sign-in step.".into()),
        }
        request(
            "Cancel unopened browser sign-in",
            account
                .rpc()
                .accounts()
                .login()
                .cancel(AuthLoginCancelRequest {
                    flow_id: begun.flow_id,
                }),
        )
        .await?;
        request("Abort an idle restricted session", account.abort()).await?;
        let id = account.id().clone();
        request("Disconnect test session", account.disconnect()).await?;
        request("Delete test session", client.delete_session(&id)).await
    }
    .await;
    client.force_stop();
    fs::remove_dir_all(directory).unwrap();
    result.unwrap();
}
