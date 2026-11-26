//! Reference logical coordinates (720×460), independent of user size and DPI.
use super::model::{idle_geometry, Placement};
use crate::island_interaction::{Decision, Frame, Input, Interaction, Point, Rect};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Sample {
    pub x: f64,
    pub y: f64,
    pub left_down: bool,
}
impl Sample {
    pub fn valid(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}
#[derive(Clone, Copy, Default, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Gate {
    #[default]
    Visible,
    Hidden,
    Faded,
}
impl Gate {
    pub fn opacity(self) -> f64 {
        match self {
            Self::Visible => 1.0,
            Self::Faded => 0.35,
            Self::Hidden => 0.0,
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub label: String,
    pub hitrect: Option<Rect>,
    pub decision: Decision,
    pub interactive: bool,
    pub revision: u64,
    pub source: &'static str,
}
pub struct HostInput {
    pub left_down: bool,
    pub fade: FadeInput,
    gated_drag_armed: bool,
    pub model: Interaction,
    pub decision: Decision,
    pub applied: Decision,
    pub revision: u64,
    pub web: bool,
    pub gate: Gate,
    pub dirty: bool,
}
impl HostInput {
    pub fn new(placement: &Placement) -> Self {
        Self {
            left_down: false,
            fade: FadeInput::default(),
            gated_drag_armed: false,
            model: Interaction::with_hitrect(native_rect(placement)),
            decision: Decision::default(),
            applied: Decision::default(),
            revision: 0,
            web: false,
            gate: Gate::Visible,
            dirty: false,
        }
    }
    pub fn step(&mut self, placement: &Placement, sample: Option<Sample>) {
        self.left_down = sample.filter(|s| s.valid()).is_some_and(|s| s.left_down);
        self.decision = if let Some(sample) = sample.filter(|s| s.valid()) {
            let cursor = logical(placement, sample);
            self.model.step(Input {
                cursor,
                left_down: sample.left_down,
                in_band: in_band(cursor),
                fullscreen: matches!(self.gate, Gate::Hidden),
                faded: matches!(self.gate, Gate::Faded),
            })
        } else {
            self.model.ole_drag = false;
            self.model.step(Input {
                fullscreen: true,
                ..Input::default()
            });
            Decision {
                hidden: matches!(self.gate, Gate::Hidden),
                ..Decision::default()
            }
        };
    }
    pub fn clear_web_drag(&mut self) {
        self.model.ole_drag = false;
        if !self.left_down {
            self.model.cancel_drag();
        }
    }
    pub fn gate_for_sample(
        &mut self,
        placement: &Placement,
        sample: Option<Sample>,
        gate: Gate,
    ) -> Gate {
        let Some(sample) = sample.filter(|s| s.valid()) else {
            self.gated_drag_armed = false;
            return gate;
        };
        if gate == Gate::Hidden {
            self.gated_drag_armed = false;
            return gate;
        }
        let band = in_band(logical(placement, sample));
        if !sample.left_down && !self.model.ole_drag {
            self.gated_drag_armed = false;
        } else if sample.left_down && !band {
            self.gated_drag_armed = true;
        }
        let dragging = self.model.ole_drag
            || sample.left_down && ((band && self.gated_drag_armed) || self.decision.dragging);
        if gate == Gate::Faded && dragging {
            self.model.arm_drag();
            Gate::Visible
        } else {
            gate
        }
    }
    pub fn report(&self, label: &str) -> Report {
        Report {
            label: label.into(),
            hitrect: self.model.hitrect,
            decision: self.decision,
            interactive: self.applied.interactive,
            revision: self.revision,
            source: if self.web { "web" } else { "native" },
        }
    }
}
#[derive(Default)]
pub struct FadeInput {
    until: Option<u64>,
}
impl FadeInput {
    pub fn gate(
        &mut self,
        target: Gate,
        from_visible: bool,
        now: u64,
        reduced_or_forced: bool,
    ) -> Gate {
        if target != Gate::Faded || reduced_or_forced {
            self.until = None;
            return target;
        }
        if from_visible {
            self.until = Some(now.saturating_add(200));
        }
        if self.until.is_some_and(|until| now < until) {
            Gate::Visible
        } else {
            self.until = None;
            Gate::Faded
        }
    }
}
pub fn logical(placement: &Placement, sample: Sample) -> Point {
    Frame {
        origin: Point {
            x: f64::from(placement.bounds.x),
            y: f64::from(placement.bounds.y),
        },
        scale: placement.render_scale,
    }
    .logical(Point {
        x: sample.x,
        y: sample.y,
    })
}
pub fn in_band(point: Point) -> bool {
    point.x >= 0.0 && point.x <= 720.0 && point.y >= 0.0 && point.y <= 48.0
}
pub fn native_rect(placement: &Placement) -> Rect {
    let pill = idle_geometry(placement.shape);
    Rect {
        x: (f64::from(placement.bounds.width) / placement.render_scale - pill.width) / 2.0 - 8.0,
        y: pill.top - 8.0,
        w: pill.width + 16.0,
        h: pill.height + 16.0,
    }
    .validated()
    .expect("native geometry is inside the host")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::island::model::{Rect as Bounds, Shape};
    fn placement() -> Placement {
        Placement {
            label: "island".into(),
            monitor_id: "left".into(),
            bounds: Bounds {
                x: -1800,
                y: 60,
                width: 1242,
                height: 794,
            },
            dpi_scale: 1.5,
            size_scale: 1.15,
            render_scale: 1.725,
            shape: Shape::Notch,
        }
    }
    #[test]
    fn mixed_dpi_size_physical_edges_and_changed_rects() {
        let p = placement();
        let mut input = HostInput::new(&p);
        let sample = |x: f64, y: f64| {
            Some(Sample {
                x: -1800.0 + x * 1.725,
                y: 60.0 + y * 1.725,
                left_down: false,
            })
        };
        input.step(&p, sample(360.0, 12.0));
        assert!(input.decision.interactive);
        let r = input.model.hitrect.unwrap();
        input.step(&p, sample(r.x, 0.0));
        assert!(input.decision.interactive);
        input.step(&p, sample(r.x - 0.01, 0.0));
        assert!(!input.decision.interactive);
        input.model.hitrect = Some(Rect {
            x: 20.0,
            y: 0.0,
            w: 680.0,
            h: 420.0,
        });
        input.step(&p, sample(600.0, 200.0));
        assert!(input.decision.interactive);
        input.model.hitrect = Some(native_rect(&p));
        input.step(&p, sample(600.0, 200.0));
        assert!(!input.decision.interactive);
    }
    #[test]
    fn faded_hidden_and_invalid_provider_fail_closed() {
        let p = placement();
        let mut input = HostInput::new(&p);
        let s = Some(Sample {
            x: -1179.0,
            y: 75.0,
            left_down: true,
        });
        for gate in [Gate::Faded, Gate::Hidden] {
            input.gate = gate;
            input.step(&p, s);
            assert!(!input.decision.interactive);
            assert!(!input.decision.dragging);
        }
        input.gate = Gate::Visible;
        input.model.ole_drag = true;
        input.step(&p, None);
        assert!(!input.decision.interactive);
        assert!(!input.model.ole_drag);
        input.step(
            &p,
            Some(Sample {
                x: f64::NAN,
                ..Sample::default()
            }),
        );
        assert!(!input.decision.interactive);
        input.gate = Gate::Hidden;
        input.step(&p, None);
        assert!(input.decision.hidden);
    }
    #[test]
    fn held_drag_requires_entry_and_cancel_restores_original_rect() {
        let p = placement();
        let mut input = HostInput::new(&p);
        let step = |input: &mut HostInput, x: f64, y: f64, down: bool| {
            input.step(
                &p,
                Some(Sample {
                    x: -1800.0 + x * 1.725,
                    y: 60.0 + y * 1.725,
                    left_down: down,
                }),
            )
        };
        step(&mut input, 80.0, 10.0, true);
        assert!(!input.decision.dragging);
        step(&mut input, 80.0, 300.0, true);
        step(&mut input, 80.0, 10.0, true);
        assert!(input.decision.dragging && input.decision.interactive);
        step(&mut input, 80.0, 120.0, true);
        assert!(input.decision.dragging && input.decision.interactive);
        step(&mut input, 80.0, 300.0, false);
        assert!(!input.decision.dragging && !input.decision.interactive);
        assert_eq!(input.model.hitrect, Some(native_rect(&p)));
    }
    #[test]
    fn web_teardown_does_not_cancel_a_new_held_native_drag() {
        let p = placement();
        let mut input = HostInput::new(&p);
        let sample = |y: f64, down: bool| {
            Some(Sample {
                x: -1800.0 + 80.0 * 1.725,
                y: 60.0 + y * 1.725,
                left_down: down,
            })
        };
        input.step(&p, sample(300.0, true));
        input.step(&p, sample(10.0, true));
        assert!(input.decision.dragging);
        input.clear_web_drag();
        input.step(&p, sample(120.0, true));
        assert!(input.decision.dragging && input.decision.interactive);
        input.step(&p, sample(120.0, false));
        input.clear_web_drag();
        assert!(!input.decision.dragging);
    }
    #[test]
    fn faded_held_drag_wakes_only_after_band_entry_and_hidden_always_cancels() {
        let p = placement();
        let mut input = HostInput::new(&p);
        let step = |input: &mut HostInput, x: f64, y: f64, down: bool, gate: Gate| {
            let sample = Some(Sample {
                x: -1800.0 + x * 1.725,
                y: 60.0 + y * 1.725,
                left_down: down,
            });
            input.gate = input.gate_for_sample(&p, sample, gate);
            input.step(&p, sample);
        };
        step(&mut input, 80.0, 10.0, true, Gate::Faded);
        assert_eq!(input.gate, Gate::Faded);
        assert!(!input.decision.dragging);
        step(&mut input, 80.0, 300.0, true, Gate::Faded);
        step(&mut input, 80.0, 10.0, true, Gate::Faded);
        assert_eq!(input.gate, Gate::Visible);
        assert!(input.decision.dragging && input.decision.interactive);
        step(&mut input, 80.0, 120.0, true, Gate::Faded);
        assert!(input.decision.dragging);
        step(&mut input, 80.0, 10.0, true, Gate::Hidden);
        assert!(input.decision.hidden);
        assert!(!input.decision.dragging && !input.decision.interactive);
        step(&mut input, 80.0, 10.0, true, Gate::Faded);
        assert_eq!(input.gate, Gate::Faded);
    }
}
