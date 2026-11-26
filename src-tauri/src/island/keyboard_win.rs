//! Focus is requested only by explicit input, with WS_EX_NOACTIVATE retained.
use super::*;
use crate::island::{
    keyboard::{FocusPort, Keyboard, Target, WindowId},
    surface::Mode,
};
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
struct SystemFocus;
fn identity(hwnd: HWND) -> WindowId {
    let mut process = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut process);
    }
    WindowId {
        hwnd: hwnd as u64,
        process,
    }
}
impl FocusPort for SystemFocus {
    fn current(&self) -> WindowId {
        unsafe { identity(GetForegroundWindow()) }
    }
    fn valid(&self, window: WindowId) -> bool {
        unsafe {
            IsWindow(window.hwnd as HWND) != 0
                && IsWindowVisible(window.hwnd as HWND) != 0
                && identity(window.hwnd as HWND) == window
        }
    }
    fn activate(&mut self, window: WindowId) -> bool {
        if !self.valid(window) {
            return false;
        }
        unsafe {
            SetForegroundWindow(window.hwnd as HWND) != 0
                && GetForegroundWindow() == window.hwnd as HWND
        }
    }
}
fn with_focus<T>(state: &mut State, run: impl FnOnce(&mut Keyboard, &mut dyn FocusPort) -> T) -> T {
    if let Some(port) = state.keyboard_fixture.as_mut() {
        run(&mut state.keyboard, port)
    } else {
        run(&mut state.keyboard, &mut SystemFocus)
    }
}
impl Manager {
    pub fn is_expanded(&self, label: &str) -> bool {
        let state = lock(&self.state);
        state.hosts.contains_key(label)
            && state
                .surfaces
                .get(label)
                .is_some_and(|s| s.state == Mode::Expanded)
    }
    fn keyboard_allowed(&self, label: &str) -> bool {
        let snapshot = self
            .app
            .state::<Arc<crate::island::activity_bus::Bus>>()
            .snapshot();
        if snapshot
            .views
            .iter()
            .find(|v| v.label == label)
            .is_none_or(|v| v.gate == Gate::Hidden || v.fullscreen)
        {
            return false;
        }
        let state = lock(&self.state);
        let foreground = state
            .foreground_fixture
            .clone()
            .unwrap_or_else(crate::island::foreground::read);
        state
            .hosts
            .get(label)
            .and_then(|host| {
                state
                    .desktop
                    .monitors
                    .iter()
                    .find(|m| m.id == host.placement.monitor_id)
            })
            .is_some_and(|m| {
                crate::island::visibility::classify(&foreground, m.bounds).0 != Gate::Hidden
            })
    }
    pub fn shortcut_status(&self, error: Option<String>) {
        lock(&self.state).keyboard.shortcut_error = error;
    }
    pub fn toggle_keyboard(&self) -> Result<bool, String> {
        if !self.has_hosts() {
            return Ok(false);
        }
        let this = current().ok_or("Island is unavailable")?;
        self.app
            .run_on_main_thread(move || {
                if let Err(error) = this.toggle_keyboard_ui() {
                    lock(&this.state).error = Some(error);
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(true)
    }
    fn toggle_keyboard_ui(&self) -> Result<(), String> {
        let snapshot = self
            .app
            .state::<Arc<crate::island::activity_bus::Bus>>()
            .snapshot();
        let label = {
            let state = lock(&self.state);
            let preferred = state
                .keyboard
                .preferred_label()
                .filter(|label| state.hosts.contains_key(*label));
            preferred.map(str::to_owned).or_else(|| {
                let monitor = state
                    .desktop
                    .monitors
                    .iter()
                    .find(|m| m.bounds.contains(state.desktop.cursor));
                let mut hosts: Vec<_> = state.hosts.values().collect();
                hosts.sort_by_key(|h| h.placement.label.as_str());
                hosts
                    .iter()
                    .find(|h| monitor.is_some_and(|m| m.id == h.placement.monitor_id))
                    .or_else(|| hosts.first())
                    .map(|h| h.placement.label.clone())
            })
        };
        let Some(label) = label else {
            return Ok(());
        };
        let view = snapshot.views.iter().find(|v| v.label == label);
        if view.is_none_or(|v| v.gate == Gate::Hidden || v.fullscreen) {
            return Ok(());
        }
        let closing = lock(&self.state)
            .surfaces
            .get(&label)
            .is_some_and(|s| matches!(s.state, Mode::Expanded | Mode::Drop));
        if closing {
            let mode = super::web::base(view);
            if let Some(input) = lock(&self.state).inputs.get_mut(&label) {
                input.model.cancel_drag();
            }
            self.request_surface(&label, mode)?;
        } else {
            self.wake_island(&label)?;
            self.begin_keyboard_ui(&label, Target::Tab)?;
            self.request_surface(&label, Mode::Expanded)?;
        }
        Ok(())
    }
    pub fn request_keyboard_focus(&self, label: &str, target: Target) -> Result<(), String> {
        if !lock(&self.state).hosts.contains_key(label) {
            return Err("Only an active island can request keyboard focus".into());
        }
        let this = current().ok_or("Island is unavailable")?;
        let label = label.to_owned();
        self.app
            .run_on_main_thread(move || {
                if let Err(error) = this.begin_keyboard_ui(&label, target) {
                    lock(&this.state).error = Some(error);
                }
            })
            .map_err(|e| e.to_string())
    }
    pub fn keyboard_ready(&self, label: &str, request: u64) -> Result<(), String> {
        if !lock(&self.state)
            .keyboard
            .hint(label)
            .is_some_and(|hint| hint.id == request)
        {
            return Ok(());
        }
        let this = current().ok_or("Island is unavailable")?;
        let label = label.to_owned();
        self.app
            .run_on_main_thread(move || {
                let valid = lock(&this.state)
                    .keyboard
                    .hint(&label)
                    .is_some_and(|hint| hint.id == request);
                if valid {
                    if let Err(error) = this.acquire_keyboard(&label) {
                        lock(&this.state).error = Some(error);
                    }
                }
            })
            .map_err(|e| e.to_string())
    }
    fn begin_keyboard_ui(&self, label: &str, target: Target) -> Result<(), String> {
        if !self.keyboard_allowed(label) {
            return Ok(());
        }
        let mut state = lock(&self.state);
        if !state.hosts.contains_key(label) {
            return Ok(());
        }
        let own_window = state
            .surfaces
            .get(label)
            .map(|s| s.web_hwnd as u64)
            .unwrap_or(0);
        with_focus(&mut state, |keyboard, port| {
            keyboard.begin(label, target, port.current(), own_window)
        });
        drop(state);
        self.acquire_keyboard(label)?;
        if let Some(window) = self.app.get_webview_window(label) {
            window
                .emit("nabbit://island-surface", self.surface_instruction(label)?)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub(super) fn acquire_keyboard(&self, label: &str) -> Result<(), String> {
        if !self.keyboard_allowed(label) {
            self.release_keyboard(label);
            return Ok(());
        }
        let mut state = lock(&self.state);
        let Some(surface) = state
            .surfaces
            .get(label)
            .filter(|s| s.state == Mode::Expanded && s.web_allocated && s.web_hwnd != 0)
        else {
            return Ok(());
        };
        let hwnd = surface.web_hwnd;
        if state.keyboard_fixture.is_none() && unsafe { IsWindowVisible(hwnd as HWND) } == 0 {
            return Ok(());
        }
        let focused = with_focus(&mut state, |keyboard, port| {
            keyboard.ready(
                label,
                WindowId {
                    hwnd: hwnd as u64,
                    process: std::process::id(),
                },
                port,
            )
        });
        let injected = state.keyboard_fixture.is_some();
        drop(state);
        if focused && !injected {
            if let Some(window) = self.app.get_webview_window(label) {
                window
                    .with_webview(move |platform| unsafe {
                        if GetForegroundWindow() == hwnd as HWND {
                            let _ = platform
                                .controller()
                                .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                        }
                    })
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    pub(super) fn release_keyboard(&self, label: &str) {
        with_focus(&mut lock(&self.state), |keyboard, port| {
            keyboard.release(label, port)
        });
    }
    pub(super) fn observe_keyboard(&self) {
        let mut state = lock(&self.state);
        let label = with_focus(&mut state, |keyboard, port| {
            keyboard.observe(port.current())
        });
        if let Some(label) = label {
            if let Some(surface) = state.surfaces.get_mut(&label) {
                surface.pending = Some(Mode::Idle);
            }
            if let Some(input) = state.inputs.get_mut(&label) {
                input.dirty = true;
            }
        }
    }
}
