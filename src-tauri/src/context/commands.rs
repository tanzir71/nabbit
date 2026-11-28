use super::{
    classify::{self, Kind},
    text, Service,
};
use crate::{
    db::{models::ClipboardEntry, Database},
    error::{msg, Result},
    tools::registry,
};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{Emitter, Manager};
#[tauri::command]
pub fn context_preferences(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<super::registration::Preferences> {
    crate::tools::commands::caller(&app, &window)?;
    super::registration::preferences(&app.state::<crate::AppState>().db)
}
#[tauri::command]
pub async fn save_context_preferences(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    preferences: super::registration::Preferences,
) -> Result<super::registration::Preferences> {
    crate::tools::commands::caller(&app, &window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let service = app.state::<Service>();
        let _lock = service
            .registration_lock
            .lock()
            .map_err(|_| msg("Explorer registration is busy"))?;
        let db = &app.state::<crate::AppState>().db;
        let previous = super::registration::preferences(db)?;
        if crate::context::acceptance() {
            app.emit(
                "context:registration",
                serde_json::json!({"preferences":preferences,"nativeWrites":false}),
            )?;
        } else {
            super::registration::sync(preferences.clone())?;
        }
        if let Err(error) =
            db.set_setting_value("context/preferences", &serde_json::to_string(&preferences)?)
        {
            if !crate::context::acceptance() {
                let _ = super::registration::sync(previous);
            }
            return Err(error);
        }
        Ok(preferences)
    })
    .await
    .map_err(|_| msg("Explorer registration stopped"))?
}
#[derive(Serialize)]
pub struct BatchSnapshot {
    batch: Option<super::explorer::Batch>,
    error: Option<String>,
}
#[tauri::command]
pub fn context_batch(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<BatchSnapshot> {
    crate::tools::commands::caller(&app, &window)?;
    let service = app.state::<Service>();
    if super::silent(&app) {
        return Ok(BatchSnapshot {
            batch: None,
            error: None,
        });
    }
    let snapshot = BatchSnapshot {
        batch: service
            .batch
            .lock()
            .map_err(|_| msg("Explorer batch is unavailable"))?
            .clone(),
        error: service
            .batch_error
            .lock()
            .map_err(|_| msg("Explorer batch is unavailable"))?
            .clone(),
    };
    Ok(snapshot)
}
#[tauri::command]
pub fn context_batch_dismiss(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: Option<String>,
) -> Result<()> {
    crate::tools::commands::caller(&app, &window)?;
    let service = app.state::<Service>();
    let mut batch = service
        .batch
        .lock()
        .map_err(|_| msg("Explorer batch is unavailable"))?;
    if batch.as_ref().map(|b| b.id.as_str()) == id.as_deref() {
        *batch = None;
        *service
            .batch_error
            .lock()
            .map_err(|_| msg("Explorer batch is unavailable"))? = None;
    }
    app.emit("context:batch", ())?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub entry: ClipboardEntry,
    pub kind: Kind,
    pub tools: Vec<registry::Tool>,
    pub text_tools: Vec<text::TextTool>,
    pub selection: bool,
}
pub(crate) fn paths(entry: &ClipboardEntry) -> Vec<String> {
    if entry.content_type == "file" || classify::text(&entry.content) == Kind::Path {
        serde_json::from_str::<Vec<String>>(&entry.content)
            .unwrap_or_else(|_| vec![entry.content.trim().trim_matches('"').into()])
    } else {
        vec![]
    }
}
pub(crate) fn metadata(entry: ClipboardEntry, selection: bool) -> Snapshot {
    let kind = match entry.content_type.as_str() {
        "image" => Kind::Image,
        "file" if entry.content.starts_with('[') => Kind::Files,
        _ => classify::text(&entry.content),
    };
    let inputs = paths(&entry);
    let tools = registry::catalog()
        .into_iter()
        .filter(|tool| match kind {
            Kind::Image => tool.accepts.image,
            Kind::Files | Kind::Path => {
                !inputs.is_empty() && inputs.iter().all(|p| tool.accepts_path(Path::new(p)))
            }
            Kind::Link | Kind::Video => tool.accepts.link || tool.accepts.text,
            Kind::Text | Kind::Json => tool.accepts.text,
        })
        .collect();
    Snapshot {
        entry,
        kind,
        tools,
        text_tools: text::catalog(),
        selection,
    }
}
fn resolve(app: &tauri::AppHandle, id: &str) -> Result<ClipboardEntry> {
    if let Some(entry) = app
        .state::<Service>()
        .selection
        .lock()
        .map_err(|_| msg("Selection is unavailable"))?
        .as_ref()
        .filter(|e| e.id == id)
        .cloned()
    {
        return Ok(entry);
    }
    let state = app.state::<crate::AppState>();
    let entry = state.db.get_clipboard_entry(id)?;
    if !state
        .db
        .clipboard_source_allowed(entry.source_app.as_deref())?
    {
        return Err(msg("This source app is excluded from context capture"));
    }
    Ok(entry)
}
#[tauri::command]
pub fn clipboard_context(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: Option<String>,
    explicit: Option<bool>,
) -> Result<Option<Snapshot>> {
    crate::tools::commands::caller(&app, &window)?;
    if super::silent(&app) {
        return Ok(None);
    }
    let service = app.state::<Service>();
    if let Some(entry) = service
        .selection
        .lock()
        .map_err(|_| msg("Selection is unavailable"))?
        .clone()
        .filter(|_| explicit != Some(true))
    {
        return Ok(Some(metadata(entry, true)));
    }
    if explicit != Some(true)
        && *service
            .blocked
            .lock()
            .map_err(|_| msg("Context is unavailable"))?
    {
        return Ok(None);
    }
    let id = id.or_else(|| service.latest.lock().ok().and_then(|v| v.clone()));
    id.map(|id| resolve(&app, &id).map(|entry| metadata(entry, false)))
        .transpose()
}
#[tauri::command]
pub fn clipboard_context_dismiss(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<()> {
    crate::tools::commands::caller(&app, &window)?;
    *app.state::<Service>()
        .selection
        .lock()
        .map_err(|_| msg("Selection is unavailable"))? = None;
    app.emit("context:changed", ())?;
    Ok(())
}
pub(crate) fn copy_result(
    db: &Database,
    input: &str,
    operation: &str,
    write: impl FnOnce(&str) -> Result<()>,
) -> Result<ClipboardEntry> {
    let result = text::transform(operation, input)?;
    let entry = db
        .add_clipboard_text(&result, Some("Nabbit text tools".into()))?
        .ok_or_else(|| msg("The result was skipped by clipboard privacy settings"))?;
    write(&result)?;
    Ok(entry)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transform {
    pub request_id: String,
    pub id: String,
    pub operation: String,
}
#[tauri::command]
pub async fn clipboard_transform(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Transform,
) -> Result<ClipboardEntry> {
    crate::tools::commands::caller(&app, &window)?;
    if uuid::Uuid::parse_str(&request.request_id).is_err() {
        return Err(msg("Invalid text request ID"));
    }
    let entry = resolve(&app, &request.id)?;
    if entry.content_type == "image"
        || (entry.content_type == "file" && entry.content.starts_with('['))
    {
        return Err(msg("Choose a text clipboard item"));
    }
    let db = app.state::<crate::AppState>().db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let service = app.state::<Service>();
        let mut receipts = service
            .receipts
            .lock()
            .map_err(|_| msg("Text tools are unavailable"))?;
        let digest = crate::util::sha256_hex(
            serde_json::to_string(&(&entry.id, &request.operation, &entry.content))?.as_bytes(),
        );
        if let Some((old, result)) = receipts.get(&request.request_id) {
            if old != &digest {
                return Err(msg("This request belongs to another text action"));
            }
            return Ok(result.clone());
        }
        let result = copy_result(&db, &entry.content, &request.operation, |text| {
            if crate::context::acceptance() {
                app.emit("context:clipboard-write", text)?;
                return Ok(());
            }
            arboard::Clipboard::new()
                .and_then(|mut c| c.set_text(text))
                .map_err(|_| msg("Clipboard write failed; the result remains in history"))
        })?;
        if receipts.len() >= 64 {
            receipts.clear();
        }
        receipts.insert(request.request_id, (digest, result.clone()));
        app.emit("clipboard:new", &result)?;
        Ok(result)
    })
    .await
    .map_err(|_| msg("Text tool stopped"))?
}
fn owned_text_input(app: &tauri::AppHandle, text: &str) -> Result<PathBuf> {
    if text.len() > 8192 || text.is_empty() {
        return Err(msg("QR text must contain 1 to 8192 bytes"));
    }
    let directory = app
        .state::<crate::AppState>()
        .app_data_dir
        .join("context-inputs");
    std::fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{}.txt", crate::util::sha256_hex(text.as_bytes())));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut f) => {
            f.write_all(text.as_bytes())?;
            f.sync_all()?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let _guard = crate::tools::files::input(&path)?;
            if crate::tools::files::hash_with_cancel(&path, None)?
                != crate::util::sha256_hex(text.as_bytes())
            {
                return Err(msg("QR input storage changed"));
            }
        }
        Err(e) => return Err(e.into()),
    }
    Ok(path)
}
#[tauri::command]
pub async fn clipboard_tool_inputs(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    tool_id: String,
) -> Result<Vec<String>> {
    crate::tools::commands::caller(&app, &window)?;
    let entry = resolve(&app, &id)?;
    let tool = metadata(entry.clone(), false)
        .tools
        .into_iter()
        .find(|t| t.id == tool_id)
        .ok_or_else(|| msg("This tool does not accept the clipboard item"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let db = &app.state::<crate::AppState>().db;
        let inputs = if entry.content_type == "image" {
            vec![db.clipboard_image_path(&entry.id)?.to_string_lossy().into()]
        } else if tool.accepts.text || tool.accepts.link {
            vec![owned_text_input(&app, &entry.content)?
                .to_string_lossy()
                .into()]
        } else {
            paths(&entry)
        };
        if inputs.is_empty() || !inputs.iter().all(|p| tool.accepts_path(Path::new(p))) {
            return Err(msg("This tool does not accept the copied files"));
        }
        Ok(inputs)
    })
    .await
    .map_err(|_| msg("Clipboard input preparation stopped"))?
}
#[tauri::command]
pub async fn clipboard_context_action(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    action: String,
) -> Result<String> {
    crate::tools::commands::caller(&app, &window)?;
    let entry = resolve(&app, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<crate::AppState>().db.clone();
        match action.as_str() {
            "shelf" => {
                let paths = paths(&entry);
                crate::shelf::add(&db, paths)?;
                app.emit("shelf:changed", ())?;
                Ok("Added to Shelf".into())
            }
            "reveal" | "pin" => {
                let paths = paths(&entry);
                if paths.len() != 1 {
                    return Err(msg("Choose one copied path"));
                }
                let path = paths[0].clone();
                if action == "pin" {
                    crate::files::save(
                        &db,
                        crate::files::PinDraft {
                            id: None,
                            path,
                            label: None,
                            slot: None,
                            always_move: false,
                        },
                    )?;
                    app.emit("nabbit://pin-opened", ())?;
                    Ok("Path pinned".into())
                } else if crate::context::acceptance() {
                    app.emit("context:reveal", path)?;
                    Ok("Path revealed".into())
                } else {
                    crate::shell::run(move || crate::files::native::action(path, "reveal".into()))?;
                    Ok("Path revealed".into())
                }
            }
            "save-image" => {
                let source = db.clipboard_image_path(&entry.id)?;
                let folder = if crate::context::acceptance() {
                    let p = app
                        .state::<crate::AppState>()
                        .app_data_dir
                        .join("context-saved");
                    std::fs::create_dir_all(&p)?;
                    Some(p.to_string_lossy().into_owned())
                } else {
                    crate::shell::run(|| crate::files::native::choose(true))?
                };
                let Some(folder) = folder else {
                    return Ok("Save cancelled".into());
                };
                let temp = Path::new(&folder).join(format!(".nabbit-{}.png", uuid::Uuid::new_v4()));
                let mut original = crate::tools::files::input(&source)?;
                let mut output = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temp)?;
                let result = (|| {
                    std::io::copy(&mut original, &mut output)?;
                    output.sync_all()?;
                    drop(output);
                    crate::tools::files::dates(&original, &temp)?;
                    crate::tools::files::publish(
                        &temp,
                        &Path::new(&folder).join("Clipboard image.png"),
                        "Saved",
                        "png",
                        |_| Ok(()),
                    )
                })();
                if result.is_err() {
                    let _ = std::fs::remove_file(&temp);
                }
                let output = result?;
                Ok(format!(
                    "Saved {}",
                    output.file_name().unwrap_or_default().to_string_lossy()
                ))
            }
            _ => Err(msg("Unknown clipboard action")),
        }
    })
    .await
    .map_err(|_| msg("Clipboard action stopped"))?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registry_context_filters_every_tool_and_text_results_keep_the_original() {
        let db = Database::open(
            &std::env::temp_dir().join(format!("nabbit-context-actions-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        let original = db.add_clipboard_text("hello বাংলা", None).unwrap().unwrap();
        let mut writes = Vec::new();
        let result = copy_result(&db, &original.content, "upper", |s| {
            writes.push(s.to_owned());
            Ok(())
        })
        .unwrap();
        assert_eq!(writes, ["HELLO বাংলা"]);
        assert_eq!(
            db.get_clipboard_entry(&original.id).unwrap().content,
            "hello বাংলা"
        );
        assert_ne!(original.id, result.id);
        assert!(copy_result(&db, "bad JSON", "json", |_| panic!("invalid input copied")).is_err());
        let item = db
            .add_clipboard_files(
                vec![std::env::temp_dir()
                    .join("fixture.png")
                    .to_string_lossy()
                    .into()],
                None,
            )
            .unwrap()
            .unwrap();
        let snapshot = metadata(item, false);
        assert_eq!(snapshot.kind, Kind::Files);
        assert!(snapshot.tools.iter().any(|t| t.id == "image-text"));
        assert!(snapshot
            .tools
            .iter()
            .all(|t| t.accepts_path(Path::new(&paths(&snapshot.entry)[0]))));
    }
}
