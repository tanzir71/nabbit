//! Persistent focus timer with a deadline worker and no renderer polling clock.
pub mod model;
pub mod store;
#[cfg(test)]
mod tests;
use crate::{
    db::Database,
    island::activity::{ActivityEvent, Snapshot as ActivitySnapshot},
};
use model::*;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicI64, AtomicU8, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::Duration;
use tauri::{Emitter, Listener};
pub const SHORTCUT: &str = "Ctrl+Alt+T";
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
    fn automatic(&self) -> bool {
        true
    }
}
struct SystemClock;
impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}
pub struct FixtureClock(pub AtomicI64);
impl Clock for FixtureClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }
    fn automatic(&self) -> bool {
        false
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Countdown {
    pub id: String,
    pub phase: Phase,
    pub status: Status,
    pub round: u8,
    pub planned_s: u32,
    pub remaining_s: u32,
    pub deadline_ms: Option<i64>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub generation: u64,
    pub config: Config,
    pub session: Option<Countdown>,
    pub linked_card: Option<store::LinkedCard>,
    pub link_unavailable: bool,
    pub shortcut_error: Option<String>,
    pub error: Option<String>,
}
type Reply = mpsc::Sender<Result<Snapshot, String>>;
enum Notice {
    Read(Reply),
    Action(Request, Reply),
    Toggle(Option<Reply>),
    Wake,
    Visibility(u8),
    Viewer(String, String, bool),
    WindowClosed(String),
    Shortcut(Option<String>),
    Stop,
}
pub type Publish = Arc<dyn Fn(Snapshot, Vec<ActivityEvent>) + Send + Sync>;
pub struct Service {
    native_hosts: Mutex<Option<std::collections::BTreeSet<String>>>,
    tx: mpsc::Sender<Notice>,
    cache: Arc<Mutex<Snapshot>>,
    coverage: AtomicU8,
    fixture: Option<Arc<FixtureClock>>,
}
impl Service {
    pub fn new(db: Database, clock: Arc<dyn Clock>, publish: Publish) -> Result<Arc<Self>, String> {
        Self::create(db, clock, publish, None)
    }
    fn create(
        db: Database,
        clock: Arc<dyn Clock>,
        publish: Publish,
        fixture: Option<Arc<FixtureClock>>,
    ) -> Result<Arc<Self>, String> {
        let model = store::load(&db).map_err(|e| e.to_string())?;
        let cache = Arc::new(Mutex::new(snapshot(
            &db,
            &model,
            clock.now_ms(),
            0,
            None,
            None,
        )));
        let (tx, rx) = mpsc::channel();
        let service = Arc::new(Self {
            native_hosts: Mutex::new(None),
            tx,
            cache: cache.clone(),
            coverage: AtomicU8::new(0),
            fixture,
        });
        std::thread::Builder::new()
            .name("nabbit-focus-timer".into())
            .spawn(move || {
                let mut actor = Actor {
                    db,
                    model,
                    clock,
                    publish,
                    cache,
                    revision: 0,
                    coverage: 0,
                    viewers: std::collections::BTreeSet::new(),
                    shortcut: None,
                    error: None,
                    last: None,
                };
                actor.refresh();
                loop {
                    let wait = if actor.clock.automatic() {
                        actor.wait_ms()
                    } else {
                        None
                    };
                    let notice = match wait {
                        Some(ms) => match rx.recv_timeout(Duration::from_millis(ms)) {
                            Ok(n) => n,
                            Err(mpsc::RecvTimeoutError::Timeout) => Notice::Wake,
                            Err(_) => break,
                        },
                        None => match rx.recv() {
                            Ok(n) => n,
                            Err(_) => break,
                        },
                    };
                    match notice {
                        Notice::Stop => break,
                        Notice::Wake => actor.refresh(),
                        Notice::Visibility(value) => {
                            actor.coverage = value;
                            actor.refresh();
                        }
                        Notice::Viewer(window, lease, active) => {
                            if active {
                                actor.viewers.insert((window, lease));
                            } else {
                                actor.viewers.remove(&(window, lease));
                            }
                            actor.refresh();
                        }
                        Notice::WindowClosed(window) => {
                            actor.viewers.retain(|(label, _)| label != &window);
                            actor.refresh();
                        }
                        Notice::Shortcut(error) => {
                            actor.shortcut = error;
                            actor.emit(vec![]);
                        }
                        Notice::Read(reply) => {
                            actor.refresh();
                            let _ = reply.send(Ok(actor.cached()));
                        }
                        Notice::Action(request, reply) => {
                            actor.refresh();
                            let result = if request.expected_generation != actor.model.generation {
                                Err("The timer changed in another window. Try again.".into())
                            } else {
                                actor.action(request.action)
                            };
                            let _ = reply.send(result.map(|_| actor.cached()));
                        }
                        Notice::Toggle(reply) => {
                            actor.refresh();
                            let action = actor.model.toggle_action();
                            let result = actor.action(action);
                            if let Some(reply) = reply {
                                let _ = reply.send(result.map(|_| actor.cached()));
                            }
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(service)
    }
    fn request(&self, notice: impl FnOnce(Reply) -> Notice) -> Result<Snapshot, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(notice(tx))
            .map_err(|_| "Timer service stopped.")?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Timer service timed out.")?
    }
    pub fn read(&self) -> Result<Snapshot, String> {
        self.request(Notice::Read)
    }
    pub fn cached(&self) -> Snapshot {
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn action(&self, request: Request) -> Result<Snapshot, String> {
        self.request(|r| Notice::Action(request, r))
    }
    pub fn toggle(&self) -> Result<Snapshot, String> {
        self.request(|r| Notice::Toggle(Some(r)))
    }
    pub fn hotkey(&self) {
        let _ = self.tx.send(Notice::Toggle(None));
    }
    pub fn wake(&self) {
        let _ = self.tx.send(Notice::Wake);
    }
    pub fn viewer(&self, window: String, lease: String, active: bool) {
        let _ = self.tx.send(Notice::Viewer(window, lease, active));
    }
    pub fn window_closed(&self, label: String) {
        let _ = self.tx.send(Notice::WindowClosed(label));
    }
    pub fn shortcut_status(&self, error: Option<String>) {
        let _ = self.tx.send(Notice::Shortcut(error));
    }
    pub fn stop(&self) {
        let _ = self.tx.send(Notice::Stop);
    }
    pub fn observe(&self, snapshot: &ActivitySnapshot) {
        let native = self.native_hosts.lock().unwrap_or_else(|e| e.into_inner());
        let eligible = snapshot.views.iter().any(|v| {
            v.gate == crate::island::input::Gate::Visible
                && !v.fullscreen
                && !v.focus_mode
                && !v.user_hidden
        });
        let visible = snapshot.views.iter().any(|v| {
            v.gate == crate::island::input::Gate::Visible
                && native
                    .as_ref()
                    .is_none_or(|labels| labels.contains(&v.label))
                && [v.primary.as_ref(), v.bubble.as_ref()]
                    .into_iter()
                    .flatten()
                    .any(|i| {
                        matches!(
                            i.event,
                            ActivityEvent::TimerTick { .. } | ActivityEvent::TimerPaused { .. }
                        )
                    })
        });
        let value = u8::from(visible) | if eligible { 2 } else { 0 };
        if self.coverage.swap(value, Ordering::Relaxed) != value {
            let _ = self.tx.send(Notice::Visibility(value));
        }
    }
    pub fn native_hosts(
        &self,
        labels: std::collections::BTreeSet<String>,
        snapshot: &ActivitySnapshot,
    ) {
        let mut current = self.native_hosts.lock().unwrap_or_else(|e| e.into_inner());
        if current.as_ref() == Some(&labels) {
            return;
        }
        *current = Some(labels);
        drop(current);
        self.observe(snapshot);
    }
}
fn snapshot(
    db: &Database,
    model: &Model,
    now: i64,
    revision: u64,
    shortcut_error: Option<String>,
    error: Option<String>,
) -> Snapshot {
    let linked_card = model
        .config
        .card
        .as_ref()
        .and_then(|c| store::linked(db, c).ok());
    Snapshot {
        revision,
        generation: model.generation,
        config: model.config.clone(),
        session: model.session.as_ref().map(|s| Countdown {
            id: s.id.clone(),
            phase: s.phase,
            status: s.status,
            round: s.round,
            planned_s: s.planned_s,
            remaining_s: s.remaining_s(now),
            deadline_ms: s.deadline_ms,
        }),
        link_unavailable: model.config.card.is_some() && linked_card.is_none(),
        linked_card,
        shortcut_error,
        error,
    }
}
struct Actor {
    db: Database,
    model: Model,
    clock: Arc<dyn Clock>,
    publish: Publish,
    cache: Arc<Mutex<Snapshot>>,
    revision: u64,
    coverage: u8,
    viewers: std::collections::BTreeSet<(String, String)>,
    shortcut: Option<String>,
    error: Option<String>,
    last: Option<String>,
}
impl Actor {
    fn cached(&self) -> Snapshot {
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn refresh(&mut self) {
        let mut next = self.model.clone();
        let now = self.clock.now_ms();
        let ended = next.advance(now);
        if let Some(id) = ended {
            match store::save(&self.db, &self.model, &next, now) {
                Ok(()) => {
                    self.model = next;
                    self.error = None;
                    self.emit(vec![ActivityEvent::TimerEnded { id }]);
                }
                Err(e) => {
                    self.error = Some(e.to_string());
                    self.emit(vec![]);
                }
            }
        } else {
            self.emit(vec![]);
        }
    }
    fn action(&mut self, action: Action) -> Result<(), String> {
        let card = match &action {
            Action::Link { card } => card.as_ref(),
            Action::Configure { config } => config.card.as_ref(),
            _ => None,
        };
        if let Some(card) = card {
            store::linked(&self.db, card).map_err(|e| e.to_string())?;
        }
        let old = self.model.clone();
        let mut next = old.clone();
        let now = self.clock.now_ms();
        next.apply(action, now, || uuid::Uuid::new_v4().to_string())?;
        store::save(&self.db, &old, &next, now).map_err(|e| e.to_string())?;
        let removed = old
            .session
            .as_ref()
            .filter(|s| next.session.as_ref().map(|n| &n.id) != Some(&s.id))
            .map(|s| s.id.clone());
        self.model = next;
        self.error = None;
        self.emit(
            removed
                .into_iter()
                .map(|id| ActivityEvent::TimerRemoved { id })
                .collect(),
        );
        Ok(())
    }
    fn emit(&mut self, mut events: Vec<ActivityEvent>) {
        let mut value = snapshot(
            &self.db,
            &self.model,
            self.clock.now_ms(),
            0,
            self.shortcut.clone(),
            self.error.clone(),
        );
        let signature = serde_json::to_string(&value).expect("timer snapshot serialization");
        if self.last.as_ref() == Some(&signature) && events.is_empty() {
            return;
        }
        self.last = Some(signature);
        self.revision += 1;
        value.revision = self.revision;
        if let Some(s) = &value.session {
            let label = if s.phase == Phase::Break {
                "Break".into()
            } else {
                value.config.label.clone()
            };
            match s.status {
                Status::Running => events.push(ActivityEvent::TimerTick {
                    id: s.id.clone(),
                    remaining_s: s.remaining_s,
                    label,
                }),
                Status::Paused => events.push(ActivityEvent::TimerPaused {
                    id: s.id.clone(),
                    remaining_s: s.remaining_s,
                    label,
                }),
                Status::Ended => {}
            }
        }
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = value.clone();
        (self.publish)(value, events);
    }
    fn wait_ms(&self) -> Option<u64> {
        let now = self.clock.now_ms();
        let visible = self.coverage & 1 != 0 || !self.viewers.is_empty();
        let wait = self.model.wait_ms(now, visible)?;
        if self.error.is_some() && wait == 0 {
            return Some(1000);
        } // Retry a failed completion write with a bounded delay, never a busy loop.
        if !visible && self.coverage & 2 != 0 {
            let remaining = self.model.session.as_ref()?.remaining_ms(now) as u64;
            if remaining >= 60_000 {
                return Some(wait.min(remaining - 59_000));
            }
        }
        Some(wait)
    }
}
pub fn start(app: tauri::AppHandle, db: Database) -> Result<Arc<Service>, String> {
    let fixture = crate::island::acceptance_session().then(|| {
        Arc::new(FixtureClock(AtomicI64::new(
            chrono::Utc::now().timestamp_millis(),
        )))
    });
    let clock: Arc<dyn Clock> = fixture
        .as_ref()
        .map(|c| c.clone() as Arc<dyn Clock>)
        .unwrap_or_else(|| Arc::new(SystemClock));
    let output = app.clone();
    let service = Service::create(
        db,
        clock,
        Arc::new(move |snapshot, events| {
            let _ = output.emit("nabbit://timer", snapshot);
            for event in events {
                crate::island::activity_bus::publish(&output, event);
            }
        }),
        fixture,
    )?;
    let weak = Arc::downgrade(&service);
    app.listen("notes:updated", move |_| {
        if let Some(s) = weak.upgrade() {
            s.wake();
        }
    });
    let weak = Arc::downgrade(&service);
    app.listen("tack:sync", move |_| {
        if let Some(s) = weak.upgrade() {
            s.wake();
        }
    });
    Ok(service)
}
#[tauri::command]
pub async fn timer_snapshot(service: tauri::State<'_, Arc<Service>>) -> Result<Snapshot, String> {
    let s = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.read())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn timer_action(
    service: tauri::State<'_, Arc<Service>>,
    request: Request,
) -> Result<Snapshot, String> {
    let s = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.action(request))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn timer_view(
    service: tauri::State<'_, Arc<Service>>,
    window: tauri::WebviewWindow,
    lease: String,
    active: bool,
) -> Result<(), String> {
    if lease.len() > 64
        || lease.is_empty()
        || !lease.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Invalid timer view lease.".into());
    }
    service.viewer(window.label().into(), lease, active);
    Ok(())
}
#[tauri::command]
pub async fn timer_fixture(
    service: tauri::State<'_, Arc<Service>>,
    now_ms: Option<i64>,
    defer: Option<bool>,
) -> Result<Snapshot, String> {
    if !crate::island::acceptance_session() {
        return Err("Timer clock fixtures require an isolated acceptance session.".into());
    }
    let clock = service.fixture.as_ref().ok_or("No injected clock")?;
    if let Some(now) = now_ms {
        clock.0.store(now, Ordering::Relaxed);
    }
    if defer == Some(true) {
        return Ok(service.cached());
    }
    let s = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.read())
        .await
        .map_err(|e| e.to_string())?
}
