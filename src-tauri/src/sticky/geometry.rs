//! Monitor-relative logical profiles; native window positions remain physical.
use crate::island::model::{Monitor, Rect};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub monitor: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub pinned: bool,
    pub opacity: u8,
}
impl Profile {
    pub fn new(monitor: &Monitor) -> Self {
        Self {
            monitor: monitor.id.clone(),
            x: 32.,
            y: 64.,
            width: 280.,
            height: 200.,
            pinned: true,
            opacity: 100,
        }
        .clamped(monitor)
    }
    pub fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .into_iter()
            .all(f64::is_finite)
            && (60..=100).contains(&self.opacity)
    }
    pub fn clamped(mut self, monitor: &Monitor) -> Self {
        let scale = scale(monitor);
        let width = f64::from(monitor.work_area.width) / scale;
        let height = f64::from(monitor.work_area.height) / scale;
        if !self.valid() {
            return Self {
                monitor: monitor.id.clone(),
                x: 0.,
                y: 0.,
                width: 280.,
                height: 200.,
                pinned: true,
                opacity: 100,
            }
            .clamped(monitor);
        }
        self.monitor = monitor.id.clone();
        self.width = self.width.clamp(220., 480.).min(width.max(220.));
        self.height = self.height.clamp(120., height.max(120.));
        self.x = self.x.clamp(0., (width - self.width).max(0.));
        self.y = self.y.clamp(0., (height - self.height).max(0.));
        self
    }
    pub fn physical(&self, monitor: &Monitor) -> Rect {
        let s = scale(monitor);
        Rect {
            x: monitor
                .work_area
                .x
                .saturating_add((self.x * s).round() as i32),
            y: monitor
                .work_area
                .y
                .saturating_add((self.y * s).round() as i32),
            width: (self.width * s).round() as u32,
            height: (self.height * s).round() as u32,
        }
    }
    pub fn observed(&self, monitor: &Monitor, rect: Rect) -> Self {
        let s = scale(monitor);
        Self {
            monitor: monitor.id.clone(),
            x: (f64::from(rect.x) - f64::from(monitor.work_area.x)) / s,
            y: (f64::from(rect.y) - f64::from(monitor.work_area.y)) / s,
            width: f64::from(rect.width) / s,
            height: f64::from(rect.height) / s,
            ..self.clone()
        }
        .clamped(monitor)
    }
}
pub fn scale(m: &Monitor) -> f64 {
    if m.scale_factor.is_finite() && m.scale_factor > 0. {
        m.scale_factor
    } else {
        1.
    }
}
pub fn choose<'a>(
    monitors: &'a [Monitor],
    preferred: Option<&str>,
    rect: Option<Rect>,
) -> Option<&'a Monitor> {
    monitors
        .iter()
        .find(|m| Some(m.id.as_str()) == preferred)
        .or_else(|| {
            rect.and_then(|r| {
                monitors
                    .iter()
                    .max_by_key(|m| intersection(m.bounds, r))
                    .filter(|m| intersection(m.bounds, r) > 0)
            })
        })
        .or_else(|| monitors.iter().find(|m| m.primary))
        .or_else(|| monitors.first())
}
fn intersection(a: Rect, b: Rect) -> i64 {
    let x = (i64::from(a.x) + i64::from(a.width)).min(i64::from(b.x) + i64::from(b.width))
        - i64::from(a.x).max(i64::from(b.x));
    let y = (i64::from(a.y) + i64::from(a.height)).min(i64::from(b.y) + i64::from(b.height))
        - i64::from(a.y).max(i64::from(b.y));
    x.max(0) * y.max(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn monitor(id: &str, x: i32, scale: f64) -> Monitor {
        Monitor {
            id: id.into(),
            name: id.into(),
            primary: id == "a",
            bounds: Rect {
                x,
                y: 0,
                width: 1920,
                height: 1080,
            },
            work_area: Rect {
                x,
                y: 40,
                width: 1920,
                height: 1040,
            },
            scale_factor: scale,
        }
    }
    #[test]
    fn profiles_follow_work_area_and_dpi_without_reusing_absolute_coordinates() {
        let a = monitor("a", 0, 1.);
        let b = monitor("b", -1920, 1.5);
        let p = Profile::new(&b);
        assert_eq!(
            p.physical(&b),
            Rect {
                x: -1872,
                y: 136,
                width: 420,
                height: 300
            }
        );
        let resized = monitor("b", -2560, 2.);
        let q = p.clone().clamped(&resized);
        assert_eq!(q.width, 280.);
        assert_eq!(q.physical(&resized).x, -2496);
        assert_eq!(p.observed(&b, p.physical(&b)), p);
        assert_eq!(
            choose(std::slice::from_ref(&a), Some("b"), None)
                .unwrap()
                .id,
            "a"
        );
    }
    #[test]
    fn hostile_or_removed_monitor_geometry_always_keeps_the_title_bar_reachable() {
        let m = monitor("a", 0, 1.);
        let p = Profile {
            monitor: "old".into(),
            x: -9000.,
            y: 9000.,
            width: 900.,
            height: 9000.,
            pinned: false,
            opacity: 60,
        }
        .clamped(&m);
        assert_eq!((p.x, p.y, p.width, p.height), (0., 0., 480., 1040.));
        assert!(!Profile {
            width: f64::NAN,
            ..p.clone()
        }
        .valid());
        let tiny = Monitor {
            work_area: Rect {
                x: 0,
                y: 0,
                width: 100,
                height: 80,
            },
            ..m
        };
        let p = p.clamped(&tiny);
        assert_eq!((p.x, p.y, p.width, p.height), (0., 0., 220., 120.));
    }
    #[test]
    fn selection_prefers_saved_monitor_then_window_overlap_then_primary() {
        let a = monitor("a", 0, 1.);
        let b = monitor("b", -1920, 1.5);
        let monitors = [a, b];
        let rect = Rect {
            x: -1500,
            y: 100,
            width: 300,
            height: 300,
        };
        assert_eq!(choose(&monitors, Some("a"), Some(rect)).unwrap().id, "a");
        assert_eq!(choose(&monitors, None, Some(rect)).unwrap().id, "b");
        assert!(choose(&[], None, None).is_none());
    }
}
