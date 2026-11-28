//! Event-driven tray presentation. The notification worker blocks between jobs.
pub mod model;
mod toast;
use crate::{
    db::models::{DisplayMode, DownloadJob},
    error::{msg, Result},
    tray_icon::{self, TaskbarTheme},
};
use model::{Completion, Presentation, Tracker};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use tauri::{menu::CheckMenuItem, Manager};

#[derive(Clone)]
pub struct ModeMenu(pub [CheckMenuItem<tauri::Wry>; 3]);
pub const MODES: [DisplayMode; 3] = [
    DisplayMode::IslandAndTray,
    DisplayMode::TrayOnly,
    DisplayMode::IslandOnly,
];
pub const MENU_IDS: [&str; 3] = ["mode-both", "mode-tray", "mode-island"];
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub revision: u64,
    pub presentation: Presentation,
    pub theme: TaskbarTheme,
    pub width: u32,
    pub height: u32,
    pub rgba_sha256: String,
    pub checked: Vec<bool>,
    pub rect: Option<tauri::Rect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rgba_base64: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationReceipt {
    pub completion: Completion,
    pub xml: String,
    pub adapter: &'static str,
    pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub desired: Presentation,
    pub revision: u64,
    pub applied: Option<Applied>,
    pub tray_error: Option<String>,
    pub notification_error: Option<String>,
    pub notifications: Vec<NotificationReceipt>,
}
struct State {
    tracker: Tracker,
    theme: TaskbarTheme,
    physical_size: Option<u32>,
    menu: Option<ModeMenu>,
    revision: u64,
    applied: Option<Applied>,
    tray_error: Option<String>,
    notification_error: Option<String>,
    notifications: std::collections::VecDeque<NotificationReceipt>,
}
pub struct Service {
    app: tauri::AppHandle,
    state: Mutex<State>,
    sender: Mutex<Option<mpsc::Sender<Completion>>>,
    pending: AtomicBool,
}
impl Service {
    pub fn start(app: tauri::AppHandle, mode: DisplayMode, jobs: &[DownloadJob]) -> Arc<Self> {
        let (sender, receiver) = mpsc::channel::<Completion>();
        let service = Arc::new(Self {
            app,
            state: Mutex::new(State {
                tracker: Tracker::seed(mode, jobs),
                theme: tray_icon::initial_theme(),
                physical_size: None,
                menu: None,
                revision: 0,
                applied: None,
                tray_error: None,
                notification_error: None,
                notifications: Default::default(),
            }),
            sender: Mutex::new(Some(sender)),
            pending: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&service);
        std::thread::Builder::new()
            .name("nabbit-notifications".into())
            .spawn(move || {
                while let Ok(completion) = receiver.recv() {
                    let Some(service) = weak.upgrade() else { break };
                    let xml = toast::xml(&completion);
                    let injected = crate::island::acceptance_session();
                    // Acceptance validates Windows' real XML/notification object,
                    // but never displays a system notification or registers an app.
                    let result = if injected {
                        #[cfg(windows)]
                        {
                            crate::tools::platform::Apartment::new()
                                .map_err(|e| e.to_string())
                                .and_then(|_apartment| {
                                    toast::notification(&xml)
                                        .map(|_| ())
                                        .map_err(|e| e.to_string())
                                })
                        }
                        #[cfg(not(windows))]
                        {
                            Ok(())
                        }
                    } else {
                        toast::show(&service.app.config().identifier, &xml)
                    };
                    let error = result.err();
                    let mut state = service.state.lock().unwrap_or_else(|e| e.into_inner());
                    state.notification_error = error.clone();
                    if injected {
                        state.notifications.push_back(NotificationReceipt {
                            completion,
                            xml,
                            adapter: "owned WinRT validation; Show suppressed",
                            error,
                        });
                        while state.notifications.len() > 16 {
                            state.notifications.pop_front();
                        }
                    }
                }
            })
            .expect("spawn notification worker");
        service
    }
    pub fn snapshot(&self) -> Snapshot {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        Snapshot {
            desired: state.tracker.presentation(),
            revision: state.revision,
            applied: state.applied.clone(),
            tray_error: state.tray_error.clone(),
            notification_error: state.notification_error.clone(),
            notifications: state.notifications.iter().cloned().collect(),
        }
    }
    pub fn configure(self: &Arc<Self>, mode: DisplayMode) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .tracker
            .mode = mode;
        self.refresh();
    }
    pub fn menu(self: &Arc<Self>, menu: ModeMenu) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).menu = Some(menu);
        self.refresh();
    }
    pub fn theme(self: &Arc<Self>, theme: TaskbarTheme) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).theme = theme;
        self.refresh();
    }
    pub fn download(self: &Arc<Self>, job: &DownloadJob) {
        let (changed, completion) = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let before = state.tracker.presentation();
            let completion = state.tracker.update(job);
            (before != state.tracker.presentation(), completion)
        };
        if changed {
            self.refresh();
        }
        if let Some(completion) = completion {
            if let Some(sender) = self
                .sender
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
            {
                let _ = sender.send(completion);
            }
        }
    }
    pub fn refresh(self: &Arc<Self>) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .revision += 1;
        if self.pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let service = self.clone();
        if let Err(error) = self.app.run_on_main_thread(move || service.apply()) {
            self.pending.store(false, Ordering::Release);
            self.state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .tray_error = Some(error.to_string());
        }
    }
    fn apply(&self) {
        self.pending.store(false, Ordering::Release);
        let (presentation, theme, menu, revision, physical_size) = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            (
                state.tracker.presentation(),
                state.theme,
                state.menu.clone(),
                state.revision,
                state.physical_size.unwrap_or_else(tray_icon::physical_size),
            )
        };
        let update = || -> Result<Applied> {
            let tray = self
                .app
                .tray_by_id("main-tray")
                .ok_or_else(|| msg("Tray unavailable"))?;
            let image = tray_icon::badged(theme, physical_size, presentation.badge)?;
            let width = image.width();
            let height = image.height();
            let rgba_sha256 = format!("{:x}", Sha256::digest(image.rgba()));
            let rgba_base64 = crate::island::acceptance_session().then(|| {
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, image.rgba())
            });
            tray.set_icon(Some(image))?;
            tray.set_tooltip(Some(&presentation.tooltip))?;
            tray.set_visible(presentation.visible)?;
            let rect = tray.rect()?;
            let mut checked = Vec::new();
            if let Some(menu) = &menu {
                for (item, mode) in menu.0.iter().zip(MODES) {
                    item.set_checked(mode == presentation.mode)?;
                    checked.push(item.is_checked()?);
                }
            }
            Ok(Applied {
                revision,
                presentation,
                theme,
                width,
                height,
                rgba_sha256,
                checked,
                rect,
                rgba_base64,
            })
        };
        let result = update();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match result {
            Ok(applied) => {
                state.applied = Some(applied);
                state.tray_error = None;
            }
            Err(error) => state.tray_error = Some(error.to_string()),
        }
    }
    pub fn stop(&self) {
        self.sender.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}
pub fn menu_action(app: &tauri::AppHandle, id: &str) -> Result<bool> {
    let Some(index) = MENU_IDS.iter().position(|value| *value == id) else {
        return Ok(false);
    };
    let state = app.state::<crate::AppState>();
    crate::commands::settings::patch(app, &state, serde_json::json!({"displayMode":MODES[index]}))?;
    // Check items auto-toggle before their callback. Restore the radio group
    // even when its already-selected value did not change in the database.
    app.state::<Arc<Service>>().refresh();
    Ok(true)
}
#[tauri::command]
pub fn get_mode_snapshot(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Snapshot> {
    crate::tools::commands::caller(&app, &window)?;
    Ok(app.state::<Arc<Service>>().snapshot())
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Fixture {
    Menu { id: String },
    Theme { light: bool, size: Option<u32> },
    Reapply,
}
#[tauri::command]
pub fn mode_fixture(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    action: Fixture,
) -> Result<Snapshot> {
    crate::tools::commands::caller(&app, &window)?;
    if !crate::island::acceptance_session() {
        return Err(msg("Mode fixture is disabled"));
    }
    let service = app.state::<Arc<Service>>();
    match action {
        Fixture::Menu { id } => {
            if let Some(index) = MENU_IDS.iter().position(|value| *value == id) {
                let item = service
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .menu
                    .as_ref()
                    .map(|menu| menu.0[index].clone());
                if let Some(item) = item {
                    item.set_checked(!item.is_checked()?)?;
                }
            }
            if !menu_action(&app, &id)? {
                return Err(msg("Unknown mode menu action"));
            }
        }
        Fixture::Theme { light, size } => {
            if size.is_some_and(|value| !matches!(value, 16 | 24)) {
                return Err(msg("Use an owned 16px or 24px icon fixture"));
            }
            service
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .physical_size = size;
            service.theme(if light {
                TaskbarTheme::Light
            } else {
                TaskbarTheme::Dark
            });
        }
        Fixture::Reapply => service.refresh(),
    }
    Ok(service.snapshot())
}
