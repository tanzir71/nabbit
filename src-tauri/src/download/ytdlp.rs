use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use serde_json::Value;

use crate::{
    db::models::{DownloadMetadata, DownloadRequest},
    error::{msg, Result},
    util::{default_output_dir, normalize_video_url},
};

#[derive(Debug, Clone, Default)]
pub struct ProgressLine {
    pub progress: Option<f64>,
    pub speed: Option<String>,
    pub eta: Option<String>,
    pub output_path: Option<String>,
}

pub fn resolve_engine(app_data_dir: &Path, name: &str) -> Option<PathBuf> {
    let ext = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    let app_data = app_data_dir.join("engine").join(format!("{name}{ext}"));
    if app_data.exists() {
        return Some(app_data);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let bundled = parent.join(format!("{name}{ext}"));
            if bundled.is_file() {
                return Some(bundled);
            }
        }
    }
    let target = target_triple();
    let file_name = format!("{name}-{target}{ext}");
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(file_name);
    if dev_path.exists() {
        return Some(dev_path);
    }

    let plain_dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{name}{ext}"));
    if plain_dev.exists() {
        return Some(plain_dev);
    }

    which::which(format!("{name}{ext}"))
        .ok()
        .or_else(|| which::which(name).ok())
}

pub fn target_triple() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "aarch64-pc-windows-msvc"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else {
        "unknown"
    }
}

pub fn probe_metadata(app_data_dir: &Path, url: &str) -> Result<DownloadMetadata> {
    let normalized = normalize_video_url(url).unwrap_or_else(|| url.trim().to_string());
    let Some(ytdlp) = resolve_engine(app_data_dir, "yt-dlp") else {
        return Ok(fallback_metadata(&normalized, "yt-dlp sidecar missing"));
    };

    let runtime = super::engine::runtime_args(resolve_engine(app_data_dir, "deno").as_deref())?;
    let output = Command::new(ytdlp)
        .args(runtime)
        .args(["-J", "--no-warnings", "--skip-download", "--flat-playlist"])
        .arg(&normalized)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(msg(format!("yt-dlp metadata failed: {}", stderr.trim())));
    }

    let value: Value = serde_json::from_slice(&output.stdout)?;
    let is_playlist = value.get("_type").and_then(Value::as_str) == Some("playlist")
        || value.get("entries").and_then(Value::as_array).is_some()
        || normalized.contains("list=");
    let playlist_count = value
        .get("playlist_count")
        .and_then(Value::as_i64)
        .or_else(|| {
            value
                .get("entries")
                .and_then(Value::as_array)
                .map(|items| items.len() as i64)
        });

    Ok(DownloadMetadata {
        url: url.to_string(),
        normalized_url: normalized,
        title: value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled video")
            .to_string(),
        channel: value
            .get("channel")
            .or_else(|| value.get("uploader"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        duration: value.get("duration").and_then(Value::as_f64),
        thumbnail: value
            .get("thumbnail")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        is_playlist,
        playlist_count,
        extractor: value
            .get("extractor")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    })
}

pub fn build_download_args(
    request: &DownloadRequest,
    output_dir: &str,
    filename_template: &str,
    ffmpeg: Option<&Path>,
    fallback_format: bool,
) -> Vec<String> {
    let mut args = vec![
        "--newline".into(),
        "--no-warnings".into(),
        "--progress-template".into(),
        "download:nabbit:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.filename)s".into(),
    ];

    let quality = request.quality.as_str();
    match quality {
        "audio_mp3" => {
            args.extend(["-x".into(), "--audio-format".into(), "mp3".into()]);
        }
        "audio_m4a" => {
            args.extend(["-x".into(), "--audio-format".into(), "m4a".into()]);
        }
        "best" => {
            args.extend(["-f".into(), "bestvideo*+bestaudio/best".into()]);
        }
        value if value.ends_with('p') => {
            let height = value.trim_end_matches('p');
            let format = if fallback_format {
                format!("best[height<={height}]/best")
            } else {
                format!("bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/best[height<={height}][ext=mp4]/best[height<={height}]")
            };
            args.extend(["-f".into(), format]);
        }
        _ => args.extend(["-f".into(), "bestvideo*+bestaudio/best".into()]),
    }

    if let Some(ffmpeg) = ffmpeg {
        args.extend([
            "--ffmpeg-location".into(),
            ffmpeg.to_string_lossy().to_string(),
        ]);
    }

    if request.playlist_mode == "playlist" {
        args.push("--yes-playlist".into());
        if let Some(range) = request
            .playlist_range
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            args.extend(["--playlist-items".into(), range.trim().into()]);
        }
    } else {
        args.push("--no-playlist".into());
    }

    let dir = if output_dir.trim().is_empty() {
        default_output_dir()
    } else {
        output_dir.to_string()
    };
    let _ = fs::create_dir_all(&dir);
    args.extend(["-P".into(), dir]);
    args.extend(["-o".into(), filename_template.to_string()]);
    args
}

pub fn parse_progress_line(line: &str) -> Option<ProgressLine> {
    let payload = line
        .strip_prefix("nabbit:")
        .or_else(|| line.strip_prefix("download:"))
        .or_else(|| line.contains('|').then_some(line))?;
    let mut parts = payload.split('|');
    let progress = parts
        .next()
        .map(|value| value.trim().trim_end_matches('%').trim())
        .and_then(|value| value.parse::<f64>().ok());
    let speed = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "NA")
        .map(ToOwned::to_owned);
    let eta = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "NA")
        .map(ToOwned::to_owned);
    let output_path = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "NA")
        .map(ToOwned::to_owned);

    Some(ProgressLine {
        progress,
        speed,
        eta,
        output_path,
    })
}

fn fallback_metadata(url: &str, reason: &str) -> DownloadMetadata {
    DownloadMetadata {
        url: url.to_string(),
        normalized_url: url.to_string(),
        title: reason.into(),
        channel: Some("Nabbit".into()),
        duration: None,
        thumbnail: None,
        is_playlist: url.contains("list="),
        playlist_count: None,
        extractor: Some("fallback".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_machine_progress() {
        let parsed = parse_progress_line("nabbit: 42.5%|1.4MiB/s|00:10|C:\\Video.mp4").unwrap();
        assert_eq!(parsed.progress, Some(42.5));
        assert_eq!(parsed.speed.as_deref(), Some("1.4MiB/s"));
        assert_eq!(parsed.eta.as_deref(), Some("00:10"));
    }

    #[test]
    fn parses_bare_machine_progress_from_yt_dlp_type_prefix() {
        let parsed = parse_progress_line(" 100.0%|698.75KiB/s|NA|C:\\Video.mp4").unwrap();
        assert_eq!(parsed.progress, Some(100.0));
        assert_eq!(parsed.speed.as_deref(), Some("698.75KiB/s"));
        assert_eq!(parsed.eta, None);
    }

    #[test]
    fn builds_audio_args() {
        let request = DownloadRequest {
            url: "https://youtu.be/x".into(),
            quality: "audio_mp3".into(),
            playlist_mode: "video".into(),
            playlist_range: None,
        };
        let args = build_download_args(&request, "", "%(title)s.%(ext)s", None, false);
        assert!(args.contains(&"-x".to_string()));
        assert!(args.contains(&"mp3".to_string()));
        assert!(args.contains(&"--no-playlist".to_string()));
    }

    #[test]
    fn builds_playlist_range_args() {
        let request = DownloadRequest {
            url: "https://www.youtube.com/playlist?list=PLabc".into(),
            quality: "1080p".into(),
            playlist_mode: "playlist".into(),
            playlist_range: Some("1-3,7".into()),
        };
        let args = build_download_args(&request, "", "%(title)s.%(ext)s", None, false);

        assert!(args.contains(&"--yes-playlist".to_string()));
        assert!(args.contains(&"--playlist-items".to_string()));
        assert!(args.contains(&"1-3,7".to_string()));
        assert!(!args.contains(&"--no-playlist".to_string()));
    }

    #[test]
    fn fallback_format_uses_progressive_best_when_merge_fails() {
        let request = DownloadRequest {
            url: "https://youtu.be/x".into(),
            quality: "1080p".into(),
            playlist_mode: "video".into(),
            playlist_range: None,
        };
        let args = build_download_args(&request, "", "%(title)s.%(ext)s", None, true);

        let format_index = args.iter().position(|arg| arg == "-f").unwrap() + 1;
        assert_eq!(args[format_index], "best[height<=1080]/best");
    }
}
