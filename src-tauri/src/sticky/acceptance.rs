//! Explicitly opted-in owned-process automation. No real clipboard, profile,
//! keyboard injection, remote server or display-setting mutation is involved.
use super::*;
use serde_json::{json, Value};
use std::path::Path;
fn execute(app: &tauri::AppHandle, request: Value) -> Result<Value> {
    let text = |key| {
        request[key]
            .as_str()
            .ok_or_else(|| msg("Missing acceptance argument"))
    };
    match text("action")? {
        "seed" => {
            let note = app
                .state::<AppState>()
                .db
                .create_note_card(serde_json::from_value(request["draft"].clone())?)?;
            Ok(serde_json::to_value(note)?)
        }
        "open" => Ok(json!(open(
            app,
            text("id")?.into(),
            app.state::<AppState>().db.notes_state()?.scope,
            None,
            false
        )?)),
        "windows" => {
            let mut rows = Vec::new();
            for (label, window) in app.webview_windows() {
                if !label.starts_with("sticky-") {
                    continue;
                }
                let mut row = json!({"label":label,"snapshot":snapshot(app,&window)?,"rect":rectangle(&window)?,"visible":window.is_visible()?,"scale":window.scale_factor()?});
                #[cfg(windows)]
                unsafe {
                    use windows_sys::Win32::UI::WindowsAndMessaging::*;
                    let hwnd = window.hwnd()?.0 as _;
                    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                    let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
                    let mut client = windows_sys::Win32::Foundation::RECT {
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    };
                    let mut outer = windows_sys::Win32::Foundation::RECT {
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    };
                    let mut origin = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
                    if GetClientRect(hwnd, &mut client) == 0
                        || GetWindowRect(hwnd, &mut outer) == 0
                        || windows_sys::Win32::Graphics::Gdi::ClientToScreen(hwnd, &mut origin) == 0
                    {
                        return Err(msg("Owned window geometry probe failed"));
                    }
                    row["clientInsets"] = json!({"left":origin.x-outer.left,"top":origin.y-outer.top,"right":outer.right-origin.x-client.right,"bottom":outer.bottom-origin.y-client.bottom});
                    row["decorated"] = json!(window.is_decorated()?);
                    let mut alpha = 0u8;
                    let mut key = 0u32;
                    let mut flags = 0u32;
                    let alpha_ok =
                        GetLayeredWindowAttributes(hwnd, &mut key, &mut alpha, &mut flags) != 0;
                    row["native"] = json!({"topmost":ex & WS_EX_TOPMOST as isize!=0,"noActivate":ex & WS_EX_NOACTIVATE as isize!=0,"toolWindow":ex & WS_EX_TOOLWINDOW as isize!=0,"windowStyle":style,"extendedStyle":ex,"resizable":style & WS_THICKFRAME as isize!=0,"alphaOk":alpha_ok,"alpha":alpha,"alphaFlags":flags,"foreground":GetForegroundWindow()==hwnd});
                }
                rows.push(row);
            }
            rows.sort_by_key(|r| r["label"].as_str().unwrap_or("").to_string());
            Ok(json!(rows))
        }
        "configure" | "move" | "close" | "abandon" => {
            let window = app
                .get_webview_window(text("label")?)
                .ok_or_else(|| msg("Unknown owned window"))?;
            let v = live(app, &window, None)?;
            match text("action")? {
                "configure" => Ok(json!(sticky_configure(
                    app.clone(),
                    window,
                    Configure {
                        instance: v.binding.instance,
                        pinned: request["pinned"].as_bool(),
                        opacity: request["opacity"].as_u64().map(|n| n as u8),
                        monitor: request["monitor"].as_str().map(str::to_string)
                    }
                )?)),
                "move" => {
                    let rect: Rect = serde_json::from_value(request["rect"].clone())?;
                    window.set_position(tauri::PhysicalPosition::new(rect.x, rect.y))?;
                    window.set_size(tauri::PhysicalSize::new(rect.width, rect.height))?;
                    Ok(json!(true))
                }
                "close" => {
                    sticky_close(
                        app.clone(),
                        window,
                        v.binding.instance,
                        request["discard"].as_bool().unwrap_or(false),
                    )?;
                    Ok(json!(true))
                }
                // Model process destruction without the user explicitly closing
                // a card; the saved opened bit and checkpoint must survive.
                _ => {
                    window.destroy()?;
                    Ok(json!(true))
                }
            }
        }
        "exit" => {
            app.exit(0);
            Ok(json!(true))
        }
        _ => Err(msg("Unknown sticky acceptance action")),
    }
}
pub fn process(app: &tauri::AppHandle, directory: &Path) {
    if !acceptance_enabled() {
        return;
    }
    let input = directory.join("sticky.json");
    if !input.exists() {
        return;
    }
    let result =
        (|| -> Result<Value> { execute(app, serde_json::from_slice(&std::fs::read(&input)?)?) })();
    let _ = std::fs::remove_file(input);
    let value = match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(_) => json!({"ok":false,"error":"Owned sticky acceptance action failed"}),
    };
    if let Ok(bytes) = serde_json::to_vec_pretty(&value) {
        let _ = std::fs::write(directory.join("sticky.done"), bytes);
    }
}
