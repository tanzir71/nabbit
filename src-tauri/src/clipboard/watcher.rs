use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use arboard::Clipboard;
use tauri::{AppHandle, Emitter, Manager};

use crate::{capture::clipboard_url, db::Database};

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
                        if let Some(state) = app.try_state::<crate::AppState>() {
                            state.capture.invalidate();
                        }
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
    injected_event(
        app,
        db,
        text,
        current_source_app(),
        should_skip_os_protected_clipboard(),
        last_url_emit,
    );
}
pub(crate) fn injected_event(
    app: &AppHandle,
    db: &Database,
    text: &str,
    source: Option<String>,
    os_protected: bool,
    last_url_emit: &mut Option<(String, Instant)>,
) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.capture.invalidate();
    }
    if os_protected {
        return;
    }
    match ingest(db, text, source) {
        Ok(Some((entry, url))) => {
            let _ = app.emit("clipboard:new", &entry);
            if let Some(url) = url {
                let recently_emitted = last_url_emit.as_ref().is_some_and(|(last, at)| {
                    last == &url && at.elapsed() < Duration::from_secs(20)
                });
                if !recently_emitted {
                    *last_url_emit = Some((url.clone(), Instant::now()));
                    let _ = crate::capture::review(app, &url);
                }
            }
        }
        Ok(None) => {}
        Err(error) => eprintln!("clipboard watcher store error: {error}"),
    }
}

fn ingest(
    db: &Database,
    text: &str,
    source: Option<String>,
) -> crate::error::Result<Option<(crate::db::models::ClipboardEntry, Option<String>)>> {
    let Some(entry) = db.add_clipboard_text(text, source)? else {
        return Ok(None);
    };
    let settings = db.get_settings()?;
    let url = (settings.auto_detect_links && !settings.pause_auto_detect)
        .then(|| clipboard_url(text).ok())
        .flatten();
    Ok(Some((entry, url)))
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

    let excluded = register_format("ExcludeClipboardContentFromMonitorProcessing")
        .is_some_and(|format| is_format_avail(format.get()));
    let permission = |name: &str| {
        let format = register_format(name)?;
        if !is_format_avail(format.get()) {
            return None;
        }
        let mut data = Vec::new();
        raw::get_vec(format.get(), &mut data).ok()?;
        Some(u32::from_ne_bytes(data.get(..4)?.try_into().ok()?))
    };
    protected(
        excluded,
        permission("CanIncludeInClipboardHistory"),
        permission("CanUploadToCloudClipboard"),
    )
}
/// Explicit note/link hotkeys reuse the watcher policy without persisting the
/// clipboard or ever synthesizing keys. Hold the Windows clipboard lock while
/// checking privacy formats and reading the corresponding text.
pub(crate) fn note_hotkey_text(db: &Database) -> Option<String> {
    let source = current_source_app();
    if source
        .as_deref()
        .is_some_and(|s| db.is_excluded_app(s).unwrap_or(true))
    {
        return None;
    }
    #[cfg(windows)]
    let text = {
        use clipboard_win::{is_format_avail, raw, register_format, Clipboard};
        let _clipboard = Clipboard::new().ok()?;
        let excluded = register_format("ExcludeClipboardContentFromMonitorProcessing")
            .is_some_and(|f| is_format_avail(f.get()));
        let permission = |name: &str| {
            let f = register_format(name)?;
            if !is_format_avail(f.get()) {
                return None;
            }
            let mut bytes = Vec::new();
            raw::get_vec(f.get(), &mut bytes).ok()?;
            Some(u32::from_ne_bytes(bytes.get(..4)?.try_into().ok()?))
        };
        if protected(
            excluded,
            permission("CanIncludeInClipboardHistory"),
            permission("CanUploadToCloudClipboard"),
        ) {
            return None;
        }
        if raw::size(clipboard_win::formats::CF_UNICODETEXT)?.get() > 32_770 {
            return None;
        }
        let mut bytes = Vec::new();
        raw::get_string(&mut bytes).ok()?;
        String::from_utf8(bytes).ok()?
    };
    #[cfg(not(windows))]
    let text = Clipboard::new().ok()?.get_text().ok()?;
    let settings = db.get_settings().ok()?;
    if settings.sensitive_heuristics && crate::clipboard::sensitive::looks_sensitive(&text) {
        return None;
    }
    Some(text)
}
#[cfg(any(windows, test))]
fn protected(excluded: bool, history: Option<u32>, cloud: Option<u32>) -> bool {
    excluded || history == Some(0) || cloud == Some(0)
}

#[cfg(not(target_os = "windows"))]
fn should_skip_os_protected_clipboard() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protected_clipboard_flags_are_tested_without_reading_or_overwriting_the_os_clipboard() {
        assert!(protected(true, None, None));
        assert!(protected(false, Some(0), Some(1)));
        assert!(protected(false, Some(1), Some(0)));
        assert!(!protected(false, None, None));
        assert!(!protected(false, Some(1), Some(1)));
    }
    #[test]
    fn intake_applies_exclusions_and_sensitive_filter_before_url_capture() {
        let dir = std::env::temp_dir().join(format!("nabbit-intake-{}", uuid::Uuid::new_v4()));
        let db = Database::open(&dir).unwrap();
        let settings = crate::db::models::AppSettings {
            sensitive_heuristics: true,
            ..Default::default()
        };
        db.save_settings(&settings).unwrap();
        assert!(
            ingest(&db, "https://youtu.be/example", Some("Bitwarden".into()))
                .unwrap()
                .is_none()
        );
        assert!(ingest(
            &db,
            "https://example.com/fixture1234567890alphaBETA!_",
            None
        )
        .unwrap()
        .is_none());
        assert!(db.list_clipboard_entries(None).unwrap().is_empty());
        let (_, url) = ingest(
            &db,
            "Watch https://youtu.be/example",
            Some("Fixture browser".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(url.unwrap(), "https://www.youtube.com/watch?v=example");
        assert!(db.list_downloads().unwrap().is_empty());
    }
    #[test]
    fn disabled_and_paused_detection_store_text_without_staging_or_enqueuing() {
        let db = Database::open(
            &std::env::temp_dir().join(format!("nabbit-intake-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        for paused in [true, false] {
            let mut settings = db.get_settings().unwrap();
            settings.auto_detect_links = paused;
            settings.pause_auto_detect = paused;
            db.save_settings(&settings).unwrap();
            let (_, url) = ingest(&db, "https://youtu.be/example", None)
                .unwrap()
                .unwrap();
            assert!(url.is_none());
            assert!(db.setting_value("staged_url").unwrap().is_none());
            assert!(db.list_downloads().unwrap().is_empty());
        }
    }
}
