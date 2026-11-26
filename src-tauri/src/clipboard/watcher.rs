use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use arboard::Clipboard;
use tauri::{AppHandle, Emitter};

use crate::{
    db::{models::DownloadMetadata, Database},
    util::normalize_video_url,
};

pub const WATCH_INTERVAL: Duration = Duration::from_millis(750);

pub fn spawn_clipboard_watcher(app: AppHandle, db: Database, shutdown: Arc<AtomicBool>) {
    spawn_platform_clipboard_watcher(app, db, shutdown);
}

#[cfg(target_os = "windows")]
fn spawn_platform_clipboard_watcher(app: AppHandle, db: Database, shutdown: Arc<AtomicBool>) {
    thread::Builder::new()
        .name("nabbit-clipboard-watcher".into())
        .spawn(move || {
            let Ok(mut monitor) = clipboard_win::Monitor::new() else {
                run_polling_watcher(app, db, shutdown);
                return;
            };
            let monitor_shutdown = monitor.shutdown_channel();
            let shutdown_signal = shutdown.clone();
            thread::Builder::new()
                .name("nabbit-clipboard-shutdown".into())
                .spawn(move || {
                    while !shutdown_signal.load(Ordering::Relaxed) {
                        thread::sleep(WATCH_INTERVAL);
                    }
                    drop(monitor_shutdown);
                })
                .expect("spawn clipboard monitor shutdown");

            let mut clipboard = Clipboard::new().ok();
            let mut last_seen = String::new();
            let mut last_url_emit: Option<(String, Instant)> = None;

            while !shutdown.load(Ordering::Relaxed) {
                match monitor.recv() {
                    Ok(true) => {
                        crate::island::activity_bus::publish(
                            &app,
                            crate::island::activity::ActivityEvent::ClipboardChanged,
                        );
                        if clipboard.is_none() {
                            clipboard = Clipboard::new().ok();
                        }
                        if let Some(board) = clipboard.as_mut() {
                            match board.get_text() {
                                Ok(text) if text != last_seen => {
                                    last_seen = text.clone();
                                    handle_clipboard_text(&app, &db, &text, &mut last_url_emit);
                                }
                                Ok(_) => {}
                                Err(_) => clipboard = None,
                            }
                        }
                    }
                    Ok(false) => break,
                    Err(error) => {
                        eprintln!("clipboard monitor error: {error}");
                        thread::sleep(WATCH_INTERVAL);
                    }
                }
            }
        })
        .expect("spawn clipboard watcher");
}

#[cfg(not(target_os = "windows"))]
fn spawn_platform_clipboard_watcher(app: AppHandle, db: Database, shutdown: Arc<AtomicBool>) {
    thread::Builder::new()
        .name("nabbit-clipboard-watcher".into())
        .spawn(move || run_polling_watcher(app, db, shutdown))
        .expect("spawn clipboard watcher");
}

fn run_polling_watcher(app: AppHandle, db: Database, shutdown: Arc<AtomicBool>) {
    let mut clipboard = Clipboard::new().ok();
    let mut last_seen = String::new();
    let mut last_url_emit: Option<(String, Instant)> = None;

    while !shutdown.load(Ordering::Relaxed) {
        if clipboard.is_none() {
            clipboard = Clipboard::new().ok();
        }

        if let Some(board) = clipboard.as_mut() {
            match board.get_text() {
                Ok(text) if text != last_seen => {
                    crate::island::activity_bus::publish(
                        &app,
                        crate::island::activity::ActivityEvent::ClipboardChanged,
                    );
                    last_seen = text.clone();
                    handle_clipboard_text(&app, &db, &text, &mut last_url_emit);
                }
                Ok(_) => {}
                Err(_) => {}
            }
        }

        thread::sleep(WATCH_INTERVAL);
    }
}

fn handle_clipboard_text(
    app: &AppHandle,
    db: &Database,
    text: &str,
    last_url_emit: &mut Option<(String, Instant)>,
) {
    if should_skip_os_protected_clipboard() {
        return;
    }
    match db.add_clipboard_text(text, current_source_app()) {
        Ok(Some(entry)) => {
            let _ = app.emit("clipboard:new", &entry);
            if let Ok(settings) = db.get_settings() {
                if settings.auto_detect_links && !settings.pause_auto_detect {
                    if let Some(url) = normalize_video_url(text) {
                        let recently_emitted = last_url_emit
                            .as_ref()
                            .map(|(last, at)| {
                                last == &url && at.elapsed() < Duration::from_secs(20)
                            })
                            .unwrap_or(false);
                        if !recently_emitted {
                            *last_url_emit = Some((url.clone(), Instant::now()));
                            let _ = db.set_setting_value("staged_url", &url);
                            let metadata = DownloadMetadata {
                                url: url.clone(),
                                normalized_url: url,
                                title: "YouTube link detected".into(),
                                channel: None,
                                duration: None,
                                thumbnail: None,
                                is_playlist: text.contains("list="),
                                playlist_count: None,
                                extractor: Some("clipboard".into()),
                                qualities: vec![],
                            };
                            crate::island::activity_bus::publish(
                                app,
                                crate::island::activity::ActivityEvent::LinkDetected {
                                    url: metadata.normalized_url.clone(),
                                    title: Some(metadata.title.clone()),
                                    duration: None,
                                    site: "youtube".into(),
                                },
                            );
                            let _ = app.emit("url:detected", metadata);
                        }
                    }
                }
            }
        }
        Ok(None) => {}
        Err(error) => eprintln!("clipboard watcher store error: {error}"),
    }
}

#[cfg(target_os = "windows")]
fn current_source_app() -> Option<String> {
    use sysinfo::{Pid, System};
    let hwnd = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
    if hwnd.is_null() {
        return None;
    }
    let mut pid = 0u32;
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd, &mut pid);
    }
    let system = System::new_all();
    system
        .process(Pid::from_u32(pid))
        .map(|process| process.name().to_string_lossy().to_string())
}

#[cfg(not(target_os = "windows"))]
fn current_source_app() -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn should_skip_os_protected_clipboard() -> bool {
    use clipboard_win::{is_format_avail, raw, register_format, Clipboard};

    let Ok(_clipboard) = Clipboard::new() else {
        return false;
    };

    if register_format("ExcludeClipboardContentFromMonitorProcessing")
        .map(|format| is_format_avail(format.get()))
        .unwrap_or(false)
    {
        return true;
    }

    for name in ["CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"] {
        let Some(format) = register_format(name) else {
            continue;
        };
        if !is_format_avail(format.get()) {
            continue;
        }
        let mut data = Vec::new();
        if raw::get_vec(format.get(), &mut data).is_ok() && data.len() >= 4 {
            let value = u32::from_ne_bytes([data[0], data[1], data[2], data[3]]);
            if value == 0 {
                return true;
            }
        }
    }

    false
}

#[cfg(not(target_os = "windows"))]
fn should_skip_os_protected_clipboard() -> bool {
    false
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::should_skip_os_protected_clipboard;

    #[test]
    fn windows_clipboard_monitor_receives_updates() {
        use clipboard_win::{set_clipboard_string, Monitor};
        use std::{thread, time::Duration};

        let mut monitor = Monitor::new().expect("create monitor");
        let marker = format!("nabbit monitor {}", uuid::Uuid::new_v4());
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            set_clipboard_string(&marker).expect("set clipboard text");
        });

        assert!(monitor.recv().expect("receive clipboard update"));
    }

    #[test]
    fn detects_windows_clipboard_monitor_exclusion_format() {
        use clipboard_win::{raw, register_format, Clipboard};

        let _clipboard = Clipboard::new().expect("open clipboard");
        raw::empty().expect("empty clipboard");
        raw::set_string("concealed sample").expect("set clipboard text");
        let format = register_format("ExcludeClipboardContentFromMonitorProcessing")
            .expect("register exclusion format");
        raw::set_without_clear(format.get(), &0u32.to_ne_bytes()).expect("set exclusion format");

        assert!(should_skip_os_protected_clipboard());
    }
}
