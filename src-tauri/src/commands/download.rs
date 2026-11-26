use std::fs;

use crate::{
    db::models::{DownloadJob, DownloadMetadata, DownloadRequest, EngineStatus},
    download::{engine::Channel, manager::reveal_path, probe},
    error::{msg, Result},
    util::default_output_dir,
    AppState,
};

#[tauri::command]
pub async fn probe_url(state: tauri::State<'_, AppState>, url: String) -> Result<DownloadMetadata> {
    let dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || probe::probe(&dir, &url))
        .await
        .map_err(|e| msg(e.to_string()))?
}
#[tauri::command]
pub fn capture_url(app: tauri::AppHandle, url: String) -> Result<DownloadMetadata> {
    crate::capture::review(&app, &url)
}
#[tauri::command]
pub fn get_captured_link(state: tauri::State<'_, AppState>) -> Option<DownloadMetadata> {
    state.capture.current()
}

#[tauri::command]
pub fn get_staged_url(state: tauri::State<'_, AppState>) -> Result<Option<String>> {
    state.db.setting_value("staged_url")
}

#[tauri::command]
pub fn clear_staged_url(state: tauri::State<'_, AppState>) -> Result<()> {
    state.capture.clear()
}

#[tauri::command]
pub fn start_download(
    state: tauri::State<'_, AppState>,
    request: DownloadRequest,
) -> Result<DownloadJob> {
    let job = state.downloads.enqueue(request)?;
    let _ = state.capture.clear_if_current(&job.url);
    Ok(job)
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
pub fn pause_download(state: tauri::State<'_, AppState>, id: String) -> Result<()> {
    state.downloads.pause(&id)
}

#[tauri::command]
pub fn resume_download(state: tauri::State<'_, AppState>, id: String) -> Result<DownloadJob> {
    state.downloads.resume(&id)
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
    Ok(state.engine.snapshot())
}

#[tauri::command]
pub async fn check_engine(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<EngineStatus> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.run(&app, false, None))
        .await
        .map_err(|e| msg(e.to_string()))
}

#[tauri::command]
pub async fn repair_engine(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    channel: Option<Channel>,
) -> Result<EngineStatus> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.run(&app, true, channel))
        .await
        .map_err(|e| msg(e.to_string()))
}

#[tauri::command]
pub fn quick_download_staged(state: tauri::State<'_, AppState>) -> Result<Option<DownloadJob>> {
    let Some(url) = state.db.setting_value("staged_url")? else {
        return Ok(None);
    };
    state.downloads.enqueue_remembered(url).map(Some)
}

#[tauri::command]
pub fn list_download_presets() -> Vec<crate::download::presets::Preset> {
    crate::download::presets::defaults()
}

#[tauri::command]
pub fn parse_download_timecode(value: String) -> Result<u64> {
    crate::download::options::parse_timecode(&value)
}
#[tauri::command]
pub fn resolve_download_preset(
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<crate::download::presets::Preset> {
    state
        .db
        .download_preset(&url, &state.db.get_settings()?.default_quality)
}
#[tauri::command]
pub fn remember_download_preset(
    state: tauri::State<'_, AppState>,
    url: String,
    options: crate::download::options::DownloadOptions,
) -> Result<crate::download::presets::Preset> {
    state.db.remember_download_preset(&url, &options)
}
#[tauri::command]
pub fn start_download_with_preset(
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<DownloadJob> {
    let job = state.downloads.enqueue_remembered(url)?;
    let _ = state.capture.clear_if_current(&job.url);
    Ok(job)
}
