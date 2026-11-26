use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use chrono::Utc;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::{
    db::{
        models::{DownloadJob, DownloadMetadata, DownloadRequest},
        Database,
    },
    download::{
        options::{Browser, DownloadOptions},
        probe, ytdlp,
    },
    error::{msg, Result},
    util::default_output_dir,
};

#[derive(Clone)]
pub struct DownloadManager {
    inner: Arc<Mutex<Inner>>,
    db: Database,
    app: AppHandle,
    app_data_dir: PathBuf,
    deferred: Arc<super::deferred::Scheduler>,
}

struct Inner {
    queue: VecDeque<String>,
    active: usize,
    children: HashMap<String, ChildHandle>,
    browsers: HashMap<String, Browser>,
}

#[derive(Clone)]
struct ChildHandle {
    pid: u32,
}

impl DownloadManager {
    fn emit_updated(&self, job: &DownloadJob) {
        let mut job = job.clone();
        job.failure = super::errors::for_job(&job);
        let _ = self.app.emit("download:updated", job.clone());
        crate::island::activity_bus::download(&self.app, &job);
    }
    pub fn new(db: Database, app: AppHandle, app_data_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                queue: VecDeque::new(),
                active: 0,
                children: HashMap::new(),
                browsers: HashMap::new(),
            })),
            db,
            app,
            app_data_dir,
            deferred: Arc::default(),
        }
    }

    pub fn enqueue_remembered(&self, url: String) -> Result<DownloadJob> {
        let fallback = self.db.get_settings()?.default_quality;
        let preset = self.db.download_preset(&url, &fallback)?;
        self.enqueue(DownloadRequest {
            url,
            options: Some(preset.options),
            ..Default::default()
        })
    }

    pub fn enqueue(&self, request: DownloadRequest) -> Result<DownloadJob> {
        let settings = self.db.get_settings()?;
        let options = match &request.options {
            Some(o) => o.clone(),
            None => DownloadOptions::from_legacy(
                &request.quality,
                &request.playlist_mode,
                request.playlist_range.as_deref(),
            )?,
        }
        .with_defaults(&settings.output_dir, &settings.filename_template)?;
        let normalized = crate::capture::web_url(&request.url)?;
        super::presets::site_key(&normalized)?;
        let captured = self
            .app
            .try_state::<crate::AppState>()
            .and_then(|s| s.capture.current())
            .filter(|m| {
                m.normalized_url == normalized && m.extractor.as_deref() != Some("capture")
            });
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
                qualities: vec![],
                details: None,
                live_pending: None,
            }
        } else if let Some(metadata) = captured {
            metadata
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
                qualities: vec![],
                details: None,
                live_pending: None,
            })
        };
        let job = job_from_metadata(metadata, options);
        self.db
            .insert_download_and_preset(&job, request.remember_for_site)?;
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| msg("download manager lock poisoned"))?;
            if let Some(browser) = request.cookies_from_browser {
                inner.browsers.insert(job.id.clone(), browser);
            }
            inner.queue.push_back(job.id.clone());
        }
        self.pump();
        Ok(job)
    }

    pub fn enqueue_playlist(
        &self,
        request: DownloadRequest,
        indices: Vec<u32>,
    ) -> Result<Vec<DownloadJob>> {
        let settings = self.db.get_settings()?;
        let normalized = crate::capture::web_url(&request.url)?;
        let metadata = self
            .app
            .try_state::<crate::AppState>()
            .and_then(|s| s.capture.current())
            .filter(|m| m.normalized_url == normalized && m.details.is_some())
            .map(Ok)
            .unwrap_or_else(|| probe::probe(&self.app_data_dir, &normalized))?;
        let mut options = request.options.clone().unwrap_or_default();
        options.playlist_mode = super::options::PlaylistMode::Video;
        options.playlist_items = None;
        if !options.sections.is_empty() {
            return Err(msg("Trim one video at a time."));
        }
        let options = options.with_defaults(&settings.output_dir, &settings.filename_template)?;
        let jobs = playlist_jobs(&metadata, &indices, &options)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| msg("download manager lock poisoned"))?;
        self.db
            .insert_download_batch(&jobs, request.remember_for_site, &normalized)?;
        for job in &jobs {
            if let Some(browser) = request.cookies_from_browser {
                inner.browsers.insert(job.id.clone(), browser);
            }
            inner.queue.push_back(job.id.clone());
        }
        drop(inner);
        self.pump();
        Ok(jobs)
    }

    pub fn retry(&self, id: &str) -> Result<DownloadJob> {
        self.recover(id, super::errors::Recovery::Retry)
    }
    pub fn retry_with_browser(&self, id: &str, browser: Browser) -> Result<DownloadJob> {
        self.recover(id, super::errors::Recovery::SignIn { browser })
    }

    pub fn recover(&self, id: &str, recovery: super::errors::Recovery) -> Result<DownloadJob> {
        self.recover_inner(id, recovery, false)
    }
    fn recover_inner(
        &self,
        id: &str,
        recovery: super::errors::Recovery,
        automatic: bool,
    ) -> Result<DownloadJob> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| msg("download manager lock poisoned"))?;
        let mut job = self.db.get_download(id)?;
        if automatic && !super::deferred::eligible(&job) {
            return Err(msg("This download is no longer waiting."));
        }
        job.options = Some(super::errors::apply_recovery(&job, &recovery)?);
        job.quality = job.options.as_ref().unwrap().legacy_quality();
        job.playlist_mode = if job.options.as_ref().unwrap().playlist_mode
            == super::options::PlaylistMode::Playlist
        {
            "playlist"
        } else {
            "video"
        }
        .into();
        job.playlist_range = job.options.as_ref().unwrap().playlist_items.clone();
        job.status = "queued".into();
        job.progress = 0.0;
        job.speed = None;
        job.eta = None;
        job.error = None;
        job.failure = None;
        job.updated_at = Utc::now();
        self.db.update_download(&job)?;
        match recovery {
            super::errors::Recovery::SignIn { browser } => {
                inner.browsers.insert(id.into(), browser);
            }
            super::errors::Recovery::Options { browser, .. } => {
                inner.browsers.remove(id);
                if let Some(browser) = browser {
                    inner.browsers.insert(id.into(), browser);
                }
            }
            _ => (),
        }
        self.deferred.remove(id);
        if !inner.queue.contains(&job.id) {
            inner.queue.push_back(job.id.clone());
        }
        drop(inner);
        self.emit_updated(&job);
        self.pump();
        Ok(job)
    }
    pub fn start_deferred(&self) {
        for job in self
            .db
            .list_downloads()
            .unwrap_or_default()
            .into_iter()
            .filter(super::deferred::eligible)
        {
            self.deferred.schedule(&job.id);
        }
        let manager = self.clone();
        thread::Builder::new()
            .name("nabbit-download-recovery".into())
            .spawn(move || {
                while let Some(ids) = manager.deferred.next() {
                    for id in ids {
                        let Ok(job) = manager.db.get_download(&id) else {
                            continue;
                        };
                        if !super::deferred::eligible(&job) {
                            continue;
                        }
                        let kind =
                            super::errors::classify(job.error.as_deref().unwrap_or_default());
                        if kind == super::errors::ErrorKind::Offline
                            && !super::deferred::online(&job.url)
                        {
                            manager.deferred.schedule(&id);
                            continue;
                        }
                        let _ = manager.recover_inner(&id, super::errors::Recovery::Retry, true);
                    }
                }
            })
            .expect("spawn deferred download recovery");
    }
    pub fn stop(&self) {
        self.deferred.stop();
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
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| msg("download manager lock poisoned"))?;
        self.deferred.remove(id);
        inner.queue.retain(|queued| queued != id);
        if status == "cancelled" {
            inner.browsers.remove(id);
        }
        if let Some(child) = inner.children.remove(id) {
            kill_pid(child.pid);
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
        if result.as_ref().is_err_and(|error| {
            !fallback_format && should_fallback_download_error(&error.to_string())
        }) && self
            .db
            .get_download(&id)
            .is_ok_and(|job| !matches!(job.status.as_str(), "paused" | "cancelled"))
        {
            self.run_job(id, true);
            return;
        }
        // Publish the terminal state only after releasing this worker's slot/child.
        // A recovery action therefore cannot race cleanup of the same job.
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.active = inner.active.saturating_sub(1);
        inner.children.remove(&id);
        if let Err(error) = result {
            if let Some(mut job) =
                self.db.get_download(&id).ok().filter(|job| {
                    !matches!(job.status.as_str(), "paused" | "cancelled" | "completed")
                })
            {
                job.status = "failed".into();
                job.error = Some(error.to_string());
                job.failure = super::errors::for_job(&job);
                job.updated_at = Utc::now();
                if self.db.update_download(&job).is_ok() {
                    self.emit_updated(&job);
                    if super::deferred::eligible(&job) {
                        self.deferred.schedule(&id);
                    }
                }
            }
        }
        if self
            .db
            .get_download(&id)
            .is_ok_and(|job| matches!(job.status.as_str(), "completed" | "cancelled"))
        {
            inner.browsers.remove(&id);
        }
        drop(inner);
        self.pump();
    }

    fn run_job_inner(&self, id: &str, fallback_format: bool) -> Result<()> {
        if std::env::var_os("NABBIT_ACCEPTANCE_FAKE_DOWNLOAD").is_some() {
            return self.run_acceptance_fake_job(id);
        }

        let mut job = self.db.get_download(id)?;
        if job.options.as_ref().is_some_and(|o| o.wait_for_video) {
            let browser = self
                .inner
                .lock()
                .map_err(|_| msg("download manager lock poisoned"))?
                .browsers
                .get(id)
                .copied();
            let metadata =
                ytdlp::probe_metadata_with_browser(&self.app_data_dir, &job.url, browser)?;
            if metadata.live_pending == Some(true) {
                return Err(msg(
                    "This is still live (is_live / is_upcoming); waiting for the replay.",
                ));
            }
            if metadata.live_pending.is_none() {
                return Err(msg(
                    "The source did not report whether the replay is ready. Try again later.",
                ));
            }
        }
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
            options: job.options.clone(),
            cookies_from_browser: self
                .inner
                .lock()
                .map_err(|_| msg("download manager lock poisoned"))?
                .browsers
                .get(id)
                .copied(),
            ..Default::default()
        };
        let output_dir = if let Some(dir) = job.options.as_ref().and_then(|o| o.output_dir.clone())
        {
            dir
        } else if settings.output_dir.trim().is_empty() {
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
        )?;
        fs::create_dir_all(&output_dir)?;
        args.extend(super::engine::runtime_args(
            ytdlp::resolve_engine(&self.app_data_dir, "deno").as_deref(),
        )?);
        if let Some(section) = std::env::var_os("NABBIT_ACCEPTANCE_DOWNLOAD_SECTION") {
            args.extend([
                "--download-sections".into(),
                section.to_string_lossy().to_string(),
            ]);
        }
        args.extend(["--".into(), job.url.clone()]);

        let mut inner = self
            .inner
            .lock()
            .map_err(|_| msg("download manager lock poisoned"))?;
        if self
            .db
            .get_download(id)
            .is_ok_and(|j| matches!(j.status.as_str(), "paused" | "cancelled" | "completed"))
        {
            return Ok(());
        }
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
        inner.children.insert(id.to_string(), ChildHandle { pid });
        drop(inner);

        // Drain stderr alongside stdout so a long failure/trace cannot fill its pipe.
        let mut stderr_pipe = child
            .stderr
            .take()
            .ok_or_else(|| msg("download process stderr unavailable"))?;
        let stderr_reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            stderr_pipe.read_to_end(&mut bytes).map(|_| bytes)
        });

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| msg("download process stdout unavailable"))?;
        let reader = BufReader::new(stdout);
        let mut last_output_path = None;
        for line in reader.lines().map_while(std::result::Result::ok) {
            if let Some(progress) = ytdlp::parse_progress_line(&line) {
                let _guard = self
                    .inner
                    .lock()
                    .map_err(|_| msg("download manager lock poisoned"))?;
                let mut update = self.db.get_download(id)?;
                if matches!(update.status.as_str(), "paused" | "cancelled") {
                    break;
                }
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
        let stderr = stderr_reader
            .join()
            .map_err(|_| msg("download error log reader failed"))??;
        let _guard = self
            .inner
            .lock()
            .map_err(|_| msg("download manager lock poisoned"))?;
        let mut finished = self.db.get_download(id)?;
        if matches!(finished.status.as_str(), "paused" | "cancelled") {
            return Ok(());
        }
        finished.updated_at = Utc::now();
        finished.output_path = finished.output_path.or(last_output_path);
        if output.status.success() {
            finished.status = "completed".into();
            finished.progress = 100.0;
            finished.error = None;
            if let Some(path) =
                find_final_output_path(&output_dir, &finished.url, &finished.quality).filter(|_| {
                    !finished
                        .output_path
                        .as_deref()
                        .is_some_and(|p| Path::new(p).is_file())
                })
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
            let stderr = String::from_utf8_lossy(&stderr).to_string();
            Err(msg(if stderr.trim().is_empty() {
                "Download failed without an error message".into()
            } else {
                stderr
            }))
        }
    }

    fn run_acceptance_fake_job(&self, id: &str) -> Result<()> {
        let settings = self.db.get_settings()?;
        let saved = self.db.get_download(id)?;
        let output_dir =
            if let Some(dir) = saved.options.as_ref().and_then(|o| o.output_dir.clone()) {
                dir
            } else if settings.output_dir.trim().is_empty() {
                default_output_dir()
            } else {
                settings.output_dir.clone()
            };
        fs::create_dir_all(&output_dir)?;

        let extension = saved.options.as_ref().map(|o| o.format.as_str()).unwrap_or(
            if saved.quality == "audio_mp3" {
                "mp3"
            } else {
                "mp4"
            },
        );
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
        "audio_opus" => &["opus"],
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
    super::errors::classify(error) == super::errors::ErrorKind::Unknown
        && ["ffmpeg", "merge", "merging", "mux", "postprocessing"]
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
        assert!(!should_fallback_download_error(
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

fn job_from_metadata(metadata: DownloadMetadata, options: DownloadOptions) -> DownloadJob {
    let now = Utc::now();
    DownloadJob {
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
        failure: None,
        quality: options.legacy_quality(),
        playlist_mode: match options.playlist_mode {
            super::options::PlaylistMode::Video => "video",
            super::options::PlaylistMode::Playlist => "playlist",
        }
        .into(),
        playlist_range: options.playlist_items.clone(),
        options: Some(options),
        created_at: now,
        updated_at: now,
    }
}

fn playlist_jobs(
    metadata: &DownloadMetadata,
    indices: &[u32],
    options: &DownloadOptions,
) -> Result<Vec<DownloadJob>> {
    let jobs: Vec<_> = super::media::selected(metadata, indices)?
        .into_iter()
        .map(|entry| {
            let url = entry.url.expect("selected entries have validated URLs");
            job_from_metadata(
                DownloadMetadata {
                    url: url.clone(),
                    normalized_url: url,
                    title: entry.title,
                    channel: metadata.channel.clone(),
                    duration: entry.duration,
                    thumbnail: entry.thumbnail,
                    is_playlist: false,
                    playlist_count: None,
                    extractor: metadata.extractor.clone(),
                    qualities: entry.qualities,
                    details: None,
                    live_pending: None,
                },
                options.clone(),
            )
        })
        .collect();
    Ok(jobs)
}

#[cfg(test)]
mod playlist_tests {
    use super::*;
    #[test]
    fn selected_videos_get_distinct_jobs_with_individual_urls_and_snapshots() {
        let source = "https://www.youtube.com/playlist?list=fixture";
        let metadata=super::super::ytdlp::metadata_from_value(&serde_json::json!({"_type":"playlist","title":"Fixture","entries":[{"id":"one","title":"First"},{"id":"two","title":"Second"},{"id":"three","title":"Third"}]}),source).unwrap();
        let options = DownloadOptions {
            format: super::super::options::Format::Opus,
            height: None,
            speed_limit: Some("2M".into()),
            ..Default::default()
        };
        let jobs = playlist_jobs(&metadata, &[3, 1, 1], &options).unwrap();
        assert_eq!(jobs.len(), 2);
        assert_ne!(jobs[0].id, jobs[1].id);
        assert_eq!(jobs[0].title, "First");
        assert!(jobs[0].url.ends_with("v=one"));
        assert!(jobs[1].url.ends_with("v=three"));
        assert!(jobs.iter().all(|j| j.options.as_ref() == Some(&options)
            && j.playlist_mode == "video"
            && j.playlist_range.is_none()
            && j.status == "queued"));
        assert!(playlist_jobs(&metadata, &[4], &options).is_err());
    }
}
