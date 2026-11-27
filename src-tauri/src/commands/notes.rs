use crate::{
    error::Result,
    notes::{
        store::{NoteDraft, NotesState, StoredNote},
        sync_store::Context,
    },
    tack::service::Service,
    AppState,
};
use serde_json::Value;
use tauri::{Emitter, Manager};

fn publish(app: &tauri::AppHandle) {
    if let Some(sync) = app.try_state::<Service>() {
        sync.edited();
    } else {
        let _ = app.emit("notes:updated", ());
    }
}

#[tauri::command]
pub fn list_note_cards(state: tauri::State<'_, AppState>) -> Result<Vec<StoredNote>> {
    state.db.list_note_cards()
}

#[tauri::command]
pub fn get_notes_state(state: tauri::State<'_, AppState>) -> Result<NotesState> {
    state.db.notes_state()
}

#[tauri::command]
pub fn save_note_reminder(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    scope: Context,
    id: String,
    value: Value,
) -> Result<()> {
    state.db.tack_save_reminder(&scope, &id, value)?;
    publish(&app);
    Ok(())
}

#[tauri::command]
pub fn create_note_card(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    draft: NoteDraft,
    expected_scope: Option<Context>,
) -> Result<StoredNote> {
    let note = state
        .db
        .create_note_card_in(draft, expected_scope.as_ref())?;
    publish(&app);
    Ok(note)
}

#[tauri::command]
pub fn update_note_card(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    expected_revision: u64,
    patch: Value,
    expected_scope: Option<Context>,
    expected_edit_token: Option<String>,
) -> Result<StoredNote> {
    let note = state.db.update_note_card_in(
        &id,
        expected_revision,
        expected_scope.as_ref(),
        expected_edit_token.as_deref(),
        patch,
    )?;
    publish(&app);
    Ok(note)
}
