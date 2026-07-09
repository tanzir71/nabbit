use chrono::Utc;
use std::{fs, path::Path, process::Command};

use crate::{
    db::models::{DownloadJob, DownloadMetadata, DownloadRequest, EngineStatus},
    download::{manager::reveal_path, probe, ytdlp},
    error::{msg, Result},
    util::default_output_dir,
    AppState,
};

#[tauri::command]
pub fn probe_url(state: tauri::State<'_, AppState>, url: String) -> Result<DownloadMetadata> {
    let metadata = probe::probe(&state.app_data_dir, &url)?;
    let _ = state
        .db
        .set_setting_value("staged_url", &metadata.normalized_url);
    Ok(metadata)
}

#[tauri::command]
pub fn start_download(
    state: tauri::State<'_, AppState>,
    request: DownloadRequest,
) -> Result<DownloadJob> {
    state.downloads.enqueue(request)
}

#[tauri::command]
pub fn list_downloads(state: tauri::State<'_, AppState>) -> Result<Vec<DownloadJob>> {
    state.db.list_downloads()
}

#[tauri::command]
pub fn cancel_download(state: tauri::State<'_, AppState>, id: String) -> Result<()> {
    state.downloads.cancel(&id)
}

#[tauri::command]
pub fn retry_download(state: tauri::State<'_, AppState>, id: String) -> Result<DownloadJob> {
    state.downloads.retry(&id)
}

#[tauri::command]
pub fn reveal_download(state: tauri::State<'_, AppState>, id: String) -> Result<()> {
    let job = state.db.get_download(&id)?;
    if let Some(path) = job.output_path {
        reveal_path(&path)
    } else {
        Err(msg("No file path recorded for this download"))
    }
}

#[tauri::command]
pub fn open_downloads_folder(state: tauri::State<'_, AppState>) -> Result<()> {
    let settings = state.db.get_settings()?;
    let output = if settings.output_dir.trim().is_empty() {
        default_output_dir()
    } else {
        settings.output_dir
    };
    fs::create_dir_all(&output)?;
    reveal_path(&output)
}

#[tauri::command]
pub fn get_engine_status(state: tauri::State<'_, AppState>) -> Result<EngineStatus> {
    Ok(engine_status(&state))
}

#[tauri::command]
pub fn repair_engine(state: tauri::State<'_, AppState>) -> Result<EngineStatus> {
    fetch_ytdlp(&state.app_data_dir)?;
    Ok(engine_status(&state))
}

#[tauri::command]
pub fn quick_download_staged(state: tauri::State<'_, AppState>) -> Result<Option<DownloadJob>> {
    let Some(url) = state.db.setting_value("staged_url")? else {
        return Ok(None);
    };
    let settings = state.db.get_settings()?;
    let request = DownloadRequest {
        url,
        quality: settings.default_quality,
        playlist_mode: "video".into(),
        playlist_range: None,
    };
    state.downloads.enqueue(request).map(Some)
}

pub fn engine_status(state: &AppState) -> EngineStatus {
    let ytdlp = ytdlp::resolve_engine(&state.app_data_dir, "yt-dlp");
    let ffmpeg = ytdlp::resolve_engine(&state.app_data_dir, "ffmpeg");
    let version = ytdlp::ytdlp_version(&state.app_data_dir);
    let mut missing = Vec::new();
    if ytdlp.is_none() {
        missing.push("yt-dlp".into());
    }
    if ffmpeg.is_none() {
        missing.push("ffmpeg".into());
    }
    EngineStatus {
        ytdlp_path: ytdlp.map(|path| path.to_string_lossy().to_string()),
        ffmpeg_path: ffmpeg.map(|path| path.to_string_lossy().to_string()),
        ytdlp_version: version,
        last_update_check: state
            .db
            .setting_value("engine_last_update_check")
            .ok()
            .flatten(),
        missing,
    }
}

pub fn spawn_engine_update(state: AppState) {
    std::thread::Builder::new()
        .name("nabbit-engine-update".into())
        .spawn(move || {
            let Ok(settings) = state.db.get_settings() else {
                return;
            };
            if !settings.engine_auto_update {
                return;
            }
            let last = state
                .db
                .setting_value("engine_last_update_check")
                .ok()
                .flatten();
            let should_run = last
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
                .map(|value| {
                    Utc::now()
                        .signed_duration_since(value.with_timezone(&Utc))
                        .num_hours()
                        >= 24
                })
                .unwrap_or(true);
            if !should_run {
                return;
            }
            let _ = state
                .db
                .set_setting_value("engine_last_update_check", &Utc::now().to_rfc3339());
            if let Some(path) = ytdlp::resolve_engine(&state.app_data_dir, "yt-dlp") {
                let _ = Command::new(path).arg("-U").output();
            } else {
                let _ = fetch_ytdlp(&state.app_data_dir);
            }
        })
        .expect("spawn engine update");
}

fn fetch_ytdlp(app_data_dir: &Path) -> Result<()> {
    let engine_dir = app_data_dir.join("engine");
    fs::create_dir_all(&engine_dir)?;
    let url = if cfg!(target_os = "windows") {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    } else if cfg!(target_os = "linux") {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
    } else {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
    };
    let target = engine_dir.join(if cfg!(target_os = "windows") {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    });
    let response = reqwest::blocking::get(url)
        .map_err(|error| msg(format!("engine download failed: {error}")))?;
    if !response.status().is_success() {
        return Err(msg(format!(
            "engine download returned {}",
            response.status()
        )));
    }
    fs::write(
        &target,
        response.bytes().map_err(|error| msg(error.to_string()))?,
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&target)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&target, permissions)?;
    }
    Ok(())
}
