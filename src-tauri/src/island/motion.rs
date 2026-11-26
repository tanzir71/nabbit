use super::presentation::Compact;
#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    pub width: f32,
    pub primary: f32,
    pub height: f32,
    pub radius: f32,
    pub top: f32,
}
impl From<&Compact> for Geometry {
    fn from(s: &Compact) -> Self {
        Self {
            width: s.width,
            primary: s.primary_width,
            height: s.height,
            radius: s.radius,
            top: s.top,
        }
    }
}
impl Geometry {
    pub fn x(self) -> f32 {
        (720.0 - self.width) / 2.0
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
impl Motion {
    pub fn new(from: Geometry, to: Geometry, reduced: bool) -> Self {
        let collapse = to.height < from.height;
        Self {
            from,
            to,
            duration: if reduced {
                0.0
            } else if collapse {
                0.22
            } else {
                0.26
            },
            delay: if collapse && !reduced { 0.08 } else { 0.0 },
            collapse,
        }
    }
    pub fn stop(self, index: usize) -> f32 {
        if index == 0 {
            return 0.0;
        }
        if index >= 40 {
            return 1.0;
        }
        let p = index as f64 / 40.0;
        let result = if self.collapse {
            let (mut low, mut high) = (0.0, 1.0);
            for _ in 0..40 {
                let m = (low + high) / 2.0;
                let x = 0.6 * (1.0 - m) * (1.0 - m) * m + m * m * m;
                if x < p {
                    low = m
                } else {
                    high = m
                }
            }
            let m = (low + high) / 2.0;
            3.0 * (1.0 - m) * m * m + m * m * m
        } else {
            let decay = 16.0;
            let frequency = (380.0_f64 - decay * decay).sqrt();
            let spring = |t: f64| {
                1.0 - (-decay * t).exp()
                    * ((frequency * t).cos() + decay / frequency * (frequency * t).sin())
            };
            spring(p * self.duration) / spring(self.duration)
        };
        ((result * 100000.0).round() / 100000.0) as f32
    }
    pub fn at(self, elapsed: f64) -> Geometry {
        let p = if self.duration == 0.0 {
            1.0
        } else {
            ((elapsed - self.delay) / self.duration).clamp(0.0, 1.0)
        };
        let step = (p * 40.0).floor() as usize;
        let k = if step >= 40 {
            1.0
        } else {
            self.stop(step)
                + (self.stop(step + 1) - self.stop(step)) * (p * 40.0 - step as f64) as f32
        };
        let lerp = |a, b| a + (b - a) * k;
        Geometry {
            width: lerp(self.from.width, self.to.width),
            primary: lerp(self.from.primary, self.to.primary),
            height: lerp(self.from.height, self.to.height),
            radius: lerp(self.from.radius, self.to.radius),
            top: lerp(self.from.top, self.to.top),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn geom(width: f32, height: f32) -> Geometry {
        Geometry {
            width,
            primary: width,
            height,
            radius: height / 2.0,
            top: 6.0,
        }
    }
    #[test]
    fn native_matches_generated_css_and_interrupted_geometry() {
        let m = Motion::new(geom(112.0, 26.0), geom(320.0, 32.0), false);
        assert!((m.at(0.13).width - 278.142).abs() < 0.01);
        let current = m.at(0.05);
        let next = Motion::new(current, geom(298.0, 32.0), false);
        assert_eq!(next.at(0.0).width, current.width);
        assert_eq!(next.at(1.0).width, 298.0);
        assert_eq!(next.to.x(), 211.0);
    }
    #[test]
    fn collapse_fades_first_and_reduced_motion_has_no_morph() {
        let m = Motion::new(geom(320.0, 32.0), geom(112.0, 26.0), false);
        assert_eq!(m.at(0.079).width, 320.0);
        assert_eq!(m.at(0.301).width, 112.0);
        assert_eq!(Motion::new(m.from, m.to, true).at(0.0).width, 112.0);
    }
}
