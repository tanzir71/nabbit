//! Typed download settings and a pure argument builder for the pinned yt-dlp.
//! Browser selection is deliberately separate from persisted options/presets.
use crate::error::{msg, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_TEMPLATE: &str = "%(title)s [%(id)s].%(ext)s";
pub const PROGRESS_TEMPLATE: &str = "download:nabbit:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.filename)s";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    #[default]
    Mp4,
    Mkv,
    Webm,
    Mp3,
    M4a,
    Opus,
}
impl Format {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Mkv => "mkv",
            Self::Webm => "webm",
            Self::Mp3 => "mp3",
            Self::M4a => "m4a",
            Self::Opus => "opus",
        }
    }
    pub fn video(self) -> bool {
        matches!(self, Self::Mp4 | Self::Mkv | Self::Webm)
    }
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Chapters {
    #[default]
    Off,
    Keep,
    Split,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SponsorBlock {
    #[default]
    Off,
    Mark,
    Cut,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaylistMode {
    #[default]
    Video,
    Playlist,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Browser {
    Chrome,
    Edge,
    Firefox,
    Brave,
}
impl Browser {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chrome => "chrome",
            Self::Edge => "edge",
            Self::Firefox => "firefox",
            Self::Brave => "brave",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Subtitles {
    pub languages: Vec<String>,
    pub embed: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeRange {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadOptions {
    pub format: Format,
    pub height: Option<u16>,
    pub subtitles: Option<Subtitles>,
    pub chapters: Chapters,
    pub sponsor_block: SponsorBlock,
    pub embed_thumbnail: bool,
    pub embed_metadata: bool,
    pub filename_template: Option<String>,
    pub output_dir: Option<String>,
    pub sections: Vec<TimeRange>,
    pub precise_cuts: bool,
    pub playlist_mode: PlaylistMode,
    pub playlist_items: Option<String>,
    pub speed_limit: Option<String>,
}
impl Default for DownloadOptions {
    fn default() -> Self {
        Self {
            format: Format::Mp4,
            height: Some(1080),
            subtitles: None,
            chapters: Chapters::Off,
            sponsor_block: SponsorBlock::Off,
            embed_thumbnail: false,
            embed_metadata: false,
            filename_template: None,
            output_dir: None,
            sections: vec![],
            precise_cuts: false,
            playlist_mode: PlaylistMode::Video,
            playlist_items: None,
            speed_limit: None,
        }
    }
}
impl DownloadOptions {
    pub fn from_legacy(quality: &str, mode: &str, items: Option<&str>) -> Result<Self> {
        let mut o = Self::default();
        match quality {
            "best" => o.height = None,
            "audio_mp3" => {
                o.format = Format::Mp3;
                o.height = None;
            }
            "audio_m4a" => {
                o.format = Format::M4a;
                o.height = None;
            }
            "audio_opus" => {
                o.format = Format::Opus;
                o.height = None;
            }
            "2160p" | "1440p" | "1080p" | "720p" | "480p" => {
                o.height = quality.trim_end_matches('p').parse().ok()
            }
            _ => return Err(msg("Choose a supported download quality.")),
        }
        o.playlist_mode = match mode {
            "video" => PlaylistMode::Video,
            "playlist" => PlaylistMode::Playlist,
            _ => return Err(msg("Choose video or playlist.")),
        };
        o.playlist_items = items.filter(|v| !v.trim().is_empty()).map(str::to_owned);
        o.normalized()
    }
    pub fn legacy_quality(&self) -> String {
        if self.format.video() {
            self.height
                .map(|h| format!("{h}p"))
                .unwrap_or("best".into())
        } else {
            format!("audio_{}", self.format.as_str())
        }
    }
    pub fn normalized(&self) -> Result<Self> {
        let mut o = self.clone();
        if o.height == Some(0) {
            return Err(msg("Quality height must be positive."));
        }
        if !o.format.video() {
            o.height = None;
        }
        if let Some(subs) = &mut o.subtitles {
            if subs.languages.is_empty() || subs.languages.len() > 32 {
                return Err(msg("Choose subtitle languages."));
            }
            for language in &mut subs.languages {
                *language = language.trim().to_owned();
                if language.is_empty()
                    || language.len() > 64
                    || !language
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "._*-".contains(c))
                {
                    return Err(msg("Unsupported subtitle language selection."));
                }
            }
            if subs.languages[0].starts_with('-') {
                return Err(msg("Choose a subtitle language before exclusions."));
            }
            subs.languages.dedup();
            if subs.embed && !o.format.video() {
                return Err(msg("Embedded subtitles need a video format."));
            }
        }
        if o.sections.len() > 100 {
            return Err(msg("Choose at most 100 trim ranges."));
        }
        for r in &o.sections {
            if r.start_ms >= r.end_ms {
                return Err(msg("A trim range must end after it starts."));
            }
        }
        o.sections.sort_by_key(|r| (r.start_ms, r.end_ms));
        let mut merged: Vec<TimeRange> = vec![];
        for range in o.sections {
            if let Some(last) = merged.last_mut().filter(|r| range.start_ms <= r.end_ms) {
                last.end_ms = last.end_ms.max(range.end_ms);
            } else {
                merged.push(range);
            }
        }
        o.sections = merged;
        if o.precise_cuts
            && o.sections.is_empty()
            && o.chapters != Chapters::Split
            && o.sponsor_block != SponsorBlock::Cut
        {
            return Err(msg(
                "Precise cuts need a trim, chapter split or SponsorBlock cut.",
            ));
        }
        if let Some(items) = &o.playlist_items {
            if o.playlist_mode != PlaylistMode::Playlist {
                return Err(msg("Playlist selection needs playlist mode."));
            }
            o.playlist_items = Some(playlist_items(items)?);
        }
        if let Some(rate) = &o.speed_limit {
            let rate = rate.trim().to_uppercase();
            let re =
                regex::Regex::new(r"^([0-9]+(?:\.[0-9]+)?)([KMG]?)$").expect("rate expression");
            let number = re
                .captures(&rate)
                .and_then(|c| c[1].parse::<f64>().ok())
                .filter(|v| v.is_finite() && *v > 0.0);
            if number.is_none() {
                return Err(msg("Use a positive speed limit such as 50K or 4.2M."));
            }
            o.speed_limit = Some(rate);
        }
        if let Some(template) = &o.filename_template {
            validate_template(template)?;
        }
        if let Some(dir) = &o.output_dir {
            validate_text(dir, "Choose an output folder.")?;
        }
        Ok(o)
    }
    /// Remember reusable choices, never another video's ranges, playlist or folder.
    pub fn rememberable(&self) -> Result<Self> {
        let mut o = self.normalized()?;
        o.sections.clear();
        o.precise_cuts = false;
        o.playlist_mode = PlaylistMode::Video;
        o.playlist_items = None;
        o.output_dir = None;
        Ok(o)
    }
    pub fn with_defaults(&self, output_dir: &str, template: &str) -> Result<Self> {
        let mut o = self.normalized()?;
        if o.output_dir.is_none() {
            o.output_dir = Some(if output_dir.trim().is_empty() {
                crate::util::default_output_dir()
            } else {
                output_dir.to_owned()
            });
        }
        if o.filename_template.is_none() {
            o.filename_template = Some(template.to_owned());
        }
        o.normalized()
    }
}
fn validate_text(value: &str, message: &str) -> Result<()> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        Err(msg(message))
    } else {
        Ok(())
    }
}
fn validate_template(value: &str) -> Result<()> {
    validate_text(value, "Choose a filename template.")?;
    if value.starts_with(['-', '/', '\\'])
        || value.as_bytes().get(1) == Some(&b':')
        || value.split(['\\', '/']).any(|v| v == "..")
    {
        return Err(msg(
            "Use a filename template relative to the output folder.",
        ));
    }
    Ok(())
}
pub fn playlist_items(value: &str) -> Result<String> {
    let value = value.replace([' ', '\t'], "").replace('–', "-");
    if value.is_empty() || value.len() > 4096 {
        return Err(msg("Choose playlist items such as 1-5 or 1,3,7."));
    }
    for part in value.split(',') {
        let pair: Vec<_> = part.split('-').collect();
        if pair.is_empty() || pair.len() > 2 {
            return Err(msg("Invalid playlist range."));
        }
        let start = pair[0]
            .parse::<u32>()
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| msg("Playlist indices start at 1."))?;
        if pair.len() == 2
            && pair[1]
                .parse::<u32>()
                .ok()
                .filter(|end| *end >= start)
                .is_none()
        {
            return Err(msg("A playlist range must end after its first item."));
        }
    }
    Ok(value)
}
pub fn parse_timecode(value: &str) -> Result<u64> {
    let parts: Vec<_> = value.trim().split(':').collect();
    if !(1..=3).contains(&parts.len()) {
        return Err(msg("Use mm:ss or mm:ss.f for a time."));
    }
    let mut total = 0u64;
    for (index, part) in parts.iter().enumerate() {
        let last = index == parts.len() - 1;
        if part.contains('.') && (!last || part.ends_with('.')) {
            return Err(msg("Use a complete decimal value in seconds."));
        }
        let (whole, fraction) = part.split_once('.').unwrap_or((part, ""));
        if whole.is_empty()
            || !whole.chars().all(|c| c.is_ascii_digit())
            || (!last && !fraction.is_empty())
            || fraction.len() > 3
            || !fraction.chars().all(|c| c.is_ascii_digit())
        {
            return Err(msg("Use seconds with at most three decimal places."));
        }
        let number = whole
            .parse::<u64>()
            .map_err(|_| msg("Time is too large."))?;
        if index > 0 && number >= 60 {
            return Err(msg("Seconds and minutes must be below 60."));
        }
        total = total
            .checked_mul(60)
            .and_then(|t| t.checked_add(number))
            .ok_or_else(|| msg("Time is too large."))?;
        if last {
            total = total
                .checked_mul(1000)
                .and_then(|t| {
                    t.checked_add(if fraction.is_empty() {
                        0
                    } else {
                        fraction.parse::<u64>().unwrap_or(0)
                            * 10u64.pow((3 - fraction.len()) as u32)
                    })
                })
                .ok_or_else(|| msg("Time is too large."))?;
        }
    }
    Ok(total)
}
fn seconds(ms: u64) -> String {
    format!("{}.{:03}", ms / 1000, ms % 1000)
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_owned()
}

pub fn build(
    options: &DownloadOptions,
    ffmpeg: Option<&Path>,
    browser: Option<Browser>,
    fallback: bool,
) -> Result<Vec<String>> {
    let o = options.normalized()?;
    let dir = o
        .output_dir
        .as_deref()
        .ok_or_else(|| msg("Choose an output folder."))?;
    let template = o
        .filename_template
        .as_deref()
        .ok_or_else(|| msg("Choose a filename template."))?;
    let mut args = vec![
        "--newline".into(),
        "--no-warnings".into(),
        "--no-cache-dir".into(),
        "--no-overwrites".into(),
        "--progress-template".into(),
        PROGRESS_TEMPLATE.into(),
        "--print".into(),
        "after_move:nabbit-file:%(filepath)s".into(),
    ];
    if o.format.video() {
        let filter = o
            .height
            .map(|h| format!("[height<={h}]"))
            .unwrap_or_default();
        let format = if fallback {
            format!("b{filter}")
        } else {
            format!("bv*{filter}+ba/b{filter}")
        };
        args.extend([
            "-f".into(),
            format,
            "--merge-output-format".into(),
            o.format.as_str().into(),
        ]);
    } else {
        args.extend([
            "-x".into(),
            "--audio-format".into(),
            o.format.as_str().into(),
        ]);
        if o.format == Format::Mp3 {
            args.extend(["--audio-quality".into(), "320K".into()]);
        }
    }
    if let Some(path) = ffmpeg {
        args.extend([
            "--ffmpeg-location".into(),
            path.to_string_lossy().into_owned(),
        ]);
    }
    if let Some(subs) = o.subtitles {
        args.extend([
            "--write-subs".into(),
            "--write-auto-subs".into(),
            "--sub-langs".into(),
            subs.languages.join(","),
        ]);
        if subs.embed {
            args.push("--embed-subs".into());
        }
    }
    match o.chapters {
        Chapters::Off => {}
        Chapters::Keep => args.push("--embed-chapters".into()),
        Chapters::Split => args.push("--split-chapters".into()),
    }
    match o.sponsor_block {
        SponsorBlock::Off => {}
        SponsorBlock::Mark => args.extend(["--sponsorblock-mark".into(), "all".into()]),
        SponsorBlock::Cut => args.extend(["--sponsorblock-remove".into(), "sponsor".into()]),
    }
    if o.embed_thumbnail {
        args.push("--embed-thumbnail".into());
    }
    if o.embed_metadata {
        args.push("--embed-metadata".into());
    }
    for r in &o.sections {
        args.extend([
            "--download-sections".into(),
            format!("*{}-{}", seconds(r.start_ms), seconds(r.end_ms)),
        ]);
    }
    if o.precise_cuts {
        args.push("--force-keyframes-at-cuts".into());
    }
    match o.playlist_mode {
        PlaylistMode::Video => args.push("--no-playlist".into()),
        PlaylistMode::Playlist => {
            args.push("--yes-playlist".into());
            if let Some(items) = o.playlist_items {
                args.extend(["-I".into(), items]);
            }
        }
    }
    if let Some(rate) = o.speed_limit {
        args.extend(["-r".into(), rate]);
    }
    if let Some(browser) = browser {
        args.extend(["--cookies-from-browser".into(), browser.as_str().into()]);
    }
    let output = PathBuf::from(dir).join(template);
    args.extend(["-o".into(), output.to_string_lossy().into_owned()]);
    if o.sections.len() > 1 {
        // The same template for several sections would overwrite/skip a cut.
        let parent = output.parent().unwrap_or(Path::new(dir));
        let name = output
            .file_name()
            .ok_or_else(|| msg("Choose a filename template."))?
            .to_string_lossy();
        *args.last_mut().expect("output") = parent
            .join(format!("%(section_number)03d - {name}"))
            .to_string_lossy()
            .into_owned();
    }
    Ok(args)
}

#[cfg(test)]
#[path = "options_tests.rs"]
mod tests;
