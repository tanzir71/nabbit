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

type FixtureVersion = Option<(SystemTime, u64)>;

fn read_fixture(
    path: &std::path::Path,
    previous: &mut FixtureVersion,
    cached: &mut Option<Sample>,
    retries: &AtomicU64,
) -> Option<Sample> {
    // Windows can briefly deny a read while a fixture writer replaces the
    // file. Retry only transient I/O, not invalid JSON or cursor values. A
    // persistently unavailable provider still fails closed within four ms.
    for attempt in 0..5 {
        let read = || -> std::io::Result<_> {
            let metadata = std::fs::metadata(path)?;
            let version = Some((metadata.modified()?, metadata.len()));
            if version == *previous {
                return Ok((version, *cached));
            }
            let raw = std::fs::read(path)?;
            Ok((
                version,
                serde_json::from_slice::<Sample>(&raw)
                    .ok()
                    .filter(|s| s.valid()),
            ))
        };
        match read() {
            Ok((version, sample)) => {
                *previous = version;
                *cached = sample;
                return sample;
            }
            Err(error)
                if attempt < 4
                    && (matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound
                            | std::io::ErrorKind::PermissionDenied
                            | std::io::ErrorKind::WouldBlock
                    ) || matches!(error.raw_os_error(), Some(32 | 33))) =>
            {
                retries.fetch_add(1, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(_) => break,
        }
    }
    *previous = None;
    *cached = None;
    None
}
#[derive(Default)]
pub struct Watcher {
    generation: Mutex<u64>,
    changed: Condvar,
    stopped: AtomicBool,
    samples: AtomicU64,
    events: AtomicU64,
    own_events: AtomicU64,
    system_dirty: AtomicBool,
    system_samples: AtomicU64,
    fixture_read_retries: AtomicU64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub cursor_samples: u64,
    pub foreground_events: u64,
    pub own_foreground_events: u64,
    pub hook_installed: bool,
    pub system_samples: u64,
    pub fixture_read_retries: u64,
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
        self.system_changed()
    }
    pub fn system_changed(&self) {
        self.system_dirty.store(true, Ordering::Relaxed);
        self.wake()
    }
    pub fn stats(&self, hook_installed: bool) -> Stats {
        Stats {
            cursor_samples: self.samples.load(Ordering::Relaxed),
            foreground_events: self.events.load(Ordering::Relaxed),
            own_foreground_events: self.own_events.load(Ordering::Relaxed),
            hook_installed,
            system_samples: self.system_samples.load(Ordering::Relaxed),
            fixture_read_retries: self.fixture_read_retries.load(Ordering::Relaxed),
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
        let fixed_fixture = super::acceptance_session()
            && std::env::var("NABBIT_ACCEPTANCE_CURSOR_STATIC").as_deref() == Ok("1");
        let _ = std::thread::Builder::new()
            .name("nabbit-island-input".into())
            .spawn(move || {
                let mut fixture_version: FixtureVersion = None;
                let mut fixture_sample: Option<Sample> = None;
                let mut next_system = Instant::now();
                while !watcher.stopped.load(Ordering::Relaxed) {
                    let started = Instant::now();
                    let generation = *watcher.generation.lock().unwrap_or_else(|e| e.into_inner());
                    let Some(manager) = manager.upgrade() else {
                        break;
                    };
                    let system_dirty = watcher.system_dirty.swap(false, Ordering::Relaxed);
                    if manager.has_hosts() && (started >= next_system || system_dirty) {
                        manager.sample_system();
                        watcher.system_samples.fetch_add(1, Ordering::Relaxed);
                        next_system = started + Duration::from_millis(500);
                    }
                    let delay = if manager.has_hosts() && !matches!(fixture, Some(None)) {
                        watcher.samples.fetch_add(1, Ordering::Relaxed);
                        let sample = match &fixture {
                            Some(Some(path)) => {
                                // Fixture polling must model the cheap real API,
                                // rather than re-open/parse an unchanged file at 40Hz.
                                if !fixed_fixture || fixture_version.is_none() {
                                    fixture_sample = read_fixture(
                                        path,
                                        &mut fixture_version,
                                        &mut fixture_sample,
                                        &watcher.fixture_read_retries,
                                    );
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
