use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(not(windows))]
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
                eprintln!("Clipboard event listener is unavailable; capture is stopped.");
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
                        crate::context::observe(&app, None);
                        if crate::context::fallback::active() {
                            continue;
                        }
                        let _ = crate::context::fallback::recover();
                        if !crate::context::fallback::capture_allowed(
                            clipboard_win::raw::seq_num().map(|n| n.get()).unwrap_or(0),
                        ) {
                            continue;
                        }
                        match crate::context::clipboard::read(&db) {
                            Ok(Some(read)) => {
                                if let crate::context::clipboard::Payload::Text(text) = read.payload
                                {
                                    injected_event(
                                        &app,
                                        &db,
                                        &text,
                                        read.source,
                                        false,
                                        &mut last_url_emit,
                                    );
                                } else {
                                    match crate::context::clipboard::ingest(&db, read) {
                                        Ok(Some(entry)) => {
                                            crate::context::observe(&app, Some(entry.id.clone()));
                                            let _ = app.emit("clipboard:new", &entry);
                                        }
                                        Ok(None) => {}
                                        Err(error) => eprintln!(
                                            "Clipboard payload could not be stored: {error}"
                                        ),
                                    }
                                }
                            }
                            Ok(None) => {}
                            Err(error) => eprintln!("Clipboard event was skipped: {error}"),
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

#[cfg(not(windows))]
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

#[cfg(not(windows))]
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
    crate::context::observe(app, None);
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.capture.invalidate();
    }
    if os_protected {
        return;
    }
    match ingest(db, text, source) {
        Ok(Some((entry, url))) => {
            crate::context::observe(app, Some(entry.id.clone()));
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

#[cfg(not(target_os = "windows"))]
fn current_source_app() -> Option<String> {
    None
}

/// Explicit note/link hotkeys reuse the watcher policy without persisting the
/// clipboard or ever synthesizing keys. Hold the Windows clipboard lock while
/// checking privacy formats and reading the corresponding text.
pub(crate) fn note_hotkey_text(db: &Database) -> Option<String> {
    let _ = crate::context::fallback::recover();
    if crate::context::fallback::active() {
        return None;
    }
    #[cfg(windows)]
    if !crate::context::fallback::capture_allowed(
        clipboard_win::raw::seq_num().map(|n| n.get()).unwrap_or(0),
    ) {
        return None;
    }
    #[cfg(windows)]
    let text = {
        use clipboard_win::{raw, Clipboard};
        let _clipboard = Clipboard::new().ok()?;
        if crate::context::clipboard::privacy_locked().ok()?.blocked() {
            return None;
        }
        let source = crate::context::clipboard::source_app()?;
        if !db.clipboard_source_allowed(Some(&source)).ok()? {
            return None;
        }
        if raw::size(clipboard_win::formats::CF_UNICODETEXT)?.get() > 65_538 {
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
#[cfg(test)]
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
