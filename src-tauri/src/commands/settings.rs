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
pub async fn save_island_preferences(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    preferences: crate::island::model::Preferences,
) -> Result<AppSettings> {
    patch_settings(app, state, serde_json::json!({"island": preferences})).await
}

#[tauri::command]
pub async fn patch_settings(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    change: serde_json::Value,
) -> Result<AppSettings> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || patch(&app, &state, change))
        .await
        .map_err(|error| crate::error::msg(error.to_string()))?
}

pub(crate) fn patch(
    app: &AppHandle,
    state: &AppState,
    change: serde_json::Value,
) -> Result<AppSettings> {
    let _write = state
        .settings_write
        .lock()
        .map_err(|_| crate::error::msg("Settings are busy"))?;
    let previous = state.db.get_settings()?;
    let targets = crate::shortcuts::supplied(&change);
    let settings = crate::db::settings_schema::patch(&previous, change)?;
    apply_settings(app, state, previous, settings, targets)
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _write = state
            .settings_write
            .lock()
            .map_err(|_| crate::error::msg("Settings are busy"))?;
        let previous = state.db.get_settings()?;
        apply_settings(&app, &state, previous, settings, vec![])
    })
    .await
    .map_err(|error| crate::error::msg(error.to_string()))?
}

fn apply_settings(
    app: &AppHandle,
    state: &AppState,
    previous: AppSettings,
    mut settings: AppSettings,
    mut targets: Vec<crate::shortcuts::Action>,
) -> Result<AppSettings> {
    if previous.display_mode != settings.display_mode {
        settings.island.enabled = settings.display_mode != crate::db::models::DisplayMode::TrayOnly;
    } else if previous.island.enabled != settings.island.enabled {
        settings.display_mode = if settings.island.enabled {
            crate::db::models::DisplayMode::IslandAndTray
        } else {
            crate::db::models::DisplayMode::TrayOnly
        };
    }
    for action in crate::shortcuts::ACTIONS {
        if action.value(&previous).trim() != action.value(&settings).trim()
            && !targets.contains(&action)
        {
            targets.push(action);
        }
    }
    let saved = if targets.is_empty() {
        state.db.save_settings(&settings)?
    } else {
        crate::shortcuts::save(app, &settings, &targets, || {
            state.db.save_settings(&settings)
        })?
    };
    if previous.island_activity != saved.island_activity {
        crate::island::activity_bus::publish(
            app,
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
    if previous.launch_at_login != saved.launch_at_login && !crate::context::acceptance() {
        crate::apply_runtime_settings(app, state, &saved);
    }
    if previous.theme != saved.theme {
        let _ = app.emit("nabbit://theme-preference", &saved.theme);
        crate::settings_window::apply_theme(app, saved.theme);
    }
    if previous.display_mode != saved.display_mode {
        app.state::<std::sync::Arc<crate::modes::Service>>()
            .configure(saved.display_mode);
    }
    let _ = app.emit("nabbit://settings-changed", &saved);
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
pub async fn acknowledge_first_run(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<AppSettings> {
    patch_settings(
        app,
        state,
        serde_json::json!({"firstRunAcknowledged": true}),
    )
    .await
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
