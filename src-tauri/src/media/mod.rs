//! Event-driven media state. Reads are cache-only; providers never have a tick API.
use crate::island::activity::{ActivityEvent, Timeline as ActivityTimeline};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
pub mod recorded;
#[cfg(test)]
mod tests;
#[cfg(windows)]
mod windows;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub position_s: f64,
    pub duration_s: f64,
    pub updated_at_ms: i64,
    pub rate: f64,
    pub start_ticks: i64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Controls {
    pub play: bool,
    pub pause: bool,
    pub toggle: bool,
    pub previous: bool,
    pub next: bool,
    pub seek: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub app: String,
    pub title: String,
    pub artist: String,
    pub playing: bool,
    pub controls: Controls,
    pub timeline: Option<Timeline>,
    pub art: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub percent: u8,
    pub muted: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub sessions: Vec<Session>,
    pub selected: Option<String>,
    pub volume: Option<Volume>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    Toggle { id: String },
    Previous { id: String },
    Next { id: String },
    Seek { id: String, position_s: f64 },
    VolumeStep { direction: i8, fine: bool },
    Volume { percent: u8 },
    Mute { muted: bool },
}
pub type Sink = Arc<dyn Fn(Snapshot) + Send + Sync>;
pub trait MediaProvider: Send + Sync {
    fn subscribe(&self, sink: Sink) -> Result<(), String>;
    fn perform(&self, action: Action) -> Result<(), String>;
    fn resume(&self);
    fn stop(&self);
}
type Publish = Arc<dyn Fn(Snapshot, Vec<ActivityEvent>) + Send + Sync>;
#[derive(Default)]
struct State {
    snapshot: Snapshot,
    preferred: Option<String>,
}
pub struct Service {
    provider: Arc<dyn MediaProvider>,
    state: Mutex<State>,
    publish: Publish,
    recorded: Option<Arc<recorded::Recorded>>,
}
impl Service {
    pub fn new(provider: Arc<dyn MediaProvider>, publish: Publish) -> Arc<Self> {
        Self::with_recorded(provider, publish, None)
    }
    fn with_recorded(
        provider: Arc<dyn MediaProvider>,
        publish: Publish,
        recorded: Option<Arc<recorded::Recorded>>,
    ) -> Arc<Self> {
        let service = Arc::new(Self {
            provider,
            state: Mutex::new(State::default()),
            publish,
            recorded,
        });
        let weak = Arc::downgrade(&service);
        if let Err(error) = service.provider.subscribe(Arc::new(move |snapshot| {
            if let Some(service) = weak.upgrade() {
                service.receive(snapshot);
            }
        })) {
            service.receive(Snapshot {
                error: Some(error),
                ..Snapshot::default()
            });
        }
        service
    }
    pub fn snapshot(&self) -> Snapshot {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot
            .clone()
    }
    fn receive(&self, mut next: Snapshot) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !next
            .sessions
            .iter()
            .any(|s| Some(&s.id) == state.preferred.as_ref())
        {
            state.preferred = None;
        }
        next.selected = state
            .preferred
            .clone()
            .or(next.selected)
            .filter(|id| next.sessions.iter().any(|s| s.id == *id))
            .or_else(|| {
                next.sessions
                    .iter()
                    .find(|s| s.playing)
                    .or(next.sessions.first())
                    .map(|s| s.id.clone())
            });
        self.update(&mut state, next);
    }
    fn update(&self, state: &mut State, mut next: Snapshot) {
        next.revision = state.snapshot.revision;
        if next == state.snapshot {
            return;
        }
        next.revision += 1;
        let mut events = vec![];
        let selected = |snapshot: &Snapshot| {
            snapshot
                .sessions
                .iter()
                .find(|s| Some(&s.id) == snapshot.selected.as_ref())
                .cloned()
        };
        let old = selected(&state.snapshot);
        let current = selected(&next);
        if old != current {
            if let Some(old) = old.filter(|s| current.as_ref().map(|n| &n.id) != Some(&s.id)) {
                events.push(ActivityEvent::MediaRemoved { session_id: old.id });
            }
            if let Some(s) = current {
                events.push(ActivityEvent::MediaChanged {
                    session_id: s.id,
                    title: s.title,
                    artist: [s.artist, s.app]
                        .into_iter()
                        .filter(|v| !v.is_empty())
                        .collect::<Vec<_>>()
                        .join(" · "),
                    playing: s.playing,
                    art: s.art,
                    timeline: s.timeline.map(|t| ActivityTimeline {
                        position_s: t.position_s as u32,
                        duration_s: t.duration_s as u32,
                    }),
                });
            }
        }
        if next.volume != state.snapshot.volume && state.snapshot.volume.is_some() {
            if let Some(v) = &next.volume {
                events.push(ActivityEvent::VolumeChanged {
                    percent: v.percent,
                    muted: v.muted,
                });
            }
        }
        state.snapshot = next.clone();
        (self.publish)(next, events);
    }
    pub fn select(&self, id: String) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.snapshot.sessions.iter().any(|s| s.id == id) {
            return Err("This media session has closed.".into());
        }
        state.preferred = Some(id.clone());
        let mut next = state.snapshot.clone();
        next.selected = Some(id);
        next.error = None;
        self.update(&mut state, next);
        Ok(())
    }
    pub fn perform(&self, action: Action) -> Result<(), String> {
        validate(&self.snapshot(), &action)?;
        self.provider.perform(action)
    }
    pub fn toggle(&self) -> Result<(), String> {
        let id = self.snapshot().selected.ok_or("Nothing playing.")?;
        self.perform(Action::Toggle { id })
    }
    pub fn resume(&self) {
        self.provider.resume();
    }
    pub fn stop(&self) {
        self.provider.stop();
    }
}
pub fn validate(snapshot: &Snapshot, action: &Action) -> Result<(), String> {
    let (id, supported) = match action {
        Action::VolumeStep { direction, .. } if ![-1, 1].contains(direction) => {
            return Err("Invalid volume direction.".into())
        }
        Action::Volume { percent } if *percent > 100 => return Err("Invalid volume.".into()),
        Action::VolumeStep { .. } | Action::Volume { .. } | Action::Mute { .. } => {
            return snapshot
                .volume
                .as_ref()
                .map(|_| ())
                .ok_or("No audio output is available.".into())
        }
        Action::Toggle { id } => (id, 0),
        Action::Previous { id } => (id, 1),
        Action::Next { id } => (id, 2),
        Action::Seek { id, .. } => (id, 3),
    };
    let s = snapshot
        .sessions
        .iter()
        .find(|s| s.id == *id)
        .ok_or("This media session has closed.")?;
    let allowed = match supported {
        0 => {
            s.controls.toggle
                || if s.playing {
                    s.controls.pause
                } else {
                    s.controls.play
                }
        }
        1 => s.controls.previous,
        2 => s.controls.next,
        _ => {
            matches!(action, Action::Seek { position_s, .. } if s.controls.seek && position_s.is_finite() && s.timeline.as_ref().is_some_and(|t| *position_s >= 0.0 && *position_s <= t.duration_s))
        }
    };
    if allowed {
        Ok(())
    } else {
        Err("This player does not support that control.".into())
    }
}
pub fn stepped_volume(percent: u8, direction: i8, fine: bool) -> u8 {
    (i16::from(percent) + i16::from(direction.signum()) * if fine { 1 } else { 2 }).clamp(0, 100)
        as u8
}
#[cfg(any(windows, test))]
fn application_name(id: &str) -> String {
    let lower = id.to_lowercase();
    for (key, label) in [
        ("zunemusic", "Media Player"),
        ("spotify", "Spotify"),
        ("chrome", "Chrome"),
        ("msedge", "Edge"),
        ("firefox", "Firefox"),
        ("vlc", "VLC"),
    ] {
        if lower.contains(key) {
            return label.into();
        }
    }
    id.rsplit(['\\', '/'])
        .next()
        .unwrap_or(id)
        .chars()
        .take(80)
        .collect()
}
#[derive(Default)]
pub struct Wheel {
    remainder: i32,
}
impl Wheel {
    pub fn steps(&mut self, delta: i16) -> i32 {
        if self.remainder.signum() != i32::from(delta).signum() {
            self.remainder = 0;
        }
        self.remainder += i32::from(delta);
        let steps = self.remainder / 120;
        self.remainder %= 120;
        steps
    }
}
pub fn pill_hit(x: f64, y: f64, width: f64, height: f64, radius: f64) -> bool {
    if !x.is_finite() || !y.is_finite() || x < 0.0 || x > width || y < 0.0 || y > height {
        return false;
    }
    let cx = x.clamp(radius, width - radius);
    let cy = y.clamp(radius, height - radius);
    (x - cx).powi(2) + (y - cy).powi(2) <= radius.powi(2)
}
/// Decode untrusted player artwork with bounded allocation, then retain only a 96px PNG.
#[cfg(any(windows, test))]
fn thumbnail(bytes: &[u8]) -> Option<String> {
    use base64::Engine;
    if bytes.len() > 4 * 1024 * 1024 {
        return None;
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(32 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .ok()?
        .resize_to_fill(96, 96, image::imageops::FilterType::Triangle);
    let mut out = std::io::Cursor::new(Vec::new());
    image.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(out.into_inner())
    ))
}
struct Unavailable;
impl MediaProvider for Unavailable {
    fn subscribe(&self, sink: Sink) -> Result<(), String> {
        sink(Snapshot::default());
        Ok(())
    }
    fn perform(&self, _: Action) -> Result<(), String> {
        Err("Media control is unavailable.".into())
    }
    fn resume(&self) {}
    fn stop(&self) {}
}
pub fn start(app: tauri::AppHandle) -> Arc<Service> {
    let recorded =
        crate::island::acceptance_session().then(|| Arc::new(recorded::Recorded::default()));
    #[cfg(windows)]
    let provider: Arc<dyn MediaProvider> = if let Some(provider) = &recorded {
        provider.clone()
    } else if crate::sticky::acceptance_enabled()
        || crate::download::acceptance::injected_clipboard()
    {
        Arc::new(Unavailable)
    } else {
        windows::Provider::new()
    };
    #[cfg(not(windows))]
    let provider: Arc<dyn MediaProvider> = Arc::new(Unavailable);
    Service::with_recorded(
        provider,
        Arc::new(move |snapshot, events| {
            let _ = app.emit("nabbit://media", snapshot);
            for event in events {
                app.state::<Arc<crate::island::activity_bus::Bus>>()
                    .submit(event, None);
            }
        }),
        recorded,
    )
}
#[tauri::command]
pub fn media_fixture(
    service: tauri::State<'_, Arc<Service>>,
    snapshot: Option<Snapshot>,
    resume: bool,
) -> Result<serde_json::Value, String> {
    if !crate::island::acceptance_session() {
        return Err("Media fixtures require an isolated acceptance session.".into());
    }
    let provider = service.recorded.as_ref().ok_or("No recorded provider")?;
    if let Some(snapshot) = snapshot {
        provider.replace(snapshot);
    }
    if resume {
        service.resume();
    }
    Ok(serde_json::json!({"snapshot":service.snapshot(),"audit":provider.audit()}))
}
#[tauri::command]
pub fn media_snapshot(service: tauri::State<'_, Arc<Service>>) -> Snapshot {
    service.snapshot()
}
#[tauri::command]
pub fn media_select(service: tauri::State<'_, Arc<Service>>, id: String) -> Result<(), String> {
    service.select(id)
}
#[tauri::command]
pub async fn media_toggle(service: tauri::State<'_, Arc<Service>>) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.toggle())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn media_action(
    service: tauri::State<'_, Arc<Service>>,
    action: Action,
) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.perform(action))
        .await
        .map_err(|e| e.to_string())?
}
