use super::options::{DownloadOptions, Format};
use crate::error::{msg, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PresetId {
    #[serde(rename = "mp4_1080")]
    Mp41080,
    #[serde(rename = "mp4_720")]
    Mp4720,
    #[serde(rename = "mp3_320")]
    Mp3320,
    #[serde(rename = "m4a")]
    M4a,
    #[serde(rename = "custom")]
    Custom,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: PresetId,
    pub label: String,
    pub options: DownloadOptions,
}
pub fn defaults() -> Vec<Preset> {
    [
        (PresetId::Mp41080, "MP4 · 1080p", Format::Mp4, Some(1080)),
        (PresetId::Mp4720, "MP4 · 720p", Format::Mp4, Some(720)),
        (PresetId::Mp3320, "MP3 · 320", Format::Mp3, None),
        (PresetId::M4a, "M4A", Format::M4a, None),
        (PresetId::Custom, "Custom…", Format::Mp4, Some(1080)),
    ]
    .into_iter()
    .map(|(id, label, format, height)| Preset {
        id,
        label: label.into(),
        options: DownloadOptions {
            format,
            height,
            ..Default::default()
        },
    })
    .collect()
}
pub fn from_options(options: &DownloadOptions) -> Result<Preset> {
    let mut options = options.rememberable()?;
    if options.filename_template.as_deref() == Some(super::options::DEFAULT_TEMPLATE) {
        options.filename_template = None;
    }
    Ok(defaults()
        .into_iter()
        .find(|p| p.id != PresetId::Custom && p.options == options)
        .unwrap_or(Preset {
            id: PresetId::Custom,
            label: "Custom…".into(),
            options,
        }))
}
pub fn site_key(value: &str) -> Result<String> {
    let url = url::Url::parse(value.trim()).map_err(|_| msg("Use an HTTP or HTTPS video URL."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(msg("Use an HTTP or HTTPS video URL."));
    }
    let host = url
        .host_str()
        .ok_or_else(|| msg("The video URL needs a site name."))?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    if host.is_empty() {
        return Err(msg("The video URL needs a site name."));
    }
    Ok(
        if matches!(
            host,
            "youtu.be"
                | "youtube.com"
                | "m.youtube.com"
                | "music.youtube.com"
                | "youtube-nocookie.com"
        ) {
            "youtube.com".into()
        } else {
            host.to_owned()
        },
    )
}
