use tauri::{AppHandle, Manager};

use crate::{
    db::models::{AppSettings, StorageStats},
    error::Result,
    AppState,
};

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, AppState>) -> Result<AppSettings> {
    state.db.get_settings()
}

#[tauri::command]
pub fn save_island_preferences(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    preferences: crate::island::model::Preferences,
) -> Result<AppSettings> {
    let mut settings = state.db.get_settings()?;
    settings.island = preferences;
    save_settings(app, state, settings)
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings> {
    let previous = state.db.get_settings()?;
    let saved = state.db.save_settings(&settings)?;
    if previous.island_activity != saved.island_activity {
        crate::island::activity_bus::publish(
            &app,
            crate::island::activity::ActivityEvent::PreferencesChanged {
                preferences: saved.island_activity.clone(),
            },
        );
    }
    if previous.retention_days != saved.retention_days {
        let _ = state.db.run_retention_gc();
    }
    #[cfg(windows)]
    if previous.island != saved.island {
        if let Some(manager) = app.try_state::<std::sync::Arc<crate::island::Manager>>() {
            manager.configure(saved.island.clone());
        }
    }
    if (previous.launch_at_login != saved.launch_at_login
        || previous.toggle_popover_shortcut != saved.toggle_popover_shortcut
        || previous.quick_download_shortcut != saved.quick_download_shortcut
        || previous.clipboard_search_shortcut != saved.clipboard_search_shortcut)
        && !crate::island::acceptance_session()
    {
        crate::apply_runtime_settings(&app, &state, &saved);
    }
    Ok(saved)
}

#[tauri::command]
pub fn get_island_snapshot(app: AppHandle) -> serde_json::Value {
    #[cfg(windows)]
    if let Some(manager) = app.try_state::<std::sync::Arc<crate::island::Manager>>() {
        return serde_json::to_value(manager.snapshot()).unwrap_or_default();
    }
    let _ = app;
    serde_json::json!({"supported":false,"desktop":{"monitors":[]},"hosts":[],"lastError":null})
}

#[tauri::command]
pub fn acknowledge_first_run(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<AppSettings> {
    let mut settings = state.db.get_settings()?;
    settings.first_run_acknowledged = true;
    save_settings(app, state, settings)
}

#[tauri::command]
pub fn get_storage_stats(state: tauri::State<'_, AppState>) -> Result<StorageStats> {
    state.db.stats()
}

#[tauri::command]
pub fn run_retention_gc(state: tauri::State<'_, AppState>) -> Result<usize> {
    state.db.run_retention_gc()
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<()> {
    crate::show_popover(&app)
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    Ok(())
}
