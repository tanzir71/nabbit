//! One scoped card per native window, with independent profiles for each monitor.
pub mod acceptance;
pub mod geometry;
pub mod store;
#[cfg(test)]
mod tests;
use crate::{
    error::{msg, Result},
    island::model::{Monitor, Rect},
    notes::{capture::CaptureRequest, store::StoredNote, sync_store::Context},
    AppState,
};
use geometry::{choose, scale, Profile};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex};
use tauri::{Emitter, Manager, WebviewWindow};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub instance: String,
    pub card_id: String,
    pub scope: Option<Context>,
}
#[derive(Clone)]
struct Live {
    binding: Binding,
    profile: Profile,
    placing: bool,
    fresh: bool,
    focus: bool,
    built: bool,
    pending_ready: Option<f64>,
}
#[derive(Default)]
pub struct Service {
    windows: Mutex<HashMap<String, Live>>,
    opening: Mutex<()>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub binding: Binding,
    pub profile: Profile,
    pub content: store::Content,
    pub monitors: Vec<Monitor>,
    pub native_opacity: bool,
    pub theme: crate::db::models::ThemePreference,
}
fn label(scope: Option<&Context>, card: &str) -> String {
    format!(
        "sticky-{:x}",
        Sha256::digest(format!("{}\0{card}", store::scope_key(scope)).as_bytes())
    )
}
fn lock<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    m.lock()
        .map_err(|_| msg("Sticky window lock is unavailable"))
}
fn live(app: &tauri::AppHandle, window: &WebviewWindow, instance: Option<&str>) -> Result<Live> {
    let service = app.state::<Service>();
    let value = lock(&service.windows)?
        .get(window.label())
        .cloned()
        .ok_or_else(|| msg("This sticky window is no longer bound"))?;
    if instance.is_some_and(|id| id != value.binding.instance) {
        return Err(msg("This reply belongs to an older sticky window"));
    }
    Ok(value)
}
pub fn monitors(app: &tauri::AppHandle) -> Result<Vec<Monitor>> {
    #[cfg(windows)]
    {
        let _ = app;
        Ok(crate::island::real_desktop().monitors)
    }
    #[cfg(not(windows))]
    {
        let primary = app.primary_monitor()?;
        Ok(app
            .available_monitors()?
            .into_iter()
            .map(|m| {
                let r = m.work_area();
                let bounds = Rect {
                    x: m.position().x,
                    y: m.position().y,
                    width: m.size().width,
                    height: m.size().height,
                };
                Monitor {
                    id: format!(
                        "{:x}",
                        Sha256::digest(m.name().map_or("monitor", String::as_str).as_bytes())
                    ),
                    name: m.name().cloned().unwrap_or_else(|| "Monitor".into()),
                    primary: primary
                        .as_ref()
                        .is_some_and(|p| p.position() == m.position()),
                    bounds,
                    work_area: Rect {
                        x: r.position.x,
                        y: r.position.y,
                        width: r.size.width,
                        height: r.size.height,
                    },
                    scale_factor: m.scale_factor(),
                }
            })
            .collect())
    }
}
fn rectangle(window: &WebviewWindow) -> Result<Rect> {
    let p = window.outer_position()?;
    let s = window.inner_size()?;
    Ok(Rect {
        x: p.x,
        y: p.y,
        width: s.width,
        height: s.height,
    })
}
fn apply(window: &WebviewWindow, profile: &Profile, monitor: &Monitor) -> Result<()> {
    let rect = profile.physical(monitor);
    window.set_position(tauri::PhysicalPosition::new(rect.x, rect.y))?;
    window.set_min_size(Some(tauri::LogicalSize::new(220., 120.)))?;
    window.set_max_size(Some(tauri::LogicalSize::new(
        480.,
        (f64::from(monitor.work_area.height) / scale(monitor)).max(120.),
    )))?;
    window.set_size(tauri::PhysicalSize::new(rect.width, rect.height))?;
    window.set_always_on_top(profile.pinned)?;
    opacity(window, profile.opacity)
}
#[cfg(windows)]
fn opacity(window: &WebviewWindow, value: u8) -> Result<()> {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    unsafe {
        let hwnd = window.hwnd()?.0 as _;
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let target = ((u16::from(value) * 255 + 50) / 100) as u8;
        let (mut key, mut alpha, mut flags) = (0, 0, 0);
        if style & WS_EX_LAYERED as isize != 0
            && GetLayeredWindowAttributes(hwnd, &mut key, &mut alpha, &mut flags) != 0
            && alpha == target
            && flags & LWA_ALPHA != 0
        {
            return Ok(());
        }
        if style & WS_EX_LAYERED as isize == 0 {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED as isize);
        }
        if SetLayeredWindowAttributes(hwnd, 0, target, LWA_ALPHA) == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    Ok(())
}
#[cfg(not(windows))]
fn opacity(_: &WebviewWindow, _: u8) -> Result<()> {
    Ok(())
}
pub fn open(
    app: &tauri::AppHandle,
    card_id: String,
    scope: Option<Context>,
    origin: Option<Rect>,
    restoring: bool,
) -> Result<String> {
    let service = app.state::<Service>();
    let _opening = lock(&service.opening)?;
    let db = &app.state::<AppState>().db;
    let name = label(scope.as_ref(), &card_id);
    if let Some(window) = app.get_webview_window(&name) {
        reconcile(app, &window)?;
        window.show()?;
        let value = live(app, &window, None)?;
        opacity(&window, value.profile.opacity)?;
        if !restoring && !acceptance_enabled() {
            window.set_focus()?;
        }
        return Ok(name);
    }
    let current = db.notes_state()?.scope;
    if current != scope {
        return Err(msg(
            "Workspace changed. Your note stays in its original workspace.",
        ));
    }
    let cached = db
        .sticky_saved(scope.as_ref(), false)?
        .into_iter()
        .find(|s| s.card_id == card_id);
    let note = db
        .note_editor(&card_id, scope.as_ref())
        .map(|s| s.note)
        .or_else(|error| {
            if restoring {
                cached.as_ref().map(|s| s.last_note.clone()).ok_or(error)
            } else {
                Err(error)
            }
        })?;
    let monitors = monitors(app)?;
    let monitor = choose(
        &monitors,
        cached.as_ref().map(|s| s.monitor.as_str()),
        origin,
    )
    .ok_or_else(|| msg("No display is available for this note"))?;
    let saved = db.sticky_profile(scope.as_ref(), &card_id, &monitor.id)?;
    let profile = saved
        .clone()
        .unwrap_or_else(|| Profile::new(monitor))
        .clamped(monitor);
    let binding = Binding {
        instance: uuid::Uuid::new_v4().to_string(),
        card_id,
        scope,
    };
    lock(&service.windows)?.insert(
        name.clone(),
        Live {
            binding: binding.clone(),
            profile: profile.clone(),
            placing: true,
            fresh: saved.is_none(),
            focus: !restoring && !acceptance_enabled(),
            built: false,
            pending_ready: None,
        },
    );
    let rect = profile.physical(monitor);
    let result = (|| -> Result<()> {
        db.sticky_remember(&binding, &profile, true, Some(&note))?;
        let window = tauri::WebviewWindowBuilder::new(
            app,
            &name,
            tauri::WebviewUrl::App("sticky.html".into()),
        )
        .title("Nabbit — Sticky note")
        .inner_size(profile.width, profile.height)
        .position(
            f64::from(rect.x) / scale(monitor),
            f64::from(rect.y) / scale(monitor),
        )
        .min_inner_size(220., 120.)
        .max_inner_size(
            480.,
            (f64::from(monitor.work_area.height) / scale(monitor)).max(120.),
        )
        .decorations(false)
        .resizable(true)
        .transparent(true)
        .shadow(true)
        .always_on_top(profile.pinned)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()?;
        apply(&window, &profile, monitor)?;
        let pending = {
            let mut windows = lock(&service.windows)?;
            let v = windows
                .get_mut(&name)
                .ok_or_else(|| msg("Sticky window was closed during creation"))?;
            v.built = true;
            v.pending_ready.take()
        };
        if let Some(height) = pending {
            sticky_ready(
                app.clone(),
                window.clone(),
                binding.instance.clone(),
                height,
            )?;
        }
        // A failed frontend load must remain visible and closable. Never focus
        // a restored or acceptance window as part of this recovery path.
        let fallback = window.clone();
        let fallback_opacity = profile.opacity;
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(8));
            if !fallback.is_visible().unwrap_or(true) {
                let _ = fallback.show();
                let _ = opacity(&fallback, fallback_opacity);
            }
        });
        Ok(())
    })();
    if result.is_err() {
        let _ = db.sticky_remember(&binding, &profile, false, None);
        lock(&service.windows)?.remove(&name);
        if let Some(window) = app.get_webview_window(&name) {
            let _ = window.destroy();
        }
    }
    result?;
    Ok(name)
}
pub fn restore(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| -> Result<()> {
            let scope = app.state::<AppState>().db.notes_state()?.scope;
            let saved = app
                .state::<AppState>()
                .db
                .sticky_saved(scope.as_ref(), true)?;
            for row in saved {
                if open(&app, row.card_id, scope.clone(), None, true).is_err() {
                    eprintln!("A sticky note could not be restored; its draft and placement remain saved.");
                }
            }
            Ok(())
        })();
        if result.is_err() {
            eprintln!("Sticky window restoration is unavailable.");
        }
    });
}
pub fn reconcile(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<()> {
    let old = live(app, window, None)?;
    let monitors = monitors(app)?;
    let chosen = choose(
        &monitors,
        Some(&old.profile.monitor),
        rectangle(window).ok(),
    )
    .ok_or_else(|| msg("No display is available"))?;
    let next = old.profile.clone().clamped(chosen);
    let service = app.state::<Service>();
    {
        if let Some(v) = lock(&service.windows)?.get_mut(window.label()) {
            v.placing = true;
        }
    }
    let result = apply(window, &next, chosen);
    {
        if let Some(v) = lock(&service.windows)?.get_mut(window.label()) {
            v.placing = false;
            if result.is_ok() {
                v.profile = next.clone();
            }
        }
    }
    result?;
    app.state::<AppState>()
        .db
        .sticky_remember(&old.binding, &next, true, None)?;
    window.emit("sticky:profile", &next)?;
    Ok(())
}
pub fn event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle();
    let Some(service) = app.try_state::<Service>() else {
        return;
    };
    let value = lock(&service.windows)
        .ok()
        .and_then(|m| m.get(window.label()).cloned());
    let Some(value) = value else {
        return;
    };
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.emit("sticky:close-requested", ());
        }
        tauri::WindowEvent::Destroyed => {
            if app.get_webview_window(window.label()).is_none() {
                if let Ok(mut m) = service.windows.lock() {
                    m.remove(window.label());
                }
            }
        }
        tauri::WindowEvent::Moved(_)
        | tauri::WindowEvent::Resized(_)
        | tauri::WindowEvent::ScaleFactorChanged { .. }
        | tauri::WindowEvent::Focused(_) => {
            if value.placing {
                return;
            }
            let Some(web) = app.get_webview_window(window.label()) else {
                return;
            };
            let result = (|| -> Result<()> {
                opacity(&web, value.profile.opacity)?;
                let rect = rectangle(&web)?;
                let monitors = monitors(app)?;
                let monitor = choose(&monitors, None, Some(rect))
                    .ok_or_else(|| msg("No display is available"))?;
                let profile = value.profile.observed(monitor, rect);
                if profile != value.profile {
                    app.state::<AppState>().db.sticky_remember(
                        &value.binding,
                        &profile,
                        true,
                        None,
                    )?;
                    if let Some(v) = lock(&service.windows)?.get_mut(window.label()) {
                        v.profile = profile.clone();
                    }
                    web.emit("sticky:profile", profile)?;
                }
                Ok(())
            })();
            if result.is_err() {
                let _ = web.emit("sticky:placement-error", ());
            }
        }
        _ => {}
    }
}
fn snapshot(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<Snapshot> {
    let value = live(app, window, None)?;
    Ok(Snapshot {
        content: app.state::<AppState>().db.sticky_content(&value.binding)?,
        binding: value.binding,
        profile: value.profile,
        monitors: monitors(app)?,
        native_opacity: cfg!(windows),
        theme: app.state::<AppState>().db.get_settings()?.theme,
    })
}
#[tauri::command]
pub async fn open_sticky(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: String,
    expected_scope: Option<Context>,
) -> Result<String> {
    let origin = rectangle(&window).ok();
    tauri::async_runtime::spawn_blocking(move || open(&app, id, expected_scope, origin, false))
        .await
        .map_err(|e| msg(e.to_string()))?
}
#[tauri::command]
pub fn sticky_snapshot(app: tauri::AppHandle, window: WebviewWindow) -> Result<Snapshot> {
    snapshot(&app, &window)
}
#[tauri::command]
pub fn sticky_ready(
    app: tauri::AppHandle,
    window: WebviewWindow,
    instance: String,
    height: f64,
) -> Result<()> {
    let value = live(&app, &window, Some(&instance))?;
    if !height.is_finite() {
        return Err(msg("Invalid sticky size"));
    }
    if !value.built {
        if let Some(v) = lock(&app.state::<Service>().windows)?.get_mut(window.label()) {
            v.pending_ready = Some(height);
        }
        return Ok(());
    }
    let monitors = monitors(&app)?;
    let monitor = choose(&monitors, Some(&value.profile.monitor), None)
        .ok_or_else(|| msg("No display is available"))?;
    let mut profile = value.profile.clone();
    if value.fresh {
        profile.height = height;
        profile = profile.clamped(monitor);
    }
    apply(&window, &profile, monitor)?;
    app.state::<AppState>()
        .db
        .sticky_remember(&value.binding, &profile, true, None)?;
    if let Some(v) = lock(&app.state::<Service>().windows)?.get_mut(window.label()) {
        v.profile = profile;
        v.placing = false;
        v.fresh = false;
    }
    window.show()?;
    // Tao's first show reapplies cached extended styles, including clearing
    // WS_EX_LAYERED. Set native alpha after that visibility transition.
    opacity(&window, value.profile.opacity)?;
    if value.focus {
        window.set_focus()?;
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configure {
    pub instance: String,
    pub pinned: Option<bool>,
    pub opacity: Option<u8>,
    pub monitor: Option<String>,
}
#[tauri::command]
pub fn sticky_configure(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request: Configure,
) -> Result<Profile> {
    let old = live(&app, &window, Some(&request.instance))?;
    let monitors = monitors(&app)?;
    let monitor = choose(
        &monitors,
        request.monitor.as_deref().or(Some(&old.profile.monitor)),
        None,
    )
    .ok_or_else(|| msg("No display is available"))?;
    if request.monitor.as_ref().is_some_and(|id| id != &monitor.id) {
        return Err(msg("This display is no longer available"));
    }
    let db = &app.state::<AppState>().db;
    let mut next = if monitor.id != old.profile.monitor {
        db.sticky_profile(
            old.binding.scope.as_ref(),
            &old.binding.card_id,
            &monitor.id,
        )?
        .unwrap_or_else(|| Profile::new(monitor))
    } else {
        old.profile.clone()
    };
    if let Some(pinned) = request.pinned {
        next.pinned = pinned;
    }
    if let Some(opacity) = request.opacity {
        next.opacity = opacity;
    }
    if !next.valid() {
        return Err(msg("Opacity must be between 60% and 100%"));
    }
    next = next.clamped(monitor);
    {
        if let Some(v) = lock(&app.state::<Service>().windows)?.get_mut(window.label()) {
            v.placing = true;
        }
    }
    let result = (|| -> Result<()> {
        if next.monitor != old.profile.monitor {
            apply(&window, &next, monitor)?;
        } else {
            window.set_always_on_top(next.pinned)?;
            opacity(&window, next.opacity)?;
        }
        db.sticky_remember(&old.binding, &next, true, None)?;
        Ok(())
    })();
    if result.is_err() {
        if let Some(old_monitor) = choose(&monitors, Some(&old.profile.monitor), None) {
            let _ = apply(&window, &old.profile, old_monitor);
        }
    }
    {
        if let Some(v) = lock(&app.state::<Service>().windows)?.get_mut(window.label()) {
            v.placing = false;
            if result.is_ok() {
                v.profile = next.clone();
            }
        }
    }
    result?;
    window.emit("sticky:profile", &next)?;
    Ok(next)
}
#[tauri::command]
pub fn sticky_drag(app: tauri::AppHandle, window: WebviewWindow) -> Result<()> {
    live(&app, &window, None)?;
    window.start_dragging()?;
    Ok(())
}
#[tauri::command]
pub fn sticky_checkpoint(
    app: tauri::AppHandle,
    window: WebviewWindow,
    instance: String,
    sequence: u64,
    draft: store::Draft,
) -> Result<()> {
    let v = live(&app, &window, Some(&instance))?;
    app.state::<AppState>()
        .db
        .sticky_checkpoint(&v.binding, sequence, draft)
}
#[tauri::command]
pub fn sticky_clear_checkpoint(
    app: tauri::AppHandle,
    window: WebviewWindow,
    instance: String,
    sequence: u64,
) -> Result<()> {
    let v = live(&app, &window, Some(&instance))?;
    app.state::<AppState>()
        .db
        .sticky_clear_checkpoint(&v.binding, sequence)
}
#[tauri::command]
pub fn sticky_save(
    app: tauri::AppHandle,
    window: WebviewWindow,
    instance: String,
    sequence: u64,
    base: StoredNote,
    patch: Value,
) -> Result<StoredNote> {
    let v = live(&app, &window, Some(&instance))?;
    let db = &app.state::<AppState>().db;
    let saved = db.sticky_save_bound(&v.binding, base, patch)?;
    crate::commands::notes::publish(&app);
    let _ = db.sticky_clear_checkpoint(&v.binding, sequence);
    Ok(saved)
}
#[tauri::command]
pub fn sticky_reload(
    app: tauri::AppHandle,
    window: WebviewWindow,
    instance: String,
) -> Result<Snapshot> {
    let v = live(&app, &window, Some(&instance))?;
    let current = app.state::<AppState>().db.notes_state()?.scope;
    if store::scope_key(current.as_ref()) != store::scope_key(v.binding.scope.as_ref()) {
        return Err(msg(
            "Return to this note's original workspace before reloading",
        ));
    }
    app.state::<AppState>()
        .db
        .note_editor(&v.binding.card_id, current.as_ref())?;
    app.state::<AppState>()
        .db
        .sticky_discard_checkpoint(&v.binding)?;
    if let Some(value) = lock(&app.state::<Service>().windows)?.get_mut(window.label()) {
        value.binding.scope = current;
    }
    snapshot(&app, &window)
}
#[tauri::command]
pub fn sticky_leave(app: tauri::AppHandle, window: WebviewWindow) -> Result<()> {
    // The frontend may fail before learning its instance. Permit the bound
    // caller to close without ever discarding the durable recovery journal.
    let v = live(&app, &window, None)?;
    sticky_close(app, window, v.binding.instance, false)
}
#[tauri::command]
pub fn sticky_close(
    app: tauri::AppHandle,
    window: WebviewWindow,
    instance: String,
    discard: bool,
) -> Result<()> {
    let v = live(&app, &window, Some(&instance))?;
    if discard {
        app.state::<AppState>()
            .db
            .sticky_discard_checkpoint(&v.binding)?;
    }
    app.state::<AppState>()
        .db
        .sticky_remember(&v.binding, &v.profile, false, None)?;
    window.destroy()?;
    Ok(())
}
#[tauri::command]
pub async fn sticky_save_as_new(
    app: tauri::AppHandle,
    window: WebviewWindow,
    instance: String,
    request: CaptureRequest,
) -> Result<String> {
    live(&app, &window, Some(&instance))?;
    tauri::async_runtime::spawn_blocking(move || {
        let saved = app.state::<AppState>().db.capture_note(request)?;
        crate::commands::notes::publish(&app);
        let id = saved.value["id"]
            .as_str()
            .ok_or_else(|| msg("Invalid saved note"))?
            .to_string();
        open(&app, id, saved.scope, rectangle(&window).ok(), false)
    })
    .await
    .map_err(|e| msg(e.to_string()))?
}
pub fn acceptance_enabled() -> bool {
    std::env::var("NABBIT_STICKY_ACCEPTANCE").as_deref() == Ok("1")
        && std::env::var_os("NABBIT_APP_DATA_DIR").is_some()
        && std::env::var_os("NABBIT_ACCEPTANCE_COMMAND_DIR").is_some()
}
