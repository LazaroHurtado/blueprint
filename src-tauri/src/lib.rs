mod copilot;
mod persistence;

use persistence::{OutputFile, SaveResult, SaveStore};
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_fs::FsExt;

fn save_store(app: &tauri::AppHandle) -> Result<SaveStore, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    SaveStore::open(directory.join("save-recovery"))
}

#[tauri::command]
async fn recover_saves(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || save_store(&app)?.recover())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_export(
    app: tauri::AppHandle,
    root: PathBuf,
    files: Vec<OutputFile>,
) -> Result<SaveResult, String> {
    if files.iter().any(|file| !file.path.starts_with(".github/")) {
        return Err("Repository exports must stay inside .github.".into());
    }
    write_files(app, root, files).await
}

#[tauri::command]
async fn save_draft(
    app: tauri::AppHandle,
    path: PathBuf,
    content: String,
) -> Result<SaveResult, String> {
    if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
        return Err("Choose a JSON filename, such as workflow.blueprint.json.".into());
    }
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|error| format!("Draft is not valid JSON: {error}"))?;
    let root = path
        .parent()
        .ok_or("Draft needs a parent folder.")?
        .to_path_buf();
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid draft filename.")?
        .to_string();
    write_files(
        app,
        root,
        vec![OutputFile {
            path: name,
            content,
        }],
    )
    .await
}

async fn write_files(
    app: tauri::AppHandle,
    root: PathBuf,
    files: Vec<OutputFile>,
) -> Result<SaveResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = save_store(&app)?;
        let scope = app.fs_scope();
        store.save(
            &root,
            files,
            |target| scope.is_allowed(target),
            |conflicts| {
                app.dialog()
                    .message(format!(
                        "Replace these existing files?\n\n{}",
                        conflicts
                            .iter()
                            .map(|path| path.display().to_string())
                            .collect::<Vec<_>>()
                            .join("\n")
                    ))
                    .title("Replace Blueprint files")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancel)
                    .blocking_show()
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(copilot::CopilotState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            save_export,
            save_draft,
            recover_saves,
            copilot::copilot_status,
            copilot::copilot_models,
            copilot::copilot_login,
            copilot::copilot_cancel,
            copilot::copilot_reopen_browser,
            copilot::copilot_disconnect,
            copilot::copilot_generate
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<copilot::CopilotState>().shutdown();
            }
        });
}
