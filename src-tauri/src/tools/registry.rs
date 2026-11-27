//! One metadata source for every tool entry point. Executors register here as they land.
use crate::error::{msg, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    #[serde(skip)]
    pub executor: Executor,
    pub id: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub icon: &'static str,
    pub keywords: &'static [&'static str],
    pub accepts: Accepts,
    pub presets: &'static [&'static str],
    pub form: Vec<Field>,
}
#[derive(Clone, Copy, Debug)]
pub enum Executor {
    Mp4,
    Jpg,
}
impl Executor {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Jpg => "jpg",
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Accepts {
    pub filetypes: &'static [&'static str],
    pub text: bool,
    pub link: bool,
    pub image: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct Field {
    pub key: &'static str,
    pub label: &'static str,
    pub min: u32,
    pub max: u32,
    pub default: u32,
    pub advanced: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub max_mb: Option<u32>,
    pub quality: u32,
}
pub fn presets() -> Vec<Preset> {
    [
        ("discord", "Fit for Discord", Some(20)),
        ("email", "Fit for email", Some(25)),
        ("outlook", "Fit for Outlook", Some(10)),
        ("whatsapp", "Fit for WhatsApp", Some(100)),
        ("jpg", "To JPG", None),
        ("mp4", "To MP4", None),
        ("smaller", "Make smaller", None),
        ("pdf", "Make PDF", None),
    ]
    .into_iter()
    .map(|(id, name, max_mb)| Preset {
        id: id.into(),
        name: name.into(),
        max_mb,
        quality: 85,
    })
    .collect()
}
pub fn validate_preset(preset: &Preset) -> Result<()> {
    let original = presets()
        .into_iter()
        .find(|p| p.id == preset.id)
        .ok_or_else(|| msg("Unknown preset"))?;
    if preset.name != original.name
        || preset.max_mb.is_some() != original.max_mb.is_some()
        || preset.max_mb.is_some_and(|n| !(1..=100_000).contains(&n))
        || !(1..=100).contains(&preset.quality)
    {
        return Err(msg("Preset numbers are outside the supported range"));
    }
    Ok(())
}
pub fn catalog() -> Vec<Tool> {
    vec![
        Tool {
            executor: Executor::Mp4,
            id: "to-mp4",
            name: "To MP4",
            category: "media",
            icon: "iconFile",
            keywords: &["video", "convert", "mov", "mkv", "h264"],
            accepts: Accepts {
                filetypes: &["mp4", "mov", "mkv", "webm", "avi", "m4v"],
                text: false,
                link: false,
                image: false,
            },
            presets: &["mp4"],
            form: vec![],
        },
        Tool {
            executor: Executor::Jpg,
            id: "to-jpg",
            name: "To JPG",
            category: "images",
            icon: "iconImage",
            keywords: &["image", "photo", "convert", "jpeg", "png", "webp"],
            accepts: Accepts {
                filetypes: &["png", "jpg", "jpeg", "webp"],
                text: false,
                link: false,
                image: true,
            },
            presets: &["jpg"],
            form: vec![Field {
                key: "quality",
                label: "Quality",
                min: 1,
                max: 100,
                default: 85,
                advanced: true,
            }],
        },
    ]
}
pub fn get(id: &str) -> Result<Tool> {
    catalog()
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| msg("Unknown tool"))
}
impl Tool {
    pub fn run(&self, runner: &super::Service, request: super::Request) -> Result<super::Job> {
        if request.tool_id != self.id {
            return Err(msg("The request belongs to another tool"));
        }
        runner.submit(request)
    }
    pub fn accepts_path(&self, path: &std::path::Path) -> bool {
        path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
            self.accepts
                .filetypes
                .contains(&e.to_ascii_lowercase().as_str())
        })
    }
}
