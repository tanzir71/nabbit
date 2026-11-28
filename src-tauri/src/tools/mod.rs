pub mod commands;
pub mod documents;
pub(crate) mod files;
pub mod images;
pub mod media;
pub(crate) mod platform;
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
    #[serde(default)]
    pub options: media::Options,
    #[serde(default)]
    pub image_options: images::Options,
    #[serde(default)]
    pub document_options: documents::Options,
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
    #[serde(default)]
    pub media_info: Option<media::Info>,
    #[serde(default)]
    pub media_report: Option<media::Report>,
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
    pub sheet: Mutex<Option<media::sheet::Intent>>,
    pub sheet_open: Mutex<()>,
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
            sheet: Mutex::new(None),
            sheet_open: Mutex::new(()),
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
    pub fn reload_locations(&self) -> Result<Vec<String>> {
        let rows = self.inner.db.tool_jobs()?;
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| msg("Tool queue unavailable"))?;
        let mut changed = Vec::new();
        for row in rows {
            if let Some(job) = state.jobs.get_mut(&row.id) {
                if job.status == "completed"
                    && row.status == "completed"
                    && job.request == row.request
                    && (job.output != row.output || job.output_identity != row.output_identity)
                {
                    job.output = row.output;
                    job.output_identity = row.output_identity;
                    job.output_hash = row.output_hash;
                    changed.push(job.id.clone());
                }
            }
        }
        Ok(changed)
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
        request.options.validate()?;
        request.image_options.validate()?;
        request.document_options.validate()?;
        for extra in &request.document_options.inputs {
            if !matches!(
                tool.executor,
                registry::Executor::Document(documents::Kind::Merge | documents::Kind::ImagesPdf)
            ) || !tool.accepts_path(Path::new(extra))
            {
                return Err(msg("Unsupported extra input"));
            }
            let _guard = files::input(Path::new(extra))?;
        }
        if let registry::Executor::Document(kind) = tool.executor {
            if matches!(kind, documents::Kind::Split | documents::Kind::Render)
                && request.document_options.pages.is_empty()
            {
                return Err(msg("Choose PDF pages"));
            }
        }
        if !tool.presets.contains(&request.preset_id.as_str())
            || !tool.accepts_path(Path::new(&request.input))
        {
            return Err(msg("Choose a supported file and preset"));
        }
        let _file = files::input(Path::new(&request.input))?;
        let mut preset = if let Some(old) = retry {
            old.preset.clone()
        } else {
            self.inner
                .db
                .tool_presets()?
                .into_iter()
                .find(|p| p.id == request.preset_id)
                .ok_or_else(|| msg("Unknown preset"))?
        };
        if matches!(tool.executor, registry::Executor::Media(media::Kind::Fit)) {
            if let Some(max_mb) = request.options.max_mb {
                preset.max_mb = Some(max_mb);
            }
        }
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
            media_info: None,
            media_report: None,
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
        let mut extra_inputs = Vec::new();
        let mut total = job.before_bytes;
        for path in &job.request.document_options.inputs {
            let path = PathBuf::from(path);
            let guard = files::input(&path)?;
            total = total.saturating_add(guard.metadata()?.len());
            if total > 256 * 1024 * 1024 {
                return Err(msg("Combined inputs exceed 256 MB"));
            }
            let hash = files::hash_with_cancel(&path, Some(cancel))?;
            extra_inputs.push((path, guard, hash));
        }
        job.before_bytes = total;
        let executor = registry::get(&job.request.tool_id)?.executor_for(source);
        let ffmpeg = if let registry::Executor::Media(_) = executor {
            let ffmpeg = crate::download::ffmpeg::verified(&self.dir)?;
            job.media_info = Some(media::inspect(&ffmpeg, source, cancel)?);
            Some(ffmpeg)
        } else {
            None
        };
        let mut ext = executor.extension(source, job.media_info.as_ref());
        let mut image_options = job.request.image_options.clone();
        if matches!(executor, registry::Executor::Image(images::Kind::Convert))
            && image_options.format == images::Format::Original
        {
            image_options.format = match job.request.preset_id.as_str() {
                "png" => images::Format::Png,
                "webp" => images::Format::Webp,
                "avif" => images::Format::Avif,
                _ => images::Format::Jpg,
            };
        }
        let image_job = matches!(executor, registry::Executor::Image(_));
        if let registry::Executor::Image(kind) = executor {
            ext = if kind == images::Kind::Strip {
                source
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into()
            } else {
                image_options.format.extension(source).into()
            };
        }
        let destination = if image_job {
            job.request
                .image_options
                .output_dir
                .as_ref()
                .map(|dir| Path::new(dir).join(source.file_name().unwrap_or_default()))
                .unwrap_or_else(|| source.to_path_buf())
        } else {
            source.to_path_buf()
        };
        if !destination.parent().is_some_and(|p| p.is_dir()) {
            return Err(msg("Choose an existing output folder"));
        }
        let temp = destination.with_file_name(format!(".nabbit-{}.{}", job.id, ext));
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
                registry::Executor::Media(kind) => {
                    let last = std::cell::RefCell::new((
                        job.percent,
                        job.note.clone(),
                        job.media_report.clone(),
                    ));
                    let progress = |percent, stage: &str, report: &media::Report| {
                        let label = if kind == media::Kind::Fit {
                            format!("{} · {stage}", job.preset.name)
                        } else {
                            format!(
                                "{} · {stage}",
                                registry::get(&job.request.tool_id)
                                    .map(|t| t.name)
                                    .unwrap_or("Media tool")
                            )
                        };
                        *last.borrow_mut() = (percent, Some(label.clone()), Some(report.clone()));
                        let mut update = job.clone();
                        update.percent = percent;
                        update.note = Some(label);
                        update.media_report = Some(report.clone());
                        let _ = self.save(&update);
                    };
                    let result = media::execute(
                        media::Context {
                            ffmpeg: ffmpeg.as_ref().expect("media engine"),
                            db: &self.db,
                            input: source,
                            output: &temp,
                            info: job.media_info.as_ref().expect("media information"),
                            options: &job.request.options,
                            cancel,
                            progress: &progress,
                        },
                        kind,
                        job.preset.max_mb,
                    );

                    let (percent, note, report) = last.into_inner();
                    job.percent = percent;
                    job.note = note;
                    job.media_report = report;
                    job.media_report = Some(result?);
                }
                registry::Executor::Document(kind) => {
                    let engine = crate::download::ffmpeg::verified(&self.dir).unwrap_or_default();
                    documents::execute(
                        &engine,
                        source,
                        &temp,
                        kind,
                        &job.request.document_options,
                        cancel,
                    )?;
                }
                registry::Executor::Image(kind) => {
                    let engine = crate::download::ffmpeg::verified(&self.dir).unwrap_or_default();
                    let report = images::execute(
                        images::Context {
                            ffmpeg: &engine,
                            input: source,
                            output: &temp,
                            options: &image_options,
                            cancel,
                        },
                        kind,
                        job.preset.quality,
                        job.preset.max_mb,
                    )?;
                    job.note = report.warning;
                }
            }
            if cancel.load(Ordering::Acquire) {
                return Err(msg("Cancelled"));
            }
            if before != files::hash_with_cancel(source, Some(cancel))? {
                return Err(msg("The input changed while the tool was running"));
            }
            for (path, _guard, hash) in &extra_inputs {
                if *hash != files::hash_with_cancel(path, Some(cancel))? {
                    return Err(msg("An input changed while the tool was running"));
                }
            }
            if std::fs::metadata(&temp)?.len() == 0 {
                return Err(msg("The tool produced an empty file"));
            }
            let copied = image_job && !job.request.image_options.keep_dates
                || files::dates(&file, &temp).is_ok();
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
            let output = files::publish(&temp, &destination, &preset_name, &ext, |path| {
                job.status = "publishing".into();
                job.output = Some(path.to_string_lossy().into());
                self.db.save_tool_job(job)
            })?;
            job.output = Some(output.to_string_lossy().into());
            job.status = "completed".into();
            job.percent = 100.;
            job.note = Some(if copied {
                match &job.media_report {
                    _ if image_job && job.note.is_some() => job.note.clone().unwrap_or_default(),
                    Some(report) if report.warning.is_some() => {
                        report.warning.clone().unwrap_or_default()
                    }
                    Some(report) if report.remuxed => "Remuxed without re-encoding".into(),
                    Some(report) if !report.attempts.is_empty() => {
                        format!("Fits {}", job.preset.name.trim_start_matches("Fit for "))
                    }
                    _ => job.preset.name.clone(),
                }
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
    if app
        .try_state::<Arc<crate::files::Service>>()
        .is_some_and(|files| files.active())
    {
        let _ = app.emit("files:quit-blocked", ());
        #[cfg(windows)]
        if !crate::island::acceptance_session() {
            unsafe {
                use windows_sys::Win32::UI::WindowsAndMessaging::{
                    MessageBoxW, MB_ICONWARNING, MB_OK,
                };
                let text="A file operation is still running. Finish or cancel it in the Windows progress dialog, then quit.\0".encode_utf16().collect::<Vec<_>>();
                let title = "Files are still being filed\0"
                    .encode_utf16()
                    .collect::<Vec<_>>();
                MessageBoxW(
                    std::ptr::null_mut(),
                    text.as_ptr(),
                    title.as_ptr(),
                    MB_OK | MB_ICONWARNING,
                );
            }
        }
        return;
    }
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
        label: if job.status == "running" {
            job.note.clone().unwrap_or_else(|| job.preset.name.clone())
        } else {
            job.preset.name.clone()
        },
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
