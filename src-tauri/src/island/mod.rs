#[cfg_attr(not(windows), allow(dead_code))]
pub mod artwork;
#[cfg(windows)]
mod assets;
#[cfg(windows)]
#[path = "../../../spikes/island/native_capture.rs"]
pub(crate) mod capture;
#[cfg(windows)]
mod compact_draw;
#[cfg(windows)]
#[path = "../../../spikes/island/native_files.rs"]
pub(crate) mod files;
#[cfg(windows)]
#[path = "../../../spikes/island/native_fonts.rs"]
pub(crate) mod fonts;
#[cfg(windows)]
mod foreground;
#[cfg_attr(not(windows), allow(dead_code))]
pub mod input;
#[cfg(windows)]
mod input_watcher;
#[cfg_attr(not(windows), allow(dead_code))]
pub mod keyboard;
#[cfg_attr(not(windows), allow(dead_code))]
pub mod model;
#[cfg_attr(not(windows), allow(dead_code))]
pub mod motion;
#[cfg(windows)]
mod native;
#[cfg_attr(not(windows), allow(dead_code))]
pub mod presentation;
#[cfg(windows)]
mod renderer;
#[cfg_attr(not(windows), allow(dead_code))]
pub mod surface;
#[cfg_attr(not(windows), allow(dead_code))]
pub mod visibility;

#[cfg(windows)]
pub use native::{start, Manager};

#[tauri::command]
pub fn island_set_hitrect(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    rect: crate::island_interaction::Rect,
) -> Result<(), String> {
    let rect = rect.validated().ok_or("Invalid island hit rectangle")?;
    #[cfg(windows)]
    {
        let manager = input_manager(&app)?;
        if !current_input_window(&app, &window, &manager)? {
            return Ok(());
        }
        manager.set_hitrect(window.label(), Some(rect))
    }
    #[cfg(not(windows))]
    {
        let _ = (app, window, rect);
        Err("Island input is available on Windows".into())
    }
}
#[tauri::command]
pub fn island_clear_hitrect(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let manager = input_manager(&app)?;
        if !current_input_window(&app, &window, &manager)? {
            return Ok(());
        }
        manager.set_hitrect(window.label(), None)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, window);
        Err("Island input is available on Windows".into())
    }
}
#[tauri::command]
pub fn island_set_drag(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    active: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let manager = input_manager(&app)?;
        if !current_input_window(&app, &window, &manager)? {
            return Ok(());
        }
        manager.set_drag(window.label(), active)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, window, active);
        Err("Island input is available on Windows".into())
    }
}
#[tauri::command]
pub fn island_wake(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    return input_manager(&app)?.wake_island(window.label());
    #[cfg(not(windows))]
    {
        let _ = (app, window);
        Err("Island visibility is available on Windows".into())
    }
}
#[tauri::command]
pub fn island_toggle_keyboard(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    trigger: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let manager = input_manager(&app)?;
        let _ = manager.surface_instruction(window.label())?;
        crate::dispatch_island_shortcut(&app, trigger.as_deref())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, window, trigger);
        Err("Island keyboard is available on Windows".into())
    }
}
#[tauri::command]
pub fn island_keyboard_focus(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    target: keyboard::Target,
) -> Result<(), String> {
    #[cfg(windows)]
    return input_manager(&app)?.request_keyboard_focus(window.label(), target);
    #[cfg(not(windows))]
    {
        let _ = (app, window, target);
        Err("Island keyboard is available on Windows".into())
    }
}
#[tauri::command]
pub fn island_keyboard_ready(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: u64,
) -> Result<(), String> {
    #[cfg(windows)]
    return input_manager(&app)?.keyboard_ready(window.label(), request);
    #[cfg(not(windows))]
    {
        let _ = (app, window, request);
        Ok(())
    }
}
#[cfg(windows)]
fn current_input_window(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    manager: &Manager,
) -> Result<bool, String> {
    use tauri::Manager as _;
    if !manager.has_label(window.label()) {
        return Err("Only an active island surface can update input".into());
    }
    // Teardown IPC from a destroyed view must not mutate its replacement,
    // even though both views use the same stable monitor label.
    Ok(app
        .get_webview_window(window.label())
        .and_then(|active| active.hwnd().ok())
        .zip(window.hwnd().ok())
        .is_some_and(|(active, caller)| active == caller))
}
#[cfg(windows)]
fn input_manager(app: &tauri::AppHandle) -> Result<std::sync::Arc<Manager>, String> {
    use tauri::Manager;
    app.try_state::<std::sync::Arc<native::Manager>>()
        .map(|value| value.inner().clone())
        .ok_or("Island manager is unavailable".into())
}

pub fn acceptance_session() -> bool {
    std::env::var("NABBIT_ISLAND_ACCEPTANCE").as_deref() == Ok("1")
        && std::env::var_os("NABBIT_APP_DATA_DIR").is_some()
}
#[tauri::command]
pub fn island_open_settings(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let manager = input_manager(&app)?;
        let _ = manager.surface_instruction(window.label())?;
        manager.settings_intent(true);
    }
    #[cfg(not(windows))]
    let _ = window;
    crate::show_popover(&app).map_err(|e| e.to_string())?;
    use tauri::Emitter;
    app.emit("nabbit://open-settings", ())
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn consume_island_settings_intent(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("Only the tray can consume its navigation intent".into());
    }
    #[cfg(windows)]
    {
        use tauri::Manager as _;
        Ok(app
            .try_state::<std::sync::Arc<native::Manager>>()
            .is_some_and(|manager| manager.settings_intent(false)))
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(false)
    }
}

#[tauri::command]
pub fn get_island_surface(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    return serde_json::to_value(input_manager(&app)?.surface_instruction(window.label())?)
        .map_err(|e| e.to_string());
    #[cfg(not(windows))]
    {
        let _ = (app, window);
        Err("Island surfaces are available on Windows".into())
    }
}
#[tauri::command]
pub fn island_surface_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: surface::Mode,
) -> Result<(), String> {
    #[cfg(windows)]
    return input_manager(&app)?.request_surface(window.label(), state);
    #[cfg(not(windows))]
    {
        let _ = (app, window, state);
        Err("Island surfaces are available on Windows".into())
    }
}
#[tauri::command]
pub fn island_surface_ack(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    generation: u64,
) -> Result<(), String> {
    #[cfg(windows)]
    return input_manager(&app)?.surface_ack(window.label(), generation);
    #[cfg(not(windows))]
    {
        let _ = (app, window, generation);
        Err("Island surfaces are available on Windows".into())
    }
}
#[tauri::command]
pub fn island_stage_drop(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    payload: serde_json::Value,
    zone: String,
) -> Result<(), String> {
    #[cfg(windows)]
    return input_manager(&app)?.stage_drop(window.label(), payload, &zone);
    #[cfg(not(windows))]
    {
        let _ = (app, window, payload, zone);
        Err("Island surfaces are available on Windows".into())
    }
}
#[tauri::command]
pub fn get_island_drop(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<serde_json::Value>, String> {
    #[cfg(windows)]
    return Ok(input_manager(&app)?.drop_draft(window.label()));
    #[cfg(not(windows))]
    {
        let _ = (app, window);
        Ok(None)
    }
}
#[tauri::command]
pub fn island_review_url(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    url: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = input_manager(&app)?.surface_instruction(window.label())?;
    }
    #[cfg(not(windows))]
    let _ = window;
    let parsed = url::Url::parse(url.trim()).map_err(|_| "Enter a valid web link")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Enter an http or https link".into());
    }
    state
        .db
        .set_setting_value("staged_url", parsed.as_str())
        .map_err(|e| e.to_string())?;
    activity_bus::publish(
        &app,
        activity::ActivityEvent::LinkDetected {
            url: parsed.to_string(),
            title: None,
            duration: None,
            site: parsed.host_str().unwrap_or_default().into(),
        },
    );
    Ok(())
}

#[cfg(windows)]
pub fn production_session() -> bool {
    #[cfg(all(windows, feature = "island-spike"))]
    if crate::island_spike::session_requested() {
        return false;
    }
    // Legacy acceptance scripts keep their existing tray-only process shape.
    cfg!(windows)
        && (std::env::var_os("NABBIT_ACCEPTANCE_COMMAND_DIR").is_none() || acceptance_session())
}
pub mod activity;
pub mod activity_bus;
#[cfg(test)]
mod activity_tests;
#[cfg(test)]
mod presentation_tests;
