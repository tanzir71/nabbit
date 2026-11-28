//! Local media inspection and executors. Only the separately pinned ffmpeg is run.
#[cfg(test)]
mod acceptance;
mod encode;
pub mod gpu;
pub mod model;
pub mod sheet;
#[cfg(test)]
mod tests;
use crate::error::{msg, Result};
pub use encode::{execute, Context};
pub use model::*;
use std::{path::Path, sync::atomic::AtomicBool, time::Duration};
pub const FORMATS: &str = "mov,matroska,webm,avi,m4v,mp3,wav,aac,flac,ogg,asf,mpeg,mpegts";
pub fn source_args(path: &Path, options: &Options) -> Vec<String> {
    let mut args = [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        FORMATS,
        "-i",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    args.push(path.to_string_lossy().into());
    if let Some(range) = &options.trim {
        args.extend([
            "-ss".into(),
            format!("{:.3}", range.start_ms as f64 / 1000.),
            "-t".into(),
            format!("{:.3}", (range.end_ms - range.start_ms) as f64 / 1000.),
        ]);
    }
    args
}
pub fn parse_info(text: &str, bytes: u64) -> Result<Info> {
    let regex = |expression| regex::Regex::new(expression).expect("constant media expression");
    let duration = regex(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)");
    let time = duration
        .captures(text)
        .ok_or_else(|| msg("The file has no supported finite duration"))?;
    let number = |n: usize| time[n].parse::<f64>().unwrap_or(0.);
    let seconds = number(1) * 3600. + number(2) * 60. + number(3);
    if !seconds.is_finite() || !(0.02..=31. * 86400.).contains(&seconds) {
        return Err(msg("The file has no supported finite duration"));
    }
    let mut info = Info {
        duration_ms: (seconds * 1000.).round() as u64,
        bytes,
        ..Info::default()
    };
    for line in text.lines() {
        if line.contains("Video:") && !line.contains("attached pic") && !info.video {
            let size = regex(r"(?:^|[, ])(\d{2,5})x(\d{2,5})(?:[ ,\[])");
            if let Some(c) = size.captures(line) {
                info.width = c[1].parse().unwrap_or(0);
                info.height = c[2].parse().unwrap_or(0);
                info.video = true;
            }
            info.fps = regex(r"([\d.]+) fps")
                .captures(line)
                .and_then(|c| c[1].parse().ok())
                .unwrap_or(30.);
            info.video_codec = line
                .split("Video:")
                .nth(1)
                .and_then(|s| s.split([',', ' ']).find(|s| !s.is_empty()))
                .map(str::to_owned);
        }
        if line.contains("Audio:") && !info.audio {
            info.audio = true;
            info.channels = if line.contains("mono") { 1 } else { 2 };
            info.audio_codec = line
                .split("Audio:")
                .nth(1)
                .and_then(|s| s.split([',', ' ']).find(|s| !s.is_empty()))
                .map(str::to_owned);
        }
    }
    if !info.audio && !info.video {
        return Err(msg("No supported audio or video stream was found"));
    }
    if regex(r"rotation of -(?:90|270)(?:\.0+)? degrees|rotation of (?:90|270)(?:\.0+)? degrees")
        .is_match(text)
    {
        std::mem::swap(&mut info.width, &mut info.height);
    }
    Ok(info)
}
pub fn inspect(ffmpeg: &Path, input: &Path, cancel: &AtomicBool) -> Result<Info> {
    use std::sync::atomic::Ordering;
    if cancel.load(Ordering::Acquire) {
        return Err(msg("Cancelled"));
    }
    let facts = crate::files::paths::facts(&input.to_string_lossy())?;
    crate::files::paths::local_only(&facts, || {
        let _lock = super::files::input(input)?;
        let args = [
            "-hide_banner",
            "-nostdin",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            FORMATS,
            "-i",
        ]
        .into_iter()
        .map(str::to_owned)
        .chain([input.to_string_lossy().into()])
        .collect::<Vec<_>>();
        let output = crate::download::engine::run_bounded(ffmpeg, &args, Duration::from_secs(20))?;
        if cancel.load(Ordering::Acquire) {
            return Err(msg("Cancelled"));
        }
        parse_info(&output.stderr, facts.bytes)
    })
}
