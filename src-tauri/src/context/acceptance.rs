//! Acceptance inputs are confined to an isolated profile and never use the
//! system clipboard, global input, installed integrations or another app.
use crate::error::{msg, Result};
use serde::Deserialize;
use tauri::{Emitter, Manager};
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Fixture {
    Clipboard {
        text: String,
        source: Option<String>,
        #[serde(default)]
        exclude: bool,
        history: Option<u32>,
        cloud: Option<u32>,
    },
    Image {
        path: String,
    },
    Files {
        paths: Vec<String>,
    },
    Selection {
        text: String,
    },
    SelectionUia,
    Notification {
        state: Option<i32>,
    },
    Explorer {
        args: Vec<String>,
    },
}
#[tauri::command]
pub async fn context_fixture(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Fixture,
) -> Result<serde_json::Value> {
    crate::tools::commands::caller(&app, &window)?;
    if !crate::sticky::acceptance_enabled() || !crate::island::acceptance_session() {
        return Err(msg(
            "Context fixtures require an isolated acceptance session",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let owned = crate::files::commands::Owned { root: state.app_data_dir.clone() };
        let payload = match request {
            Fixture::Clipboard { text, source, exclude, history, cloud } => {
                if text.len() > 2_000_000 { return Err(msg("Context fixture text is too large")); }
                let policy = super::classify::Privacy { excluded: exclude, history, cloud, excluded_app: !state.db.clipboard_source_allowed(source.as_deref())? };
                if policy.blocked() {
                    super::observe(&app, None);
                    return Ok(serde_json::json!({"entry":null,"blocked":true}));
                }
                super::clipboard::Read { source, payload: super::clipboard::Payload::Text(text) }
            }
            Fixture::Image { path } => {
                owned.guard(&path)?;
                if std::fs::metadata(&path)?.len() > 128 * 1024 * 1024 { return Err(msg("Context fixture image is too large")); }
                super::clipboard::Read { source: Some("Owned fixture".into()), payload: super::clipboard::Payload::Image(std::fs::read(path)?) }
            }
            Fixture::Files { paths } => {
                if paths.is_empty() || paths.len() > 256 { return Err(msg("Context fixture supports 1 to 256 files")); }
                for path in &paths { owned.guard(path)?; }
                super::clipboard::Read { source: Some("Owned fixture".into()), payload: super::clipboard::Payload::Files(paths) }
            }
            Fixture::Selection { text } => {
                super::selection::open(&app,text)?;
                return Ok(serde_json::json!({"injected":true}));
            }
            Fixture::SelectionUia => {
                #[cfg(windows)]
                { let text=super::selection_fixture::verify()?; super::selection::open(&app,text.clone())?;
                  return Ok(serde_json::json!({"text":text,"nativeOwnedControl":true,"globalInput":false,"clipboardAccess":false})); }
                #[cfg(not(windows))]
                return Err(msg("The owned UIA control requires Windows"));
            }
            Fixture::Notification { state } => {
                if state.is_some_and(|n| !(1..=7).contains(&n)) { return Err(msg("Invalid notification-state fixture")); }
                *app.state::<super::Service>().notification.lock().map_err(|_|msg("Notification fixture is unavailable"))?=state;
                app.emit("context:changed",())?; app.emit("context:batch",())?;
                return Ok(serde_json::json!({"silent":super::silent(&app)}));
            }
            Fixture::Explorer { args } => {
                if args.len()>520 { return Err(msg("Too many fixture arguments")); }
                let invocation=super::explorer::parse(&args,&state.app_data_dir)?.ok_or_else(||msg("The fixture needs Send To arguments"))?;
                for path in &invocation.paths { owned.guard(path)?; }
                let accepted=super::explorer::intake(&app,&args,&state.app_data_dir);
                return Ok(serde_json::json!({"accepted":accepted,"nativeRegistration":false}));
            }
        };
        let entry=super::clipboard::ingest(&state.db,payload)?;
        super::observe(&app,entry.as_ref().map(|e|e.id.clone()));
        if let Some(entry)=&entry { app.emit("clipboard:new",entry)?; }
        Ok(serde_json::json!({"entry":entry,"blocked":false,"clipboardAccess":false}))
    }).await.map_err(|_|msg("Context fixture stopped"))?
}
