use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEntry {
    pub id: String,
    pub content_type: String,
    pub content: String,
    pub preview: String,
    pub hash: String,
    pub source_app: Option<String>,
    pub pinned: bool,
    pub created_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
    pub blob_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: String,
    pub url: String,
    pub title: String,
    pub thumbnail: Option<String>,
    pub status: String,
    pub progress: f64,
    pub speed: Option<String>,
    pub eta: Option<String>,
    pub output_path: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub failure: Option<crate::download::errors::Failure>,
    pub quality: String,
    #[serde(default)]
    pub options: Option<crate::download::options::DownloadOptions>,
    pub playlist_mode: String,
    pub playlist_range: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadMetadata {
    pub url: String,
    pub normalized_url: String,
    pub title: String,
    pub channel: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
    pub is_playlist: bool,
    pub playlist_count: Option<i64>,
    pub extractor: Option<String>,
    #[serde(default)]
    pub qualities: Vec<crate::download::format_sizes::QualityEstimate>,
    #[serde(default)]
    pub details: Option<crate::download::media::Details>,
    #[serde(default)]
    pub live_pending: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct DownloadRequest {
    pub url: String,
    pub quality: String,
    pub playlist_mode: String,
    pub playlist_range: Option<String>,
    #[serde(default)]
    pub options: Option<crate::download::options::DownloadOptions>,
    #[serde(default)]
    pub remember_for_site: bool,
    #[serde(default)]
    pub cookies_from_browser: Option<crate::download::options::Browser>,
}

impl Default for DownloadRequest {
    fn default() -> Self {
        Self {
            url: String::new(),
            quality: "1080p".into(),
            playlist_mode: "video".into(),
            playlist_range: None,
            options: None,
            remember_for_site: false,
            cookies_from_browser: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    pub clipboard_count: i64,
    pub download_count: i64,
    pub db_size_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EngineStatus {
    pub ytdlp_path: Option<String>,
    pub ffmpeg_path: Option<String>,
    pub ytdlp_version: Option<String>,
    pub deno_path: Option<String>,
    pub deno_version: Option<String>,
    pub ffmpeg_version: Option<String>,
    pub checked_at: Option<String>,
    pub updated_at: Option<String>,
    pub channel: crate::download::engine::Channel,
    pub extraction: crate::download::engine::Extraction,
    pub failure: Option<crate::island::activity::ErrorKind>,
    pub update_error: Option<String>,
    pub busy: bool,
    pub last_update_check: Option<String>,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    Light,
    Dark,
    #[default]
    #[serde(other)]
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub island_activity: crate::island::activity::Preferences,
    #[serde(default)]
    pub island: crate::island::model::Preferences,
    #[serde(default)]
    pub theme: ThemePreference,
    pub retention_days: i64,
    pub capture_images: bool,
    pub image_size_cap_mb: i64,
    pub paste_on_select: bool,
    pub sensitive_heuristics: bool,
    pub auto_detect_links: bool,
    pub show_detect_notification: bool,
    pub pause_auto_detect: bool,
    pub launch_at_login: bool,
    pub start_hidden: bool,
    pub show_dock_icon: bool,
    pub toggle_popover_shortcut: String,
    #[serde(default = "default_island_shortcut")]
    pub island_shortcut: String,
    pub quick_download_shortcut: String,
    pub clipboard_search_shortcut: String,
    pub default_quality: String,
    pub output_dir: String,
    pub filename_template: String,
    pub max_concurrent_downloads: usize,
    pub reveal_after_download: bool,
    pub engine_auto_update: bool,
    pub first_run_acknowledged: bool,
    pub last_tab: String,
}

fn default_island_shortcut() -> String {
    if cfg!(windows) {
        "Alt+Space".into()
    } else {
        String::new()
    }
}
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            island_activity: crate::island::activity::Preferences::default(),
            island: crate::island::model::Preferences::default(),
            theme: ThemePreference::System,
            retention_days: 30,
            capture_images: true,
            image_size_cap_mb: 10,
            paste_on_select: false,
            sensitive_heuristics: false,
            auto_detect_links: true,
            show_detect_notification: true,
            pause_auto_detect: false,
            launch_at_login: false,
            start_hidden: true,
            show_dock_icon: false,
            toggle_popover_shortcut: "CmdOrCtrl+Shift+V".into(),
            island_shortcut: default_island_shortcut(),
            quick_download_shortcut: "Ctrl+Alt+D".into(),
            clipboard_search_shortcut: "CmdOrCtrl+Shift+C".into(),
            default_quality: "1080p".into(),
            output_dir: String::new(),
            filename_template: "%(title)s [%(id)s].%(ext)s".into(),
            max_concurrent_downloads: 2,
            reveal_after_download: false,
            engine_auto_update: true,
            first_run_acknowledged: false,
            last_tab: "download".into(),
        }
    }
}
