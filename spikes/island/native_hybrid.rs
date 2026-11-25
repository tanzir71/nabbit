//! Native compact host. WebView2 exists only while a larger surface is open.
use super::{
    native_files,
    native_graphics::Renderer,
    watcher::{self, Controller, Presentation, Target},
};
use crate::{
    island_interaction::Rect,
    island_native_model::{Action, Geometry, Instruction, Motion, Owner, Routing, Surface},
};
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicIsize, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
    time::{Duration, Instant},
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use windows_sys::{
    w,
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::{HiDpi::GetDpiForWindow, WindowsAndMessaging::*},
    },
};

thread_local! { static GRAPHICS:RefCell<Option<Renderer>>=const { RefCell::new(None) }; }
static HOSTS: OnceLock<Mutex<HashMap<isize, Weak<Hybrid>>>> = OnceLock::new();
fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|e| e.into_inner())
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphicsInfo {
    commits: u64,
    surface_draws: u64,
    warp: bool,
    bundled_fonts_loaded: bool,
    composition_clock: Option<(i64, i64)>,
}
struct State {
    routing: Routing,
    web: Option<WebviewWindow>,
    motion: Motion,
    began: Instant,
    hidden: bool,
    native_visible: bool,
    info: GraphicsInfo,
    error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    renderer: &'static str,
    desired: Surface,
    owner: Owner,
    generation: u64,
    web_allocated: bool,
    tray_allocated: bool,
    native_state: Surface,
    geometry: Geometry,
    scale: f32,
    reduced_motion: bool,
    native_visible: bool,
    host_shown: bool,
    graphics: GraphicsInfo,
    last_error: Option<String>,
}
pub struct Hybrid {
    app: AppHandle,
    hwnd: AtomicIsize,
    controller: Arc<Controller>,
    state: Mutex<State>,
    scale: f32,
    reduced: bool,
    weak: OnceLock<Weak<Self>>,
}
impl Hybrid {
    pub fn open(
        app: &AppHandle,
        controller: Arc<Controller>,
        shutdown: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let monitor = app
            .primary_monitor()
            .map_err(|e| e.to_string())?
            .ok_or("No primary monitor")?;
        let mut scale = monitor.scale_factor() as f32;
        if std::env::var_os("NABBIT_ACCEPTANCE_CURSOR").is_some() {
            if let Ok(value) = std::env::var("NABBIT_ACCEPTANCE_NATIVE_SCALE") {
                scale = value
                    .parse::<f32>()
                    .map_err(|_| "Invalid native acceptance scale")?;
                if !(0.75..=3.0).contains(&scale) {
                    return Err("Invalid native acceptance scale".into());
                }
            }
        }
        let mut animations = 1i32;
        unsafe {
            SystemParametersInfoW(
                SPI_GETCLIENTAREAANIMATION,
                0,
                &mut animations as *mut _ as *mut _,
                0,
            );
        }
        let reduced = animations == 0
            || (std::env::var_os("NABBIT_ACCEPTANCE_CURSOR").is_some()
                && std::env::var("NABBIT_ACCEPTANCE_REDUCED_MOTION").as_deref() == Ok("1"));
        let area = monitor.work_area();
        let hwnd = unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let class = WNDCLASSW {
                lpfnWndProc: Some(window_proc),
                hInstance: instance,
                lpszClassName: w!("NabbitNativeCompact"),
                ..std::mem::zeroed()
            };
            if RegisterClassW(&class) == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let handle = CreateWindowExW(
                WS_EX_LAYERED
                    | WS_EX_NOREDIRECTIONBITMAP
                    | WS_EX_NOACTIVATE
                    | WS_EX_TOOLWINDOW
                    | WS_EX_TOPMOST
                    | WS_EX_TRANSPARENT,
                w!("NabbitNativeCompact"),
                w!("Nabbit Native Island Spike"),
                WS_POPUP,
                area.position.x + (area.size.width as i32 - (720.0 * scale).round() as i32) / 2,
                area.position.y,
                (720.0 * scale).round() as i32,
                (460.0 * scale).round() as i32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            if SetLayeredWindowAttributes(handle, 0, 255, LWA_ALPHA) == 0 {
                DestroyWindow(handle);
                return Err(std::io::Error::last_os_error().to_string());
            }
            handle as isize
        };
        let graphics = Renderer::new(hwnd, scale).map_err(|e| e.to_string());
        let graphics = match graphics {
            Ok(v) => v,
            Err(e) => {
                unsafe {
                    DestroyWindow(hwnd as HWND);
                }
                return Err(e);
            }
        };
        let info = GraphicsInfo {
            commits: graphics.commits,
            surface_draws: graphics.surface_draws,
            warp: graphics.warp,
            bundled_fonts_loaded: graphics.bundled_fonts_loaded(),
            composition_clock: graphics.frame_clock().ok(),
        };
        GRAPHICS.with(|value| *value.borrow_mut() = Some(graphics));
        let hybrid = Arc::new(Self {
            app: app.clone(),
            hwnd: AtomicIsize::new(hwnd),
            controller: controller.clone(),
            scale,
            reduced,
            weak: OnceLock::new(),
            state: Mutex::new(State {
                routing: Routing::default(),
                web: None,
                motion: Motion::new(Surface::Idle.geometry(), Surface::Idle, true),
                began: Instant::now(),
                hidden: false,
                native_visible: true,
                info,
                error: None,
            }),
        });
        let _ = hybrid.weak.set(Arc::downgrade(&hybrid));
        lock(HOSTS.get_or_init(Mutex::default)).insert(hwnd, Arc::downgrade(&hybrid));
        app.manage(hybrid.clone());
        unsafe {
            ShowWindow(hwnd as HWND, SW_SHOWNOACTIVATE);
        }
        watcher::spawn_target(hybrid.clone(), controller, shutdown).map_err(|e| e.to_string())?;
        hybrid.acceptance_worker();
        Ok(())
    }
    fn on_main(
        self: &Arc<Self>,
        task: impl FnOnce(Arc<Self>) -> Result<(), String> + Send + 'static,
    ) {
        let this = self.clone();
        let _ = self.app.run_on_main_thread(move || {
            if let Err(error) = task(this.clone()) {
                lock(&this.state).error = Some(error.clone());
                eprintln!("Native island: {error}");
            }
        });
    }
    pub fn request(self: &Arc<Self>, state: Surface) {
        self.on_main(move |this| this.execute(state));
    }
    fn execute(self: &Arc<Self>, next: Surface) -> Result<(), String> {
        {
            let state = lock(&self.state);
            if state.routing.desired == next && next.compact() && !state.routing.web_allocated {
                return Ok(());
            }
        }
        let (action, instruction, initial, web) = {
            let mut state = lock(&self.state);
            let action = state.routing.request(next);
            (
                action,
                state.routing.instruction(),
                state.routing.native_state,
                state.web.clone(),
            )
        };
        match action {
            Action::Native => self.paint(next, true)?,
            Action::OpenWeb => {
                let this = self.clone();
                std::thread::Builder::new()
                    .name("native-island-webview".into())
                    .spawn(move || {
                        if let Err(error) = this.build_web(initial) {
                            this.on_main(move |this| {
                                let mut state = lock(&this.state);
                                state.routing.web_allocated = false;
                                state.routing.desired = state.routing.native_state;
                                Err(error)
                            });
                        }
                    })
                    .map_err(|e| e.to_string())?;
            }
            Action::SendWeb => {
                if let Some(window) = web {
                    window
                        .emit("nabbit://spike-surface", instruction)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        self.controller.signal.wake();
        Ok(())
    }
    // WebView2 creation may pump messages. Never build inside a main-thread
    // event/IPC callback; Tauri documents a Windows deadlock in that context.
    fn build_web(self: &Arc<Self>, initial: Surface) -> Result<(), String> {
        for _ in 0..100 {
            if self.app.get_webview_window("island-spike").is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let script = format!(
            "window.__NABBIT_NATIVE_COMPACT__=true;window.__NABBIT_NATIVE_START__={};",
            serde_json::to_string(&initial).map_err(|e| e.to_string())?
        );
        let window = WebviewWindowBuilder::new(
            &self.app,
            "island-spike",
            WebviewUrl::App("spikes/island/index.html".into()),
        )
        .title("Nabbit Island Spike")
        .inner_size(720.0, 460.0)
        .transparent(true)
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .no_redirection_bitmap(true)
        .disable_drag_drop_handler()
        .initialization_script(&script)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
        let mut rect = unsafe { std::mem::zeroed() };
        unsafe {
            GetWindowRect(self.hwnd.load(Ordering::Relaxed) as HWND, &mut rect);
        }
        window
            .set_position(PhysicalPosition::new(rect.left, rect.top))
            .map_err(|e| e.to_string())?;
        window
            .set_size(PhysicalSize::new(
                (720.0 * self.scale).round() as u32,
                (460.0 * self.scale).round() as u32,
            ))
            .map_err(|e| e.to_string())?;
        let actual = unsafe { GetDpiForWindow(window.hwnd().map_err(|e| e.to_string())?.0 as HWND) }
            as f32
            / 96.0;
        if (self.scale - actual).abs() > 0.01 {
            window
                .set_zoom((self.scale / actual) as f64)
                .map_err(|e| e.to_string())?;
        }
        window
            .set_ignore_cursor_events(true)
            .map_err(|e| e.to_string())?;
        native_files::install(&window).map_err(|e| e.to_string())?;
        lock(&self.state).web = Some(window.clone());
        window.show().map_err(|e| e.to_string())?;
        window
            .emit("nabbit://spike-surface", self.instruction())
            .map_err(|e| e.to_string())?;
        self.controller.signal.wake();
        Ok(())
    }
    pub fn instruction(&self) -> Instruction {
        lock(&self.state).routing.instruction()
    }
    pub fn acknowledge(self: &Arc<Self>, generation: u64, owner: Owner) {
        self.on_main(move |this| {
            let (accepted, desired) = {
                let mut state = lock(&this.state);
                // The page can initialize before its hidden host has been placed/shown.
                // build_web emits the current instruction again after storing the host.
                if state.web.is_none() {
                    return Ok(());
                }
                (
                    state.routing.acknowledge(generation, owner),
                    state.routing.desired,
                )
            };
            if !accepted {
                return Ok(());
            }
            if owner == Owner::Native {
                this.paint(desired, false)?;
                let web = lock(&this.state).web.take();
                if let Some(web) = web {
                    web.destroy().map_err(|e| e.to_string())?;
                }
            }
            this.visibility()?;
            this.ignore(!this.controller.report().decision.interactive)?;
            this.controller.signal.wake();
            Ok(())
        });
    }
    fn paint(&self, next: Surface, animate: bool) -> Result<(), String> {
        let motion = {
            let state = lock(&self.state);
            let current = state.motion.geometry(state.began.elapsed().as_secs_f64());
            Motion::new(current, next, self.reduced || !animate)
        };
        GRAPHICS.with(|graphics| -> Result<(), String> {
            let mut value = graphics.borrow_mut();
            let renderer = value.as_mut().ok_or("Native renderer is closed")?;
            renderer
                .show_state(motion, next, animate, self.reduced)
                .map_err(|e| e.to_string())?;
            let mut state = lock(&self.state);
            state.motion = motion;
            state.began = Instant::now();
            state.info = GraphicsInfo {
                commits: renderer.commits,
                surface_draws: renderer.surface_draws,
                warp: renderer.warp,
                bundled_fonts_loaded: renderer.bundled_fonts_loaded(),
                composition_clock: renderer.frame_clock().ok(),
            };
            Ok(())
        })?;
        self.visibility()
    }
    fn visibility(&self) -> Result<(), String> {
        let visible = {
            let state = lock(&self.state);
            !state.hidden && state.routing.owner == Owner::Native
        };
        if lock(&self.state).native_visible == visible {
            return Ok(());
        }
        GRAPHICS.with(|graphics| -> Result<(), String> {
            let mut graphics = graphics.borrow_mut();
            let renderer = graphics.as_mut().ok_or("Native renderer is closed")?;
            renderer.visible(visible).map_err(|e| e.to_string())?;
            let mut state = lock(&self.state);
            state.native_visible = visible;
            state.info.commits = renderer.commits;
            Ok(())
        })
    }
    pub fn snapshot(&self) -> Snapshot {
        let state = lock(&self.state);
        Snapshot {
            renderer: "Win32 layered + DirectComposition",
            desired: state.routing.desired,
            owner: state.routing.owner,
            generation: state.routing.generation,
            web_allocated: state.web.is_some(),
            tray_allocated: self.app.get_webview_window("main").is_some(),
            native_state: state.routing.native_state,
            geometry: state.motion.geometry(state.began.elapsed().as_secs_f64()),
            scale: self.scale,
            reduced_motion: self.reduced,
            native_visible: state.native_visible,
            host_shown: unsafe { IsWindowVisible(self.hwnd.load(Ordering::Relaxed) as HWND) != 0 },
            graphics: state.info.clone(),
            last_error: state.error.clone(),
        }
    }
    fn acceptance_worker(self: &Arc<Self>) {
        if std::env::var_os("NABBIT_ACCEPTANCE_CURSOR").is_none() {
            return;
        }
        let Some(directory) =
            std::env::var_os("NABBIT_ACCEPTANCE_NATIVE_CONTROL").map(std::path::PathBuf::from)
        else {
            return;
        };
        let weak = Arc::downgrade(self);
        let _ = std::thread::Builder::new()
            .name("native-island-acceptance".into())
            .spawn(move || {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Request {
                    id: String,
                    state: Option<Surface>,
                    capture: Option<String>,
                    prepare_tray: Option<bool>,
                }
                let mut last = String::new();
                while let Some(this) = weak.upgrade() {
                    if this.hwnd.load(Ordering::Relaxed) == 0
                        || this
                            .app
                            .state::<crate::AppState>()
                            .shutdown
                            .load(Ordering::Relaxed)
                    {
                        break;
                    }
                    if let Ok(bytes) = std::fs::read(directory.join("request.json")) {
                        if let Ok(request) = serde_json::from_slice::<Request>(&bytes) {
                            if request.id != last {
                                last = request.id.clone();
                                let path = directory.join("response.json");
                                let capture_dir = directory.clone();
                                if request.prepare_tray == Some(true) {
                                    if let Err(error) = crate::ensure_popover(&this.app) {
                                        lock(&this.state).error = Some(error.to_string());
                                    }
                                }
                                this.on_main(move |this| {
                                    if let Some(state) = request.state {
                                        this.execute(state)?;
                                    }
                                    if request.prepare_tray == Some(false) {
                                        if let Some(window) = this.app.get_webview_window("main") {
                                            window.destroy().map_err(|e| e.to_string())?;
                                        }
                                    }
                                    let capture = if let Some(stem) = request.capture {
                                        if stem.is_empty()
                                            || !stem.bytes().all(|v| {
                                                v.is_ascii_alphanumeric() || b"-_@.".contains(&v)
                                            })
                                            || stem.contains("..")
                                        {
                                            return Err("Invalid capture name".into());
                                        }
                                        Some(GRAPHICS.with(|graphics| {
                                            graphics
                                                .borrow()
                                                .as_ref()
                                                .ok_or("Renderer is closed".to_string())?
                                                .capture(
                                                    this.hwnd.load(Ordering::Relaxed),
                                                    &capture_dir.join(format!("{stem}.bgra")),
                                                )
                                                .map_err(|e| e.to_string())
                                        })?)
                                    } else {
                                        None
                                    };
                                    let payload = serde_json::json!({
                                        "id":request.id, "hybrid":this.snapshot(),
                                        "interaction":this.controller.report(), "capture":capture
                                    });
                                    std::fs::write(
                                        path,
                                        serde_json::to_vec_pretty(&payload)
                                            .map_err(|e| e.to_string())?,
                                    )
                                    .map_err(|e| e.to_string())?;
                                    Ok(())
                                });
                            }
                        }
                    }
                    drop(this);
                    std::thread::sleep(Duration::from_millis(100));
                }
            });
    }
}
impl Target for Hybrid {
    fn hwnd(&self) -> tauri::Result<isize> {
        Ok(self.hwnd.load(Ordering::Relaxed))
    }
    fn native_hitrect(&self) -> Option<Rect> {
        let state = lock(&self.state);
        if state.web.is_some() && state.routing.owner == Owner::Webview {
            return None;
        }
        let geometry = state.motion.geometry(state.began.elapsed().as_secs_f64());
        Rect {
            x: geometry.x() as f64 - 8.0,
            y: -2.0,
            w: geometry.width as f64 + 16.0,
            h: geometry.height as f64 + 16.0,
        }
        .validated()
    }
    fn ignore(&self, ignore: bool) -> Result<(), String> {
        let (web, owner) = {
            let state = lock(&self.state);
            (state.web.clone(), state.routing.owner)
        };
        let native_ignore = ignore || owner == Owner::Webview;
        unsafe {
            let hwnd = self.hwnd.load(Ordering::Relaxed) as HWND;
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let next = if native_ignore {
                style | WS_EX_TRANSPARENT as isize
            } else {
                style & !(WS_EX_TRANSPARENT as isize)
            };
            if next != style {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
            }
        }
        if let Some(web) = web {
            web.set_ignore_cursor_events(ignore || owner != Owner::Webview)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn present(&self, value: Presentation) {
        let Some(this) = self.weak.get().and_then(Weak::upgrade) else {
            return;
        };
        this.on_main(move |this| {
            let (web, next) = {
                let mut state = lock(&this.state);
                state.hidden = value.hidden;
                (state.web.clone(), state.routing.drag(value.dragging))
            };
            if let Some(web) = web {
                let _ = web.emit("nabbit://spike-interaction", value);
            }
            if let Some(next) = next {
                this.execute(next)?;
            }
            this.visibility()
        });
    }
    fn shutdown(&self) {
        let hwnd = self.hwnd.swap(0, Ordering::Relaxed);
        let _ = self.app.run_on_main_thread(move || {
            GRAPHICS.with(|graphics| graphics.borrow_mut().take());
            unsafe {
                DestroyWindow(hwnd as HWND);
            }
            if let Some(hosts) = HOSTS.get() {
                lock(hosts).remove(&hwnd);
            }
        });
    }
}
unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_MOUSEACTIVATE => MA_NOACTIVATE as LRESULT,
        WM_ERASEBKGND => 1,
        WM_PAINT => {
            windows_sys::Win32::Graphics::Gdi::ValidateRect(hwnd, std::ptr::null());
            0
        }
        WM_LBUTTONUP => {
            if let Some(this) = HOSTS
                .get()
                .and_then(|hosts| lock(hosts).get(&(hwnd as isize)).and_then(Weak::upgrade))
            {
                this.request(Surface::Expanded);
            }
            0
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}
