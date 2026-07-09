use crate::{error::Result, AppState};

#[tauri::command]
pub fn app_health(state: tauri::State<'_, AppState>) -> Result<String> {
    let stats = state.db.stats()?;
    Ok(format!(
        "ok: {} clipboard entries, {} downloads",
        stats.clipboard_count, stats.download_count
    ))
}
