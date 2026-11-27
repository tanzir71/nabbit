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
    let entry = state.db.get_clipboard_entry(&id)?;
    let mut clipboard =
        Clipboard::new().map_err(|error| msg(format!("clipboard unavailable: {error}")))?;
    clipboard
        .set_text(entry.content)
        .map_err(|error| msg(format!("clipboard write failed: {error}")))?;
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
