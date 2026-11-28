//! The settings WebView is a normal, independently closable taskbar window.
//! Creation runs off the Windows event thread; acceptance never steals focus.
use crate::{
    db::models::ThemePreference,
    error::{msg, Result},
    AppState,
};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{
    window::{Effect, EffectsBuilder},
    Emitter, Manager, WebviewWindow,
};

pub const LABEL: &str = "settings";
#[derive(Default)]
pub struct Service(Mutex<()>, Mutex<Option<String>>);

pub(crate) fn open_page(app: &tauri::AppHandle, page: &str) -> Result<()> {
    if !matches!(page, "island" | "widgets") {
        return Err(msg("Unknown settings page"));
    }
    *app.state::<Service>()
        .1
        .lock()
        .map_err(|_| msg("Settings are busy"))? = Some(page.into());
    open(app)?;
    app.emit_to(LABEL, "settings:navigate", ())?;
    Ok(())
}
#[tauri::command]
pub fn settings_take_page(app: tauri::AppHandle, window: WebviewWindow) -> Result<Option<String>> {
    if window.label() != LABEL {
        return Err(msg("Only settings can consume its navigation"));
    }
    let service = app.state::<Service>();
    let page = service
        .1
        .lock()
        .map_err(|_| msg("Settings are busy"))?
        .take();
    Ok(page)
}

fn theme(preference: ThemePreference) -> Option<tauri::Theme> {
    match preference {
        ThemePreference::System => None,
        ThemePreference::Light => Some(tauri::Theme::Light),
        ThemePreference::Dark => Some(tauri::Theme::Dark),
    }
}
fn effects(preference: ThemePreference) -> tauri::utils::config::WindowEffectsConfig {
    EffectsBuilder::new()
        .effect(match preference {
            ThemePreference::System => Effect::Mica,
            ThemePreference::Light => Effect::MicaLight,
            ThemePreference::Dark => Effect::MicaDark,
        })
        .build()
}
fn reveal(window: &WebviewWindow) -> Result<()> {
    window.show()?;
    if !crate::island::acceptance_session() {
        window.unminimize()?;
        window.set_focus()?;
    }
    Ok(())
}
pub(crate) fn open(app: &tauri::AppHandle) -> Result<()> {
    let service = app.state::<Service>();
    let _creation = service
        .0
        .lock()
        .map_err(|_| msg("Settings window is busy"))?;
    if let Some(window) = app.get_webview_window(LABEL) {
        return reveal(&window);
    }
    let preference = app.state::<AppState>().db.get_settings()?.theme;
    let window = tauri::WebviewWindowBuilder::new(
        app,
        LABEL,
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("Nabbit settings")
    .inner_size(980.0, 720.0)
    .min_inner_size(820.0, 600.0)
    .resizable(true)
    .decorations(true)
    .always_on_top(false)
    .skip_taskbar(false)
    .transparent(true)
    .theme(theme(preference))
    .effects(effects(preference))
    .focused(false)
    .focusable(!crate::island::acceptance_session())
    .visible(false)
    .center()
    .build()?;
    // Even a failed renderer must leave a normal, closable window. Showing this
    // fallback does not change focus in an owned acceptance session.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(8));
        if !window.is_visible().unwrap_or(true) {
            let _ = reveal(&window);
        }
    });
    Ok(())
}
#[tauri::command]
pub async fn open_settings_window(app: tauri::AppHandle, window: WebviewWindow) -> Result<()> {
    crate::tools::commands::caller(&app, &window)?;
    tauri::async_runtime::spawn_blocking(move || open(&app))
        .await
        .map_err(|e| msg(e.to_string()))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    mica: bool,
}
#[tauri::command]
pub fn settings_window_ready(window: WebviewWindow) -> Result<Appearance> {
    if window.label() != LABEL {
        return Err(msg("Only the settings window can become ready"));
    }
    reveal(&window)?;
    Ok(Appearance {
        mica: has_mica(&window),
    })
}
pub(crate) fn apply_theme(app: &tauri::AppHandle, preference: ThemePreference) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.set_theme(theme(preference));
        let _ = window.set_effects(effects(preference));
    }
}
fn has_mica(window: &WebviewWindow) -> bool {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        use windows_sys::Win32::Graphics::Dwm::DwmGetWindowAttribute;
        let mut backdrop = 0_i32;
        // DWMWA_SYSTEMBACKDROP_TYPE / DWMSBT_MAINWINDOW (Windows 11 22H2+).
        // Windows 11 21H2 uses the legacy Mica attribute. Unsupported Windows
        // retains the solid CSS canvas instead of transparency.
        let result = unsafe {
            DwmGetWindowAttribute(hwnd.0.cast(), 38, (&mut backdrop as *mut i32).cast(), 4)
        };
        if result >= 0 && backdrop == 2 {
            return true;
        }
        let mut legacy = 0_i32;
        let result = unsafe {
            DwmGetWindowAttribute(hwnd.0.cast(), 1029, (&mut legacy as *mut i32).cast(), 4)
        };
        return result >= 0 && legacy != 0;
    }
    let _ = window;
    false
}
