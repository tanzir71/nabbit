//! Resolve dropped DOM File objects natively without replacing WebView2's HTML5 target.
//! https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/icorewebview2file
use serde::Deserialize;
use tauri::{Emitter, WebviewWindow};
use webview2_com::{
    take_pwstr, Microsoft::Web::WebView2::Win32::*, WebMessageReceivedEventHandler,
};
use windows::core::{Interface, PWSTR};

#[derive(Deserialize)]
struct Message {
    nabbit_file_drop: bool,
    x: f64,
    y: f64,
    scale: f64,
}

pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    let target = window.clone();
    window.with_webview(move |platform| unsafe {
        let result = (|| -> windows::core::Result<()> {
            let webview = platform.controller().CoreWebView2()?;
            let mut token = 0;
            webview.add_WebMessageReceived(
                &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut raw = PWSTR::null();
                    // Wry's existing IPC listener also expects string messages.
                    args.TryGetWebMessageAsString(&mut raw)?;
                    let Ok(message) = serde_json::from_str::<Message>(&take_pwstr(raw)) else {
                        return Ok(());
                    };
                    if !message.nabbit_file_drop
                        || !message.x.is_finite()
                        || !message.y.is_finite()
                        || !message.scale.is_finite()
                        || !(0.75..=4.0).contains(&message.scale)
                        || !(0.0..=720.0).contains(&message.x)
                        || !(0.0..=460.0).contains(&message.y)
                    {
                        return Ok(());
                    }
                    let mut source = PWSTR::null();
                    args.Source(&mut source)?;
                    let source = take_pwstr(source);
                    if target.url().ok().as_ref().map(|url| url.as_str()) != Some(source.as_str()) {
                        return Ok(());
                    }
                    let objects = args
                        .cast::<ICoreWebView2WebMessageReceivedEventArgs2>()?
                        .AdditionalObjects()?;
                    let mut count = 0;
                    objects.Count(&mut count)?;
                    let mut paths = Vec::new();
                    for index in 0..count {
                        let file = objects
                            .GetValueAtIndex(index)?
                            .cast::<ICoreWebView2File>()?;
                        let mut path = PWSTR::null();
                        file.Path(&mut path)?;
                        let path = take_pwstr(path);
                        if !path.is_empty() {
                            paths.push(path);
                        }
                    }
                    // Empty paths also finish the drag and show the unsupported receipt.
                    // onDragDropEvent consumes the standard native file-drop shape.
                    let _ = target.emit(
                        "tauri://drag-drop",
                        serde_json::json!({
                            "paths": paths,
                            "position": { "x": message.x * message.scale, "y": message.y * message.scale }
                        }),
                    );
                    Ok(())
                })),
                &mut token,
            )?;
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("Island native file bridge unavailable: {error}");
        }
    })
}
