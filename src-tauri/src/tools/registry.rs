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
    Media(super::media::Kind),
    Image(super::images::Kind),
    Document(super::documents::Kind),
}
impl Executor {
    pub fn extension(self, input: &std::path::Path, info: Option<&super::media::Info>) -> String {
        match self {
            Self::Media(kind) => kind.extension(input, info),
            Self::Document(kind) => kind.extension().into(),
            Self::Image(_) => super::images::Format::Original.extension(input).into(),
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
        ("custom-fit", "Fit under a size", Some(20)),
        ("jpg", "To JPG", None),
        ("png", "To PNG", None),
        ("webp", "To WebP", None),
        ("avif", "To AVIF", None),
        ("mp4", "To MP4", None),
        ("trim", "Trimmed", None),
        ("mp3", "Extract audio", None),
        ("m4a", "Extract audio", None),
        ("gif", "To GIF", None),
        ("animated-webp", "Animated WebP", None),
        ("strip", "Metadata removed", None),
        ("smaller", "Make smaller", None),
        ("pdf", "Make PDF", None),
        ("split", "Split PDF", None),
        ("text", "Text", None),
        ("qr", "QR", None),
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
/// Drop suggestions inspect metadata only; opening a review never starts a job.
pub fn suggestion(path: &std::path::Path, bytes: u64, discord_mb: u32) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if matches!(ext.as_str(), "mov" | "mkv") {
        Some("to-mp4")
    } else if get("fit-size").ok()?.accepts_path(path)
        && matches!(ext.as_str(), "mp4" | "webm" | "avi" | "m4v")
        && bytes > u64::from(discord_mb) * 1_000_000
    {
        Some("fit-size")
    } else if matches!(ext.as_str(), "heic" | "heif") {
        Some("to-jpg")
    } else {
        None
    }
}
pub fn catalog() -> Vec<Tool> {
    vec![
        document_tool(
            super::documents::Kind::Merge,
            "merge-pdf",
            "Merge PDFs",
            &["pdf"],
            "pdf",
        ),
        document_tool(
            super::documents::Kind::Split,
            "split-pdf",
            "Split PDF",
            &["pdf"],
            "split",
        ),
        document_tool(
            super::documents::Kind::ImagesPdf,
            "images-pdf",
            "Make PDF",
            super::images::TYPES,
            "pdf",
        ),
        document_tool(
            super::documents::Kind::Render,
            "pdf-png",
            "PDF to PNG",
            &["pdf"],
            "png",
        ),
        document_tool(
            super::documents::Kind::Ocr,
            "image-text",
            "Text from image",
            super::images::TYPES,
            "text",
        ),
        document_tool(
            super::documents::Kind::QrDecode,
            "decode-qr",
            "Read QR from image",
            super::images::TYPES,
            "text",
        ),
        document_tool(
            super::documents::Kind::QrEncode,
            "encode-qr",
            "Text file to QR",
            &["txt"],
            "qr",
        ),
        image_tool(
            super::images::Kind::Smaller,
            "smaller-image",
            "Make smaller",
            &["smaller"],
        ),
        Tool {
            executor: Executor::Media(super::media::Kind::Mp4),
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
        media_tool(
            super::media::Kind::Fit,
            "fit-size",
            "Fit under a size",
            &[
                "compress", "shrink", "discord", "email", "whatsapp", "size", "mb",
            ],
            &["discord", "email", "outlook", "whatsapp", "custom-fit"],
            true,
        ),
        media_tool(
            super::media::Kind::Trim,
            "trim-video",
            "Trim video",
            &["cut", "section", "clip"],
            &["trim"],
            false,
        ),
        media_tool(
            super::media::Kind::Mp3,
            "extract-mp3",
            "Extract MP3",
            &["audio", "sound", "music", "mp3"],
            &["mp3"],
            true,
        ),
        media_tool(
            super::media::Kind::M4a,
            "extract-m4a",
            "Extract M4A",
            &["audio", "sound", "aac", "m4a"],
            &["m4a"],
            true,
        ),
        media_tool(
            super::media::Kind::Gif,
            "to-gif",
            "To GIF",
            &["animation", "gif"],
            &["gif"],
            false,
        ),
        media_tool(
            super::media::Kind::Webp,
            "animated-webp",
            "Animated WebP",
            &["animation", "webp"],
            &["animated-webp"],
            false,
        ),
        media_tool(
            super::media::Kind::Strip,
            "strip-metadata",
            "Remove location and camera data",
            &["privacy", "gps", "metadata", "strip", "location", "camera"],
            &["strip"],
            true,
        ),
        Tool {
            executor: Executor::Image(super::images::Kind::Convert),
            id: "to-jpg",
            name: "Convert images",
            category: "images",
            icon: "iconImage",
            keywords: &["image", "photo", "convert", "jpeg", "png", "webp"],
            accepts: Accepts {
                filetypes: super::images::TYPES,
                text: false,
                link: false,
                image: true,
            },
            presets: &["jpg", "png", "webp", "avif"],
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
fn document_tool(
    kind: super::documents::Kind,
    id: &'static str,
    name: &'static str,
    types: &'static [&'static str],
    preset: &'static str,
) -> Tool {
    let presets: &'static [&'static str] = match preset {
        "split" => &["split"],
        "png" => &["png"],
        "text" => &["text"],
        "qr" => &["qr"],
        _ => &["pdf"],
    };
    Tool {
        executor: Executor::Document(kind),
        id,
        name,
        category: "documents",
        icon: "iconFile",
        keywords: match kind {
            super::documents::Kind::Merge => &["pdf", "merge", "combine", "pages"],
            super::documents::Kind::Split => &["pdf", "split", "pages", "ranges"],
            super::documents::Kind::ImagesPdf => &["image", "photo", "pdf", "combine"],
            super::documents::Kind::Render => &["pdf", "png", "render", "pages"],
            super::documents::Kind::Ocr => &["ocr", "text", "image", "extract"],
            super::documents::Kind::QrDecode => &["qr", "code", "decode", "image"],
            super::documents::Kind::QrEncode => &["qr", "code", "encode", "text"],
        },
        accepts: Accepts {
            filetypes: types,
            text: matches!(kind, super::documents::Kind::QrEncode),
            link: matches!(kind, super::documents::Kind::QrEncode),
            image: types == super::images::TYPES,
        },
        presets,
        form: vec![],
    }
}
fn image_tool(
    kind: super::images::Kind,
    id: &'static str,
    name: &'static str,
    presets: &'static [&'static str],
) -> Tool {
    Tool {
        executor: Executor::Image(kind),
        id,
        name,
        category: "images",
        icon: "iconImage",
        keywords: &["image", "photo", "resize", "compress"],
        accepts: Accepts {
            filetypes: super::images::TYPES,
            text: false,
            link: false,
            image: true,
        },
        presets,
        form: vec![],
    }
}
fn media_tool(
    kind: super::media::Kind,
    id: &'static str,
    name: &'static str,
    keywords: &'static [&'static str],
    presets: &'static [&'static str],
    audio: bool,
) -> Tool {
    Tool {
        executor: Executor::Media(kind),
        id,
        name,
        category: "media",
        icon: "iconFile",
        keywords,
        accepts: Accepts {
            filetypes: if kind == super::media::Kind::Strip {
                &[
                    "mp4", "mov", "mkv", "webm", "avi", "m4v", "mp3", "m4a", "wav", "aac", "flac",
                    "ogg", "opus", "wma", "jpg", "jpeg", "png", "webp",
                ]
            } else if kind == super::media::Kind::Fit {
                &[
                    "mp4", "mov", "mkv", "webm", "avi", "m4v", "mp3", "m4a", "wav", "aac", "flac",
                    "ogg", "opus", "wma", "jpg", "jpeg", "png", "webp", "avif", "heic", "heif",
                    "svg",
                ]
            } else if audio {
                &[
                    "mp4", "mov", "mkv", "webm", "avi", "m4v", "mp3", "m4a", "wav", "aac", "flac",
                    "ogg", "opus", "wma",
                ]
            } else {
                &["mp4", "mov", "mkv", "webm", "avi", "m4v"]
            },
            text: false,
            link: false,
            image: false,
        },
        presets,
        form: vec![],
    }
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
    pub fn executor_for(&self, path: &std::path::Path) -> Executor {
        let image = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| super::images::TYPES.contains(&e.to_ascii_lowercase().as_str()));
        match self.executor {
            Executor::Media(super::media::Kind::Fit) if image => {
                Executor::Image(super::images::Kind::Fit)
            }
            Executor::Media(super::media::Kind::Strip) if image => {
                Executor::Image(super::images::Kind::Strip)
            }
            other => other,
        }
    }
    pub fn accepts_path(&self, path: &std::path::Path) -> bool {
        path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
            self.accepts
                .filetypes
                .contains(&e.to_ascii_lowercase().as_str())
        })
    }
}
