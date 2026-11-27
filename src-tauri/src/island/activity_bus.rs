//! One blocked Rust scheduler owns deadlines. No collapsed WebView is needed.
use super::activity::{ActivityEvent, Engine, Message, Monitor, Preferences, Snapshot, Time};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
pub struct Bus {
    wakes: AtomicU64,
    app: AppHandle,
    state: Mutex<Engine>,
    changed: Condvar,
    stopped: AtomicBool,
    started: Instant,
}
impl Bus {
    pub fn start(app: AppHandle, preferences: Preferences) -> Arc<Self> {
        let bus = Arc::new(Self {
            wakes: AtomicU64::new(0),
            app,
            state: Mutex::new(Engine::new(preferences)),
            changed: Condvar::new(),
            stopped: AtomicBool::new(false),
            started: Instant::now(),
        });
        let worker = bus.clone();
        std::thread::Builder::new()
            .name("nabbit-activity".into())
            .spawn(move || {
                let mut state = worker.state.lock().unwrap_or_else(|e| e.into_inner());
                while !worker.stopped.load(Ordering::Relaxed) {
                    if let Some(message) = state.tick(worker.now()) {
                        drop(state);
                        worker.emit(message, true);
                        state = worker.state.lock().unwrap_or_else(|e| e.into_inner());
                        continue;
                    }
                    state = match state.next_wait_ms(worker.now()) {
                        Some(ms) => {
                            worker
                                .changed
                                .wait_timeout(state, Duration::from_millis(ms))
                                .unwrap_or_else(|e| e.into_inner())
                                .0
                        }
                        None => worker
                            .changed
                            .wait(state)
                            .unwrap_or_else(|e| e.into_inner()),
                    };
                    worker.wakes.fetch_add(1, Ordering::Relaxed);
                }
            })
            .expect("spawn activity scheduler");
        bus
    }
    fn now(&self) -> Time {
        Time {
            mono_ms: self.started.elapsed().as_millis() as u64,
            unix_ms: chrono::Utc::now().timestamp_millis(),
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot()
    }
    #[cfg(windows)]
    pub fn stats(&self) -> SchedulerStats {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        SchedulerStats {
            wakeups: self.wakes.load(Ordering::Relaxed),
            next_deadline_ms: state.next_wait_ms(self.now()),
        }
    }
    pub fn submit(&self, event: ActivityEvent, target: Option<String>) {
        let message =
            self.state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .submit(event, target, self.now());
        self.changed.notify_one();
        self.emit(message, true);
    }
    pub fn enrich_link(&self, url: &str, title: &str, duration: Option<u32>) {
        let message = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .enrich_link(url, title, duration);
        if let Some(message) = message {
            self.emit(message, true);
        }
    }
    pub fn monitors(&self, monitors: Vec<Monitor>) {
        let message = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .monitors(monitors, self.now());
        if let Some(message) = message {
            self.changed.notify_one();
            self.emit(message, false);
        }
    }
    // Native input holds its own state lock. Mutate the pure engine here, but
    // defer all WebView/event work until that lock has been released.
    #[cfg(windows)]
    pub fn native_update(
        &self,
        monitors: Vec<Monitor>,
        events: Vec<ActivityEvent>,
    ) -> (Snapshot, Vec<Message>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut messages: Vec<_> = events
            .into_iter()
            .map(|event| state.submit(event, None, self.now()))
            .collect();
        if let Some(message) = state.monitors(monitors, self.now()) {
            messages.push(message);
        }
        (state.snapshot(), messages)
    }
    #[cfg(windows)]
    pub fn native_publish(&self, messages: Vec<Message>) {
        if !messages.is_empty() {
            self.changed.notify_one();
        }
        for message in messages {
            self.emit(message, false);
        }
    }
    pub fn refresh(&self) {
        let _state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.changed.notify_one();
    }
    pub fn stop(&self) {
        let _state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.stopped.store(true, Ordering::Relaxed);
        self.changed.notify_one();
    }
    fn emit(&self, message: Message, wake: bool) {
        if let Some(timer) = self.app.try_state::<Arc<crate::timer::Service>>() {
            timer.observe(&message.snapshot);
        }
        let _ = self.app.emit("nabbit://activity", &message);
        let _ = self.app.emit("nabbit://island", &message);
        #[cfg(windows)]
        if wake {
            if let Some(manager) = self.app.try_state::<Arc<super::Manager>>() {
                manager.activity_changed();
            }
        }
        #[cfg(not(windows))]
        let _ = wake;
    }
}
#[cfg(windows)]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerStats {
    pub wakeups: u64,
    pub next_deadline_ms: Option<u64>,
}
pub fn publish(app: &AppHandle, event: ActivityEvent) {
    publish_to(app, event, None);
}
pub fn publish_to(app: &AppHandle, event: ActivityEvent, target: Option<String>) {
    if let Some(bus) = app.try_state::<Arc<Bus>>() {
        bus.submit(event, target);
    }
}
pub fn download(app: &AppHandle, job: &crate::db::models::DownloadJob) {
    publish(app, download_event(job));
}
pub(crate) fn download_event(job: &crate::db::models::DownloadJob) -> ActivityEvent {
    match job.status.as_str() {
        "running" => ActivityEvent::DownloadProgress {
            job_id: job.id.clone(),
            title: job.title.clone(),
            percent: job.progress.clamp(0.0, 100.0),
            speed: job.speed.clone(),
            eta: job.eta.clone(),
        },
        "completed" => ActivityEvent::DownloadDone {
            job_id: job.id.clone(),
            path: job.output_path.clone().unwrap_or_default(),
        },
        "failed" => ActivityEvent::DownloadFailed {
            job_id: job.id.clone(),
            error: crate::download::errors::classify(job.error.as_deref().unwrap_or_default()),
        },
        _ => ActivityEvent::DownloadRemoved {
            job_id: job.id.clone(),
        },
    }
}
#[tauri::command]
pub fn get_activity_snapshot(app: AppHandle) -> Result<Snapshot, String> {
    app.try_state::<Arc<Bus>>()
        .map(|bus| bus.snapshot())
        .ok_or("Activity bus is unavailable".into())
}
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
    Dismiss { id: String },
    HideOneHour,
    Show,
    Focus { active: bool },
    Configure { preferences: Preferences },
}
#[tauri::command]
pub fn island_activity_action(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
    action: Action,
) -> Result<(), String> {
    let bus = app
        .try_state::<Arc<Bus>>()
        .ok_or("Activity bus is unavailable")?;
    bus.refresh();
    if let Action::Dismiss { id } = action {
        bus.submit(ActivityEvent::Dismissed { id }, None);
        return Ok(());
    }
    let mut settings = state.db.get_settings().map_err(|e| e.to_string())?;
    match action {
        Action::HideOneHour => {
            settings.island_activity.hidden_until_ms =
                Some(chrono::Utc::now().timestamp_millis() + 3_600_000)
        }
        Action::Show => {
            settings.island_activity.hidden_until_ms = None;
            settings.island_activity.focus_mode = false;
        }
        Action::Focus { active } => settings.island_activity.focus_mode = active,
        Action::Configure { preferences } => settings.island_activity = preferences,
        Action::Dismiss { .. } => unreachable!(),
    }
    crate::commands::settings::save_settings(app, state, settings).map_err(|e| e.to_string())?;
    Ok(())
}
