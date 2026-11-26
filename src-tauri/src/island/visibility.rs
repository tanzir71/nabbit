//! Foreground classification and hover wake policy, with an injected monotonic clock.
use super::{input::Gate, model::Rect};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Foreground {
    pub window_id: u64,
    pub rect: Option<Rect>,
    pub monitor: Option<Rect>,
    pub maximised: bool,
    pub minimised: bool,
    pub visible: bool,
    pub cloaked: bool,
    pub own_process: bool,
    pub desktop: bool,
    pub notification_state: Option<i32>,
}
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    #[default]
    None,
    Notification,
    Borderless,
    Maximised,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub label: String,
    pub mode: Gate,
    pub base: Gate,
    pub reason: Reason,
    pub opacity: f64,
    pub revision: u64,
}
pub fn same_rect(a: Rect, b: Rect) -> bool {
    a.width > 0
        && a.height > 0
        && b.width > 0
        && b.height > 0
        && (i64::from(a.x) - i64::from(b.x)).abs() <= 1
        && (i64::from(a.y) - i64::from(b.y)).abs() <= 1
        && (i64::from(a.x) + i64::from(a.width) - i64::from(b.x) - i64::from(b.width)).abs() <= 1
        && (i64::from(a.y) + i64::from(a.height) - i64::from(b.y) - i64::from(b.height)).abs() <= 1
}
pub fn classify(foreground: &Foreground, monitor: Rect) -> (Gate, Reason) {
    if foreground.window_id == 0
        || !foreground.visible
        || foreground.minimised
        || foreground.cloaked
        || foreground.own_process
        || foreground.desktop
        || !foreground.monitor.is_some_and(|m| same_rect(m, monitor))
    {
        return (Gate::Visible, Reason::None);
    }
    if matches!(foreground.notification_state, Some(2..=4)) {
        return (Gate::Hidden, Reason::Notification);
    }
    // Maximised with an auto-hide taskbar can cover the full monitor. It still
    // has the maximised affordance; notification fullscreen takes precedence.
    if foreground.maximised {
        return (Gate::Faded, Reason::Maximised);
    }
    if foreground.rect.is_some_and(|r| same_rect(r, monitor)) {
        return (Gate::Hidden, Reason::Borderless);
    }
    (Gate::Visible, Reason::None)
}
#[derive(Default)]
pub struct Visibility {
    pub mode: Gate,
    pub base: Gate,
    pub reason: Reason,
    pub revision: u64,
    foreground: u64,
    hover_since: Option<u64>,
    awake: bool,
    explicit: bool,
}
impl Visibility {
    pub fn wake(&mut self) {
        self.explicit = true;
    }
    pub fn release(&mut self) {
        self.explicit = false;
        self.awake = false;
        self.hover_since = None;
    }
    pub fn step(
        &mut self,
        fg: &Foreground,
        monitor: Rect,
        in_band: bool,
        in_rect: bool,
        now_ms: u64,
        override_gate: Option<Gate>,
    ) -> bool {
        if self.foreground != fg.window_id {
            self.release();
            self.foreground = fg.window_id;
        }
        let (base, reason) = override_gate
            .map(|gate| (gate, Reason::None))
            .unwrap_or_else(|| classify(fg, monitor));
        // The V2.2 acceptance seam forces input gates; it must not hover-wake.
        let mode = if override_gate.is_some() {
            self.release();
            base
        } else {
            match base {
                Gate::Hidden => {
                    self.release();
                    Gate::Hidden
                }
                Gate::Visible => {
                    self.release();
                    Gate::Visible
                }
                Gate::Faded => {
                    if self.explicit {
                        self.awake = true;
                    } else if !in_band && !in_rect {
                        self.release();
                    }
                    if !self.awake && in_band {
                        let since = *self.hover_since.get_or_insert(now_ms);
                        if now_ms.saturating_sub(since) >= 400 {
                            self.awake = true;
                        }
                    } else if !in_band && !self.awake {
                        self.hover_since = None;
                    }
                    if self.awake {
                        Gate::Visible
                    } else {
                        Gate::Faded
                    }
                }
            }
        };
        let changed = (self.mode, self.base, self.reason) != (mode, base, reason);
        self.mode = mode;
        self.base = base;
        self.reason = reason;
        if changed {
            self.revision += 1;
        }
        changed
    }
    pub fn report(&self, label: &str) -> Report {
        Report {
            label: label.into(),
            mode: self.mode,
            base: self.base,
            reason: self.reason,
            opacity: self.mode.opacity(),
            revision: self.revision,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn monitor() -> Rect {
        Rect {
            x: -1920,
            y: -200,
            width: 1920,
            height: 1080,
        }
    }
    fn foreground() -> Foreground {
        Foreground {
            window_id: 42,
            monitor: Some(monitor()),
            visible: true,
            notification_state: Some(5),
            rect: Some(Rect {
                x: -1800,
                y: -100,
                width: 1000,
                height: 700,
            }),
            ..Foreground::default()
        }
    }
    #[test]
    fn notification_states_are_scoped_and_ignore_shell_own_and_invisible_windows() {
        let mut fg = foreground();
        for state in [2, 3, 4] {
            fg.notification_state = Some(state);
            assert_eq!(classify(&fg, monitor()).0, Gate::Hidden);
        }
        for state in [None, Some(1), Some(5), Some(6), Some(7), Some(99)] {
            fg.notification_state = state;
            assert_eq!(classify(&fg, monitor()).0, Gate::Visible);
        }
        fg.notification_state = Some(3);
        let other = Rect {
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
        };
        assert_eq!(classify(&fg, other).0, Gate::Visible);
        for property in 0..5 {
            let mut ignored = fg.clone();
            match property {
                0 => ignored.own_process = true,
                1 => ignored.desktop = true,
                2 => ignored.visible = false,
                3 => ignored.cloaked = true,
                _ => ignored.minimised = true,
            };
            assert_eq!(classify(&ignored, monitor()).0, Gate::Visible);
        }
    }
    #[test]
    fn borderless_geometry_and_maximised_auto_hide_are_distinct() {
        let mut fg = foreground();
        fg.rect = Some(monitor());
        assert_eq!(classify(&fg, monitor()), (Gate::Hidden, Reason::Borderless));
        fg.rect.as_mut().unwrap().x += 1;
        assert_eq!(classify(&fg, monitor()).0, Gate::Hidden);
        fg.rect.as_mut().unwrap().x += 2;
        assert_eq!(classify(&fg, monitor()).0, Gate::Visible);
        fg.maximised = true;
        fg.rect = Some(monitor());
        assert_eq!(classify(&fg, monitor()).0, Gate::Faded);
        fg.notification_state = Some(3);
        assert_eq!(classify(&fg, monitor()).0, Gate::Hidden);
        fg.notification_state = None;
        fg.rect.as_mut().unwrap().height = 0;
        assert_eq!(classify(&fg, monitor()).0, Gate::Faded);
    }
    #[test]
    fn hover_intent_requires_400ms_and_resets_on_leave_or_foreground_change() {
        let mut fg = foreground();
        fg.maximised = true;
        let mut state = Visibility::default();
        state.step(&fg, monitor(), true, false, 10, None);
        assert_eq!(state.mode, Gate::Faded);
        state.step(&fg, monitor(), true, false, 409, None);
        assert_eq!(state.mode, Gate::Faded);
        state.step(&fg, monitor(), true, false, 410, None);
        assert_eq!(state.mode, Gate::Visible);
        state.step(&fg, monitor(), false, true, 430, None);
        assert_eq!(state.mode, Gate::Visible);
        state.step(&fg, monitor(), false, false, 440, None);
        assert_eq!(state.mode, Gate::Faded);
        state.step(&fg, monitor(), true, false, 500, None);
        fg.window_id += 1;
        state.step(&fg, monitor(), true, false, 900, None);
        assert_eq!(state.mode, Gate::Faded);
        state.step(&fg, monitor(), true, false, 1300, None);
        assert_eq!(state.mode, Gate::Visible);
    }
    #[test]
    fn explicit_wake_cannot_override_fullscreen_and_recovers_without_stale_hover() {
        let mut fg = foreground();
        fg.maximised = true;
        let mut state = Visibility::default();
        state.step(&fg, monitor(), false, false, 0, None);
        state.wake();
        state.step(&fg, monitor(), false, false, 1, None);
        assert_eq!(state.mode, Gate::Visible);
        fg.notification_state = Some(2);
        state.step(&fg, monitor(), true, true, 100, None);
        assert_eq!(state.mode, Gate::Hidden);
        state.wake();
        state.step(&fg, monitor(), true, true, 200, None);
        assert_eq!(state.mode, Gate::Hidden);
        fg.notification_state = Some(5);
        state.step(&fg, monitor(), true, true, 300, None);
        assert_eq!(state.mode, Gate::Faded);
        state.step(&fg, monitor(), true, true, 700, None);
        assert_eq!(state.mode, Gate::Visible);
        fg.maximised = false;
        state.step(&fg, monitor(), false, false, 800, None);
        assert_eq!(state.mode, Gate::Visible);
        assert_eq!(state.mode.opacity(), 1.0);
    }
}
