use arboard::Clipboard;
use tauri::Emitter;

use crate::{
    db::models::ClipboardEntry,
    error::{msg, Result},
    AppState,
};

#[tauri::command]
pub fn list_clipboard_entries(
    state: tauri::State<'_, AppState>,
    query: Option<String>,
) -> Result<Vec<ClipboardEntry>> {
    let query = query.filter(|value| !value.trim().is_empty());
    state.db.list_clipboard_entries(query.as_deref())
}

#[tauri::command]
pub fn add_clipboard_text(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    content: String,
) -> Result<Option<ClipboardEntry>> {
    let entry = state
        .db
        .add_clipboard_text(&content, Some("Manual".into()))?;
    if entry.is_some() {
        let _ = app.emit("clipboard:changed", ());
    }
    Ok(entry)
}

#[tauri::command]
pub fn copy_clipboard_entry(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<()> {
    if crate::sticky::acceptance_enabled()
        || crate::island::acceptance_session()
        || crate::download::acceptance::enabled()
    {
        return Err(msg("Native clipboard writes are disabled in acceptance"));
    }
    let entry = state.db.get_clipboard_entry(&id)?;
    if entry.content_type == "image" {
        let image = image::open(state.db.clipboard_image_path(&id)?)
            .map_err(|_| msg("The clipboard image could not be read"))?
            .to_rgba8();
        let data = arboard::ImageData {
            width: image.width() as usize,
            height: image.height() as usize,
            bytes: std::borrow::Cow::Owned(image.into_raw()),
        };
        Clipboard::new()
            .and_then(|mut board| board.set_image(data))
            .map_err(|_| msg("Clipboard image write failed"))?;
    } else if entry.content_type == "file" && entry.content.starts_with('[') {
        let paths = serde_json::from_str::<Vec<String>>(&entry.content)?;
        #[cfg(windows)]
        {
            let _lock = clipboard_win::Clipboard::new().map_err(|_| msg("Clipboard is busy"))?;
            clipboard_win::raw::set_file_list(&paths)
                .map_err(|_| msg("Clipboard file write failed"))?;
        }
        #[cfg(not(windows))]
        Clipboard::new()
            .and_then(|mut board| board.set_text(paths.join("\n")))
            .map_err(|_| msg("Clipboard file write failed"))?;
    } else {
        let mut clipboard =
            Clipboard::new().map_err(|error| msg(format!("clipboard unavailable: {error}")))?;
        clipboard
            .set_text(entry.content)
            .map_err(|error| msg(format!("clipboard write failed: {error}")))?;
    }
    state.db.touch_clipboard_entry(&id)?;
    let _ = app.emit("clipboard:changed", ());
    Ok(())
}

#[tauri::command]
pub fn toggle_pin_clipboard_entry(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<ClipboardEntry> {
    let entry = state.db.toggle_pin_clipboard_entry(&id)?;
    let _ = app.emit("clipboard:changed", ());
    Ok(entry)
}

#[tauri::command]
pub fn delete_clipboard_entry(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<()> {
    state.db.delete_clipboard_entry(&id)?;
    let _ = app.emit("clipboard:changed", ());
    Ok(())
}

#[tauri::command]
pub fn clear_clipboard_history(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    state.db.clear_clipboard_history()?;
    let _ = app.emit("clipboard:changed", ());
    Ok(())
}
