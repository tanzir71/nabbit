//! One adaptive worker for all active hosts. HWND mutations remain on the UI thread.
use super::{input::Sample, native::Manager};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, Weak,
    },
    time::{Duration, Instant, SystemTime},
};
use windows_sys::Win32::{
    Foundation::POINT,
    UI::{
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
        WindowsAndMessaging::GetCursorPos,
    },
};
#[derive(Default)]
pub struct Watcher {
    generation: Mutex<u64>,
    changed: Condvar,
    stopped: AtomicBool,
    samples: AtomicU64,
    events: AtomicU64,
    own_events: AtomicU64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub cursor_samples: u64,
    pub foreground_events: u64,
    pub own_foreground_events: u64,
    pub hook_installed: bool,
}
impl Watcher {
    pub fn wake(&self) {
        *self.generation.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        self.changed.notify_one();
    }
    pub fn foreground(&self, own: bool) {
        self.events.fetch_add(1, Ordering::Relaxed);
        if own {
            self.own_events.fetch_add(1, Ordering::Relaxed);
        }
        self.wake()
    }
    pub fn stats(&self, hook_installed: bool) -> Stats {
        Stats {
            cursor_samples: self.samples.load(Ordering::Relaxed),
            foreground_events: self.events.load(Ordering::Relaxed),
            own_foreground_events: self.own_events.load(Ordering::Relaxed),
            hook_installed,
        }
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        self.wake()
    }
    pub fn start(self: &Arc<Self>, manager: Weak<Manager>) {
        let watcher = self.clone();
        let fixture = if super::acceptance_session() {
            Some(std::env::var_os("NABBIT_ACCEPTANCE_CURSOR").map(std::path::PathBuf::from))
        } else {
            None
        };
        let _ = std::thread::Builder::new()
            .name("nabbit-island-input".into())
            .spawn(move || {
                let mut fixture_version: Option<(SystemTime, u64)> = None;
                let mut fixture_sample: Option<Sample> = None;
                while !watcher.stopped.load(Ordering::Relaxed) {
                    let started = Instant::now();
                    let generation = *watcher.generation.lock().unwrap_or_else(|e| e.into_inner());
                    let Some(manager) = manager.upgrade() else {
                        break;
                    };
                    let delay = if manager.has_hosts() && !matches!(fixture, Some(None)) {
                        watcher.samples.fetch_add(1, Ordering::Relaxed);
                        let sample = match &fixture {
                            Some(Some(path)) => {
                                // Fixture polling must model the cheap real API,
                                // rather than re-open/parse an unchanged file at 40Hz.
                                let version = std::fs::metadata(path).ok().and_then(|metadata| {
                                    metadata.modified().ok().map(|time| (time, metadata.len()))
                                });
                                if version.is_none() || version != fixture_version {
                                    fixture_sample = std::fs::read(path)
                                        .ok()
                                        .and_then(|raw| serde_json::from_slice::<Sample>(&raw).ok())
                                        .filter(|s| s.valid());
                                    fixture_version = version;
                                }
                                fixture_sample
                            }
                            Some(None) => None,
                            None => {
                                let mut point = POINT { x: 0, y: 0 };
                                if unsafe { GetCursorPos(&mut point) } == 0 {
                                    None
                                } else {
                                    Some(Sample {
                                        x: f64::from(point.x),
                                        y: f64::from(point.y),
                                        left_down: manager.button_down()
                                            || unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } < 0,
                                    })
                                }
                            }
                        };
                        Some(
                            Duration::from_millis(manager.sample_input(sample))
                                .saturating_sub(started.elapsed()),
                        )
                    } else {
                        None
                    };
                    drop(manager);
                    let guard = watcher.generation.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(delay) = delay {
                        drop(watcher.changed.wait_timeout_while(guard, delay, |value| {
                            *value == generation && !watcher.stopped.load(Ordering::Relaxed)
                        }));
                    } else {
                        drop(watcher.changed.wait_while(guard, |value| {
                            *value == generation && !watcher.stopped.load(Ordering::Relaxed)
                        }));
                    }
                }
            });
    }
}
