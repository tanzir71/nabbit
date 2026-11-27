use crate::{
    error::Result,
    notes::store::{NoteDraft, StoredNote},
    AppState,
};
use serde_json::Value;
use tauri::Emitter;

#[tauri::command]
pub fn list_note_cards(state: tauri::State<'_, AppState>) -> Result<Vec<StoredNote>> {
    state.db.list_note_cards()
}

#[tauri::command]
pub fn create_note_card(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    draft: NoteDraft,
) -> Result<StoredNote> {
    let note = state.db.create_note_card(draft)?;
    let _ = app.emit("notes:updated", ());
    Ok(note)
}

#[tauri::command]
pub fn update_note_card(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    expected_revision: u64,
    patch: Value,
) -> Result<StoredNote> {
    let note = state.db.update_note_card(&id, expected_revision, patch)?;
    let _ = app.emit("notes:updated", ());
    Ok(note)
}
