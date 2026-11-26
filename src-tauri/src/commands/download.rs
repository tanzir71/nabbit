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
pub async fn start_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: DownloadRequest,
) -> Result<DownloadJob> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let job = state.downloads.enqueue(request)?;
        crate::capture::download_started(&app, &job.url);
        Ok(job)
    })
    .await
    .map_err(|e| msg(e.to_string()))?
}

#[tauri::command]
pub fn clear_finished_downloads(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    use tauri::Emitter;
    for id in state.db.clear_finished_downloads()? {
        crate::island::activity_bus::publish(
            &app,
            crate::island::activity::ActivityEvent::DownloadRemoved { job_id: id },
        );
    }
    app.emit("download:cleared", ())?;
    Ok(())
}
#[tauri::command]
pub async fn open_download(state: tauri::State<'_, AppState>, id: String) -> Result<()> {
    let job = state.db.get_download(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        open_completed_with(&job, |path| open::that(path).map_err(Into::into))
    })
    .await
    .map_err(|e| msg(e.to_string()))?
}
fn open_completed_with(
    job: &DownloadJob,
    open: impl FnOnce(&std::path::Path) -> Result<()>,
) -> Result<()> {
    if job.status != "completed" {
        return Err(msg("This download has not finished"));
    }
    let path = job
        .output_path
        .as_deref()
        .map(std::path::Path::new)
        .filter(|p| p.is_file())
        .ok_or_else(|| msg("The downloaded file is no longer here"))?;
    open(path)
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
pub fn retry_download_with_browser(
    state: tauri::State<'_, AppState>,
    id: String,
    browser: crate::download::options::Browser,
) -> Result<DownloadJob> {
    state.downloads.retry_with_browser(&id, browser)
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
pub async fn start_download_with_preset(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<DownloadJob> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let job = state.downloads.enqueue_remembered(url)?;
        crate::capture::download_started(&app, &job.url);
        Ok(job)
    })
    .await
    .map_err(|e| msg(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    fn job(status: &str, path: &std::path::Path) -> DownloadJob {
        DownloadJob {
            id: uuid::Uuid::new_v4().to_string(),
            url: "https://example.invalid/video".into(),
            title: "Fixture media".into(),
            thumbnail: None,
            status: status.into(),
            progress: 100.0,
            speed: None,
            eta: None,
            output_path: Some(path.to_string_lossy().into_owned()),
            error: None,
            quality: "720p".into(),
            options: None,
            playlist_mode: "video".into(),
            playlist_range: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }
    #[test]
    fn clear_finished_only_removes_completed_or_cancelled_records_and_keeps_files() {
        let dir = std::env::temp_dir().join(format!("nabbit-queue-{}", uuid::Uuid::new_v4()));
        let db = crate::db::Database::open(&dir).unwrap();
        let output = dir.join("fixture.mp4");
        fs::write(&output, b"fixture media").unwrap();
        for status in [
            "running",
            "queued",
            "paused",
            "interrupted",
            "failed",
            "completed",
            "cancelled",
        ] {
            db.insert_download(&job(status, &output)).unwrap();
        }
        assert_eq!(db.clear_finished_downloads().unwrap().len(), 2);
        assert_eq!(db.list_downloads().unwrap().len(), 5);
        assert!(db.clear_finished_downloads().unwrap().is_empty());
        assert_eq!(fs::read(&output).unwrap(), b"fixture media");
        drop(db);
        assert_eq!(
            crate::db::Database::open(&dir)
                .unwrap()
                .list_downloads()
                .unwrap()
                .len(),
            5
        );
    }
    #[test]
    fn open_validates_the_recorded_completed_file_before_calling_an_injected_opener() {
        let dir = std::env::temp_dir().join(format!("nabbit-open-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let output = dir.join("fixture.mp4");
        fs::write(&output, b"fixture media").unwrap();
        let complete = job("completed", &output);
        open_completed_with(&complete, |p| {
            assert_eq!(p, output);
            Ok(())
        })
        .unwrap();
        assert!(open_completed_with(&job("running", &output), |_| panic!(
            "opened an unfinished file"
        ))
        .is_err());
        fs::remove_file(&output).unwrap();
        assert!(open_completed_with(&complete, |_| panic!("opened a missing file")).is_err());
    }
}
