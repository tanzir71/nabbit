use crate::error::{msg, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    Exact,
    Fast,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Range {
    pub start_ms: u64,
    pub end_ms: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub mode: Mode,
    pub max_mb: Option<u32>,
    pub keep_audio: bool,
    pub downscale: bool,
    pub audio_kbps: Option<u32>,
    pub max_height: u32,
    pub trim: Option<Range>,
    pub gif_fps: u32,
    pub gif_pixels: u32,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            mode: Mode::Exact,
            max_mb: None,
            keep_audio: true,
            downscale: true,
            audio_kbps: None,
            max_height: 1080,
            trim: None,
            gif_fps: 15,
            gif_pixels: 720,
        }
    }
}
impl Options {
    pub fn validate(&self) -> Result<()> {
        if self.max_mb.is_some_and(|n| !(1..=100_000).contains(&n))
            || self.audio_kbps.is_some_and(|n| !(16..=320).contains(&n))
            || ![480, 720, 1080].contains(&self.max_height)
            || !(1..=15).contains(&self.gif_fps)
            || !(32..=720).contains(&self.gif_pixels)
            || self
                .trim
                .as_ref()
                .is_some_and(|r| r.end_ms <= r.start_ms || r.end_ms > 31 * 86400 * 1000)
        {
            return Err(msg("Media options are outside the supported range"));
        }
        Ok(())
    }
    pub fn seconds(&self, info: &Info) -> Result<f64> {
        self.validate()?;
        let milliseconds = if let Some(range) = &self.trim {
            if range.end_ms > info.duration_ms {
                return Err(msg("The trim range ends after the file"));
            }
            range.end_ms - range.start_ms
        } else {
            info.duration_ms
        };
        if !(20..=31 * 86400 * 1000).contains(&milliseconds) {
            return Err(msg("A finite media duration is required"));
        }
        Ok(milliseconds as f64 / 1000.)
    }
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Info {
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub video: bool,
    pub audio: bool,
    pub channels: u32,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub target_bytes: u64,
    pub seconds: f64,
    pub width: u32,
    pub height: u32,
    pub video_kbps: u32,
    pub audio_kbps: u32,
    pub mono: bool,
    pub estimated_bytes: u64,
}
// A conservative quality floor, in bits per source frame pixel. This is a
// resolution decision, never a promise that a particular picture will look good.
pub const MIN_BITS_PER_PIXEL: f64 = 0.07;
pub fn dimensions(info: &Info, height: u32) -> Result<(u32, u32)> {
    if !info.video || !(2..=32768).contains(&info.width) || !(2..=32768).contains(&info.height) {
        return Err(msg("A supported video stream is required"));
    }
    let ratio = (height as f64 / info.height as f64).min(1.);
    Ok((
        ((info.width as f64 * ratio) as u32 / 2 * 2).max(2),
        ((info.height as f64 * ratio) as u32 / 2 * 2).max(2),
    ))
}
pub fn plan(info: &Info, options: &Options, cap_mb: u32, retry_kbps: Option<u32>) -> Result<Plan> {
    let seconds = options.seconds(info)?;
    if !(1..=100_000).contains(&cap_mb) || !info.fps.is_finite() {
        return Err(msg("Invalid size or frame rate"));
    }
    let target_bytes = u64::from(cap_mb) * 1_000_000;
    let total_kbps = target_bytes as f64 * 8. * 0.97 / seconds / 1000.;
    let mono = info.channels == 1 && seconds >= 180.;
    let audio_kbps = if !options.keep_audio || !info.audio {
        0
    } else {
        let default = if mono {
            if total_kbps < 256. {
                64
            } else {
                96
            }
        } else {
            128
        };
        options.audio_kbps.unwrap_or(default)
    };
    let video_kbps = if info.video {
        let calculated = (total_kbps - f64::from(audio_kbps)).floor();
        if calculated < 16. {
            return Err(msg("The audio budget leaves too little room for video. Lower audio bitrate or shorten the clip."));
        }
        retry_kbps
            .unwrap_or(calculated.min(2_000_000.) as u32)
            .max(16)
    } else {
        0
    };
    let audio_kbps = if !info.video {
        if !info.audio || !options.keep_audio {
            return Err(msg("Choose an audio or video file"));
        }
        let bitrate = retry_kbps.unwrap_or(audio_kbps.min(total_kbps.floor().max(0.) as u32));
        if bitrate < 16 {
            return Err(msg(
                "This clip cannot fit at the minimum audio bitrate. Shorten it or raise the limit.",
            ));
        }
        bitrate
    } else {
        audio_kbps
    };
    let (mut width, mut height) = if info.video {
        dimensions(info, options.max_height)?
    } else {
        (0, 0)
    };
    if info.video && options.downscale {
        for limit in [720, 480] {
            let bpp = f64::from(video_kbps) * 1000.
                / (f64::from(width) * f64::from(height) * info.fps.clamp(1., 240.));
            if bpp >= MIN_BITS_PER_PIXEL {
                break;
            }
            if height <= limit {
                continue;
            }
            (width, height) = dimensions(info, limit)?;
        }
    }
    Ok(Plan {
        target_bytes,
        seconds,
        width,
        height,
        video_kbps,
        audio_kbps,
        mono,
        estimated_bytes: (f64::from(video_kbps + audio_kbps) * 1000. * seconds / 8.).round() as u64,
    })
}
pub fn retry_bitrate(plan: &Plan, actual_bytes: u64, video: bool) -> Result<u32> {
    let audio_bytes = if video {
        f64::from(plan.audio_kbps) * 1000. * plan.seconds / 8.
    } else {
        0.
    };
    let budget = (plan.target_bytes as f64 * 0.94 - audio_bytes).max(0.);
    let observed = (actual_bytes as f64 - audio_bytes).max(1.);
    let previous = if video {
        plan.video_kbps
    } else {
        plan.audio_kbps
    };
    let next = (f64::from(previous) * (budget / observed).min(0.9)).floor() as u32;
    if next < 16 {
        return Err(msg(
            "The file cannot fit at a useful bitrate. Shorten it or raise the limit.",
        ));
    }
    Ok(next)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Fit,
    Mp4,
    Trim,
    Mp3,
    M4a,
    Gif,
    Webp,
    Strip,
}
impl Kind {
    pub fn extension(self, input: &std::path::Path, info: Option<&Info>) -> String {
        match self {
            Self::Fit if info.is_some_and(|i| !i.video) => "m4a",
            Self::Fit | Self::Mp4 | Self::Trim => "mp4",
            Self::Mp3 => "mp3",
            Self::M4a => "m4a",
            Self::Gif => "gif",
            Self::Webp => "webp",
            Self::Strip => {
                return input
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("mp4")
                    .to_ascii_lowercase()
            }
        }
        .into()
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub number: u32,
    pub encoder: String,
    pub plan: Plan,
    pub bytes: u64,
    pub source_hash: String,
    pub fits: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub encoder: String,
    pub remuxed: bool,
    pub attempts: Vec<Attempt>,
    pub warning: Option<String>,
}
