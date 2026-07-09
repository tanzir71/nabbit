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
    thread::Builder::new()
        .name("nabbit-clipboard-watcher".into())
        .spawn(move || {
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
                            last_seen = text.clone();
                            match db.add_clipboard_text(&text, current_source_app()) {
                                Ok(Some(entry)) => {
                                    let _ = app.emit("clipboard:new", &entry);
                                    if let Ok(settings) = db.get_settings() {
                                        if settings.auto_detect_links && !settings.pause_auto_detect
                                        {
                                            if let Some(url) = normalize_video_url(&text) {
                                                let recently_emitted = last_url_emit
                                                    .as_ref()
                                                    .map(|(last, at)| {
                                                        last == &url
                                                            && at.elapsed()
                                                                < Duration::from_secs(20)
                                                    })
                                                    .unwrap_or(false);
                                                if !recently_emitted {
                                                    last_url_emit =
                                                        Some((url.clone(), Instant::now()));
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
                                                    };
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
                        Ok(_) => {}
                        Err(_) => {}
                    }
                }

                thread::sleep(WATCH_INTERVAL);
            }
        })
        .expect("spawn clipboard watcher");
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
