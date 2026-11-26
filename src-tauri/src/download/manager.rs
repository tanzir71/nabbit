use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use chrono::Utc;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::{
    db::{
        models::{DownloadJob, DownloadMetadata, DownloadRequest},
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
    fn emit_updated(&self, job: &DownloadJob) {
        let _ = self.app.emit("download:updated", job.clone());
        crate::island::activity_bus::download(&self.app, job);
    }
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
        let metadata = if std::env::var_os("NABBIT_ACCEPTANCE_FAKE_DOWNLOAD").is_some() {
            DownloadMetadata {
                url: request.url.clone(),
                normalized_url: normalized.clone(),
                title: format!("Acceptance download {normalized}"),
                channel: None,
                duration: None,
                thumbnail: None,
                is_playlist: normalized.contains("list="),
                playlist_count: None,
                extractor: Some("acceptance".into()),
            }
        } else {
            probe::probe(&self.app_data_dir, &normalized).unwrap_or_else(|_| DownloadMetadata {
                url: request.url.clone(),
                normalized_url: normalized.clone(),
                title: normalized.clone(),
                channel: None,
                duration: None,
                thumbnail: None,
                is_playlist: normalized.contains("list="),
                playlist_count: None,
                extractor: Some("fallback".into()),
            })
        };
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
        self.stop_job(id, "cancelled", Some("Cancelled"))
    }

    pub fn pause(&self, id: &str) -> Result<()> {
        self.stop_job(id, "paused", None)
    }

    pub fn resume(&self, id: &str) -> Result<DownloadJob> {
        let mut job = self.db.get_download(id)?;
        if job.status != "paused" && job.status != "interrupted" {
            return Ok(job);
        }
        job.status = "queued".into();
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
        self.emit_updated(&job);
        self.pump();
        Ok(job)
    }

    fn stop_job(&self, id: &str, status: &str, error: Option<&str>) -> Result<()> {
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
            job.status = status.into();
            job.error = error.map(ToOwned::to_owned);
            job.updated_at = Utc::now();
            self.db.update_download(&job)?;
            self.emit_updated(&job);
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
            if let Ok(job) = self.db.get_download(&id) {
                if matches!(job.status.as_str(), "paused" | "cancelled") {
                    if let Ok(mut inner) = self.inner.lock() {
                        inner.active = inner.active.saturating_sub(1);
                        inner.children.remove(&id);
                    }
                    self.pump();
                    return;
                }
            }
            if !fallback_format && should_fallback_download_error(&error.to_string()) {
                self.run_job(id.clone(), true);
                return;
            }
            if let Ok(mut job) = self.db.get_download(&id) {
                job.status = "failed".into();
                job.error = Some(error.to_string());
                job.updated_at = Utc::now();
                let _ = self.db.update_download(&job);
                self.emit_updated(&job);
            }
        }

        if let Ok(mut inner) = self.inner.lock() {
            inner.active = inner.active.saturating_sub(1);
            inner.children.remove(&id);
        }
        self.pump();
    }

    fn run_job_inner(&self, id: &str, fallback_format: bool) -> Result<()> {
        if std::env::var_os("NABBIT_ACCEPTANCE_FAKE_DOWNLOAD").is_some() {
            return self.run_acceptance_fake_job(id);
        }

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
        if let Some(section) = std::env::var_os("NABBIT_ACCEPTANCE_DOWNLOAD_SECTION") {
            args.extend([
                "--download-sections".into(),
                section.to_string_lossy().to_string(),
            ]);
        }
        args.push(job.url.clone());

        job.status = "running".into();
        job.updated_at = Utc::now();
        self.db.update_download(&job)?;
        self.emit_updated(&job);

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
                self.emit_updated(&update);
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
            if let Some(path) =
                find_final_output_path(&output_dir, &finished.url, &finished.quality)
            {
                finished.output_path = Some(path.to_string_lossy().to_string());
            }
            self.db.update_download(&finished)?;
            self.emit_updated(&finished);
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

    fn run_acceptance_fake_job(&self, id: &str) -> Result<()> {
        let settings = self.db.get_settings()?;
        let output_dir = if settings.output_dir.trim().is_empty() {
            default_output_dir()
        } else {
            settings.output_dir.clone()
        };
        fs::create_dir_all(&output_dir)?;

        let extension = if self.db.get_download(id)?.quality == "audio_mp3" {
            "mp3"
        } else {
            "mp4"
        };
        let output_path =
            Path::new(&output_dir).join(format!("nabbit-acceptance-{id}.{extension}"));
        let output_path_string = output_path.to_string_lossy().to_string();
        let delay_ms = std::env::var("NABBIT_ACCEPTANCE_FAKE_DOWNLOAD_DELAY_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(250);

        let mut job = self.db.get_download(id)?;
        job.status = "running".into();
        job.output_path = Some(output_path_string.clone());
        job.updated_at = Utc::now();
        self.db.update_download(&job)?;
        self.emit_updated(&job);

        for step in 1..=5 {
            thread::sleep(Duration::from_millis(delay_ms));

            let mut update = self.db.get_download(id)?;
            if update.status != "running" {
                return Ok(());
            }

            update.status = "running".into();
            update.progress = step as f64 * 20.0;
            update.speed = Some("1.0MiB/s".into());
            update.eta = (step < 5).then(|| format!("00:0{}", 5 - step));
            update.output_path = Some(output_path_string.clone());
            update.updated_at = Utc::now();
            self.db.update_download(&update)?;
            self.emit_updated(&update);
        }

        let current = self.db.get_download(id)?;
        if current.status != "running" {
            return Ok(());
        }

        let bytes: &[u8] = if extension == "mp3" {
            b"ID3nabbit acceptance mp3"
        } else {
            b"nabbit acceptance mp4"
        };
        fs::write(&output_path, bytes)?;

        let mut finished = current;
        finished.status = "completed".into();
        finished.progress = 100.0;
        finished.speed = Some("1.0MiB/s".into());
        finished.eta = None;
        finished.output_path = Some(output_path_string);
        finished.error = None;
        finished.updated_at = Utc::now();
        self.db.update_download(&finished)?;
        self.emit_updated(&finished);

        Ok(())
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

fn find_final_output_path(output_dir: &str, url: &str, quality: &str) -> Option<PathBuf> {
    let dir = Path::new(output_dir);
    let id = video_id_from_url(url);
    let preferred_exts: &[&str] = match quality {
        "audio_mp3" => &["mp3"],
        "audio_m4a" => &["m4a", "mp4"],
        _ => &["mp4", "mkv", "webm"],
    };
    let mut candidates = Vec::new();
    collect_candidate_files(dir, id.as_deref(), preferred_exts, &mut candidates);
    candidates
        .into_iter()
        .max_by_key(|(_, modified)| *modified)
        .map(|(path, _)| path)
}

fn collect_candidate_files(
    dir: &Path,
    id: Option<&str>,
    preferred_exts: &[&str],
    candidates: &mut Vec<(PathBuf, std::time::SystemTime)>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_candidate_files(&path, id, preferred_exts, candidates);
            continue;
        }
        let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        if !preferred_exts
            .iter()
            .any(|candidate| ext.eq_ignore_ascii_case(candidate))
        {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if let Some(id) = id {
            if !name.contains(id) {
                continue;
            }
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        candidates.push((path, modified));
    }
}

fn video_id_from_url(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    if url.host_str()?.contains("youtu.be") {
        return url
            .path_segments()
            .and_then(|mut segments| segments.next().map(ToOwned::to_owned));
    }
    url.query_pairs()
        .find(|(key, _)| key == "v")
        .map(|(_, value)| value.to_string())
}

fn should_fallback_download_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    [
        "format",
        "requested format",
        "ffmpeg",
        "merge",
        "merging",
        "mux",
        "postprocessing",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::{find_final_output_path, should_fallback_download_error};
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    #[test]
    fn final_output_prefers_extracted_mp3_for_audio_jobs() {
        let dir = tempfile_dir();
        let mp3 = dir.join("Example [abc123].mp3");
        let webm = dir.join("Example [abc123].webm");
        fs::write(&webm, b"temp").unwrap();
        fs::write(&mp3, b"final").unwrap();

        let found = find_final_output_path(
            dir.to_str().unwrap(),
            "https://www.youtube.com/watch?v=abc123",
            "audio_mp3",
        )
        .unwrap();

        assert_eq!(found, mp3);
    }

    #[test]
    fn fallback_covers_format_and_merge_failures() {
        assert!(should_fallback_download_error(
            "Requested format is not available"
        ));
        assert!(should_fallback_download_error(
            "ffmpeg exited with code 1 while merging formats"
        ));
        assert!(!should_fallback_download_error(
            "This video is private and cannot be downloaded"
        ));
    }

    fn tempfile_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nabbit-download-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}

#[cfg(not(target_os = "windows"))]
fn kill_pid(pid: u32) {
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .output();
}
