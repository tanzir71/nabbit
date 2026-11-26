//! Throwaway V0 WebView2 spike. Compiled only by the `island-spike` feature on Windows.

use crate::island::capture as native_capture;
use crate::island_interaction::Rect;
use std::sync::{atomic::AtomicBool, Arc};
use tauri::{
    webview::Color, AppHandle, LogicalSize, Manager, PhysicalPosition, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
#[path = "native_files.rs"]
mod native_files;
#[path = "native_fonts.rs"]
mod native_fonts;
#[path = "native_graphics.rs"]
mod native_graphics;
#[path = "native_hybrid.rs"]
pub mod native_hybrid;
#[path = "watcher.rs"]
mod watcher;
use crate::island_native_model::{Instruction, Owner, Surface};
use watcher::{Controller, Presentation, Report};

#[tauri::command]
pub fn island_spike_surface(
    window: WebviewWindow,
    state: Surface,
    hybrid: State<'_, Arc<native_hybrid::Hybrid>>,
) -> Result<(), String> {
    permitted(&window)?;
    hybrid.request(state);
    Ok(())
}
#[tauri::command]
pub fn island_spike_ready(
    window: WebviewWindow,
    hybrid: State<'_, Arc<native_hybrid::Hybrid>>,
) -> Result<Instruction, String> {
    permitted(&window)?;
    Ok(hybrid.instruction())
}
#[tauri::command]
pub fn island_spike_handoff(
    window: WebviewWindow,
    generation: u64,
    owner: Owner,
    hybrid: State<'_, Arc<native_hybrid::Hybrid>>,
) -> Result<(), String> {
    permitted(&window)?;
    hybrid.acknowledge(generation, owner);
    Ok(())
}

fn permitted(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "island-spike"
        && std::env::var("NABBIT_ISLAND_SPIKE").as_deref() == Ok("1")
    {
        Ok(())
    } else {
        Err("The command belongs to the opt-in island spike".into())
    }
}
#[tauri::command]
pub fn island_set_hitrect(
    window: WebviewWindow,
    rect: Rect,
    controller: State<'_, Arc<Controller>>,
) -> Result<Presentation, String> {
    permitted(&window)?;
    let rect = rect.validated().ok_or("Invalid island hit rectangle")?;
    controller
        .model
        .lock()
        .map_err(|_| "Island model unavailable")?
        .hitrect = Some(rect);
    controller.signal.wake();
    Ok(controller.report().presentation)
}
#[tauri::command]
pub fn island_spike_set_drag(
    window: WebviewWindow,
    active: bool,
    controller: State<'_, Arc<Controller>>,
) -> Result<(), String> {
    permitted(&window)?;
    controller
        .model
        .lock()
        .map_err(|_| "Island model unavailable")?
        .ole_drag = active;
    controller.signal.wake();
    Ok(())
}
#[tauri::command]
pub fn island_spike_snapshot(
    window: WebviewWindow,
    refresh: bool,
    controller: State<'_, Arc<Controller>>,
) -> Result<Report, String> {
    permitted(&window)?;
    if std::env::var_os("NABBIT_ACCEPTANCE_CURSOR").is_none() {
        return Err("Acceptance input provider is not enabled".into());
    }
    if refresh {
        controller.refresh();
    }
    Ok(controller.report())
}

pub fn session_requested() -> bool {
    matches!(
        std::env::var("NABBIT_ISLAND_SPIKE").as_deref(),
        Ok("0" | "1")
    )
}

pub fn native_session() -> bool {
    session_requested() && std::env::var("NABBIT_ISLAND_RENDERER").as_deref() != Ok("webview")
}

pub fn open_if_enabled(app: &AppHandle, shutdown: Arc<AtomicBool>) -> tauri::Result<()> {
    if std::env::var_os("NABBIT_ISLAND_SPIKE").as_deref() != Some(std::ffi::OsStr::new("1")) {
        return Ok(());
    }

    let controller = Arc::new(Controller::new());
    app.manage(controller.clone());
    if std::env::var("NABBIT_ISLAND_RENDERER").as_deref() != Ok("webview") {
        return native_hybrid::Hybrid::open(app, controller, shutdown)
            .map_err(|e| tauri::Error::Anyhow(anyhow::anyhow!(e)));
    }
    let window = WebviewWindowBuilder::new(
        app,
        "island-spike",
        WebviewUrl::App("spikes/island/index.html".into()),
    )
    .title("Nabbit Island Spike")
    .inner_size(720.0, 460.0)
    .transparent(true)
    .background_color(Color(0, 0, 0, 0))
    .decorations(false)
    .shadow(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .focusable(false)
    .no_redirection_bitmap(true)
    // Keep HTML5 URL/text drops; resolve DOM File objects through WebView2 below.
    .disable_drag_drop_handler()
    .visible(false)
    .build()?;

    if let Some(monitor) = app.primary_monitor()? {
        let area = monitor.work_area();
        let physical_width = (720.0 * monitor.scale_factor()).round() as i32;
        window.set_position(PhysicalPosition::new(
            area.position.x + (area.size.width as i32 - physical_width) / 2,
            area.position.y,
        ))?;
        window.set_size(LogicalSize::new(720.0, 460.0))?;
    }

    window.set_ignore_cursor_events(true)?;
    native_files::install(&window)?;
    window.show()?;
    let closing = controller.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            closing.close();
        }
    });
    watcher::spawn(window, controller, shutdown)?;
    Ok(())
}
