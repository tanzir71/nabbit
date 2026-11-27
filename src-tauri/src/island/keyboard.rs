//! Explicit-input focus ownership. Activity and hover never create a request.
use serde::{Deserialize, Serialize};
pub fn validate_shortcut(settings: &crate::db::models::AppSettings) -> Result<(), String> {
    let timer = crate::timer::SHORTCUT
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| e.to_string())?;
    for value in [
        &settings.selected_text_shortcut,
        &settings.island_shortcut,
        &settings.toggle_popover_shortcut,
        &settings.quick_download_shortcut,
        &settings.clipboard_search_shortcut,
    ] {
        if value.parse::<tauri_plugin_global_shortcut::Shortcut>().ok() == Some(timer) {
            return Err("Ctrl+Alt+T is reserved for the focus timer".into());
        }
    }
    if !settings.selected_text_shortcut.trim().is_empty() {
        let selected = settings
            .selected_text_shortcut
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .map_err(|_| "Enter a valid selected-link shortcut".to_string())?;
        for other in [
            crate::notes::capture::SHORTCUT,
            &settings.island_shortcut,
            &settings.toggle_popover_shortcut,
            &settings.quick_download_shortcut,
            &settings.clipboard_search_shortcut,
        ] {
            if other.parse::<tauri_plugin_global_shortcut::Shortcut>().ok() == Some(selected) {
                return Err(
                    "The selected-link shortcut conflicts with another Nabbit shortcut".into(),
                );
            }
        }
    }
    let capture = crate::notes::capture::SHORTCUT
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| e.to_string())?;
    for value in [
        &settings.island_shortcut,
        &settings.toggle_popover_shortcut,
        &settings.quick_download_shortcut,
        &settings.clipboard_search_shortcut,
    ] {
        if value.parse::<tauri_plugin_global_shortcut::Shortcut>().ok() == Some(capture) {
            return Err("Ctrl+Alt+N is reserved for quick note capture".into());
        }
    }
    let value = settings.island_shortcut.trim();
    if value.is_empty() {
        return Ok(());
    }
    let parsed = value
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|_| "Enter a valid island shortcut".to_string())?;
    for other in [
        &settings.toggle_popover_shortcut,
        &settings.quick_download_shortcut,
        &settings.clipboard_search_shortcut,
    ] {
        if other.parse::<tauri_plugin_global_shortcut::Shortcut>().ok() == Some(parsed) {
            return Err("The island shortcut conflicts with another Nabbit shortcut".into());
        }
    }
    Ok(())
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowId {
    pub hwnd: u64,
    pub process: u32,
}
pub trait FocusPort {
    fn current(&self) -> WindowId;
    fn valid(&self, window: WindowId) -> bool;
    fn activate(&mut self, window: WindowId) -> bool;
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    #[default]
    Tab,
    Preserve,
    Notes,
}
#[derive(Clone, Debug, Serialize)]
pub struct Hint {
    pub id: u64,
    pub target: Target,
}
#[derive(Clone, Debug, Serialize)]
pub struct Request {
    pub label: String,
    pub hint: Hint,
    pub origin: WindowId,
    previous: Option<WindowId>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Lease {
    pub label: String,
    pub window: WindowId,
    pub request_id: u64,
    pub active: bool,
    previous: Option<WindowId>,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyboard {
    pub request: Option<Request>,
    pub lease: Option<Lease>,
    pub requests: u64,
    pub acquired: u64,
    pub denied: u64,
    pub cancelled: u64,
    pub lost: u64,
    pub restore_attempts: u64,
    pub restored: u64,
    pub shortcut_error: Option<String>,
    pub injected_focus: bool,
}
impl Keyboard {
    pub fn hint(&self, label: &str) -> Option<Hint> {
        self.request
            .as_ref()
            .filter(|r| r.label == label)
            .map(|r| r.hint.clone())
    }
    pub fn preferred_label(&self) -> Option<&str> {
        self.request
            .as_ref()
            .map(|r| r.label.as_str())
            .or_else(|| self.lease.as_ref().map(|l| l.label.as_str()))
    }
    pub fn begin(&mut self, label: &str, target: Target, current: WindowId, own_window: u64) {
        if target == Target::Preserve
            && self
                .lease
                .as_ref()
                .is_some_and(|l| l.label == label && l.active && l.window == current)
        {
            return;
        }
        let previous = if self
            .lease
            .as_ref()
            .is_some_and(|lease| lease.window == current)
            || current.hwnd == own_window
        {
            self.lease
                .as_ref()
                .and_then(|l| l.previous)
                .or_else(|| self.request.as_ref().and_then(|r| r.previous))
        } else {
            (current.hwnd != 0).then_some(current)
        };
        self.requests += 1;
        self.request = Some(Request {
            label: label.into(),
            hint: Hint {
                id: self.requests,
                target,
            },
            origin: current,
            previous,
        });
    }
    pub fn ready(&mut self, label: &str, window: WindowId, port: &mut dyn FocusPort) -> bool {
        let Some(request) = self.request.as_ref().filter(|r| r.label == label).cloned() else {
            return false;
        };
        if self
            .lease
            .as_ref()
            .is_some_and(|l| l.request_id == request.hint.id)
        {
            return false;
        }
        let current = port.current();
        if current != request.origin && current != window {
            self.request = None;
            self.cancelled += 1;
            return false;
        }
        let acquired = current == window || port.activate(window);
        if acquired {
            self.acquired += 1;
        } else {
            self.denied += 1;
        }
        self.lease = Some(Lease {
            label: label.into(),
            window,
            request_id: request.hint.id,
            active: acquired,
            previous: request.previous,
        });
        acquired
    }
    pub fn paste_ticket(
        &self,
        label: &str,
        current: WindowId,
    ) -> Option<crate::clipboard::pick::Ticket> {
        let lease = self
            .lease
            .as_ref()
            .filter(|l| l.label == label && l.active && l.window == current)?;
        let target = lease
            .previous
            .filter(|w| w.hwnd != 0 && w.process != 0 && w.process != current.process)?;
        Some(crate::clipboard::pick::Ticket {
            window: lease.window,
            target,
            request_id: lease.request_id,
        })
    }
    pub fn release(&mut self, label: &str, port: &mut dyn FocusPort) {
        if self.request.as_ref().is_some_and(|r| r.label == label) {
            self.request = None;
        }
        if !self.lease.as_ref().is_some_and(|l| l.label == label) {
            return;
        }
        let lease = self.lease.take().expect("checked lease");
        if lease.active && port.current() == lease.window {
            if let Some(previous) = lease.previous.filter(|w| port.valid(*w)) {
                self.restore_attempts += 1;
                if port.activate(previous) {
                    self.restored += 1;
                }
            }
        }
    }
    pub fn observe(&mut self, current: WindowId) -> Option<String> {
        if current.hwnd == 0
            || !self
                .lease
                .as_ref()
                .is_some_and(|l| l.active && l.window != current)
        {
            return None;
        }
        let label = self.lease.take()?.label;
        self.request = None;
        self.lost += 1;
        Some(label)
    }
}
#[derive(Clone)]
pub struct FixtureFocus {
    pub current: WindowId,
    pub allowed: bool,
}
impl Default for FixtureFocus {
    fn default() -> Self {
        Self {
            current: WindowId {
                hwnd: 9001,
                process: 9001,
            },
            allowed: true,
        }
    }
}
impl FocusPort for FixtureFocus {
    fn current(&self) -> WindowId {
        self.current
    }
    fn valid(&self, window: WindowId) -> bool {
        window.hwnd != 0
    }
    fn activate(&mut self, window: WindowId) -> bool {
        if self.allowed {
            self.current = window;
        }
        self.allowed
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    const OWN: WindowId = WindowId {
        hwnd: 2,
        process: 2,
    };
    #[test]
    fn remapping_validates_syntax_and_preserves_legacy_bindings() {
        let mut settings = crate::db::models::AppSettings::default();
        let legacy = settings.toggle_popover_shortcut.clone();
        settings.island_shortcut = "Ctrl+Alt+Shift+F9".into();
        assert!(validate_shortcut(&settings).is_ok());
        settings.island_shortcut = legacy.clone();
        assert!(validate_shortcut(&settings).is_err());
        settings.island_shortcut = "not+a+shortcut".into();
        assert!(validate_shortcut(&settings).is_err());
        settings.island_shortcut = String::new();
        assert!(validate_shortcut(&settings).is_ok());
        assert_eq!(settings.toggle_popover_shortcut, legacy);
    }
    #[test]
    fn opening_from_the_full_app_restores_that_window() {
        let main = WindowId {
            hwnd: 20,
            process: 2,
        };
        let mut port = FixtureFocus {
            current: main,
            ..Default::default()
        };
        let mut keyboard = Keyboard::default();
        keyboard.begin("island", Target::Tab, main, OWN.hwnd);
        keyboard.ready("island", OWN, &mut port);
        // The full app is not an external paste destination.
        assert!(keyboard.paste_ticket("island", OWN).is_none());
        keyboard.release("island", &mut port);
        assert_eq!(port.current(), main);
    }
    #[test]
    fn paste_ticket_is_bound_to_one_live_external_focus_lease() {
        let mut keyboard = Keyboard::default();
        let mut port = FixtureFocus::default();
        let original = port.current();
        assert!(keyboard.paste_ticket("a", OWN).is_none());
        keyboard.begin("a", Target::Tab, original, OWN.hwnd);
        assert!(keyboard.paste_ticket("a", OWN).is_none());
        assert!(keyboard.ready("a", OWN, &mut port));
        let ticket = keyboard.paste_ticket("a", OWN).unwrap();
        assert_eq!(ticket.target, original);
        assert!(keyboard.paste_ticket("b", OWN).is_none());
        assert!(keyboard.paste_ticket("a", original).is_none());
        keyboard.release("a", &mut port);
        assert_eq!(port.current(), original);
        assert!(keyboard.paste_ticket("a", OWN).is_none());
        keyboard.begin("a", Target::Tab, original, OWN.hwnd);
        assert!(keyboard.ready("a", OWN, &mut port));
        assert_ne!(keyboard.paste_ticket("a", OWN).unwrap(), ticket);
        keyboard.observe(original);
        assert!(keyboard.paste_ticket("a", OWN).is_none());
    }
    #[test]
    fn closed_or_reused_origin_is_never_activated_on_release() {
        struct Gone(FixtureFocus);
        impl FocusPort for Gone {
            fn current(&self) -> WindowId {
                self.0.current()
            }
            fn valid(&self, _: WindowId) -> bool {
                false
            }
            fn activate(&mut self, window: WindowId) -> bool {
                self.0.activate(window)
            }
        }
        let mut k = Keyboard::default();
        let mut p = Gone(FixtureFocus::default());
        k.begin("island", Target::Tab, p.current(), 2);
        k.ready("island", OWN, &mut p);
        k.release("island", &mut p);
        assert_eq!(k.restore_attempts, 0);
    }
    #[test]
    fn explicit_focus_is_once_per_request_and_returns_to_original_window() {
        let mut keyboard = Keyboard::default();
        let mut port = FixtureFocus::default();
        let original = port.current();
        keyboard.begin("island", Target::Tab, original, 2);
        assert!(keyboard.ready("island", OWN, &mut port));
        assert!(!keyboard.ready("island", OWN, &mut port));
        keyboard.begin("island", Target::Preserve, OWN, 2);
        assert_eq!(keyboard.requests, 1);
        keyboard.release("island", &mut port);
        assert_eq!(port.current(), original);
        assert_eq!(keyboard.restored, 1);
    }
    #[test]
    fn notes_capture_target_uses_the_same_explicit_focus_lease() {
        let mut keyboard = Keyboard::default();
        let mut port = FixtureFocus::default();
        let original = port.current();
        keyboard.begin("island", Target::Notes, original, 2);
        assert_eq!(keyboard.hint("island").unwrap().target, Target::Notes);
        assert_eq!(serde_json::to_string(&Target::Notes).unwrap(), "\"notes\"");
        assert!(keyboard.ready("island", OWN, &mut port));
        keyboard.release("island", &mut port);
        assert_eq!(port.current(), original);
        let mut settings = crate::db::models::AppSettings::default();
        assert!(validate_shortcut(&settings).is_ok());
        settings.quick_download_shortcut = "Alt+Ctrl+N".into();
        assert!(validate_shortcut(&settings)
            .unwrap_err()
            .contains("reserved"));
    }
    #[test]
    fn no_request_no_activation_and_delayed_open_never_takes_a_new_foreground() {
        let mut k = Keyboard::default();
        let mut p = FixtureFocus::default();
        assert!(!k.ready("island", OWN, &mut p));
        k.begin("island", Target::Tab, p.current(), 2);
        p.current.hwnd = 99;
        assert!(!k.ready("island", OWN, &mut p));
        assert_eq!(p.current.hwnd, 99);
        assert_eq!(k.cancelled, 1);
    }
    #[test]
    fn outside_switch_denial_and_pending_close_never_restore_or_retry() {
        let mut k = Keyboard::default();
        let mut p = FixtureFocus {
            allowed: false,
            ..Default::default()
        };
        k.begin("island", Target::Tab, p.current(), 2);
        assert!(!k.ready("island", OWN, &mut p));
        p.allowed = true;
        assert!(!k.ready("island", OWN, &mut p));
        k.release("island", &mut p);
        assert_eq!(k.restore_attempts, 0);
        k.begin("island", Target::Tab, p.current(), 2);
        assert!(k.ready("island", OWN, &mut p));
        p.current = WindowId {
            hwnd: 3,
            process: 3,
        };
        assert_eq!(k.observe(p.current()), Some("island".into()));
        k.release("island", &mut p);
        assert_eq!(p.current.hwnd, 3);
        k.begin("island", Target::Tab, p.current(), 2);
        k.release("island", &mut p);
        assert!(!k.ready("island", OWN, &mut p));
    }
    #[test]
    fn monitor_transfer_keeps_external_origin_and_ignores_other_labels() {
        let mut k = Keyboard::default();
        let mut p = FixtureFocus::default();
        let original = p.current();
        k.begin("a", Target::Tab, original, 2);
        k.ready("a", OWN, &mut p);
        k.begin("b", Target::Tab, OWN, 2);
        assert!(!k.ready("a", OWN, &mut p));
        let other = WindowId {
            hwnd: 4,
            process: 2,
        };
        k.ready("b", other, &mut p);
        k.release("a", &mut p);
        assert_eq!(p.current(), other);
        k.release("b", &mut p);
        assert_eq!(p.current(), original);
    }
}
