use crate::error::{msg, Result};
use serde::{Deserialize, Serialize};
pub const MAX_FILE: u64 = 128 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 64_000_000;
pub const TYPES: &[&str] = &["jpg", "jpeg", "png", "webp", "avif", "heic", "heif", "svg"];
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    #[default]
    Original,
    Jpg,
    Png,
    Webp,
    Avif,
}
impl Format {
    pub fn extension(self, input: &std::path::Path) -> &'static str {
        match self {
            Self::Jpg => "jpg",
            Self::Png => "png",
            Self::Webp => "webp",
            Self::Avif => "avif",
            Self::Original => match input
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str()
            {
                "png" | "svg" => "png",
                "webp" => "webp",
                "avif" => "avif",
                _ => "jpg",
            },
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Convert,
    Smaller,
    Fit,
    Strip,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub format: Format,
    pub quality: Option<u32>,
    pub max_width: Option<u32>,
    pub strip_metadata: bool,
    pub keep_profile: bool,
    pub keep_dates: bool,
    pub output_dir: Option<String>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            format: Format::Original,
            quality: None,
            max_width: None,
            strip_metadata: false,
            keep_profile: true,
            keep_dates: true,
            output_dir: None,
        }
    }
}
impl Options {
    pub fn validate(&self) -> Result<()> {
        if self.quality.is_some_and(|q| !(1..=100).contains(&q))
            || self.max_width.is_some_and(|w| !(1..=20000).contains(&w))
        {
            return Err(msg("Image options are outside the supported range"));
        }
        if let Some(dir) = &self.output_dir {
            crate::files::paths::checked(dir)?;
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub format: String,
    pub orientation: u8,
    pub has_exif: bool,
    pub has_profile: bool,
    pub animated: bool,
    pub decoder: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub encoder: String,
    pub width: u32,
    pub height: u32,
    pub quality: u32,
    pub attempts: u32,
    pub lossless: bool,
    pub warning: Option<String>,
}
pub fn dimensions(width: u32, height: u32) -> Result<()> {
    if width == 0
        || height == 0
        || width > 20000
        || height > 20000
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(msg("This image exceeds the supported 64-megapixel limit"));
    }
    Ok(())
}
pub fn fitted(width: u32, height: u32, max_width: Option<u32>) -> (u32, u32) {
    let next = width.min(max_width.unwrap_or(width));
    (
        next,
        ((f64::from(height) * f64::from(next) / f64::from(width)).round() as u32).max(1),
    )
}
