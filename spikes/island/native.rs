//! Throwaway V0 WebView2 spike. Compiled only by the `island-spike` feature on Windows.

use tauri::{
    webview::Color, AppHandle, LogicalSize, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
};

pub fn session_requested() -> bool {
    matches!(
        std::env::var("NABBIT_ISLAND_SPIKE").as_deref(),
        Ok("0" | "1")
    )
}

pub fn open_if_enabled(app: &AppHandle) -> tauri::Result<()> {
    if std::env::var_os("NABBIT_ISLAND_SPIKE").as_deref() != Some(std::ffi::OsStr::new("1")) {
        return Ok(());
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

    // V0.1 is driven over CDP, so the transparent host never blocks real clicks.
    // V0.2 replaces this with the adaptive hit-rectangle protocol.
    window.set_ignore_cursor_events(true)?;
    window.show()?;
    Ok(())
}
