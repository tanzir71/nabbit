pub mod acceptance;
pub mod classify;
pub mod clipboard;
pub mod commands;
pub mod explorer;
pub mod fallback;
pub mod registration;
pub mod selection;
#[cfg(windows)]
pub mod selection_fixture;
pub mod text;

use std::sync::Mutex;
use tauri::{Emitter, Manager};
#[derive(Default)]
pub struct Service {
    latest: Mutex<Option<String>>,
    blocked: Mutex<bool>,
    selection: Mutex<Option<crate::db::models::ClipboardEntry>>,
    receipts: Mutex<std::collections::HashMap<String, (String, crate::db::models::ClipboardEntry)>>,
    notification: Mutex<Option<i32>>,
    incoming: Mutex<Option<std::sync::mpsc::Sender<explorer::Invocation>>>,
    pending: Mutex<Vec<explorer::Invocation>>,
    batch: Mutex<Option<explorer::Batch>>,
    batch_error: Mutex<Option<String>>,
    registration_lock: Mutex<()>,
}
impl Service {
    pub fn observe(&self, app: &tauri::AppHandle, id: Option<String>) {
        if let Ok(mut blocked) = self.blocked.lock() {
            *blocked = id.is_none();
        }
        if let Ok(mut latest) = self.latest.lock() {
            *latest = id;
        }
        let _ = app.emit("context:changed", ());
    }
}
pub fn silent(app: &tauri::AppHandle) -> bool {
    if acceptance() {
        return app
            .try_state::<Service>()
            .and_then(|s| s.notification.lock().ok().map(|v| classify::silent(*v)))
            .unwrap_or(false);
    }
    #[cfg(windows)]
    unsafe {
        let mut state = 0;
        windows_sys::Win32::UI::Shell::SHQueryUserNotificationState(&mut state) >= 0
            && classify::silent(Some(state))
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        false
    }
}
pub fn acceptance() -> bool {
    crate::sticky::acceptance_enabled()
        || crate::island::acceptance_session()
        || crate::download::acceptance::enabled()
}
pub fn observe(app: &tauri::AppHandle, id: Option<String>) {
    if let Some(service) = app.try_state::<Service>() {
        service.observe(app, id);
    }
}
