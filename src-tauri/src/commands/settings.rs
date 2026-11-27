use tauri::{AppHandle, Emitter, Manager};

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
    let island_key_changed = previous.island_shortcut.trim() != settings.island_shortcut.trim();
    let legacy_keys_changed = previous.toggle_popover_shortcut != settings.toggle_popover_shortcut
        || previous.quick_download_shortcut != settings.quick_download_shortcut
        || previous.clipboard_search_shortcut != settings.clipboard_search_shortcut;
    if island_key_changed || legacy_keys_changed {
        crate::island::keyboard::validate_shortcut(&settings).map_err(crate::error::msg)?;
    }
    let same_key = previous
        .island_shortcut
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .ok()
        == settings
            .island_shortcut
            .trim()
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .ok();
    let prebind = island_key_changed
        && !same_key
        && !settings.island_shortcut.trim().is_empty()
        && !crate::island::acceptance_session();
    if prebind {
        crate::register_island_shortcut(&app, &settings.island_shortcut)
            .map_err(crate::error::msg)?;
    }
    let saved = match state.db.save_settings(&settings) {
        Ok(saved) => saved,
        Err(error) => {
            if prebind {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let _ = app
                    .global_shortcut()
                    .unregister(settings.island_shortcut.trim());
            }
            return Err(error);
        }
    };
    if island_key_changed
        && !same_key
        && !crate::island::acceptance_session()
        && crate::island::keyboard::validate_shortcut(&previous).is_ok()
        && !previous.island_shortcut.trim().is_empty()
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let _ = app
            .global_shortcut()
            .unregister(previous.island_shortcut.trim());
    }
    #[cfg(windows)]
    if island_key_changed {
        if let Some(manager) = app.try_state::<std::sync::Arc<crate::island::Manager>>() {
            manager.shortcut_status(None);
        }
    }
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
        let _ = app.emit("clipboard:changed", ());
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
    if previous.theme != saved.theme {
        let _ = app.emit("nabbit://theme-preference", &saved.theme);
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
    crate::notify_tack_visibility(&app);
    Ok(())
}
