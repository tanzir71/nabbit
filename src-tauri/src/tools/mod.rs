pub mod commands;
mod files;
mod process;
pub mod registry;
pub mod store;
#[cfg(test)]
mod tests;
use crate::{
    db::Database,
    error::{msg, Result},
    island::activity::{ActivityEvent, JobState},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::JoinHandle,
};
use tauri::{Emitter, Manager};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub request_id: String,
    pub tool_id: String,
    pub input: String,
    pub preset_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub request: Request,
    pub preset: registry::Preset,
    pub status: String,
    pub percent: f64,
    pub created_at: String,
    pub output: Option<String>,
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub note: Option<String>,
    pub error: Option<String>,
    pub output_hash: Option<String>,
    #[serde(default)]
    pub output_identity: Option<String>,
    #[serde(default)]
    pub staging_path: Option<String>,
    pub attempt: u32,
    #[serde(default)]
    pub retry_of: Option<String>,
}
struct State {
    jobs: HashMap<String, Job>,
    cancel: HashMap<String, Arc<AtomicBool>>,
    stopping: bool,
}
struct Inner {
    db: Database,
    publish: Arc<dyn Fn(&Job) + Send + Sync>,
    dir: PathBuf,
    state: Mutex<State>,
}
pub struct Service {
    inner: Arc<Inner>,
    sender: mpsc::Sender<Option<String>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    pub quit_confirmed: AtomicBool,
}
impl Service {
    pub fn start(db: Database, app: tauri::AppHandle, dir: PathBuf) -> Result<Arc<Self>> {
        Self::create(
            db,
            dir,
            Arc::new(move |job| {
                let _ = app.emit("tools:changed", ());
                for event in activity_events(job) {
                    crate::island::activity_bus::publish(&app, event);
                }
            }),
        )
    }
    fn create(
        db: Database,
        dir: PathBuf,
        publish: Arc<dyn Fn(&Job) + Send + Sync>,
    ) -> Result<Arc<Self>> {
        let mut jobs = HashMap::new();
        for mut job in db.tool_jobs()? {
            if matches!(job.status.as_str(), "queued" | "running" | "publishing") {
                let recovered = job.status == "publishing"
                    && job.output_identity.is_some()
                    && job.output_hash.is_some()
                    && job.output.as_ref().is_some_and(|path| {
                        files::identity(Path::new(path)).ok() == job.output_identity
                            && files::hash(Path::new(path)).ok() == job.output_hash
                    });
                job.status = "failed".into();
                job.error =
                    Some("Interrupted when Nabbit stopped. Retry to create a new output.".into());
                if recovered {
                    job.status = "completed".into();
                    job.percent = 100.;
                    job.error = None;
                } else {
                    job.output = None;
                    job.output_hash = None;
                }
                if let Some(path) = job.staging_path.take() {
                    if job.output_identity.is_some()
                        && files::identity(Path::new(&path)).ok() == job.output_identity
                    {
                        let _ = std::fs::remove_file(path);
                    }
                }
                db.save_tool_job(&job)?;
            }
            jobs.insert(job.id.clone(), job);
        }
        let inner = Arc::new(Inner {
            db,
            publish,
            dir,
            state: Mutex::new(State {
                jobs,
                cancel: HashMap::new(),
                stopping: false,
            }),
        });
        let (sender, receiver) = mpsc::channel::<Option<String>>();
        let work = inner.clone();
        let worker = std::thread::Builder::new()
            .name("nabbit-tools".into())
            .spawn(move || {
                while let Ok(Some(id)) = receiver.recv() {
                    work.run(&id);
                }
            })?;
        Ok(Arc::new(Self {
            inner,
            sender,
            worker: Mutex::new(Some(worker)),
            quit_confirmed: AtomicBool::new(false),
        }))
    }
    pub fn jobs(&self) -> Result<Vec<Job>> {
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| msg("Tool queue unavailable"))?;
        let mut jobs = state.jobs.values().cloned().collect::<Vec<_>>();
        jobs.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
        Ok(jobs)
    }
    pub fn active(&self) -> bool {
        self.inner
            .state
            .lock()
            .map(|s| {
                s.jobs
                    .values()
                    .any(|j| matches!(j.status.as_str(), "queued" | "running"))
            })
            .unwrap_or(true)
    }
    pub fn submit(&self, request: Request) -> Result<Job> {
        self.schedule(request, None)
    }
    fn schedule(&self, request: Request, retry: Option<&Job>) -> Result<Job> {
        let id =
            uuid::Uuid::parse_str(&request.request_id).map_err(|_| msg("Invalid request ID"))?;
        if id.get_version() != Some(uuid::Version::Random) || id.to_string() != request.request_id {
            return Err(msg("Invalid request ID"));
        }
        {
            let state = self
                .inner
                .state
                .lock()
                .map_err(|_| msg("Tool queue unavailable"))?;
            if let Some(old) = state.jobs.get(&request.request_id) {
                if old.request == request {
                    return Ok(old.clone());
                }
                return Err(msg("The request ID already belongs to another tool job"));
            }
        }
        let tool = registry::get(&request.tool_id)?;
        if !tool.presets.contains(&request.preset_id.as_str())
            || !tool.accepts_path(Path::new(&request.input))
        {
            return Err(msg("Choose a supported file and preset"));
        }
        let _file = files::input(Path::new(&request.input))?;
        let preset = if let Some(old) = retry {
            old.preset.clone()
        } else {
            self.inner
                .db
                .tool_presets()?
                .into_iter()
                .find(|p| p.id == request.preset_id)
                .ok_or_else(|| msg("Unknown preset"))?
        };
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| msg("Tool queue unavailable"))?;
        if let Some(old) = state.jobs.get(&request.request_id) {
            if old.request == request {
                return Ok(old.clone());
            }
            return Err(msg("The request ID already belongs to another tool job"));
        }
        if state.stopping {
            return Err(msg("Nabbit is quitting"));
        }
        if state
            .jobs
            .values()
            .filter(|j| matches!(j.status.as_str(), "queued" | "running"))
            .count()
            >= 64
        {
            return Err(msg("The tool queue is full"));
        }
        let job = Job {
            id: request.request_id.clone(),
            request,
            preset,
            status: "queued".into(),
            percent: 0.,
            created_at: chrono::Utc::now().to_rfc3339(),
            output: None,
            before_bytes: 0,
            after_bytes: 0,
            note: None,
            error: None,
            output_hash: None,
            output_identity: None,
            staging_path: None,
            attempt: retry.map_or(1, |old| old.attempt.saturating_add(1)),
            retry_of: retry.map(|old| old.id.clone()),
        };
        self.inner.db.save_tool_job(&job)?;
        state
            .cancel
            .insert(job.id.clone(), Arc::new(AtomicBool::new(false)));
        state.jobs.insert(job.id.clone(), job.clone());
        self.inner.changed(&job);
        self.sender
            .send(Some(job.id.clone()))
            .map_err(|_| msg("Tool worker stopped"))?;
        Ok(job)
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| msg("Tool queue unavailable"))?;
        let mut job = state
            .jobs
            .get(id)
            .cloned()
            .ok_or_else(|| msg("Tool job not found"))?;
        if !matches!(job.status.as_str(), "queued" | "running") {
            return Err(msg("This tool job is no longer running"));
        }
        if let Some(cancel) = state.cancel.get(id) {
            cancel.store(true, Ordering::Release);
        }
        // A running worker retains ownership until its process and temporary output are gone.
        if job.status == "queued" {
            job.status = "cancelled".into();
            self.inner.db.save_tool_job(&job)?;
            state.jobs.insert(id.into(), job.clone());
            state.cancel.remove(id);
            self.inner.changed(&job);
        }
        Ok(())
    }
    pub fn retry(&self, id: &str) -> Result<Job> {
        let job = self
            .jobs()?
            .into_iter()
            .find(|j| j.id == id)
            .ok_or_else(|| msg("Tool job not found"))?;
        if !matches!(job.status.as_str(), "cancelled" | "failed") {
            return Err(msg("Only cancelled or failed jobs can be retried"));
        }
        let mut request = job.request.clone();
        request.request_id = uuid::Uuid::new_v4().to_string();
        self.schedule(request, Some(&job))
    }
    pub fn undo_with(&self, id: &str, recycle: impl FnOnce(&Path) -> Result<()>) -> Result<()> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| msg("Tool queue unavailable"))?;
        let mut job = state
            .jobs
            .get(id)
            .cloned()
            .ok_or_else(|| msg("Tool job not found"))?;
        let path = job
            .output
            .as_deref()
            .filter(|_| job.status == "completed")
            .ok_or_else(|| msg("This result cannot be undone"))?;
        let path = Path::new(path);
        if job.output_identity.is_none()
            || files::identity(path).ok() != job.output_identity
            || files::hash(path)? != job.output_hash.clone().unwrap_or_default()
        {
            return Err(msg(
                "The output changed. Undo will not remove an edited file.",
            ));
        }
        recycle(path)?;
        job.status = "undone".into();
        self.inner.db.save_tool_job(&job)?;
        state.jobs.insert(id.into(), job.clone());
        self.inner.changed(&job);
        Ok(())
    }
    pub fn stop(&self) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.stopping = true;
            for flag in state.cancel.values() {
                flag.store(true, Ordering::Release);
            }
        }
        let _ = self.sender.send(None);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}
impl Inner {
    fn changed(&self, job: &Job) {
        (self.publish)(job);
    }
    fn save(&self, job: &Job) -> Result<()> {
        self.db.save_tool_job(job)?;
        self.state
            .lock()
            .map_err(|_| msg("Tool queue unavailable"))?
            .jobs
            .insert(job.id.clone(), job.clone());
        self.changed(job);
        Ok(())
    }
    fn run(&self, id: &str) {
        let (mut job, cancel) = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let Some(mut job) = state.jobs.get(id).cloned() else {
                return;
            };
            if job.status != "queued" {
                return;
            }
            let Some(cancel) = state.cancel.get(id).cloned() else {
                return;
            };
            if state.stopping {
                cancel.store(true, Ordering::Release);
            }
            job.status = "running".into();
            if self.db.save_tool_job(&job).is_err() {
                return;
            }
            state.jobs.insert(id.into(), job.clone());
            (job, cancel)
        };
        self.changed(&job);
        let result = self.execute(&mut job, &cancel);
        if let Err(error) = result {
            job.output = None;
            job.output_hash = None;
            job.status = if cancel.load(Ordering::Acquire) {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            job.error = Some(error.to_string());
        }
        if job.status != "completed" {
            if let Err(e) = self.save(&job) {
                eprintln!("Could not persist tool result: {e}");
            }
        }
        if let Ok(mut state) = self.state.lock() {
            state.cancel.remove(id);
        }
    }
    fn execute(&self, job: &mut Job, cancel: &AtomicBool) -> Result<()> {
        let input_path = job.request.input.clone();
        let source = Path::new(&input_path);
        let file = files::input(source)?;
        job.before_bytes = file.metadata()?.len();
        let before = files::hash_with_cancel(source, Some(cancel))?;
        let executor = registry::get(&job.request.tool_id)?.executor;
        let ext = executor.extension();
        let temp = source.with_file_name(format!(".nabbit-{}.{}", job.id, ext));
        let reserved = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        drop(reserved);
        job.staging_path = Some(temp.to_string_lossy().into());
        job.output_identity = Some(files::identity(&temp)?);
        self.save(job)?;
        let result = (|| {
            if cancel.load(Ordering::Acquire) {
                return Err(msg("Cancelled"));
            }
            match executor {
                registry::Executor::Mp4 => {
                    let ffmpeg = crate::download::ffmpeg::verified(&self.dir)?;
                    let last = std::cell::Cell::new(job.percent);
                    let result = process::mp4(&ffmpeg, source, &temp, cancel, &|percent| {
                        last.set(percent);
                        let mut update = job.clone();
                        update.percent = percent;
                        let _ = self.save(&update);
                    });
                    job.percent = last.get();
                    result?;
                }
                registry::Executor::Jpg => {
                    use image::ImageReader;
                    let mut reader = ImageReader::open(source).map_err(|e| msg(e.to_string()))?;
                    let mut limits = image::Limits::default();
                    limits.max_image_width = Some(20000);
                    limits.max_image_height = Some(20000);
                    limits.max_alloc = Some(256 * 1024 * 1024);
                    reader.limits(limits);
                    let image = reader
                        .decode()
                        .map_err(|e| msg(format!("Could not read the image: {e}")))?;
                    let image = image.to_rgb8();
                    let mut output = std::fs::OpenOptions::new()
                        .write(true)
                        .truncate(true)
                        .open(&temp)?;
                    image::codecs::jpeg::JpegEncoder::new_with_quality(
                        &mut output,
                        job.preset.quality as u8,
                    )
                    .encode_image(&image)
                    .map_err(|e| msg(format!("Could not write JPG: {e}")))?;
                    output.sync_all()?;
                }
            }
            if cancel.load(Ordering::Acquire) {
                return Err(msg("Cancelled"));
            }
            if before != files::hash_with_cancel(source, Some(cancel))? {
                return Err(msg("The input changed while the tool was running"));
            }
            if std::fs::metadata(&temp)?.len() == 0 {
                return Err(msg("The tool produced an empty file"));
            }
            let copied = files::dates(&file, &temp).is_ok();
            std::fs::OpenOptions::new()
                .write(true)
                .open(&temp)?
                .sync_all()?;
            job.output_hash = Some(files::hash_with_cancel(&temp, Some(cancel))?);
            job.after_bytes = std::fs::metadata(&temp)?.len();
            // Publication and completion serialize against cancel/quit. A successful cancel
            // cannot be followed by a newly published output.
            let mut state = self
                .state
                .lock()
                .map_err(|_| msg("Tool queue unavailable"))?;
            if cancel.load(Ordering::Acquire) || state.stopping {
                return Err(msg("Cancelled"));
            }
            let preset_name = job.preset.name.clone();
            let output = files::publish(&temp, source, &preset_name, ext, |path| {
                job.status = "publishing".into();
                job.output = Some(path.to_string_lossy().into());
                self.db.save_tool_job(job)
            })?;
            job.output = Some(output.to_string_lossy().into());
            job.status = "completed".into();
            job.percent = 100.;
            job.note = Some(if copied {
                job.preset.name.clone()
            } else {
                format!("{} · file dates could not be kept", job.preset.name)
            });
            if let Err(error) = self.db.save_tool_job(job) {
                let _ = std::fs::remove_file(output);
                job.output = None;
                job.output_hash = None;
                return Err(error);
            }
            state.jobs.insert(job.id.clone(), job.clone());
            self.changed(job);
            drop(state);
            Ok(())
        })();
        let _ = std::fs::remove_file(&temp);
        job.staging_path = None;
        result
    }
}
fn quit_requires_confirmation(active: bool, confirmed: bool) -> bool {
    active && !confirmed
}
pub fn request_quit(app: &tauri::AppHandle) {
    if let Some(service) = app.try_state::<Arc<Service>>() {
        if quit_requires_confirmation(
            service.active(),
            service.quit_confirmed.load(Ordering::Acquire),
        ) {
            #[cfg(windows)]
            unsafe {
                use windows_sys::Win32::UI::WindowsAndMessaging::{
                    MessageBoxW, IDCANCEL, MB_DEFBUTTON2, MB_ICONWARNING, MB_OKCANCEL,
                };
                let body="Tools are still running. Quit will cancel unfinished jobs and keep them in the queue so you can retry.\0".encode_utf16().collect::<Vec<_>>();
                let title = "Quit Nabbit?\0".encode_utf16().collect::<Vec<_>>();
                if MessageBoxW(
                    std::ptr::null_mut(),
                    body.as_ptr(),
                    title.as_ptr(),
                    MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2,
                ) == IDCANCEL
                {
                    return;
                }
            }
            #[cfg(not(windows))]
            {
                let _ = app.emit("tools:quit-warning", ());
                return;
            }
            service.quit_confirmed.store(true, Ordering::Release);
        }
    }
    app.exit(0);
}

fn activity_events(job: &Job) -> Vec<ActivityEvent> {
    let state = match job.status.as_str() {
        "queued" => JobState::Queued,
        "running" => JobState::Running,
        "failed" => JobState::Failed,
        "completed" => JobState::Done,
        _ => JobState::Cancelled,
    };
    let mut events = vec![ActivityEvent::ToolJob {
        job_id: job.id.clone(),
        tool_id: job.request.tool_id.clone(),
        label: job.preset.name.clone(),
        percent: job.percent,
        state,
    }];
    if let Some(previous) = &job.retry_of {
        events.push(ActivityEvent::Dismissed {
            id: format!("tool:{previous}"),
        });
    }
    if job.status == "completed" {
        events.push(ActivityEvent::ToolResult {
            job_id: job.id.clone(),
            path: job.output.clone().unwrap_or_default(),
            before_bytes: job.before_bytes,
            after_bytes: job.after_bytes,
            note: job.note.clone(),
        });
    }
    if job.status == "undone" {
        events.push(ActivityEvent::Dismissed {
            id: format!("toolResult:{}", job.id),
        });
    }
    events
}
