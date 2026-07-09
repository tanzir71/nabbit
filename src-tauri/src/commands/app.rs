use serde::Serialize;
use tauri_plugin_updater::UpdaterExt;

use crate::{error::Result, AppState};

#[tauri::command]
pub fn app_health(state: tauri::State<'_, AppState>) -> Result<String> {
    let stats = state.db.stats()?;
    Ok(format!(
        "ok: {} clipboard entries, {} downloads",
        stats.clipboard_count, stats.download_count
    ))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    pub available: bool,
    pub current_version: Option<String>,
    pub version: Option<String>,
    pub date: Option<String>,
    pub body: Option<String>,
    pub url: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn check_app_update(app: tauri::AppHandle) -> AppUpdateStatus {
    match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => AppUpdateStatus {
                available: true,
                current_version: Some(update.current_version),
                version: Some(update.version),
                date: update.date.map(|date| date.to_string()),
                body: update.body,
                url: Some(update.download_url.to_string()),
                error: None,
            },
            Ok(None) => AppUpdateStatus {
                available: false,
                current_version: None,
                version: None,
                date: None,
                body: None,
                url: None,
                error: None,
            },
            Err(error) => AppUpdateStatus {
                available: false,
                current_version: None,
                version: None,
                date: None,
                body: None,
                url: None,
                error: Some(error.to_string()),
            },
        },
        Err(error) => AppUpdateStatus {
            available: false,
            current_version: None,
            version: None,
            date: None,
            body: None,
            url: None,
            error: Some(error.to_string()),
        },
    }
}
