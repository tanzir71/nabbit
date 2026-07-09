use std::{
    collections::{HashMap, VecDeque},
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

use chrono::Utc;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::{
    db::{
        models::{DownloadJob, DownloadRequest},
        Database,
    },
    download::{probe, ytdlp},
    error::{msg, Result},
    util::{default_output_dir, normalize_video_url},
};

#[derive(Clone)]
pub struct DownloadManager {
    inner: Arc<Mutex<Inner>>,
    db: Database,
    app: AppHandle,
    app_data_dir: PathBuf,
}

struct Inner {
    queue: VecDeque<String>,
    active: usize,
    children: HashMap<String, ChildHandle>,
}

#[derive(Clone)]
struct ChildHandle {
    pid: u32,
}

impl DownloadManager {
    pub fn new(db: Database, app: AppHandle, app_data_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                queue: VecDeque::new(),
                active: 0,
                children: HashMap::new(),
            })),
            db,
            app,
            app_data_dir,
        }
    }

    pub fn enqueue(&self, request: DownloadRequest) -> Result<DownloadJob> {
        let normalized =
            normalize_video_url(&request.url).unwrap_or_else(|| request.url.trim().to_string());
        let metadata = probe::probe(&self.app_data_dir, &normalized).unwrap_or_else(|_| {
            crate::db::models::DownloadMetadata {
                url: request.url.clone(),
                normalized_url: normalized.clone(),
                title: normalized.clone(),
                channel: None,
                duration: None,
                thumbnail: None,
                is_playlist: normalized.contains("list="),
                playlist_count: None,
                extractor: Some("fallback".into()),
            }
        });
        let now = Utc::now();
        let job = DownloadJob {
            id: Uuid::new_v4().to_string(),
            url: metadata.normalized_url,
            title: metadata.title,
            thumbnail: metadata.thumbnail,
            status: "queued".into(),
            progress: 0.0,
            speed: None,
            eta: None,
            output_path: None,
            error: None,
            quality: request.quality,
            playlist_mode: request.playlist_mode,
            playlist_range: request.playlist_range,
            created_at: now,
            updated_at: now,
        };
        self.db.insert_download(&job)?;
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| msg("download manager lock poisoned"))?;
            inner.queue.push_back(job.id.clone());
        }
        self.pump();
        Ok(job)
    }

    pub fn retry(&self, id: &str) -> Result<DownloadJob> {
        let mut job = self.db.get_download(id)?;
        job.status = "queued".into();
        job.progress = 0.0;
        job.error = None;
        job.updated_at = Utc::now();
        self.db.update_download(&job)?;
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| msg("download manager lock poisoned"))?;
            if !inner.queue.contains(&job.id) {
                inner.queue.push_back(job.id.clone());
            }
        }
        self.pump();
        Ok(job)
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| msg("download manager lock poisoned"))?;
            inner.queue.retain(|queued| queued != id);
            if let Some(child) = inner.children.remove(id) {
                kill_pid(child.pid);
            }
        }
        let mut job = self.db.get_download(id)?;
        if job.status != "completed" {
            job.status = "cancelled".into();
            job.error = Some("Cancelled".into());
            job.updated_at = Utc::now();
            self.db.update_download(&job)?;
            let _ = self.app.emit("download:updated", job);
        }
        Ok(())
    }

    pub fn pump(&self) {
        let settings = match self.db.get_settings() {
            Ok(settings) => settings,
            Err(error) => {
                eprintln!("download pump settings error: {error}");
                return;
            }
        };
        loop {
            let id = {
                let mut inner = match self.inner.lock() {
                    Ok(inner) => inner,
                    Err(_) => return,
                };
                if inner.active >= settings.max_concurrent_downloads {
                    return;
                }
                match inner.queue.pop_front() {
                    Some(id) => {
                        inner.active += 1;
                        id
                    }
                    None => return,
                }
            };

            let manager = self.clone();
            thread::Builder::new()
                .name(format!("nabbit-download-{id}"))
                .spawn(move || manager.run_job(id, false))
                .expect("spawn download worker");
        }
    }

    fn run_job(&self, id: String, fallback_format: bool) {
        let result = self.run_job_inner(&id, fallback_format);
        if let Err(error) = result {
            if !fallback_format && error.to_string().to_lowercase().contains("format") {
                self.run_job(id.clone(), true);
                return;
            }
            if let Ok(mut job) = self.db.get_download(&id) {
                job.status = "failed".into();
                job.error = Some(error.to_string());
                job.updated_at = Utc::now();
                let _ = self.db.update_download(&job);
                let _ = self.app.emit("download:updated", job);
            }
        }

        if let Ok(mut inner) = self.inner.lock() {
            inner.active = inner.active.saturating_sub(1);
            inner.children.remove(&id);
        }
        self.pump();
    }

    fn run_job_inner(&self, id: &str, fallback_format: bool) -> Result<()> {
        let mut job = self.db.get_download(id)?;
        let Some(ytdlp) = ytdlp::resolve_engine(&self.app_data_dir, "yt-dlp") else {
            return Err(msg(
                "yt-dlp sidecar missing. Use Repair to fetch the downloader engine.",
            ));
        };
        let ffmpeg = ytdlp::resolve_engine(&self.app_data_dir, "ffmpeg");
        let settings = self.db.get_settings()?;
        let request = DownloadRequest {
            url: job.url.clone(),
            quality: job.quality.clone(),
            playlist_mode: job.playlist_mode.clone(),
            playlist_range: job.playlist_range.clone(),
        };
        let output_dir = if settings.output_dir.trim().is_empty() {
            default_output_dir()
        } else {
            settings.output_dir.clone()
        };
        let mut args = ytdlp::build_download_args(
            &request,
            &output_dir,
            &settings.filename_template,
            ffmpeg.as_deref(),
            fallback_format,
        );
        args.push(job.url.clone());

        job.status = "running".into();
        job.updated_at = Utc::now();
        self.db.update_download(&job)?;
        let _ = self.app.emit("download:updated", job.clone());

        let mut child = Command::new(ytdlp)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let pid = child.id();
        if let Ok(mut inner) = self.inner.lock() {
            inner.children.insert(id.to_string(), ChildHandle { pid });
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| msg("download process stdout unavailable"))?;
        let reader = BufReader::new(stdout);
        let mut last_output_path = None;
        for line in reader.lines().map_while(std::result::Result::ok) {
            if let Some(progress) = ytdlp::parse_progress_line(&line) {
                let mut update = self.db.get_download(id)?;
                if let Some(value) = progress.progress {
                    update.progress = value;
                }
                update.speed = progress.speed;
                update.eta = progress.eta;
                if progress.output_path.is_some() {
                    last_output_path = progress.output_path.clone();
                    update.output_path = progress.output_path;
                }
                update.status = "running".into();
                update.updated_at = Utc::now();
                self.db.update_download(&update)?;
                let _ = self.app.emit("download:updated", update);
            }
        }

        let output = child.wait_with_output()?;
        let mut finished = self.db.get_download(id)?;
        finished.updated_at = Utc::now();
        finished.output_path = finished.output_path.or(last_output_path);
        if output.status.success() {
            finished.status = "completed".into();
            finished.progress = 100.0;
            finished.error = None;
            self.db.update_download(&finished)?;
            let _ = self.app.emit("download:updated", finished.clone());
            if settings.reveal_after_download {
                let _ = reveal_path(finished.output_path.as_deref().unwrap_or(&output_dir));
            }
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(msg(if stderr.is_empty() {
                "Download failed without an error message".into()
            } else {
                stderr
            }))
        }
    }
}

pub fn reveal_path(path: &str) -> Result<()> {
    open::that(path)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn kill_pid(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
}

#[cfg(not(target_os = "windows"))]
fn kill_pid(pid: u32) {
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .output();
}
