//! Message-driven production island hosts. All HWND/COM work stays on the UI thread.
use super::{model::*, renderer::Renderer};
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
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager as TauriManager};
use windows_sys::{
    w,
    Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::LibraryLoader::GetModuleHandleW,
        UI::{HiDpi::*, WindowsAndMessaging::*},
    },
};

const REFRESH: u32 = WM_APP + 91;
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
    preferences: Preferences,
    desktop: Desktop,
    fixture: Option<Desktop>,
    hosts: HashMap<String, Host>,
    reconciliations: u64,
    error: Option<String>,
}
pub struct Manager {
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
            app: app.clone(),
            control: control as isize,
            pending: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            hook: AtomicIsize::new(0),
            state: Mutex::new(State {
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
        if let Err(error) = manager.reconcile() {
            manager.stop();
            return Err(error);
        }
        manager.acceptance_worker();
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
                create_host(&placement)?
            };
            lock(&self.state)
                .hosts
                .insert(placement.label.clone(), host);
        }
        {
            let mut state = lock(&self.state);
            state.desktop = desktop;
            state.reconciliations += 1;
            state.error = None;
        }
        self.update_hook(
            preferences.enabled && preferences.monitor_mode == MonitorMode::FollowMouse,
        )?;
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
        }
        Ok(())
    }
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::Relaxed) {
            return;
        }
        CONTROL.store(0, Ordering::Relaxed);
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
                            let weak = weak.clone();
                            let path = path.clone();
                            let response_path = response_path.clone();
                            let _ = app.run_on_main_thread(move || {
                                if let Some(manager) = weak.upgrade() {
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
    id: String,
    desktop: Option<Desktop>,
    preferences: Option<Preferences>,
    capture: Option<Capture>,
    #[serde(rename = "prepareTray")]
    prepare_tray: Option<bool>,
    quit: Option<bool>,
}
#[derive(Deserialize)]
struct Capture {
    label: String,
    stem: String,
}

fn create_host(placement: &Placement) -> Result<Host, String> {
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
        let renderer = match Renderer::new(handle, placement) {
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
    if code >= 0 && w as u32 == WM_MOUSEMOVE {
        let point = (*(l as *const MSLLHOOKSTRUCT)).pt;
        let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) as isize;
        if MOUSE_MONITOR.swap(monitor, Ordering::Relaxed) != monitor {
            let control = CONTROL.load(Ordering::Relaxed);
            if control != 0 {
                if let Some(manager) = current() {
                    manager.refresh()
                }
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, w, l)
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
