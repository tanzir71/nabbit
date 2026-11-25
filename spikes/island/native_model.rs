//! Platform-free policy and motion shared by the native compact renderer and its tests.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Surface {
    #[default]
    Idle,
    Live,
    Peek,
    Expanded,
    Drop,
}
impl Surface {
    pub fn compact(self) -> bool {
        matches!(self, Self::Idle | Self::Live)
    }
    pub fn geometry(self) -> Geometry {
        let (width, height, radius) = match self {
            Self::Idle => (112.0, 26.0, 13.0),
            Self::Live => (320.0, 32.0, 16.0),
            Self::Peek => (400.0, 74.0, 24.0),
            Self::Expanded => (680.0, 297.0, 28.0),
            Self::Drop => (640.0, 150.0, 24.0),
        };
        Geometry {
            width,
            height,
            radius,
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
pub struct Geometry {
    pub width: f32,
    pub height: f32,
    pub radius: f32,
}
impl Geometry {
    pub fn x(self) -> f32 {
        (720.0 - self.width) / 2.0
    }
    fn lerp(self, other: Self, value: f32) -> Self {
        Self {
            width: self.width + (other.width - self.width) * value,
            height: self.height + (other.height - self.height) * value,
            radius: self.radius + (other.radius - self.radius) * value,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Owner {
    Native,
    Webview,
}
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Instruction {
    pub state: Surface,
    pub owner: Owner,
    pub generation: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Native,
    OpenWeb,
    SendWeb,
}
#[derive(Debug)]
pub struct Routing {
    pub desired: Surface,
    pub native_state: Surface,
    pub owner: Owner,
    pub web_allocated: bool,
    pub generation: u64,
    before_drag: Option<Surface>,
}
impl Default for Routing {
    fn default() -> Self {
        Self {
            desired: Surface::Idle,
            native_state: Surface::Idle,
            owner: Owner::Native,
            web_allocated: false,
            generation: 0,
            before_drag: None,
        }
    }
}
impl Routing {
    pub fn instruction(&self) -> Instruction {
        Instruction {
            state: self.desired,
            owner: if self.desired.compact() {
                Owner::Native
            } else {
                Owner::Webview
            },
            generation: self.generation,
        }
    }
    pub fn request(&mut self, next: Surface) -> Action {
        self.desired = next;
        self.generation += 1;
        if next.compact() && !self.web_allocated {
            self.native_state = next;
            self.owner = Owner::Native;
            Action::Native
        } else if self.web_allocated {
            Action::SendWeb
        } else {
            self.web_allocated = true;
            Action::OpenWeb
        }
    }
    pub fn acknowledge(&mut self, generation: u64, owner: Owner) -> bool {
        if generation != self.generation || owner != self.instruction().owner {
            return false;
        }
        self.owner = owner;
        if owner == Owner::Native {
            self.web_allocated = false;
            self.native_state = self.desired;
        }
        true
    }
    pub fn drag(&mut self, active: bool) -> Option<Surface> {
        if active && self.before_drag.is_none() {
            self.before_drag = Some(self.desired);
            Some(Surface::Drop)
        } else if !active {
            self.before_drag.take()
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Motion {
    pub from: Geometry,
    pub to: Geometry,
    pub duration: f64,
    pub delay: f64,
    pub collapse: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Fade {
    pub from: f32,
    pub to: f32,
    pub delay: f64,
    pub duration: f64,
}
impl Fade {
    pub fn new(from: f32, target: Surface, reduced: bool, animate: bool) -> Self {
        let entering = target == Surface::Live;
        Self {
            from,
            to: if entering { 1.0 } else { 0.0 },
            delay: if animate && entering && !reduced {
                0.060
            } else {
                0.0
            },
            duration: if !animate {
                0.0
            } else if reduced || entering {
                0.120
            } else {
                0.080
            },
        }
    }
    pub fn value(self, elapsed: f64) -> f32 {
        if self.duration == 0.0 {
            return self.to;
        }
        self.from
            + (self.to - self.from)
                * ((elapsed - self.delay) / self.duration).clamp(0.0, 1.0) as f32
    }
}
impl Motion {
    pub fn new(from: Geometry, target: Surface, reduced: bool) -> Self {
        let collapse = target == Surface::Idle;
        Self {
            from,
            to: target.geometry(),
            duration: if reduced {
                0.0
            } else if collapse {
                0.220
            } else {
                0.260
            },
            delay: if !reduced && collapse { 0.080 } else { 0.0 },
            collapse,
        }
    }
    pub fn progress(self, t: f64) -> f32 {
        if self.duration == 0.0 {
            return 1.0;
        }
        let p = ((t - self.delay) / self.duration).clamp(0.0, 1.0);
        let index = (p * 40.0).floor() as usize;
        if index >= 40 {
            return 1.0;
        }
        let fraction = p * 40.0 - index as f64;
        (self.stop(index) + (self.stop(index + 1) - self.stop(index)) * fraction) as f32
    }
    pub fn geometry(self, elapsed: f64) -> Geometry {
        self.from.lerp(self.to, self.progress(elapsed))
    }
    pub fn stop(self, index: usize) -> f64 {
        let p = index as f64 / 40.0;
        if index == 0 {
            return 0.0;
        }
        if index == 40 {
            return 1.0;
        }
        let value = if self.collapse {
            let mut low = 0.0;
            let mut high = 1.0;
            for _ in 0..40 {
                let m = (low + high) / 2.0;
                let x = 0.6 * (1.0 - m) * (1.0 - m) * m + m * m * m;
                if x < p {
                    low = m;
                } else {
                    high = m;
                }
            }
            let m = (low + high) / 2.0;
            3.0 * (1.0 - m) * m * m + m * m * m
        } else {
            let decay: f64 = 16.0;
            let frequency = (380.0 - decay * decay).sqrt();
            let spring = |t: f64| {
                1.0 - (-decay * t).exp()
                    * ((frequency * t).cos() + decay / frequency * (frequency * t).sin())
            };
            spring(p * self.duration) / spring(self.duration)
        };
        (value * 100000.0).round() / 100000.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compact_updates_never_allocate_a_webview() {
        let mut r = Routing::default();
        assert_eq!(r.request(Surface::Live), Action::Native);
        assert!(!r.web_allocated);
        assert_eq!(r.owner, Owner::Native);
    }
    #[test]
    fn native_stays_owner_until_web_paint_ack_and_stale_acks_do_not_close_a_new_view() {
        let mut r = Routing::default();
        assert_eq!(r.request(Surface::Peek), Action::OpenWeb);
        assert_eq!(r.owner, Owner::Native);
        assert!(r.acknowledge(r.generation, Owner::Webview));
        assert_eq!(r.request(Surface::Idle), Action::SendWeb);
        let old = r.generation;
        r.request(Surface::Expanded);
        assert!(!r.acknowledge(old, Owner::Native));
        assert!(r.web_allocated);
        r.request(Surface::Live);
        assert!(r.acknowledge(r.generation, Owner::Native));
        assert!(!r.web_allocated);
        assert_eq!(r.native_state, Surface::Live);
    }
    #[test]
    fn drag_restores_the_original_surface_after_cancel_or_fullscreen() {
        let mut r = Routing::default();
        r.request(Surface::Live);
        assert_eq!(r.drag(true), Some(Surface::Drop));
        r.request(Surface::Drop);
        assert_eq!(r.drag(true), None);
        assert_eq!(r.drag(false), Some(Surface::Live));
        assert_eq!(r.drag(false), None);
    }
    #[test]
    fn native_spring_matches_the_existing_css_sample_and_never_resizes_the_host() {
        let m = Motion::new(Surface::Idle.geometry(), Surface::Live, false);
        assert!((m.geometry(0.130).width - 278.142).abs() < 0.005);
        assert_eq!(m.geometry(0.0), Surface::Idle.geometry());
        assert_eq!(m.geometry(1.0), Surface::Live.geometry());
        assert!((m.geometry(0.130).x() * 2.0 + m.geometry(0.130).width - 720.0).abs() < 0.001);
    }
    #[test]
    fn collapse_holds_for_the_content_fade_and_reduced_motion_has_no_geometry_animation() {
        let from = Surface::Live.geometry();
        let m = Motion::new(from, Surface::Idle, false);
        assert_eq!(m.geometry(0.079), from);
        assert_eq!(m.geometry(0.31), Surface::Idle.geometry());
        assert_eq!(
            Motion::new(from, Surface::Idle, true).geometry(0.0),
            Surface::Idle.geometry()
        );
    }
    #[test]
    fn retarget_starts_from_the_interpolated_geometry() {
        let first = Motion::new(Surface::Idle.geometry(), Surface::Live, false);
        let current = first.geometry(0.050);
        let second = Motion::new(current, Surface::Idle, false);
        assert_eq!(second.geometry(0.0), current);
        assert_eq!(second.geometry(1.0), Surface::Idle.geometry());
    }
    #[test]
    fn interrupted_fades_do_not_flash_content_and_reduced_motion_still_crossfades() {
        let first = Fade::new(0.0, Surface::Live, false, true);
        assert_eq!(first.value(0.050), 0.0);
        let current = first.value(0.100);
        assert!((current - 1.0 / 3.0).abs() < 0.001);
        let second = Fade::new(current, Surface::Idle, false, true);
        assert_eq!(second.value(0.0), current);
        assert_eq!(second.value(0.080), 0.0);
        assert_eq!(Fade::new(0.0, Surface::Live, true, true).value(0.060), 0.5);
        assert_eq!(Fade::new(0.0, Surface::Live, false, false).value(0.0), 1.0);
    }
}
