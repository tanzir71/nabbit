#[cfg(windows)]
#[path = "../../../spikes/island/native_capture.rs"]
pub(crate) mod capture;
#[cfg_attr(not(windows), allow(dead_code))]
pub mod input;
#[cfg(windows)]
mod input_watcher;
#[cfg_attr(not(windows), allow(dead_code))]
pub mod model;
#[cfg(windows)]
mod native;
#[cfg(windows)]
mod renderer;

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
    return input_manager(&app)?.set_hitrect(window.label(), Some(rect));
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
    return input_manager(&app)?.set_hitrect(window.label(), None);
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
    return input_manager(&app)?.set_drag(window.label(), active);
    #[cfg(not(windows))]
    {
        let _ = (app, window, active);
        Err("Island input is available on Windows".into())
    }
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
