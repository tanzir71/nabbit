//! Pure V0 hit-test, drag-band and fullscreen policy. No OS or webview dependencies.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn contains(self, point: Point) -> bool {
        // Physical → logical conversion can put an exact edge a few ULPs
        // outside, especially on negative-origin monitors at fractional DPI.
        const EPSILON: f64 = 1e-9;
        point.x >= self.x - EPSILON
            && point.x <= self.x + self.w + EPSILON
            && point.y >= self.y - EPSILON
            && point.y <= self.y + self.h + EPSILON
    }
    pub fn near(self, point: Point) -> bool {
        let dx = (self.x - point.x).max(0.0).max(point.x - self.x - self.w);
        let dy = (self.y - point.y).max(0.0).max(point.y - self.y - self.h);
        dx * dx + dy * dy <= 120.0 * 120.0
    }
    pub fn validated(self) -> Option<Self> {
        if ![self.x, self.y, self.w, self.h]
            .iter()
            .all(|v| v.is_finite())
            || self.w <= 0.0
            || self.h <= 0.0
        {
            return None;
        }
        let x = self.x.max(0.0);
        let y = self.y.max(0.0);
        let w = (self.x + self.w).min(720.0) - x;
        let h = (self.y + self.h).min(460.0) - y;
        (w > 0.0 && h > 0.0).then_some(Self { x, y, w, h })
    }
}

pub const DROP_RECT: Rect = Rect {
    x: 32.0,
    y: 0.0,
    w: 656.0,
    h: 164.0,
};

#[derive(Clone, Copy, Debug)]
pub struct Frame {
    pub origin: Point,
    pub scale: f64,
}
impl Frame {
    pub fn logical(self, physical: Point) -> Point {
        Point {
            x: (physical.x - self.origin.x) / self.scale,
            y: (physical.y - self.origin.y) / self.scale,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Foreground {
    pub notification_state: i32,
    pub rect: Option<Rect>,
    pub monitor: Rect,
    pub on_monitor: bool,
    pub own_process: bool,
    pub desktop: bool,
}
pub fn fullscreen(fg: Foreground) -> bool {
    if !fg.on_monitor || fg.own_process || fg.desktop {
        return false;
    }
    matches!(fg.notification_state, 2..=4)
        || fg.rect.is_some_and(|rect| {
            (rect.x - fg.monitor.x).abs() <= 1.0
                && (rect.y - fg.monitor.y).abs() <= 1.0
                && (rect.w - fg.monitor.w).abs() <= 1.0
                && (rect.h - fg.monitor.h).abs() <= 1.0
        })
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Input {
    pub cursor: Point,
    pub left_down: bool,
    pub in_band: bool,
    pub fullscreen: bool,
    pub faded: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub hidden: bool,
    pub dragging: bool,
    pub interactive: bool,
    pub poll_ms: u64,
}
impl Default for Decision {
    fn default() -> Self {
        Self {
            hidden: false,
            dragging: false,
            interactive: false,
            poll_ms: 500,
        }
    }
}

#[derive(Default)]
pub struct Interaction {
    pub hitrect: Option<Rect>,
    pub ole_drag: bool,
    armed: bool,
    dragging: bool,
}
impl Interaction {
    pub fn arm_drag(&mut self) {
        self.armed = true;
    }
    pub fn with_hitrect(rect: Rect) -> Self {
        Self {
            hitrect: Some(rect),
            ..Self::default()
        }
    }
    pub fn cancel_drag(&mut self) {
        self.ole_drag = false;
        self.armed = false;
        self.dragging = false;
    }
    pub fn step(&mut self, input: Input) -> Decision {
        if input.fullscreen || input.faded {
            self.ole_drag = false;
            self.armed = false;
            self.dragging = false;
            return Decision {
                hidden: input.fullscreen,
                poll_ms: if !input.fullscreen
                    && self.hitrect.is_some_and(|rect| rect.near(input.cursor))
                {
                    25
                } else {
                    500
                },
                ..Decision::default()
            };
        }
        if !input.left_down && !self.ole_drag {
            self.armed = false;
            self.dragging = false;
        } else {
            if input.left_down && !input.in_band {
                self.armed = true;
            }
            if self.ole_drag || (self.armed && input.in_band && input.left_down) {
                self.dragging = true;
            }
            if !input.in_band && !DROP_RECT.contains(input.cursor) {
                self.dragging = false;
                self.ole_drag = false;
            }
        }
        let rect = if self.dragging {
            Some(DROP_RECT)
        } else {
            self.hitrect
        };
        Decision {
            hidden: false,
            dragging: self.dragging,
            interactive: rect.is_some_and(|r| r.contains(input.cursor)),
            poll_ms: if rect.is_some_and(|r| r.near(input.cursor)) {
                25
            } else {
                500
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cursor(x: f64, y: f64) -> Input {
        Input {
            cursor: Point { x, y },
            ..Input::default()
        }
    }
    fn model() -> Interaction {
        Interaction {
            hitrect: Some(Rect {
                x: 296.0,
                y: 0.0,
                w: 128.0,
                h: 40.0,
            }),
            ..Interaction::default()
        }
    }

    #[test]
    fn inside_outside_edges_and_live_rect_updates() {
        let mut m = model();
        assert!(m.step(cursor(360.0, 12.0)).interactive);
        assert!(m.step(cursor(296.0, 0.0)).interactive);
        assert!(m.step(cursor(424.0, 40.0)).interactive);
        assert!(!m.step(cursor(425.0, 40.0)).interactive);
        m.hitrect = Some(Rect {
            x: 20.0,
            y: 6.0,
            w: 680.0,
            h: 297.0,
        });
        assert!(m.step(cursor(600.0, 180.0)).interactive);
        m.hitrect = model().hitrect;
        assert!(!m.step(cursor(600.0, 180.0)).interactive);
    }
    #[test]
    fn adaptive_polling_obeys_the_120_pixel_radius() {
        let mut m = model();
        assert_eq!(m.step(cursor(360.0, 12.0)).poll_ms, 25);
        assert_eq!(m.step(cursor(544.0, 20.0)).poll_ms, 25);
        assert_eq!(m.step(cursor(545.0, 20.0)).poll_ms, 500);
        assert_eq!(m.step(cursor(544.0, 160.0)).poll_ms, 500);
        assert_eq!(m.step(cursor(-2000.0, 1800.0)).poll_ms, 500);
    }
    #[test]
    fn rect_validation_and_physical_dpi_conversion() {
        assert!(Rect {
            x: f64::NAN,
            y: 0.0,
            w: 30.0,
            h: 30.0
        }
        .validated()
        .is_none());
        assert!(Rect {
            x: 800.0,
            y: 0.0,
            w: 20.0,
            h: 20.0
        }
        .validated()
        .is_none());
        assert_eq!(
            Rect {
                x: -8.0,
                y: -2.0,
                w: 120.0,
                h: 42.0
            }
            .validated(),
            Some(Rect {
                x: 0.0,
                y: 0.0,
                w: 112.0,
                h: 40.0
            })
        );
        let f = Frame {
            origin: Point {
                x: -1920.0,
                y: 72.0,
            },
            scale: 1.5,
        };
        assert_eq!(
            f.logical(Point {
                x: -1380.0,
                y: 90.0
            }),
            Point { x: 360.0, y: 12.0 }
        );
    }
    #[test]
    fn drag_from_outside_band_activates_large_target_and_cancel_restores_hitrect() {
        let mut m = model();
        assert!(
            !m.step(Input {
                left_down: true,
                in_band: true,
                ..cursor(80.0, 10.0)
            })
            .dragging,
            "A new click in the band is not an incoming drag"
        );
        m.step(Input {
            left_down: true,
            ..cursor(80.0, 300.0)
        });
        let enter = m.step(Input {
            left_down: true,
            in_band: true,
            ..cursor(80.0, 10.0)
        });
        assert!(
            enter.dragging && enter.interactive,
            "The original idle hitrect does not cover x=80"
        );
        assert!(
            m.step(Input {
                left_down: true,
                ..cursor(80.0, 120.0)
            })
            .dragging
        );
        assert!(
            !m.step(Input {
                left_down: true,
                ..cursor(80.0, 300.0)
            })
            .dragging
        );
        assert!(!m.step(cursor(80.0, 10.0)).interactive);
    }
    #[test]
    fn ole_callback_holds_target_until_drop_and_fullscreen_always_overrides() {
        let mut m = model();
        m.ole_drag = true;
        assert!(m.step(cursor(80.0, 120.0)).dragging);
        let hidden = m.step(Input {
            fullscreen: true,
            ..cursor(360.0, 10.0)
        });
        assert!(hidden.hidden && !hidden.interactive && !hidden.dragging);
        m.ole_drag = false;
        assert!(m.step(cursor(360.0, 10.0)).interactive);
    }
    #[test]
    fn notification_and_borderless_fullscreen_fixtures_exclude_shell_own_and_other_monitors() {
        let monitor = Rect {
            x: 0.0,
            y: 0.0,
            w: 1920.0,
            h: 1080.0,
        };
        let base = Foreground {
            on_monitor: true,
            monitor,
            notification_state: 5,
            ..Foreground::default()
        };
        for notification_state in [2, 3, 4] {
            assert!(fullscreen(Foreground {
                notification_state,
                ..base
            }));
        }
        assert!(fullscreen(Foreground {
            rect: Some(monitor),
            ..base
        }));
        assert!(!fullscreen(Foreground {
            rect: Some(Rect {
                x: -8.0,
                y: -8.0,
                w: 1936.0,
                h: 1056.0
            }),
            ..base
        }));
        for fg in [
            Foreground {
                own_process: true,
                rect: Some(monitor),
                ..base
            },
            Foreground {
                desktop: true,
                rect: Some(monitor),
                ..base
            },
            Foreground {
                on_monitor: false,
                notification_state: 3,
                ..base
            },
            base,
        ] {
            assert!(!fullscreen(fg));
        }
    }
}
