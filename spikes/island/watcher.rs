//! Windows providers and event-driven/adaptive scheduling for the V0 spike.
use crate::island_interaction::{
    fullscreen, Decision, Foreground, Frame, Input, Interaction, Point, Rect,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc, Condvar, Mutex, OnceLock, Weak,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, WebviewWindow};
use windows_sys::Win32::{
    Foundation::{HWND, POINT, RECT},
    Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    System::Threading::GetCurrentThreadId,
    UI::{
        Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
        HiDpi::GetDpiForWindow,
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
        Shell::SHQueryUserNotificationState,
        WindowsAndMessaging::{
            DispatchMessageW, GetClassNameW, GetCursorPos, GetForegroundWindow, GetMessageW,
            GetWindowRect, GetWindowThreadProcessId, PeekMessageW, PostThreadMessageW,
            TranslateMessage, EVENT_SYSTEM_FOREGROUND, MSG, PM_NOREMOVE, WINEVENT_OUTOFCONTEXT,
            WM_QUIT,
        },
    },
};

fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|error| error.into_inner())
}

#[derive(Default)]
pub struct Signal {
    generation: Mutex<u64>,
    changed: Condvar,
    foreground_dirty: AtomicBool,
    hook_thread: AtomicU32,
}
impl Signal {
    pub fn wake(&self) {
        *lock(&self.generation) += 1;
        self.changed.notify_one();
    }
    fn wait(&self, previous: u64, duration: Duration) {
        drop(
            self.changed
                .wait_timeout_while(lock(&self.generation), duration, |generation| {
                    *generation == previous
                }),
        );
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    pub hidden: bool,
    pub dragging: bool,
    pub revision: u64,
}

pub trait Target: Send + Sync + 'static {
    fn hwnd(&self) -> tauri::Result<isize>;
    fn ignore(&self, ignore: bool) -> Result<(), String>;
    fn present(&self, value: Presentation);
    fn native_hitrect(&self) -> Option<Rect> {
        None
    }
    fn shutdown(&self) {}
}
struct WebTarget(WebviewWindow);
impl Target for WebTarget {
    fn hwnd(&self) -> tauri::Result<isize> {
        Ok(self.0.hwnd()?.0 as isize)
    }
    fn ignore(&self, ignore: bool) -> Result<(), String> {
        self.0
            .set_ignore_cursor_events(ignore)
            .map_err(|e| e.to_string())
    }
    fn present(&self, value: Presentation) {
        let _ = self.0.emit("nabbit://spike-interaction", value);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub presentation: Presentation,
    pub decision: Decision,
    pub hitrect: Option<Rect>,
    pub cursor_samples: u64,
    pub foreground_samples: u64,
    pub hook_installed: bool,
    pub foreground_events: u64,
}

pub struct Controller {
    pub signal: Arc<Signal>,
    pub model: Mutex<Interaction>,
    report: Mutex<Report>,
    closed: AtomicBool,
    refresh: AtomicBool,
    hook_installed: AtomicBool,
    foreground_events: AtomicU64,
}
impl Controller {
    pub fn new() -> Self {
        Self {
            signal: Arc::default(),
            model: Mutex::default(),
            report: Mutex::new(Report {
                presentation: Presentation::default(),
                decision: Decision::default(),
                hitrect: None,
                cursor_samples: 0,
                foreground_samples: 0,
                hook_installed: false,
                foreground_events: 0,
            }),
            closed: AtomicBool::new(false),
            refresh: AtomicBool::new(false),
            hook_installed: AtomicBool::new(false),
            foreground_events: AtomicU64::new(0),
        }
    }
    pub fn report(&self) -> Report {
        let mut report = lock(&self.report).clone();
        report.hook_installed = self.hook_installed.load(Ordering::Relaxed);
        report.foreground_events = self.foreground_events.load(Ordering::Relaxed);
        report
    }
    pub fn refresh(&self) {
        self.refresh.store(true, Ordering::Relaxed);
        self.signal.wake();
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.signal.wake();
    }
}

static HOOK_TARGETS: OnceLock<Mutex<Vec<Weak<Controller>>>> = OnceLock::new();
unsafe extern "system" fn foreground_event(
    _: HWINEVENTHOOK,
    _: u32,
    _: HWND,
    _: i32,
    _: i32,
    _: u32,
    _: u32,
) {
    if let Some(targets) = HOOK_TARGETS.get() {
        lock(targets).retain(|weak| {
            let Some(target) = weak.upgrade() else {
                return false;
            };
            target.foreground_events.fetch_add(1, Ordering::Relaxed);
            target
                .signal
                .foreground_dirty
                .store(true, Ordering::Relaxed);
            target.signal.wake();
            true
        });
    }
}

fn foreground_hook(controller: Arc<Controller>, shutdown: Arc<AtomicBool>) {
    let _ = thread::Builder::new()
        .name("island-foreground-hook".into())
        .spawn(move || unsafe {
            let mut message: MSG = std::mem::zeroed();
            PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
            controller
                .signal
                .hook_thread
                .store(GetCurrentThreadId(), Ordering::Relaxed);
            lock(HOOK_TARGETS.get_or_init(Mutex::default)).push(Arc::downgrade(&controller));
            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                std::ptr::null_mut(),
                Some(foreground_event),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            controller
                .hook_installed
                .store(!hook.is_null(), Ordering::Relaxed);
            if !hook.is_null()
                && !shutdown.load(Ordering::Relaxed)
                && !controller.closed.load(Ordering::Relaxed)
            {
                while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            if !hook.is_null() {
                UnhookWinEvent(hook);
            }
            controller.hook_installed.store(false, Ordering::Relaxed);
            lock(HOOK_TARGETS.get().expect("hook registry exists"))
                .retain(|weak| weak.as_ptr() != Arc::as_ptr(&controller));
        });
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Injected {
    x: f64,
    y: f64,
    left_down: bool,
    foreground: Foreground,
}

struct Provider {
    hwnd: isize,
    fixture: Option<std::path::PathBuf>,
    injected: Injected,
    frame: Frame,
    work: Rect,
    foreground: Foreground,
    input: Input,
}
fn rect(value: RECT) -> Rect {
    Rect {
        x: value.left as f64,
        y: value.top as f64,
        w: (value.right - value.left) as f64,
        h: (value.bottom - value.top) as f64,
    }
}
impl Provider {
    fn new(hwnd: isize) -> Self {
        Self {
            hwnd,
            fixture: std::env::var_os("NABBIT_ACCEPTANCE_CURSOR").map(Into::into),
            injected: Injected::default(),
            frame: Frame {
                origin: Point::default(),
                scale: 1.0,
            },
            work: Rect::default(),
            foreground: Foreground::default(),
            input: Input::default(),
        }
    }
    fn load_fixture(&mut self) {
        if let Some(path) = &self.fixture {
            if let Ok(raw) = fs::read_to_string(path) {
                if let Ok(input) = serde_json::from_str::<Injected>(&raw) {
                    self.injected = input;
                }
            }
        }
    }
    fn system(&mut self) {
        if self.fixture.is_some() {
            self.load_fixture();
            self.foreground = self.injected.foreground;
            return;
        }
        unsafe {
            let hwnd = self.hwnd as HWND;
            let mut bounds = std::mem::zeroed();
            GetWindowRect(hwnd, &mut bounds);
            self.frame = Frame {
                origin: Point {
                    x: bounds.left as f64,
                    y: bounds.top as f64,
                },
                scale: (GetDpiForWindow(hwnd) as f64 / 96.0).max(0.25),
            };
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut info: MONITORINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            GetMonitorInfoW(monitor, &mut info);
            self.work = rect(info.rcWork);
            let foreground = GetForegroundWindow();
            let mut pid = 0;
            GetWindowThreadProcessId(foreground, &mut pid);
            let mut name = [0u16; 128];
            let length = GetClassNameW(foreground, name.as_mut_ptr(), name.len() as i32);
            let name = String::from_utf16_lossy(&name[..length.max(0) as usize]);
            let mut bounds: RECT = std::mem::zeroed();
            let foreground_rect =
                (GetWindowRect(foreground, &mut bounds) != 0).then(|| rect(bounds));
            let mut notification_state = 5;
            let _ = SHQueryUserNotificationState(&mut notification_state);
            self.foreground = Foreground {
                notification_state,
                rect: foreground_rect,
                monitor: rect(info.rcMonitor),
                on_monitor: !foreground.is_null()
                    && MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST) == monitor,
                own_process: pid == std::process::id(),
                desktop: matches!(name.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd"),
            };
        }
    }
    fn cursor(&mut self) {
        if self.fixture.is_some() {
            self.load_fixture();
            self.input.cursor = Point {
                x: self.injected.x,
                y: self.injected.y,
            };
            self.input.left_down = self.injected.left_down;
            self.input.in_band = self.injected.y >= 0.0 && self.injected.y < 48.0;
            return;
        }
        unsafe {
            let mut point: POINT = std::mem::zeroed();
            GetCursorPos(&mut point);
            self.input.cursor = self.frame.logical(Point {
                x: point.x as f64,
                y: point.y as f64,
            });
            self.input.left_down = GetAsyncKeyState(VK_LBUTTON as i32) < 0;
            self.input.in_band = point.x as f64 >= self.work.x
                && point.x as f64 <= self.work.x + self.work.w
                && point.y as f64 >= self.work.y
                && (point.y as f64) < self.work.y + 48.0 * self.frame.scale;
        }
    }
    fn input(&self) -> Input {
        Input {
            faded: false,
            fullscreen: fullscreen(self.foreground),
            ..self.input
        }
    }
}

pub fn spawn(
    window: WebviewWindow,
    controller: Arc<Controller>,
    shutdown: Arc<AtomicBool>,
) -> tauri::Result<()> {
    spawn_target(Arc::new(WebTarget(window)), controller, shutdown)
}

pub fn spawn_target(
    target: Arc<dyn Target>,
    controller: Arc<Controller>,
    shutdown: Arc<AtomicBool>,
) -> tauri::Result<()> {
    let hwnd = target.hwnd()?;
    foreground_hook(controller.clone(), shutdown.clone());
    thread::Builder::new()
        .name("island-adaptive-cursor".into())
        .spawn(move || {
            let mut provider = Provider::new(hwnd);
            let mut last_cursor = Instant::now() - Duration::from_secs(1);
            let mut next_system = Instant::now();
            let mut applied_ignore = true;
            while !shutdown.load(Ordering::Relaxed) && !controller.closed.load(Ordering::Relaxed) {
                let generation = *lock(&controller.signal.generation);
                let now = Instant::now();
                let forced = controller.refresh.swap(false, Ordering::Relaxed);
                let foreground_changed = controller
                    .signal
                    .foreground_dirty
                    .swap(false, Ordering::Relaxed);
                let previous = controller.report();
                let system_due = forced || foreground_changed || now >= next_system;
                let cursor_due = forced
                    || foreground_changed
                    || now.duration_since(last_cursor).as_millis()
                        >= previous.decision.poll_ms as u128;
                if system_due {
                    provider.system();
                    next_system = now + Duration::from_millis(500);
                }
                if cursor_due {
                    provider.cursor();
                    last_cursor = now;
                }
                let (decision, hitrect) = {
                    let mut model = lock(&controller.model);
                    if let Some(rect) = target.native_hitrect() {
                        model.hitrect = Some(rect);
                    }
                    (model.step(provider.input()), model.hitrect)
                };
                let mut report = lock(&controller.report);
                report.cursor_samples += u64::from(cursor_due);
                report.foreground_samples += u64::from(system_due);
                report.decision = decision;
                report.hitrect = hitrect;
                let mut emit = false;
                if decision.hidden != report.presentation.hidden
                    || decision.dragging != report.presentation.dragging
                {
                    report.presentation = Presentation {
                        hidden: decision.hidden,
                        dragging: decision.dragging,
                        revision: report.presentation.revision + 1,
                    };
                    emit = true;
                }
                let presentation = report.presentation;
                drop(report);
                let ignore = !decision.interactive;
                if ignore != applied_ignore && target.ignore(ignore).is_ok() {
                    applied_ignore = ignore;
                }
                if emit {
                    target.present(presentation);
                }
                let next_cursor = last_cursor + Duration::from_millis(decision.poll_ms);
                controller.signal.wait(
                    generation,
                    next_cursor
                        .min(next_system)
                        .saturating_duration_since(Instant::now()),
                );
            }
            let thread_id = controller.signal.hook_thread.load(Ordering::Relaxed);
            if thread_id != 0 {
                unsafe {
                    PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
                }
            }
            target.shutdown();
        })
        .map_err(tauri::Error::Io)?;
    Ok(())
}
