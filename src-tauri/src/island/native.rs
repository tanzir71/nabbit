//! Message-driven production island hosts. All HWND/COM work stays on the UI thread.
use super::{
    input::{self, Gate, HostInput, Sample},
    input_watcher::Watcher,
    model::*,
    renderer::Renderer,
    visibility::{Foreground, Visibility},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicIsize, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager as TauriManager};
use windows_sys::{
    w,
    Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
            HiDpi::*,
            WindowsAndMessaging::*,
        },
    },
};

const REFRESH: u32 = WM_APP + 91;
const INPUT_REFRESH: u32 = WM_APP + 92;
static MOUSE_LEFT: AtomicBool = AtomicBool::new(false);
static MOUSE_BAND: AtomicBool = AtomicBool::new(false);
static CURRENT: OnceLock<Mutex<Weak<Manager>>> = OnceLock::new();
static CONTROL: AtomicIsize = AtomicIsize::new(0);
static MOUSE_MONITOR: AtomicIsize = AtomicIsize::new(0);
thread_local! { static GRAPHICS:RefCell<HashMap<isize,Renderer>>=RefCell::new(HashMap::new()); }
fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|e| e.into_inner())
}
fn current() -> Option<Arc<Manager>> {
    CURRENT.get().and_then(|value| lock(value).upgrade())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub placement: Placement,
    pub hwnd: isize,
    pub commits: u64,
    pub warp: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub visibility: Vec<super::visibility::Report>,
    pub foreground: Foreground,
    pub input: Vec<input::Report>,
    pub input_watcher: super::input_watcher::Stats,
    pub supported: bool,
    pub preferences: Preferences,
    pub desktop: Desktop,
    pub hosts: Vec<Host>,
    pub renderer: &'static str,
    pub webviews: usize,
    pub reconciliations: u64,
    pub last_error: Option<String>,
}
struct State {
    visibility: HashMap<String, Visibility>,
    applied_visibility: HashMap<String, u64>,
    foreground: Foreground,
    foreground_fixture: Option<Foreground>,
    gate_override: Option<Gate>,
    inputs: HashMap<String, HostInput>,
    preferences: Preferences,
    desktop: Desktop,
    fixture: Option<Desktop>,
    hosts: HashMap<String, Host>,
    reconciliations: u64,
    error: Option<String>,
}
pub struct Manager {
    started: Instant,
    visibility_hooks: Mutex<Vec<isize>>,
    watcher: Arc<Watcher>,
    foreground_hook: AtomicIsize,
    input_pending: AtomicBool,
    app: AppHandle,
    control: isize,
    pending: AtomicBool,
    stopped: AtomicBool,
    hook: AtomicIsize,
    state: Mutex<State>,
}

pub fn start(app: &AppHandle, preferences: Preferences) -> Result<(), String> {
    unsafe {
        for (name, procedure) in [
            (
                w!("NabbitIslandEvents"),
                control_proc as unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT,
            ),
            (w!("NabbitIslandHost"), host_proc),
        ] {
            let class = WNDCLASSW {
                lpfnWndProc: Some(procedure),
                hInstance: GetModuleHandleW(std::ptr::null()),
                lpszClassName: name,
                ..std::mem::zeroed()
            };
            if RegisterClassW(&class) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        let fixture = if super::acceptance_session() {
            std::env::var_os("NABBIT_ISLAND_LAYOUT")
                .map(PathBuf::from)
                .map(|path| {
                    std::fs::read(path)
                        .map_err(|e| e.to_string())
                        .and_then(|raw| serde_json::from_slice(&raw).map_err(|e| e.to_string()))
                })
                .transpose()?
        } else {
            None
        };
        let control = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            w!("NabbitIslandEvents"),
            w!("Nabbit Island Events"),
            WS_POPUP,
            0,
            0,
            1,
            1,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        );
        if control.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let manager = Arc::new(Manager {
            started: Instant::now(),
            visibility_hooks: Mutex::default(),
            watcher: Arc::default(),
            foreground_hook: AtomicIsize::new(0),
            input_pending: AtomicBool::new(false),
            app: app.clone(),
            control: control as isize,
            pending: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            hook: AtomicIsize::new(0),
            state: Mutex::new(State {
                visibility: HashMap::new(),
                applied_visibility: HashMap::new(),
                foreground: Foreground::default(),
                foreground_fixture: super::acceptance_session().then(Foreground::default),
                gate_override: None,
                inputs: HashMap::new(),
                preferences,
                desktop: Desktop::default(),
                fixture,
                hosts: HashMap::new(),
                reconciliations: 0,
                error: None,
            }),
        });
        *lock(CURRENT.get_or_init(|| Mutex::new(Weak::new()))) = Arc::downgrade(&manager);
        CONTROL.store(control as isize, Ordering::Relaxed);
        app.manage(manager.clone());
        let hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            std::ptr::null_mut(),
            Some(foreground_hook),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        if hook.is_null() {
            manager.stop();
            return Err(std::io::Error::last_os_error().to_string());
        }
        manager
            .foreground_hook
            .store(hook as isize, Ordering::Relaxed);
        for (first, last) in [
            (EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE),
            (EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZEEND),
            (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
        ] {
            let hook = SetWinEventHook(
                first,
                last,
                std::ptr::null_mut(),
                Some(foreground_hook),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            if hook.is_null() {
                manager.stop();
                return Err(std::io::Error::last_os_error().to_string());
            }
            lock(&manager.visibility_hooks).push(hook as isize);
        }
        if let Err(error) = manager.reconcile() {
            manager.stop();
            return Err(error);
        }
        manager.acceptance_worker();
        manager.watcher.start(Arc::downgrade(&manager));
        Ok(())
    }
}
impl Manager {
    pub fn configure(&self, preferences: Preferences) {
        lock(&self.state).preferences = preferences;
        self.refresh()
    }
    pub fn snapshot(&self) -> Snapshot {
        let state = lock(&self.state);
        let mut hosts: Vec<_> = state.hosts.values().cloned().collect();
        hosts.sort_by(|a, b| a.placement.label.cmp(&b.placement.label));
        Snapshot {
            visibility: hosts
                .iter()
                .filter_map(|host| {
                    state
                        .visibility
                        .get(&host.placement.label)
                        .map(|value| value.report(&host.placement.label))
                })
                .collect(),
            foreground: state.foreground.clone(),
            input: hosts
                .iter()
                .filter_map(|host| {
                    state
                        .inputs
                        .get(&host.placement.label)
                        .map(|input| input.report(&host.placement.label))
                })
                .collect(),
            input_watcher: self
                .watcher
                .stats(self.foreground_hook.load(Ordering::Relaxed) != 0),
            supported: true,
            preferences: state.preferences.clone(),
            desktop: state.desktop.clone(),
            hosts,
            renderer: "native",
            webviews: self.app.webview_windows().len(),
            reconciliations: state.reconciliations,
            last_error: state.error.clone(),
        }
    }
    pub fn refresh(&self) {
        if !self.stopped.load(Ordering::Relaxed) && !self.pending.swap(true, Ordering::Relaxed) {
            unsafe {
                PostMessageW(self.control as HWND, REFRESH, 0, 0);
            }
        }
    }
    fn reconcile(&self) -> Result<(), String> {
        if self.stopped.load(Ordering::Relaxed) {
            return Ok(());
        }
        self.pending.store(false, Ordering::Relaxed);
        self.sample_system();
        let (preferences, fixture) = {
            let state = lock(&self.state);
            (state.preferences.clone(), state.fixture.clone())
        };
        let desktop = fixture.unwrap_or_else(real_desktop);
        let desired = placements(&desktop, &preferences);
        let previous = lock(&self.state).hosts.clone();
        // Track ownership after every successful operation, including partial errors.
        // A failed device update can be retried by the next system/config event.
        for (label, host) in &previous {
            if !desired.iter().any(|p| &p.label == label) {
                destroy_host(host.hwnd);
                lock(&self.state).hosts.remove(label);
            }
        }
        for placement in desired {
            let host = if let Some(old) = previous.get(&placement.label) {
                if old.placement == placement {
                    old.clone()
                } else {
                    update_host(old.hwnd, &placement)?
                }
            } else {
                let state = lock(&self.state);
                let mode = state.gate_override.unwrap_or_else(|| {
                    desktop
                        .monitors
                        .iter()
                        .find(|m| m.id == placement.monitor_id)
                        .map(|m| super::visibility::classify(&state.foreground, m.bounds).0)
                        .unwrap_or_default()
                });
                drop(state);
                create_host(&placement, mode.opacity())?
            };
            lock(&self.state)
                .hosts
                .insert(placement.label.clone(), host);
        }
        {
            let mut state = lock(&self.state);
            let placements: Vec<_> = state
                .hosts
                .values()
                .map(|host| host.placement.clone())
                .collect();
            state
                .inputs
                .retain(|label, _| placements.iter().any(|p| &p.label == label));
            state
                .visibility
                .retain(|label, _| placements.iter().any(|p| &p.label == label));
            state
                .applied_visibility
                .retain(|label, _| placements.iter().any(|p| &p.label == label));
            let foreground = state.foreground.clone();
            let gate_override = state.gate_override;
            for placement in &placements {
                state
                    .visibility
                    .entry(placement.label.clone())
                    .or_insert_with(|| {
                        let mut visibility = Visibility::default();
                        if let Some(monitor) = desktop
                            .monitors
                            .iter()
                            .find(|m| m.id == placement.monitor_id)
                        {
                            visibility.step(
                                &foreground,
                                monitor.bounds,
                                false,
                                false,
                                self.started.elapsed().as_millis() as u64,
                                gate_override,
                            );
                        }
                        visibility
                    });
                let value = state
                    .inputs
                    .entry(placement.label.clone())
                    .or_insert_with(|| HostInput::new(placement));
                if !value.web {
                    value.model.hitrect = Some(input::native_rect(placement));
                }
            }
            state.desktop = desktop;
            state.reconciliations += 1;
            state.error = None;
        }
        self.update_hook(preferences.enabled)?;
        self.watcher.system_changed();
        let _ = self.app.emit("nabbit://island-config", self.snapshot());
        Ok(())
    }
    fn update_hook(&self, follow: bool) -> Result<(), String> {
        if super::acceptance_session() {
            return Ok(());
        }
        let old = self.hook.load(Ordering::Relaxed);
        if !follow && old != 0 {
            unsafe {
                UnhookWindowsHookEx(old as HHOOK);
            }
            self.hook.store(0, Ordering::Relaxed);
        }
        if follow && old == 0 {
            let hook = unsafe {
                SetWindowsHookExW(
                    WH_MOUSE_LL,
                    Some(mouse_hook),
                    GetModuleHandleW(std::ptr::null()),
                    0,
                )
            };
            if hook.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            self.hook.store(hook as isize, Ordering::Relaxed);
            MOUSE_LEFT.store(
                unsafe {
                    windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(
                        windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_LBUTTON as i32,
                    )
                } < 0,
                Ordering::Relaxed,
            );
        }
        Ok(())
    }
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::Relaxed) {
            return;
        }
        CONTROL.store(0, Ordering::Relaxed);
        self.watcher.stop();
        for hook in std::mem::take(&mut *lock(&self.visibility_hooks)) {
            unsafe {
                UnhookWinEvent(hook as HWINEVENTHOOK);
            }
        }
        let hook = self.foreground_hook.swap(0, Ordering::Relaxed);
        if hook != 0 {
            unsafe {
                UnhookWinEvent(hook as HWINEVENTHOOK);
            }
        }
        let hook = self.hook.swap(0, Ordering::Relaxed);
        if hook != 0 {
            unsafe {
                UnhookWindowsHookEx(hook as HHOOK);
            }
        }
        let hosts = std::mem::take(&mut lock(&self.state).hosts);
        for host in hosts.values() {
            destroy_host(host.hwnd)
        }
        unsafe {
            DestroyWindow(self.control as HWND);
        }
    }
    pub fn button_down(&self) -> bool {
        MOUSE_LEFT.load(Ordering::Relaxed)
    }
    pub fn has_hosts(&self) -> bool {
        !lock(&self.state).hosts.is_empty()
    }
    pub fn set_hitrect(
        &self,
        label: &str,
        rect: Option<crate::island_interaction::Rect>,
    ) -> Result<(), String> {
        let mut state = lock(&self.state);
        let placement = state
            .hosts
            .get(label)
            .ok_or("Only an active island surface can update its hit rectangle")?
            .placement
            .clone();
        let value = state
            .inputs
            .get_mut(label)
            .ok_or("Missing island input state")?;
        value.web = rect.is_some();
        value.dirty = true;
        value.model.hitrect = Some(rect.unwrap_or_else(|| input::native_rect(&placement)));
        if !value.web {
            value.model.cancel_drag();
        }
        drop(state);
        self.watcher.wake();
        Ok(())
    }
    pub fn set_drag(&self, label: &str, active: bool) -> Result<(), String> {
        let mut state = lock(&self.state);
        let value = state
            .inputs
            .get_mut(label)
            .ok_or("Only an active island surface can update drag state")?;
        if active {
            value.model.ole_drag = true;
        } else {
            value.model.cancel_drag();
        }
        drop(state);
        self.watcher.wake();
        Ok(())
    }
    pub fn sample_input(&self, sample: Option<Sample>) -> u64 {
        if self.stopped.load(Ordering::Relaxed) {
            return 500;
        }
        let mut state = lock(&self.state);
        let placements: Vec<_> = state
            .hosts
            .values()
            .map(|host| host.placement.clone())
            .collect();
        let mut delay = 500;
        let mut changed = false;
        let foreground = state.foreground.clone();
        let gate_override = state.gate_override;
        let now = self.started.elapsed().as_millis() as u64;
        for placement in placements {
            let monitor = state
                .desktop
                .monitors
                .iter()
                .find(|m| m.id == placement.monitor_id)
                .map(|m| m.bounds);
            let point = sample
                .filter(|s| s.valid())
                .map(|s| input::logical(&placement, s));
            let band = point.is_some_and(input::in_band);
            let inside = point.is_some_and(|p| {
                state
                    .inputs
                    .get(&placement.label)
                    .and_then(|i| i.model.hitrect)
                    .is_some_and(|r| r.contains(p))
            });
            let visibility_changed = if let Some(monitor) = monitor {
                state
                    .visibility
                    .entry(placement.label.clone())
                    .or_default()
                    .step(&foreground, monitor, band, inside, now, gate_override)
            } else {
                false
            };
            let mode = state
                .visibility
                .get(&placement.label)
                .map(|v| v.mode)
                .unwrap_or_default();
            let hover_pending = band && mode == Gate::Faded;
            if let Some(value) = state.inputs.get_mut(&placement.label) {
                value.gate = mode;
                value.dirty |= visibility_changed;
                value.step(&placement, sample);
                // The wake band spans the host, including areas farther than
                // 120px from the pill. Sample intent at the near rate there.
                if hover_pending {
                    value.decision.poll_ms = 25;
                }
                delay = delay.min(value.decision.poll_ms);
                changed |= value.decision != value.applied || value.dirty;
            }
        }
        drop(state);
        if changed && !self.input_pending.swap(true, Ordering::Relaxed) {
            unsafe {
                PostMessageW(self.control as HWND, INPUT_REFRESH, 0, 0);
            }
        }
        delay
    }
    pub fn sample_system(&self) {
        let fixture = lock(&self.state).foreground_fixture.clone();
        let foreground = fixture.unwrap_or_else(super::foreground::read);
        lock(&self.state).foreground = foreground;
    }
    pub fn wake_island(&self, label: &str) -> Result<(), String> {
        let mut state = lock(&self.state);
        state
            .visibility
            .get_mut(label)
            .ok_or("Only an active island can wake")?
            .wake();
        drop(state);
        self.watcher.wake();
        Ok(())
    }
    fn apply_input(&self) {
        self.input_pending.store(false, Ordering::Relaxed);
        let mut state = lock(&self.state);
        let handles: Vec<_> = state
            .hosts
            .iter()
            .map(|(label, host)| (label.clone(), host.hwnd))
            .collect();
        let mut events = vec![];
        let mut visibility_events = vec![];
        for (label, hwnd) in handles {
            if let Some(report) = state.visibility.get(&label).map(|v| v.report(&label)) {
                if state.applied_visibility.get(&label) != Some(&report.revision) {
                    let result = GRAPHICS.with(|graphics| {
                        let mut graphics = graphics.borrow_mut();
                        let renderer = graphics
                            .get_mut(&hwnd)
                            .ok_or("Missing native renderer".to_string())?;
                        renderer
                            .set_opacity(report.opacity)
                            .map_err(|e| e.to_string())?;
                        Ok::<_, String>(renderer.commits)
                    });
                    match result {
                        Ok(commits) => {
                            if let Some(host) = state.hosts.get_mut(&label) {
                                host.commits = commits;
                            }
                            state
                                .applied_visibility
                                .insert(label.clone(), report.revision);
                            visibility_events.push(report);
                        }
                        Err(error) => {
                            state.error = Some(error);
                        }
                    }
                }
            }
            if let Some(value) = state.inputs.get_mut(&label) {
                if value.decision == value.applied && !value.dirty {
                    continue;
                }
                if value.decision.interactive != value.applied.interactive || value.dirty {
                    if let Err(error) = set_interactive(hwnd, value.decision.interactive) {
                        state.error = Some(error);
                        break;
                    }
                }
                if let Some(window) = self.app.get_webview_window(&label) {
                    // Tao's flag setter re-shows visible windows with SW_SHOW.
                    // Keep cursor changes to styles without show/focus calls.
                    if let Err(error) = window.hwnd().map_err(|e| e.to_string()).and_then(|hwnd| {
                        set_interactive(hwnd.0 as isize, value.decision.interactive)
                    }) {
                        state.error = Some(error);
                        break;
                    }
                }
                let was_dragging = value.applied.dragging;
                value.applied = value.decision;
                value.dirty = false;
                value.revision += 1;
                events.push((
                    value.report(&label),
                    was_dragging != value.decision.dragging,
                ));
            }
        }
        drop(state);
        for report in visibility_events {
            let _ = self.app.emit("nabbit://island-visibility", report);
        }
        for (report, drag_changed) in events {
            let _ = self.app.emit("nabbit://island-interaction", &report);
            if drag_changed {
                let _ = self.app.emit(
                    if report.decision.dragging {
                        "island:drag-enter"
                    } else {
                        "island:drag-leave"
                    },
                    &report,
                );
            }
        }
    }
    fn acceptance_worker(self: &Arc<Self>) {
        if !super::acceptance_session() {
            return;
        }
        let Some(path) = std::env::var_os("NABBIT_ACCEPTANCE_COMMAND_DIR").map(PathBuf::from)
        else {
            return;
        };
        let weak = Arc::downgrade(self);
        let app = self.app.clone();
        let _ = std::thread::Builder::new()
            .name("nabbit-island-fixture".into())
            .spawn(move || {
                let request_path = path.join("island-request.json");
                let response_path = path.join("island-response.json");
                loop {
                    let Some(manager) = weak.upgrade() else { break };
                    if manager.stopped.load(Ordering::Relaxed) { break; }
                    drop(manager);
                    if let Ok(raw) = std::fs::read(&request_path) {
                        let _ = std::fs::remove_file(&request_path);
                        let request = serde_json::from_slice::<Request>(&raw);
                        if let Ok(request) = request {
                            // Build outside the UI callback: WebView2 needs the
                            // event loop to service its synchronous constructor.
                            let preparation = match request.prepare_tray {
                                Some(true) => crate::ensure_popover(&app).map(|_| ()).map_err(|e| e.to_string()),
                                Some(false) => app.get_webview_window("main").map(|window| window.destroy().map_err(|e| e.to_string())).unwrap_or(Ok(())),
                                None => Ok(()),
                            };
                            let preparation=preparation.and_then(|()|match request.prepare_input {
                                Some(true)=>prepare_input_window(&app),
                                Some(false)=>app.get_webview_window("island").map(|window|window.destroy().map_err(|e|e.to_string())).unwrap_or(Ok(())),
                                None=>Ok(()),
                            });
                            let weak = weak.clone();
                            let path = path.clone();
                            let response_path = response_path.clone();
                            let _ = app.run_on_main_thread(move || {
                                if let Some(manager) = weak.upgrade() {
                                    if let Some(gate)=request.gate{lock(&manager.state).gate_override=Some(gate);manager.watcher.wake();}
                                    if request.live_foreground.unwrap_or(false){let mut state=lock(&manager.state);state.foreground_fixture=None;state.gate_override=None;drop(state);manager.watcher.system_changed();}
                                    if let Some(foreground)=request.foreground{let mut state=lock(&manager.state);state.foreground_fixture=Some(foreground.clone());state.foreground=foreground;state.gate_override=None;drop(state);manager.watcher.system_changed();}
                                    if let Some(label)=request.wake{let _=manager.wake_island(&label);}
                                    let outcome = preparation.and_then(|()| manager.accept(request.desktop, request.preferences, request.capture, &path));
                                    let response = serde_json::json!({"id":request.id,"snapshot":manager.snapshot(),"result":outcome.as_ref().ok(),"error":outcome.err()});
                                    let _ = std::fs::write(response_path, serde_json::to_vec(&response).unwrap_or_default());
                                    if request.quit.unwrap_or(false) { manager.app.exit(0); }
                                }
                            });
                        } else if let Err(error) = request {
                            let _ = std::fs::write(&response_path, serde_json::json!({"error":error.to_string()}).to_string());
                        }
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            });
    }
    fn accept(
        &self,
        desktop: Option<Desktop>,
        preferences: Option<Preferences>,
        capture: Option<Capture>,
        folder: &std::path::Path,
    ) -> Result<serde_json::Value, String> {
        if let Some(desktop) = desktop {
            lock(&self.state).fixture = Some(desktop)
        }
        if let Some(preferences) = preferences {
            let state = self.app.state::<crate::AppState>();
            let mut settings = state.db.get_settings().map_err(|e| e.to_string())?;
            settings.island = preferences;
            let saved = state
                .db
                .save_settings(&settings)
                .map_err(|e| e.to_string())?;
            lock(&self.state).preferences = saved.island;
        }
        self.reconcile()?;
        if let Some(capture) = capture {
            if capture.stem.is_empty()
                || !capture
                    .stem
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err("Invalid capture filename".into());
            }
            let hwnd = lock(&self.state)
                .hosts
                .get(&capture.label)
                .ok_or("Unknown capture label")?
                .hwnd;
            let value = GRAPHICS.with(|graphics| {
                graphics
                    .borrow()
                    .get(&hwnd)
                    .ok_or("Missing renderer".to_string())?
                    .capture(hwnd, &folder.join(format!("{}.bgra", capture.stem)))
                    .map_err(|e| e.to_string())
            })?;
            return serde_json::to_value(value).map_err(|e| e.to_string());
        }
        Ok(serde_json::Value::Null)
    }
}
#[derive(Deserialize)]
struct Request {
    #[serde(rename = "liveForeground")]
    live_foreground: Option<bool>,
    id: String,
    desktop: Option<Desktop>,
    preferences: Option<Preferences>,
    capture: Option<Capture>,
    #[serde(rename = "prepareTray")]
    prepare_tray: Option<bool>,
    quit: Option<bool>,
    #[serde(rename = "prepareInput")]
    prepare_input: Option<bool>,
    gate: Option<Gate>,
    foreground: Option<Foreground>,
    wake: Option<String>,
}
#[derive(Deserialize)]
struct Capture {
    label: String,
    stem: String,
}

fn create_host(placement: &Placement, opacity: f64) -> Result<Host, String> {
    unsafe {
        let title: Vec<_> = format!("Nabbit island · {}", placement.label)
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let b = placement.bounds;
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED
                | WS_EX_NOREDIRECTIONBITMAP
                | WS_EX_NOACTIVATE
                | WS_EX_TOOLWINDOW
                | WS_EX_TOPMOST
                | WS_EX_TRANSPARENT,
            w!("NabbitIslandHost"),
            title.as_ptr(),
            WS_POPUP,
            b.x,
            b.y,
            b.width as i32,
            b.height as i32,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let handle = hwnd as isize;
        if SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA) == 0 {
            DestroyWindow(hwnd);
            return Err(std::io::Error::last_os_error().to_string());
        }
        let renderer = match Renderer::new(handle, placement).and_then(|mut renderer| {
            renderer.set_opacity(opacity)?;
            Ok(renderer)
        }) {
            Ok(renderer) => renderer,
            Err(error) => {
                DestroyWindow(hwnd);
                return Err(error.to_string());
            }
        };
        let host = Host {
            placement: placement.clone(),
            hwnd: handle,
            commits: renderer.commits,
            warp: renderer.warp,
        };
        GRAPHICS.with(|graphics| graphics.borrow_mut().insert(handle, renderer));
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        Ok(host)
    }
}

// Acceptance-only, outside the UI thread. Production compact hosts remain native;
// this composited surface exercises the same IPC that larger V2.5 views will use.
fn prepare_input_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("island").is_some() {
        return Ok(());
    }
    let manager = app.state::<Arc<Manager>>();
    let placement = lock(&manager.state)
        .hosts
        .get("island")
        .ok_or("Input probe requires singleton mode")?
        .placement
        .clone();
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "island",
        tauri::WebviewUrl::App("island.html".into()),
    )
    .title("Nabbit island input probe")
    .inner_size(720.0, 460.0)
    .transparent(true)
    .decorations(false)
    .shadow(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .focusable(false)
    .no_redirection_bitmap(true)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(
            placement.bounds.x,
            placement.bounds.y,
        ))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(
            placement.bounds.width,
            placement.bounds.height,
        ))
        .map_err(|e| e.to_string())?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|e| e.to_string())?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    app.run_on_main_thread(move || unsafe {
        ShowWindow(hwnd as HWND, SW_SHOWNOACTIVATE);
    })
    .map_err(|e| e.to_string())
}

fn set_interactive(hwnd: isize, interactive: bool) -> Result<(), String> {
    unsafe {
        let style = GetWindowLongPtrW(hwnd as HWND, GWL_EXSTYLE);
        let next = (if interactive {
            style & !(WS_EX_TRANSPARENT as isize)
        } else {
            style | WS_EX_TRANSPARENT as isize
        }) | WS_EX_LAYERED as isize;
        if style != next {
            SetLastError(0);
            if SetWindowLongPtrW(hwnd as HWND, GWL_EXSTYLE, next) == 0 && GetLastError() != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
    }
    Ok(())
}
fn update_host(hwnd: isize, placement: &Placement) -> Result<Host, String> {
    let b = placement.bounds;
    if unsafe {
        SetWindowPos(
            hwnd as HWND,
            HWND_TOPMOST,
            b.x,
            b.y,
            b.width as i32,
            b.height as i32,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    GRAPHICS.with(|graphics| {
        let mut graphics = graphics.borrow_mut();
        let renderer = graphics.get_mut(&hwnd).ok_or("Missing native renderer")?;
        renderer.update(placement).map_err(|e| e.to_string())?;
        Ok(Host {
            placement: placement.clone(),
            hwnd,
            commits: renderer.commits,
            warp: renderer.warp,
        })
    })
}
fn destroy_host(hwnd: isize) {
    GRAPHICS.with(|graphics| graphics.borrow_mut().remove(&hwnd));
    unsafe {
        DestroyWindow(hwnd as HWND);
    }
}
unsafe extern "system" fn host_proc(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match message {
        WM_DISPLAYCHANGE | WM_DPICHANGED | WM_SETTINGCHANGE => {
            if let Some(manager) = current() {
                manager.refresh()
            }
            0
        }
        WM_MOUSEACTIVATE => MA_NOACTIVATE as LRESULT,
        _ => DefWindowProcW(hwnd, message, w, l),
    }
}
unsafe extern "system" fn control_proc(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if message == INPUT_REFRESH {
        if let Some(manager) = current() {
            manager.apply_input()
        }
        return 0;
    }
    if message == REFRESH {
        if let Some(manager) = current() {
            if let Err(error) = manager.reconcile() {
                lock(&manager.state).error = Some(error);
                let _ = manager
                    .app
                    .emit("nabbit://island-config", manager.snapshot());
            }
        }
        return 0;
    }
    if matches!(message, WM_DISPLAYCHANGE | WM_DPICHANGED | WM_SETTINGCHANGE)
        || message == RegisterWindowMessageW(w!("TaskbarCreated"))
    {
        if let Some(manager) = current() {
            manager.refresh()
        }
    }
    DefWindowProcW(hwnd, message, w, l)
}
unsafe extern "system" fn mouse_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 && matches!(w as u32, WM_MOUSEMOVE | WM_LBUTTONDOWN | WM_LBUTTONUP) {
        let point = (*(l as *const MSLLHOOKSTRUCT)).pt;
        if let Some(manager) = current() {
            let sample = Sample {
                x: f64::from(point.x),
                y: f64::from(point.y),
                left_down: MOUSE_LEFT.load(Ordering::Relaxed),
            };
            let state = lock(&manager.state);
            let band = state
                .hosts
                .values()
                .any(|host| input::in_band(input::logical(&host.placement, sample)));
            let follow = state.preferences.monitor_mode == MonitorMode::FollowMouse;
            let hover_wake = state.visibility.values().any(|v| v.base == Gate::Faded);
            drop(state);
            if follow {
                let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) as isize;
                if MOUSE_MONITOR.swap(monitor, Ordering::Relaxed) != monitor {
                    manager.refresh();
                }
            }
            let button = w as u32 != WM_MOUSEMOVE;
            if button {
                MOUSE_LEFT.store(w as u32 == WM_LBUTTONDOWN, Ordering::Relaxed);
            }
            let boundary = MOUSE_BAND.swap(band, Ordering::Relaxed) != band;
            if button || (boundary && (MOUSE_LEFT.load(Ordering::Relaxed) || hover_wake)) {
                // Use this exact hook sample to arm a fast drag before the next
                // far poll. Mouse moves outside the band do not increase polling.
                manager.sample_input(Some(Sample {
                    left_down: MOUSE_LEFT.load(Ordering::Relaxed),
                    ..sample
                }));
                manager.watcher.wake();
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, w, l)
}
unsafe extern "system" fn foreground_hook(
    _: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _: u32,
    _: u32,
) {
    if let Some(manager) = current() {
        if event != EVENT_SYSTEM_FOREGROUND {
            if hwnd == GetForegroundWindow()
                && object == OBJID_WINDOW
                && child == CHILDID_SELF as i32
            {
                manager.watcher.system_changed();
            }
            return;
        }
        let mut process = 0;
        GetWindowThreadProcessId(hwnd, &mut process);
        manager.watcher.foreground(process == std::process::id());
    }
}
fn real_desktop() -> Desktop {
    unsafe extern "system" fn enumerate(
        monitor: HMONITOR,
        _: HDC,
        _: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let result = &mut *(data as *mut Vec<Monitor>);
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(monitor, &mut info as *mut _ as *mut MONITORINFO) == 0 {
            return 1;
        }
        let name = String::from_utf16_lossy(
            &info.szDevice[..info.szDevice.iter().position(|c| *c == 0).unwrap_or(32)],
        );
        let mut device: DISPLAY_DEVICEW = std::mem::zeroed();
        device.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
        let found = EnumDisplayDevicesW(
            info.szDevice.as_ptr(),
            0,
            &mut device,
            EDD_GET_DEVICE_INTERFACE_NAME,
        ) != 0;
        let wide = |value: &[u16]| {
            String::from_utf16_lossy(
                &value[..value.iter().position(|c| *c == 0).unwrap_or(value.len())],
            )
        };
        let key = if found && !wide(&device.DeviceID).is_empty() {
            wide(&device.DeviceID)
        } else {
            name.clone()
        };
        let id = format!("{:x}", Sha256::digest(key.as_bytes()))[..16].to_string();
        let mut x = 96;
        let mut y = 96;
        let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut x, &mut y);
        let rectangle = |r: RECT| Rect {
            x: r.left,
            y: r.top,
            width: r.right.saturating_sub(r.left).max(0) as u32,
            height: r.bottom.saturating_sub(r.top).max(0) as u32,
        };
        result.push(Monitor {
            id,
            name: if found {
                wide(&device.DeviceString)
            } else {
                name
            },
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
            bounds: rectangle(info.monitorInfo.rcMonitor),
            work_area: rectangle(info.monitorInfo.rcWork),
            scale_factor: f64::from(x) / 96.0,
        });
        1
    }
    let mut monitors = vec![];
    let mut cursor = POINT { x: 0, y: 0 };
    unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(enumerate),
            &mut monitors as *mut _ as LPARAM,
        );
        GetCursorPos(&mut cursor);
    }
    let mut taskbar: windows_sys::Win32::UI::Shell::APPBARDATA = unsafe { std::mem::zeroed() };
    taskbar.cbSize = std::mem::size_of_val(&taskbar) as u32;
    let top_taskbar = if unsafe {
        windows_sys::Win32::UI::Shell::SHAppBarMessage(
            windows_sys::Win32::UI::Shell::ABM_GETTASKBARPOS,
            &mut taskbar,
        )
    } != 0
        && taskbar.uEdge == windows_sys::Win32::UI::Shell::ABE_TOP
    {
        let r = taskbar.rc;
        Some(Rect {
            x: r.left,
            y: r.top,
            width: r.right.saturating_sub(r.left).max(0) as u32,
            height: r.bottom.saturating_sub(r.top).max(0) as u32,
        })
    } else {
        None
    };
    Desktop {
        monitors,
        cursor: Point {
            x: cursor.x,
            y: cursor.y,
        },
        top_taskbar,
    }
}
