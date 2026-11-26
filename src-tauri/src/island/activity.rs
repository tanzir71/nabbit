//! Typed producer contract and deterministic arbitration. No I/O or render timer.
use super::input::Gate;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Privacy,
    TimerEnding,
    Download,
    Tool,
    Link,
    Result,
    Media,
    Timer,
    Power,
}
pub const ORDER: [Kind; 9] = [
    Kind::Privacy,
    Kind::TimerEnding,
    Kind::Download,
    Kind::Tool,
    Kind::Link,
    Kind::Result,
    Kind::Media,
    Kind::Timer,
    Kind::Power,
];
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub order: Vec<Kind>,
    pub disabled: Vec<Kind>,
    pub show_alerts_over_fullscreen: bool,
    pub focus_mode: bool,
    pub hidden_until_ms: Option<i64>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            order: ORDER.to_vec(),
            disabled: vec![],
            show_alerts_over_fullscreen: false,
            focus_mode: false,
            hidden_until_ms: None,
        }
    }
}
impl Preferences {
    pub fn normalized(mut self) -> Self {
        let mut seen = BTreeSet::new();
        self.order.retain(|kind| seen.insert(*kind));
        self.order
            .extend(ORDER.into_iter().filter(|kind| seen.insert(*kind)));
        self.disabled.sort();
        self.disabled.dedup();
        self
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum ErrorKind {
    SignInRequired,
    SiteChanged,
    MissingJsRuntime,
    FormatUnavailable,
    Drm,
    Disk,
    Offline,
    Live,
    Unknown,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncStatus {
    #[default]
    LocalOnly,
    UpToDate,
    Syncing,
    Offline,
    SignedOut,
    WorkspaceChanged,
    StorageFull,
    RecoveryPending,
    RateLimited,
    Conflict,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    Running,
    Paused,
    Done,
    Failed,
    Cancelled,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MoveVerb {
    Moved,
    Copied,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DragKind {
    Url,
    File,
    Text,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub position_s: u32,
    pub duration_s: u32,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ActivityEvent {
    VolumeChanged {
        percent: u8,
        muted: bool,
    },
    LinkDetected {
        url: String,
        title: Option<String>,
        duration: Option<u32>,
        site: String,
    },
    DownloadProgress {
        job_id: String,
        title: String,
        percent: f64,
        speed: Option<String>,
        eta: Option<String>,
    },
    DownloadDone {
        job_id: String,
        path: String,
    },
    DownloadFailed {
        job_id: String,
        error: ErrorKind,
    },
    MediaChanged {
        session_id: String,
        title: String,
        artist: String,
        playing: bool,
        timeline: Option<Timeline>,
        art: Option<String>,
    },
    TimerTick {
        id: String,
        remaining_s: u32,
        label: String,
    },
    TimerEnded {
        id: String,
    },
    PrivacyChanged {
        mic: Vec<String>,
        camera: Vec<String>,
    },
    PowerChanged {
        percent: u8,
        charging: bool,
    },
    NoteSaved {
        card_id: String,
        destination: String,
    },
    SyncState {
        state: SyncStatus,
    },
    Fullscreen {
        monitor: String,
        active: bool,
    },
    Maximized {
        monitor: String,
        active: bool,
    },
    DragEnter {
        kinds: Vec<DragKind>,
    },
    DragLeave,
    ToolJob {
        job_id: String,
        tool_id: String,
        label: String,
        percent: f64,
        state: JobState,
    },
    ToolResult {
        job_id: String,
        path: String,
        before_bytes: u64,
        after_bytes: u64,
        note: Option<String>,
    },
    FilesMoved {
        op_id: String,
        count: u32,
        destination: String,
        verb: MoveVerb,
        undoable: bool,
    },
    LinkSaved {
        card_id: String,
        title: String,
    },
    // Lifecycle/control events keep the producer contract independent of services.
    ClipboardChanged,
    DownloadRemoved {
        job_id: String,
    },
    Dismissed {
        id: String,
    },
    PreferencesChanged {
        preferences: Preferences,
    },
    Refresh,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Time {
    pub mono_ms: u64,
    pub unix_ms: i64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub category: Kind,
    pub event: ActivityEvent,
    pub alert: bool,
    pub bubble_only: bool,
}
#[derive(Clone)]
struct Entry {
    item: Item,
    created: u64,
    remaining: Option<u64>,
    exposed: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    pub label: String,
    pub monitor: String,
    pub mode: Gate,
    pub base: Gate,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub label: String,
    pub gate: Gate,
    pub primary: Option<Item>,
    pub bubble: Option<Item>,
    pub queue: Vec<Item>,
    pub fullscreen: bool,
    pub user_hidden: bool,
    pub focus_mode: bool,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub views: Vec<View>,
    pub preferences: Preferences,
    pub sync_state: SyncStatus,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    #[serde(flatten)]
    pub event: ActivityEvent,
    pub target: Option<String>,
    pub snapshot: Snapshot,
}
pub struct Engine {
    pub preferences: Preferences,
    monitors: Vec<Monitor>,
    entries: BTreeMap<String, Entry>,
    revision: u64,
    sync_state: SyncStatus,
    last: Time,
}
impl Engine {
    pub fn new(preferences: Preferences) -> Self {
        Self {
            preferences: preferences.normalized(),
            monitors: vec![],
            entries: BTreeMap::new(),
            revision: 0,
            sync_state: SyncStatus::LocalOnly,
            last: Time::default(),
        }
    }
    fn put(
        &mut self,
        id: String,
        category: Kind,
        event: ActivityEvent,
        alert: bool,
        now: Time,
        remaining: Option<u64>,
    ) {
        if alert && self.preferences.disabled.contains(&category) {
            self.entries.remove(&id);
            return;
        }
        if self
            .entries
            .get(&id)
            .is_some_and(|entry| entry.item.event == event)
        {
            return;
        }
        self.entries.insert(
            id.clone(),
            Entry {
                item: Item {
                    id,
                    category,
                    event,
                    alert,
                    bubble_only: false,
                },
                created: now.mono_ms,
                remaining,
                exposed: None,
            },
        );
    }
    fn remove(&mut self, prefix: &str, id: &str) {
        self.entries.remove(&format!("{prefix}:{id}"));
    }
    fn eligible_fullscreen(item: &Item) -> bool {
        matches!(
            item.event,
            ActivityEvent::TimerEnded { .. } | ActivityEvent::DownloadFailed { .. }
        )
    }
    fn sorted(&self) -> Vec<Item> {
        let mut entries: Vec<_> = self
            .entries
            .values()
            .filter(|entry| !self.preferences.disabled.contains(&entry.item.category))
            .collect();
        entries.sort_by_key(|entry| {
            (
                self.preferences
                    .order
                    .iter()
                    .position(|kind| kind == &entry.item.category)
                    .unwrap_or(usize::MAX),
                !entry.item.alert,
                entry.created,
                entry.item.id.clone(),
            )
        });
        entries
            .into_iter()
            .map(|entry| entry.item.clone())
            .collect()
    }
    pub fn snapshot(&self) -> Snapshot {
        let items = self.sorted();
        let user_hidden = self
            .preferences
            .hidden_until_ms
            .is_some_and(|until| until > self.last.unix_ms);
        let views = self
            .monitors
            .iter()
            .map(|monitor| {
                let fullscreen = monitor.base == Gate::Hidden;
                let suppressed = user_hidden || self.preferences.focus_mode;
                let eligible: Vec<_> = items
                    .iter()
                    .filter(|item| {
                        !suppressed
                            && (!fullscreen
                                || (self.preferences.show_alerts_over_fullscreen
                                    && Self::eligible_fullscreen(item)))
                    })
                    .collect();
                let primary = eligible
                    .iter()
                    .find(|item| !item.bubble_only)
                    .map(|item| (*item).clone());
                let bubble = eligible
                    .iter()
                    .find(|item| Some(&item.id) != primary.as_ref().map(|p| &p.id))
                    .map(|item| (*item).clone());
                let gate = if suppressed || (fullscreen && primary.is_none() && bubble.is_none()) {
                    Gate::Hidden
                } else if monitor.mode == Gate::Faded && primary.is_none() {
                    Gate::Faded
                } else {
                    Gate::Visible
                };
                let queue = items
                    .iter()
                    .filter(|item| {
                        Some(&item.id) != primary.as_ref().map(|p| &p.id)
                            && Some(&item.id) != bubble.as_ref().map(|p| &p.id)
                    })
                    .cloned()
                    .collect();
                View {
                    label: monitor.label.clone(),
                    gate,
                    primary,
                    bubble,
                    queue,
                    fullscreen,
                    user_hidden,
                    focus_mode: self.preferences.focus_mode,
                }
            })
            .collect();
        Snapshot {
            revision: self.revision,
            views,
            preferences: self.preferences.clone(),
            sync_state: self.sync_state,
        }
    }
    fn advance(&mut self, now: Time) {
        self.last = now;
        self.entries.retain(|_, entry| {
            if let Some(since) = entry.exposed.take() {
                if let Some(remaining) = &mut entry.remaining {
                    *remaining = remaining.saturating_sub(now.mono_ms.saturating_sub(since));
                }
            }
            if entry.item.category == Kind::Link
                && now.mono_ms.saturating_sub(entry.created) >= 8000
            {
                entry.item.bubble_only = true;
            }
            entry.remaining != Some(0)
                && (!matches!(entry.item.event, ActivityEvent::VolumeChanged { .. })
                    || now.mono_ms.saturating_sub(entry.created) < 1500)
        });
    }
    fn expose(&mut self, now: Time) {
        let snapshot = self.snapshot();
        let exposed: BTreeSet<_> = snapshot
            .views
            .iter()
            .flat_map(|view| [view.primary.as_ref(), view.bubble.as_ref()])
            .flatten()
            .map(|item| item.id.clone())
            .collect();
        for entry in self.entries.values_mut() {
            entry.exposed = exposed.contains(&entry.item.id).then_some(now.mono_ms);
        }
    }
    pub fn monitors(&mut self, mut monitors: Vec<Monitor>, now: Time) -> Option<Message> {
        monitors.sort_by(|a, b| a.label.cmp(&b.label));
        if monitors == self.monitors {
            return None;
        }
        let before = self.snapshot();
        self.advance(now);
        self.monitors = monitors;
        self.expose(now);
        (self.snapshot() != before).then(|| self.message(ActivityEvent::Refresh, None))
    }
    pub fn tick(&mut self, now: Time) -> Option<Message> {
        let before = self.snapshot();
        self.advance(now);
        self.expose(now);
        (self.snapshot() != before).then(|| self.message(ActivityEvent::Refresh, None))
    }
    pub fn submit(
        &mut self,
        mut event: ActivityEvent,
        target: Option<String>,
        now: Time,
    ) -> Message {
        self.advance(now);
        match &mut event {
            ActivityEvent::DownloadProgress { percent, .. }
            | ActivityEvent::ToolJob { percent, .. } => {
                *percent = if percent.is_finite() {
                    percent.clamp(0.0, 100.0)
                } else {
                    0.0
                }
            }
            ActivityEvent::PowerChanged { percent, .. }
            | ActivityEvent::VolumeChanged { percent, .. } => *percent = (*percent).min(100),
            _ => {}
        }
        match &event {
            ActivityEvent::VolumeChanged { .. } => {
                self.entries.remove("volume");
                self.put(
                    "volume".into(),
                    Kind::Result,
                    event.clone(),
                    false,
                    now,
                    None,
                );
            }
            ActivityEvent::LinkDetected { .. } => {
                self.entries.remove("link");
                self.put("link".into(), Kind::Link, event.clone(), false, now, None);
            }
            ActivityEvent::ClipboardChanged => {
                self.entries.remove("link");
            }
            ActivityEvent::DownloadProgress { job_id, .. } => {
                self.remove("downloadDone", job_id);
                self.remove("downloadFailed", job_id);
                self.put(
                    format!("download:{job_id}"),
                    Kind::Download,
                    event.clone(),
                    false,
                    now,
                    None,
                );
            }
            ActivityEvent::DownloadDone { job_id, .. }
            | ActivityEvent::DownloadFailed { job_id, .. } => {
                self.remove("download", job_id);
                let failed = matches!(event, ActivityEvent::DownloadFailed { .. });
                self.put(
                    format!(
                        "{}:{job_id}",
                        if failed {
                            "downloadFailed"
                        } else {
                            "downloadDone"
                        }
                    ),
                    if failed { Kind::Download } else { Kind::Result },
                    event.clone(),
                    true,
                    now,
                    (!failed).then_some(4000),
                );
            }
            ActivityEvent::DownloadRemoved { job_id } => {
                self.remove("download", job_id);
                self.remove("downloadDone", job_id);
                self.remove("downloadFailed", job_id);
            }
            ActivityEvent::MediaChanged {
                session_id,
                playing,
                ..
            } => {
                if *playing {
                    self.put(
                        format!("media:{session_id}"),
                        Kind::Media,
                        event.clone(),
                        false,
                        now,
                        None,
                    );
                } else {
                    self.remove("media", session_id);
                }
            }
            ActivityEvent::TimerTick {
                id, remaining_s, ..
            } => {
                self.remove("timerEnded", id);
                self.put(
                    format!("timer:{id}"),
                    if *remaining_s < 60 {
                        Kind::TimerEnding
                    } else {
                        Kind::Timer
                    },
                    event.clone(),
                    false,
                    now,
                    None,
                );
            }
            ActivityEvent::TimerEnded { id } => {
                self.remove("timer", id);
                self.put(
                    format!("timerEnded:{id}"),
                    Kind::TimerEnding,
                    event.clone(),
                    true,
                    now,
                    Some(4000),
                );
            }
            ActivityEvent::PrivacyChanged { mic, camera } => {
                if mic.is_empty() && camera.is_empty() {
                    self.entries.remove("privacy");
                } else {
                    self.put(
                        "privacy".into(),
                        Kind::Privacy,
                        event.clone(),
                        false,
                        now,
                        None,
                    );
                }
            }
            ActivityEvent::PowerChanged { percent, charging } => {
                if *percent < 20 || *charging {
                    self.put("power".into(), Kind::Power, event.clone(), false, now, None);
                } else {
                    self.entries.remove("power");
                }
            }
            ActivityEvent::NoteSaved { card_id, .. } => self.put(
                format!("note:{card_id}"),
                Kind::Result,
                event.clone(),
                true,
                now,
                Some(4000),
            ),
            ActivityEvent::LinkSaved { card_id, .. } => self.put(
                format!("linkSaved:{card_id}"),
                Kind::Result,
                event.clone(),
                true,
                now,
                Some(4000),
            ),
            ActivityEvent::ToolResult { job_id, .. } => {
                self.remove("tool", job_id);
                self.put(
                    format!("toolResult:{job_id}"),
                    Kind::Result,
                    event.clone(),
                    true,
                    now,
                    Some(4000),
                );
            }
            ActivityEvent::FilesMoved { op_id, .. } => self.put(
                format!("files:{op_id}"),
                Kind::Result,
                event.clone(),
                true,
                now,
                Some(4000),
            ),
            ActivityEvent::ToolJob { job_id, state, .. } => match state {
                JobState::Queued | JobState::Running | JobState::Failed => self.put(
                    format!("tool:{job_id}"),
                    Kind::Tool,
                    event.clone(),
                    *state == JobState::Failed,
                    now,
                    None,
                ),
                _ => self.remove("tool", job_id),
            },
            ActivityEvent::SyncState { state } => self.sync_state = *state,
            ActivityEvent::Fullscreen { monitor, active } => {
                for facts in &mut self.monitors {
                    if &facts.monitor == monitor {
                        facts.base = if *active { Gate::Hidden } else { Gate::Visible };
                        facts.mode = facts.base;
                    }
                }
            }
            ActivityEvent::Maximized { monitor, active } => {
                for facts in &mut self.monitors {
                    if &facts.monitor == monitor && facts.base != Gate::Hidden {
                        facts.base = if *active { Gate::Faded } else { Gate::Visible };
                        facts.mode = facts.base;
                    }
                }
            }
            ActivityEvent::Dismissed { id } => {
                self.entries.remove(id);
            }
            ActivityEvent::PreferencesChanged { preferences } => {
                self.preferences = preferences.clone().normalized();
                self.entries.retain(|_, entry| {
                    !entry.item.alert || !self.preferences.disabled.contains(&entry.item.category)
                });
            }
            ActivityEvent::DragEnter { .. } | ActivityEvent::DragLeave | ActivityEvent::Refresh => {
            }
        }
        self.expose(now);
        self.message(event, target)
    }
    pub fn enrich_link(
        &mut self,
        url: &str,
        title: &str,
        duration: Option<u32>,
    ) -> Option<Message> {
        let entry = self.entries.get_mut("link")?;
        let ActivityEvent::LinkDetected {
            url: current,
            title: old_title,
            duration: old_duration,
            ..
        } = &mut entry.item.event
        else {
            return None;
        };
        if current != url {
            return None;
        }
        *old_title = Some(title.into());
        *old_duration = duration;
        let event = entry.item.event.clone();
        // Preserve creation time, bubble status and dismissal. Enrichment is not a new capture.
        Some(self.message(event, None))
    }
    fn message(&mut self, event: ActivityEvent, target: Option<String>) -> Message {
        self.revision += 1;
        Message {
            event,
            target,
            snapshot: self.snapshot(),
        }
    }
    pub fn next_wait_ms(&self, now: Time) -> Option<u64> {
        let alerts = self
            .entries
            .values()
            .filter(|entry| entry.exposed.is_some())
            .filter_map(|entry| {
                entry.remaining.map(|ms| {
                    ms.saturating_sub(
                        now.mono_ms
                            .saturating_sub(entry.exposed.unwrap_or(now.mono_ms)),
                    )
                })
            });
        let links = self
            .entries
            .values()
            .filter(|entry| entry.item.category == Kind::Link && !entry.item.bubble_only)
            .map(|entry| 8000u64.saturating_sub(now.mono_ms.saturating_sub(entry.created)));
        let hidden = self
            .preferences
            .hidden_until_ms
            .filter(|until| *until > self.last.unix_ms)
            .map(|until| until.saturating_sub(now.unix_ms).max(0) as u64);
        let volume = self
            .entries
            .values()
            .filter(|entry| matches!(entry.item.event, ActivityEvent::VolumeChanged { .. }))
            .map(|entry| 1500u64.saturating_sub(now.mono_ms.saturating_sub(entry.created)));
        alerts.chain(links).chain(hidden).chain(volume).min()
    }
}
