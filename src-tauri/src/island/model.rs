//! Platform-independent island preferences and physical monitor placement.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Shape {
    Notch,
    #[default]
    #[serde(other)]
    Island,
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Size {
    Small,
    Large,
    #[default]
    #[serde(other)]
    Standard,
}
impl Size {
    pub fn scale(self) -> f64 {
        self.percent() / 100.0
    }
    fn percent(self) -> f64 {
        match self {
            Self::Small => 90.0,
            Self::Standard => 100.0,
            Self::Large => 115.0,
        }
    }
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MonitorMode {
    Primary,
    All,
    Specific,
    #[default]
    #[serde(other)]
    FollowMouse,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub enabled: bool,
    pub shape: Shape,
    pub size: Size,
    pub monitor_mode: MonitorMode,
    pub monitor_id: Option<String>,
    pub peek_on_hover_ms: Option<u64>,
    pub fade_over_maximized: bool,
    pub hide_over_fullscreen: bool,
    pub scroll_to_change_volume: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: true,
            shape: Shape::Island,
            size: Size::Standard,
            monitor_mode: MonitorMode::FollowMouse,
            monitor_id: None,
            peek_on_hover_ms: Some(180),
            fade_over_maximized: true,
            hide_over_fullscreen: true,
            scroll_to_change_volume: true,
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
impl Rect {
    pub fn contains(self, point: Point) -> bool {
        let (x, y) = (i64::from(point.x), i64::from(point.y));
        x >= i64::from(self.x)
            && x < i64::from(self.x) + i64::from(self.width)
            && y >= i64::from(self.y)
            && y < i64::from(self.y) + i64::from(self.height)
    }
    fn valid(self) -> bool {
        self.width > 0 && self.height > 0
    }
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    pub id: String,
    pub name: String,
    pub primary: bool,
    pub bounds: Rect,
    pub work_area: Rect,
    pub scale_factor: f64,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Desktop {
    pub monitors: Vec<Monitor>,
    pub cursor: Point,
    #[serde(default)]
    pub top_taskbar: Option<Rect>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub label: String,
    pub monitor_id: String,
    pub bounds: Rect,
    pub dpi_scale: f64,
    pub size_scale: f64,
    pub render_scale: f64,
    pub shape: Shape,
}
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pill {
    pub width: f64,
    pub height: f64,
    pub top: f64,
    pub top_radius: f64,
    pub bottom_radius: f64,
}
pub fn idle_geometry(shape: Shape) -> Pill {
    match shape {
        Shape::Island => Pill {
            width: 112.0,
            height: 26.0,
            top: 6.0,
            top_radius: 13.0,
            bottom_radius: 13.0,
        },
        // Figma 8:193, the Idle variant of 8:200.
        Shape::Notch => Pill {
            width: 168.0,
            height: 24.0,
            top: 0.0,
            top_radius: 0.0,
            bottom_radius: 12.0,
        },
    }
}

pub fn placements(desktop: &Desktop, preferences: &Preferences) -> Vec<Placement> {
    let mut monitors: Vec<_> = desktop
        .monitors
        .iter()
        .filter(|m| {
            !m.id.is_empty()
                && m.bounds.valid()
                && m.work_area.valid()
                && m.scale_factor.is_finite()
                && (0.5..=8.0).contains(&m.scale_factor)
        })
        .collect();
    monitors.sort_by(|a, b| a.id.cmp(&b.id));
    monitors.dedup_by(|a, b| a.id == b.id);
    if !preferences.enabled || monitors.is_empty() {
        return vec![];
    }
    let primary = monitors
        .iter()
        .copied()
        .find(|m| m.primary)
        .unwrap_or(monitors[0]);
    let selected = match preferences.monitor_mode {
        MonitorMode::All => monitors,
        MonitorMode::Primary => vec![primary],
        MonitorMode::FollowMouse => vec![monitors
            .iter()
            .copied()
            .find(|m| m.bounds.contains(desktop.cursor))
            .unwrap_or(primary)],
        MonitorMode::Specific => vec![monitors
            .iter()
            .copied()
            .find(|m| Some(&m.id) == preferences.monitor_id.as_ref())
            .unwrap_or(primary)],
    };
    selected
        .into_iter()
        .map(|monitor| {
            let size_scale = preferences.size.scale();
            // Multiply integer percentages before division so a 1.5× large
            // host rounds 793.5 to 794, rather than 793.499999… to 793.
            let render_scale = monitor.scale_factor * preferences.size.percent() / 100.0;
            // Fixed for every surface. Only explicit size/DPI/monitor changes resize
            // the host; an activity/morph never changes the HWND bounds.
            let width = (720.0 * render_scale).round() as u32;
            let height = (460.0 * render_scale).round() as u32;
            Placement {
                label: if preferences.monitor_mode == MonitorMode::All {
                    format!("island-{}", monitor.id)
                } else {
                    "island".into()
                },
                monitor_id: monitor.id.clone(),
                bounds: Rect {
                    x: (i64::from(monitor.work_area.x)
                        + (i64::from(monitor.work_area.width) - i64::from(width)) / 2)
                        .clamp(i64::from(i32::MIN), i64::from(i32::MAX))
                        as i32,
                    y: desktop
                        .top_taskbar
                        .filter(|bar| {
                            bar.y == monitor.bounds.y
                                && bar.x
                                    < monitor
                                        .bounds
                                        .x
                                        .saturating_add_unsigned(monitor.bounds.width)
                                && bar.x.saturating_add_unsigned(bar.width) > monitor.bounds.x
                        })
                        .map(|bar| {
                            bar.y
                                .saturating_add_unsigned(bar.height)
                                .max(monitor.work_area.y)
                        })
                        .unwrap_or(monitor.work_area.y),
                    width,
                    height,
                },
                dpi_scale: monitor.scale_factor,
                size_scale,
                render_scale,
                shape: preferences.shape,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn desktop() -> Desktop {
        Desktop {
            monitors: vec![
                Monitor {
                    id: "left".into(),
                    name: "Left".into(),
                    primary: false,
                    bounds: Rect {
                        x: -1920,
                        y: -200,
                        width: 1920,
                        height: 1080,
                    },
                    work_area: Rect {
                        x: -1920,
                        y: -200,
                        width: 1920,
                        height: 1040,
                    },
                    scale_factor: 1.0,
                },
                Monitor {
                    id: "primary".into(),
                    name: "Primary".into(),
                    primary: true,
                    bounds: Rect {
                        x: 0,
                        y: 0,
                        width: 2560,
                        height: 1440,
                    },
                    work_area: Rect {
                        x: 0,
                        y: 0,
                        width: 2560,
                        height: 1380,
                    },
                    scale_factor: 1.5,
                },
            ],
            cursor: Point { x: -200, y: 0 },
            top_taskbar: None,
        }
    }
    #[test]
    fn follows_mouse_across_mixed_dpi_negative_origin_and_shared_edges() {
        let mut d = desktop();
        let p = Preferences::default();
        let first = placements(&d, &p);
        assert_eq!(first[0].monitor_id, "left");
        assert_eq!(
            first[0].bounds,
            Rect {
                x: -1320,
                y: -200,
                width: 720,
                height: 460
            }
        );
        d.cursor = Point { x: 0, y: 0 };
        let next = placements(&d, &p);
        assert_eq!(
            next[0].bounds,
            Rect {
                x: 740,
                y: 0,
                width: 1080,
                height: 690
            }
        );
        assert_eq!(first[0].label, next[0].label);
        d.cursor = Point { x: 9000, y: 9000 };
        assert_eq!(placements(&d, &p)[0].monitor_id, "primary");
    }
    #[test]
    fn primary_all_and_specific_have_deterministic_labels_and_fallback() {
        let mut d = desktop();
        let mut p = Preferences {
            monitor_mode: MonitorMode::Primary,
            ..Preferences::default()
        };
        assert_eq!(placements(&d, &p)[0].monitor_id, "primary");
        p.monitor_mode = MonitorMode::All;
        assert_eq!(
            placements(&d, &p)
                .iter()
                .map(|p| p.label.as_str())
                .collect::<Vec<_>>(),
            vec!["island-left", "island-primary"]
        );
        d.monitors.reverse();
        assert_eq!(placements(&d, &p)[0].label, "island-left");
        p.monitor_mode = MonitorMode::Specific;
        p.monitor_id = Some("left".into());
        assert_eq!(placements(&d, &p)[0].monitor_id, "left");
        d.monitors.retain(|m| m.id != "left");
        assert_eq!(placements(&d, &p)[0].monitor_id, "primary");
        assert_eq!(p.monitor_id.as_deref(), Some("left"));
    }
    #[test]
    fn work_area_covers_top_bottom_and_auto_hide_taskbars() {
        let mut d = desktop();
        let p = Preferences {
            monitor_mode: MonitorMode::Primary,
            ..Preferences::default()
        };
        d.monitors[1].work_area = Rect {
            x: 0,
            y: 60,
            width: 2560,
            height: 1380,
        };
        assert_eq!(placements(&d, &p)[0].bounds.y, 60);
        d.monitors[1].work_area = d.monitors[1].bounds;
        assert_eq!(placements(&d, &p)[0].bounds.y, 0);
        d.top_taskbar = Some(Rect {
            x: 0,
            y: 0,
            width: 2560,
            height: 48,
        });
        assert_eq!(placements(&d, &p)[0].bounds.y, 48);
    }
    #[test]
    fn size_and_shape_compose_with_dpi_without_state_dependent_host_resize() {
        let d = desktop();
        for (size, width, height) in [
            (Size::Small, 972, 621),
            (Size::Standard, 1080, 690),
            (Size::Large, 1242, 794),
        ] {
            for shape in [Shape::Island, Shape::Notch] {
                let p = Preferences {
                    size,
                    shape,
                    monitor_mode: MonitorMode::Primary,
                    ..Preferences::default()
                };
                let placement = &placements(&d, &p)[0];
                assert_eq!(placement.bounds.width, width);
                assert_eq!(placement.bounds.height, height);
                assert_eq!(placement.shape, shape);
            }
        }
        assert_eq!(idle_geometry(Shape::Notch).width, 168.0);
        assert_eq!(idle_geometry(Shape::Notch).top, 0.0);
        assert_eq!(idle_geometry(Shape::Notch).top_radius, 0.0);
        assert_eq!(idle_geometry(Shape::Island).top, 6.0);
    }
    #[test]
    fn disabled_empty_invalid_and_duplicate_layouts_are_safe() {
        let mut d = desktop();
        let mut p = Preferences {
            enabled: false,
            ..Preferences::default()
        };
        assert!(placements(&d, &p).is_empty());
        p.enabled = true;
        d.monitors.clear();
        assert!(placements(&d, &p).is_empty());
        d = desktop();
        d.monitors[0].scale_factor = f64::NAN;
        d.monitors[1].work_area.width = 0;
        assert!(placements(&d, &p).is_empty());
        d = desktop();
        d.monitors.push(d.monitors[0].clone());
        p.monitor_mode = MonitorMode::All;
        assert_eq!(placements(&d, &p).len(), 2);
    }
}
