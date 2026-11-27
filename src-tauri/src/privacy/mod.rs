//! Read-only, event-driven mic/camera activity. No device is opened and no usage
//! history, executable path or process inventory is persisted or sent to JS.
pub mod model;
pub mod recorded;
#[cfg(test)]
mod tests;
#[cfg(windows)]
mod windows;
use crate::island::activity::ActivityEvent;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub mic: Vec<String>,
    pub camera: Vec<String>,
    pub error: Option<String>,
}
pub type Sink = Arc<dyn Fn(Result<model::RegistrySnapshot, String>) + Send + Sync>;
pub trait PrivacyProvider: Send + Sync {
    fn subscribe(&self, sink: Sink) -> Result<(), String>;
    fn resume(&self);
    fn stop(&self);
}
type Publish = Arc<dyn Fn(Snapshot, ActivityEvent) + Send + Sync>;
pub struct Service {
    provider: Arc<dyn PrivacyProvider>,
    state: Mutex<Snapshot>,
    publish: Publish,
    recorded: Option<Arc<recorded::Recorded>>,
}
impl Service {
    pub fn new(provider: Arc<dyn PrivacyProvider>, publish: Publish) -> Arc<Self> {
        Self::create(provider, publish, None)
    }
    fn create(
        provider: Arc<dyn PrivacyProvider>,
        publish: Publish,
        recorded: Option<Arc<recorded::Recorded>>,
    ) -> Arc<Self> {
        let service = Arc::new(Self {
            provider,
            state: Mutex::new(Snapshot::default()),
            publish,
            recorded,
        });
        let weak = Arc::downgrade(&service);
        if let Err(e) = service.provider.subscribe(Arc::new(move |value| {
            if let Some(s) = weak.upgrade() {
                s.receive(value);
            }
        })) {
            service.receive(Err(e));
        }
        service
    }
    fn receive(&self, value: Result<model::RegistrySnapshot, String>) {
        let (active, error) = match value {
            Ok(v) => (model::resolve(&v), None),
            Err(e) => (model::Active::default(), Some(e)),
        };
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.mic == active.mic && state.camera == active.camera && state.error == error {
            return;
        }
        *state = Snapshot {
            revision: state.revision + 1,
            mic: active.mic,
            camera: active.camera,
            error,
        };
        // Publish under the short state lock to preserve callback order.
        (self.publish)(
            state.clone(),
            ActivityEvent::PrivacyChanged {
                mic: state.mic.clone(),
                camera: state.camera.clone(),
            },
        );
    }
    pub fn snapshot(&self) -> Snapshot {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn resume(&self) {
        self.provider.resume();
    }
    pub fn stop(&self) {
        self.provider.stop();
    }
}
pub fn start(app: tauri::AppHandle) -> Arc<Service> {
    let recorded = (crate::island::acceptance_session()
        || crate::sticky::acceptance_enabled()
        || crate::download::acceptance::injected_clipboard())
    .then(|| Arc::new(recorded::Recorded::default()));
    #[cfg(windows)]
    let provider: Arc<dyn PrivacyProvider> = recorded.as_ref().map_or_else(
        || windows::Provider::new() as Arc<dyn PrivacyProvider>,
        |p| p.clone(),
    );
    #[cfg(not(windows))]
    let provider: Arc<dyn PrivacyProvider> = Arc::new(recorded::Recorded::default());
    Service::create(
        provider,
        Arc::new(move |snapshot, event| {
            let _ = app.emit("nabbit://privacy", snapshot);
            app.state::<Arc<crate::island::activity_bus::Bus>>()
                .submit(event, None);
        }),
        recorded,
    )
}
#[tauri::command]
pub fn privacy_snapshot(service: tauri::State<'_, Arc<Service>>) -> Snapshot {
    service.snapshot()
}
#[tauri::command]
pub fn privacy_fixture(
    service: tauri::State<'_, Arc<Service>>,
    snapshot: Option<model::RegistrySnapshot>,
    unavailable: Option<bool>,
    resume: Option<bool>,
) -> Result<serde_json::Value, String> {
    if !crate::island::acceptance_session() {
        return Err("Privacy fixtures require an isolated acceptance session.".into());
    }
    let recorded = service
        .recorded
        .as_ref()
        .ok_or("No recorded privacy provider")?;
    if unavailable == Some(true) {
        recorded.replace(Err("Mic/camera activity is unavailable.".into()));
    } else if let Some(v) = snapshot {
        recorded.replace(Ok(v));
    }
    if resume == Some(true) {
        service.resume();
    }
    Ok(serde_json::json!({"snapshot": service.snapshot(), "audit":recorded.audit()}))
}
