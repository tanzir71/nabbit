//! Per-monitor ownership and hover policy. No window APIs or animation timer.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct DropPayload {
    pub url: Option<String>,
    pub text: Option<String>,
    pub files: Vec<String>,
}
impl DropPayload {
    pub fn validate(&self, zone: &str) -> Result<(), String> {
        if !matches!(zone, "shelf" | "note") {
            return Err("Unsupported drop zone".into());
        }
        for path in &self.files {
            if !std::path::Path::new(path).is_absolute() || !std::path::Path::new(path).is_file() {
                return Err("This item has no disk file path".into());
            }
        }
        if zone == "shelf" {
            return if self.files.is_empty() {
                Err("Drop files here".into())
            } else {
                Ok(())
            };
        }
        if let Some(url) = &self.url {
            let valid = url::Url::parse(url).ok().is_some_and(|url| {
                matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
            });
            if !valid {
                return Err("Use a web link or plain text".into());
            }
        }
        let text = self
            .text
            .as_ref()
            .is_some_and(|text| !text.trim().is_empty())
            || self.url.is_some();
        let images = !self.files.is_empty()
            && self.files.iter().all(|path| {
                std::path::Path::new(path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|ext| {
                        matches!(
                            ext.to_ascii_lowercase().as_str(),
                            "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic"
                        )
                    })
            });
        if !text && !images {
            return Err("Drop text, a link or images here".into());
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Hidden,
    #[default]
    Idle,
    Faded,
    Live,
    Peek,
    Expanded,
    Drop,
}
impl Mode {
    pub fn compact(self) -> bool {
        matches!(self, Self::Hidden | Self::Idle | Self::Faded | Self::Live)
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub outgoing_drag: bool,
    pub state: Mode,
    pub generation: u64,
    pub web_allocated: bool,
    pub web_owner: bool,
    pub opening: bool,
    pub web_hwnd: isize,
    pub focus_tab: Option<String>,
    pub hover_at: Option<u64>,
    pub close_at: Option<u64>,
    pub pending: Option<Mode>,
    pub before_drag: Option<Mode>,
    #[serde(skip)]
    previous_left: bool,
    #[serde(skip)]
    hover_armed: bool,
    #[serde(skip)]
    hover_delay_ms: Option<u64>,
}
impl Default for Session {
    fn default() -> Self {
        Self {
            outgoing_drag: false,
            state: Mode::Idle,
            generation: 0,
            web_allocated: false,
            web_owner: false,
            opening: false,
            web_hwnd: 0,
            focus_tab: None,
            hover_at: None,
            close_at: None,
            pending: None,
            before_drag: None,
            previous_left: false,
            hover_armed: true,
            hover_delay_ms: Some(180),
        }
    }
}
impl Session {
    pub fn can_allocate(&self, registered: bool) -> bool {
        !self.state.compact() && !self.web_allocated && !self.opening && !registered
    }
    pub fn request(&mut self, next: Mode) -> bool {
        if self.state == next {
            return false;
        }
        if !self.state.compact() && next.compact() {
            self.hover_armed = false;
        }
        self.state = next;
        self.generation += 1;
        self.hover_at = None;
        self.close_at = None;
        self.pending = None;
        true
    }
    pub fn acknowledge(&mut self, generation: u64) -> bool {
        if generation != self.generation
            || !self.web_allocated
            || self.pending.is_some_and(|mode| !mode.compact())
        {
            return false;
        }
        self.web_owner = !self.state.compact();
        if !self.web_owner {
            self.web_allocated = false;
        }
        true
    }
    #[cfg(test)]
    pub fn sample(&mut self, inside: bool, dragging: bool, left: bool, now: u64, base: Mode) {
        self.sample_with_hover(inside, dragging, left, now, base, Some(180));
    }
    pub fn sample_with_hover(
        &mut self,
        inside: bool,
        dragging: bool,
        left: bool,
        now: u64,
        base: Mode,
        hover_ms: Option<u64>,
    ) {
        if self.hover_delay_ms != hover_ms {
            self.hover_delay_ms = hover_ms;
            self.hover_at = None;
            if self.pending == Some(Mode::Peek) {
                self.pending = None;
            }
        }
        if self.outgoing_drag {
            if left && base != Mode::Hidden {
                return;
            }
            self.outgoing_drag = false;
        }
        if !inside {
            self.hover_armed = true;
        }
        if base == Mode::Hidden {
            self.hover_at = None;
            self.close_at = None;
            self.before_drag = None;
            if self.state != Mode::Hidden {
                self.pending = Some(base);
            }
        } else if dragging {
            if self.state != Mode::Drop {
                self.before_drag = Some(self.state);
                self.pending = Some(Mode::Drop);
            }
        } else if self.state == Mode::Drop {
            self.pending = Some(self.before_drag.take().unwrap_or(base));
        } else if self.state == Mode::Live
            && inside
            && !left
            && self.hover_armed
            && hover_ms.is_some()
        {
            let due = *self.hover_at.get_or_insert(now + hover_ms.unwrap_or(180));
            if now >= due {
                self.pending = Some(Mode::Peek);
            }
        } else {
            self.hover_at = None;
            if self.state == Mode::Peek {
                if inside {
                    self.close_at = None;
                } else {
                    let due = *self.close_at.get_or_insert(now + 300);
                    if now >= due {
                        self.pending = Some(base);
                    }
                }
            } else if self.state == Mode::Expanded && left && !self.previous_left && !inside {
                self.pending = Some(base);
            }
        }
        self.previous_left = left;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configured_hover_delay_and_off_leave_drag_and_explicit_open_working() {
        let mut s = Session::default();
        s.request(Mode::Live);
        s.sample_with_hover(true, false, false, 0, Mode::Live, Some(500));
        s.sample_with_hover(true, false, false, 499, Mode::Live, Some(500));
        assert_eq!(s.pending, None);
        s.sample_with_hover(true, false, false, 500, Mode::Live, Some(500));
        assert_eq!(s.pending, Some(Mode::Peek));
        s.request(Mode::Live);
        s.sample_with_hover(true, false, false, 1_000, Mode::Live, None);
        assert_eq!(s.pending, None);
        assert_eq!(s.hover_at, None);
        s.sample_with_hover(true, true, true, 1_001, Mode::Live, None);
        assert_eq!(s.pending, Some(Mode::Drop));
        s.request(Mode::Expanded);
        assert_eq!(s.state, Mode::Expanded);
    }
    #[test]
    fn outgoing_drag_keeps_the_source_surface_until_release_but_never_bypasses_hidden_policy() {
        let mut s = Session::default();
        s.request(Mode::Expanded);
        s.outgoing_drag = true;
        s.sample(false, true, true, 1, Mode::Idle);
        assert_eq!(s.pending, None);
        assert!(s.outgoing_drag);
        s.sample(false, false, false, 2, Mode::Idle);
        assert!(!s.outgoing_drag);
        s.outgoing_drag = true;
        s.sample(true, true, true, 3, Mode::Hidden);
        assert!(!s.outgoing_drag);
        assert_eq!(s.pending, Some(Mode::Hidden));
    }
    #[test]
    fn hover_intent_and_leave_are_finite_and_cancelable() {
        let mut s = Session::default();
        s.request(Mode::Live);
        s.sample(true, false, false, 0, Mode::Live);
        s.sample(true, false, false, 179, Mode::Live);
        assert_eq!(s.pending, None);
        s.sample(false, false, false, 180, Mode::Live);
        assert_eq!(s.hover_at, None);
        s.sample(true, false, false, 200, Mode::Live);
        s.sample(true, false, false, 380, Mode::Live);
        assert_eq!(s.pending, Some(Mode::Peek));
        s.request(Mode::Peek);
        s.sample(false, false, false, 400, Mode::Live);
        s.sample(true, false, false, 699, Mode::Live);
        assert_eq!(s.close_at, None);
        s.sample(false, false, false, 700, Mode::Live);
        s.sample(false, false, false, 1000, Mode::Live);
        assert_eq!(s.pending, Some(Mode::Live));
    }
    #[test]
    fn paint_ack_does_not_destroy_a_newer_open_and_compact_needs_no_web() {
        let mut s = Session::default();
        s.request(Mode::Live);
        assert!(!s.web_allocated);
        s.request(Mode::Expanded);
        s.web_allocated = true;
        assert!(s.acknowledge(s.generation));
        assert!(s.web_owner);
        s.request(Mode::Live);
        let old = s.generation;
        s.request(Mode::Expanded);
        assert!(!s.acknowledge(old));
        assert!(s.web_allocated);
        s.request(Mode::Idle);
        assert!(s.acknowledge(s.generation));
        assert!(!s.web_allocated);
        assert!(!s.web_owner);
    }
    #[test]
    fn pending_reopen_rejects_an_older_compact_paint_ack() {
        let mut s = Session::default();
        s.request(Mode::Expanded);
        s.web_allocated = true;
        s.acknowledge(s.generation);
        s.request(Mode::Idle);
        let closing = s.generation;
        s.pending = Some(Mode::Drop);
        assert!(!s.acknowledge(closing));
        assert!(s.web_allocated);
        s.request(Mode::Drop);
        assert!(s.acknowledge(s.generation));
        assert!(s.web_owner);
    }
    #[test]
    fn reopening_waits_for_the_previous_webview_registration_to_disappear() {
        let mut s = Session::default();
        s.request(Mode::Drop);
        assert!(s.can_allocate(false));
        s.web_allocated = true;
        s.request(Mode::Idle);
        assert!(s.acknowledge(s.generation));
        s.request(Mode::Expanded);
        assert!(!s.can_allocate(true));
        assert!(s.can_allocate(false));
        s.opening = true;
        assert!(!s.can_allocate(false));
    }
    #[test]
    fn drag_cancel_restores_expanded_and_suppression_wins() {
        let mut s = Session::default();
        s.request(Mode::Expanded);
        s.sample(true, true, true, 0, Mode::Idle);
        assert_eq!(s.pending, Some(Mode::Drop));
        s.request(Mode::Drop);
        s.sample(false, false, false, 1, Mode::Idle);
        assert_eq!(s.pending, Some(Mode::Expanded));
        s.request(Mode::Drop);
        s.sample(true, true, true, 2, Mode::Hidden);
        assert_eq!(s.pending, Some(Mode::Hidden));
        assert_eq!(s.before_drag, None);
    }
}
