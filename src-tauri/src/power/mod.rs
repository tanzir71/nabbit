//! Event-only power sampling. The activity bus owns the brief display deadline;
//! this service has no timer, thread, database or JavaScript polling loop.
use crate::island::activity::ActivityEvent;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
#[cfg(test)]
mod tests;
#[cfg(windows)]
pub(crate) mod windows;
pub const DISPLAY_MS: u64 = 4000;
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawStatus {
    pub ac_line_status: u8,
    pub battery_flag: u8,
    pub battery_life_percent: u8,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub percent: Option<u8>,
    pub charging: bool,
    pub plugged_in: Option<bool>,
}
pub fn decode(raw: RawStatus) -> Option<Status> {
    if raw.battery_flag == 255 || raw.battery_flag & 128 != 0 {
        return None;
    }
    let plugged_in = match raw.ac_line_status {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    };
    Some(Status {
        percent: (raw.battery_life_percent <= 100).then_some(raw.battery_life_percent),
        charging: raw.battery_flag & 8 != 0 && plugged_in != Some(false),
        plugged_in,
    })
}
pub fn title(percent: Option<u8>, charging: bool, plugged_in: Option<bool>) -> &'static str {
    if charging {
        "Charging"
    } else if plugged_in == Some(true) {
        "Plugged in"
    } else if percent.is_some_and(|p| p <= 20) {
        "Battery low"
    } else if plugged_in == Some(false) {
        "On battery"
    } else {
        "Battery"
    }
}
pub trait PowerProvider: Send + Sync {
    fn sample(&self) -> Result<RawStatus, String>;
}
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub status: Option<Status>,
    pub error: Option<String>,
    pub notification_error: Option<String>,
}
#[derive(Default)]
struct State {
    snapshot: Snapshot,
    baseline: Option<Status>,
}
type Publish = Arc<dyn Fn(Snapshot, Option<ActivityEvent>) + Send + Sync>;
pub struct Service {
    provider: Arc<dyn PowerProvider>,
    state: Mutex<State>,
    publish: Publish,
    recorded: Option<Arc<Recorded>>,
}
impl Service {
    pub fn new(provider: Arc<dyn PowerProvider>, publish: Publish) -> Arc<Self> {
        Self::create(provider, publish, None)
    }
    fn create(
        provider: Arc<dyn PowerProvider>,
        publish: Publish,
        recorded: Option<Arc<Recorded>>,
    ) -> Arc<Self> {
        let service = Arc::new(Self {
            provider,
            state: Mutex::new(State::default()),
            publish,
            recorded,
        });
        service.refresh();
        service
    }
    pub fn snapshot(&self) -> Snapshot {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot
            .clone()
    }
    pub fn refresh(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let (status, error) = match self.provider.sample() {
            Ok(v) => (decode(v), None),
            Err(_) => (None, Some("Battery status is unavailable.".into())),
        };
        if state.snapshot.status == status && state.snapshot.error == error {
            return;
        }
        let previous = state.baseline;
        let event = match (previous, status) {
            (Some(old), Some(new)) => {
                let source = matches!((old.plugged_in,new.plugged_in),(Some(a),Some(b)) if a!=b);
                let low = new.plugged_in != Some(true)
                    && new.percent.is_some_and(|p| p <= 20)
                    && new.percent != old.percent;
                if source || old.charging != new.charging || low {
                    Some(ActivityEvent::PowerChanged {
                        percent: new.percent,
                        charging: new.charging,
                        plugged_in: new.plugged_in,
                    })
                } else if old.percent.is_some_and(|p| p <= 20)
                    && new.percent.is_some_and(|p| p > 20)
                    && !new.charging
                {
                    Some(ActivityEvent::PowerRemoved)
                } else {
                    None
                }
            }
            (Some(_), None) => Some(ActivityEvent::PowerRemoved),
            _ => None, // Startup/recovery establishes a baseline without a notification.
        };
        state.baseline = status;
        state.snapshot = Snapshot {
            revision: state.snapshot.revision + 1,
            status,
            error,
            notification_error: state.snapshot.notification_error.clone(),
        };
        (self.publish)(state.snapshot.clone(), event);
    }
    #[cfg(windows)]
    pub fn notification_error(&self, error: Option<String>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.snapshot.notification_error != error {
            state.snapshot.notification_error = error;
            state.snapshot.revision += 1;
            (self.publish)(state.snapshot.clone(), None);
        }
    }
}
pub struct Recorded {
    value: Mutex<Result<RawStatus, String>>,
    reads: std::sync::atomic::AtomicU64,
}
impl Default for Recorded {
    fn default() -> Self {
        Self {
            value: Mutex::new(Ok(RawStatus {
                ac_line_status: 255,
                battery_flag: 128,
                battery_life_percent: 255,
            })),
            reads: Default::default(),
        }
    }
}
impl PowerProvider for Recorded {
    fn sample(&self) -> Result<RawStatus, String> {
        self.reads
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.value.lock().unwrap().clone()
    }
}
impl Recorded {
    pub fn replace(&self, value: Result<RawStatus, String>) {
        *self.value.lock().unwrap() = value;
    }
    pub fn reads(&self) -> u64 {
        self.reads.load(std::sync::atomic::Ordering::Relaxed)
    }
}
pub fn start(app: tauri::AppHandle) -> Arc<Service> {
    let recorded = (crate::island::acceptance_session()
        || crate::sticky::acceptance_enabled()
        || crate::download::acceptance::injected_clipboard())
    .then(|| Arc::new(Recorded::default()));
    #[cfg(windows)]
    let provider: Arc<dyn PowerProvider> = recorded.as_ref().map_or_else(
        || Arc::new(windows::SystemProvider) as Arc<dyn PowerProvider>,
        |p| p.clone(),
    );
    #[cfg(not(windows))]
    let provider: Arc<dyn PowerProvider> = Arc::new(Recorded::default());
    Service::create(
        provider,
        Arc::new(move |snapshot, event| {
            let _ = app.emit("nabbit://power", snapshot);
            if let Some(event) = event {
                app.state::<Arc<crate::island::activity_bus::Bus>>()
                    .submit(event, None);
            }
        }),
        recorded,
    )
}
#[tauri::command]
pub fn power_snapshot(service: tauri::State<'_, Arc<Service>>) -> Snapshot {
    service.snapshot()
}
#[tauri::command]
pub fn power_fixture(
    service: tauri::State<'_, Arc<Service>>,
    sample: Option<RawStatus>,
    unavailable: Option<bool>,
    notify: Option<bool>,
) -> Result<serde_json::Value, String> {
    if !crate::island::acceptance_session() {
        return Err("Power fixtures require an isolated acceptance session.".into());
    }
    let provider = service
        .recorded
        .as_ref()
        .ok_or("No recorded power provider")?;
    if unavailable == Some(true) {
        provider.replace(Err("Unavailable".into()));
    } else if let Some(sample) = sample {
        provider.replace(Ok(sample));
    }
    if notify != Some(false) {
        service.refresh();
    }
    Ok(serde_json::json!({"snapshot":service.snapshot(),"reads":provider.reads()}))
}
