//! Own only Nabbit's bindings. Acquire replacements before saving or releasing.
use crate::{db::models::AppSettings, error::msg, AppState};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Mutex,
};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Island,
    QuickNote,
    Download,
    Clipboard,
    Timer,
    HideIsland,
    Selection,
    ToggleTray,
}
pub const ACTIONS: [Action; 8] = [
    Action::Island,
    Action::QuickNote,
    Action::Download,
    Action::Clipboard,
    Action::Timer,
    Action::HideIsland,
    Action::Selection,
    Action::ToggleTray,
];
impl Action {
    pub fn field(self) -> &'static str {
        match self {
            Self::Island => "islandShortcut",
            Self::QuickNote => "quickNoteShortcut",
            Self::Download => "quickDownloadShortcut",
            Self::Clipboard => "clipboardSearchShortcut",
            Self::Timer => "focusTimerShortcut",
            Self::HideIsland => "hideIslandShortcut",
            Self::Selection => "selectedTextShortcut",
            Self::ToggleTray => "togglePopoverShortcut",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Island => "the island",
            Self::QuickNote => "quick note capture",
            Self::Download => "download clipboard link",
            Self::Clipboard => "clipboard history",
            Self::Timer => "the focus timer",
            Self::HideIsland => "hide island for an hour",
            Self::Selection => "selected text",
            Self::ToggleTray => "the legacy tray shortcut",
        }
    }
    pub fn value(self, s: &AppSettings) -> &str {
        match self {
            Self::Island => &s.island_shortcut,
            Self::QuickNote => &s.quick_note_shortcut,
            Self::Download => &s.quick_download_shortcut,
            Self::Clipboard => &s.clipboard_search_shortcut,
            Self::Timer => &s.focus_timer_shortcut,
            Self::HideIsland => &s.hide_island_shortcut,
            Self::Selection => &s.selected_text_shortcut,
            Self::ToggleTray => &s.toggle_popover_shortcut,
        }
    }
}
fn parsed(value: &str) -> Result<Option<Shortcut>, String> {
    if value.trim().is_empty() {
        return Ok(None);
    }
    if value.len() > 80 {
        return Err("Shortcut is too long".into());
    }
    value
        .trim()
        .parse::<Shortcut>()
        .map(Some)
        .map_err(|_| "Enter a valid shortcut, such as Ctrl+Alt+F9".into())
}
fn validation(settings: &AppSettings) -> BTreeMap<Action, String> {
    let mut errors = BTreeMap::new();
    for action in ACTIONS {
        let key = match parsed(action.value(settings)) {
            Ok(key) => key,
            Err(error) => {
                errors.insert(action, error);
                continue;
            }
        };
        let Some(key) = key else {
            continue;
        };
        for other in ACTIONS.into_iter().filter(|other| *other != action) {
            if parsed(other.value(settings)).ok().flatten() == Some(key) {
                errors.insert(
                    action,
                    format!(
                        "Shortcut conflict: this combination is reserved for {}",
                        other.label()
                    ),
                );
                break;
            }
        }
    }
    errors
}
#[cfg(test)]
pub fn validate(settings: &AppSettings) -> Result<(), String> {
    validation(settings)
        .into_values()
        .next()
        .map_or(Ok(()), Err)
}
pub fn supplied(change: &serde_json::Value) -> Vec<Action> {
    ACTIONS
        .into_iter()
        .filter(|a| change.get(a.field()).is_some())
        .collect()
}

trait Port {
    fn register(&mut self, shortcut: Shortcut) -> Result<(), String>;
    fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String>;
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub shortcut: String,
    pub message: String,
    pub conflict: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: Action,
    pub shortcut: String,
    pub active_shortcut: Option<String>,
    pub problem: Option<Problem>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub rows: Vec<Row>,
    pub recording: bool,
    pub cleanup_error: Option<String>,
    pub injected: bool,
}
#[derive(Default)]
struct State {
    active: BTreeMap<Action, Shortcut>,
    owned: BTreeMap<u32, Shortcut>,
    problems: BTreeMap<Action, Problem>,
    recording: Option<(String, String)>,
    cleanup_error: Option<String>,
    conflicts: BTreeSet<u32>,
}
impl State {
    fn snapshot(&self, settings: &AppSettings, injected: bool) -> Snapshot {
        Snapshot {
            rows: ACTIONS
                .into_iter()
                .map(|id| Row {
                    id,
                    shortcut: id.value(settings).into(),
                    active_shortcut: self.active.get(&id).map(ToString::to_string),
                    problem: self.problems.get(&id).cloned(),
                })
                .collect(),
            recording: self.recording.is_some(),
            cleanup_error: self.cleanup_error.clone(),
            injected,
        }
    }
    fn fail(
        &mut self,
        action: Action,
        settings: &AppSettings,
        message: String,
        conflict: bool,
    ) -> String {
        self.problems.insert(
            action,
            Problem {
                shortcut: action.value(settings).into(),
                message: message.clone(),
                conflict,
            },
        );
        message
    }
    fn cleanup(&mut self, port: &mut dyn Port) {
        self.cleanup_error = None;
        for (id, shortcut) in self.owned.clone() {
            if self.active.values().any(|key| key.id() == id) {
                continue;
            }
            match port.unregister(shortcut) {
                Ok(()) => {
                    self.owned.remove(&id);
                }
                Err(error) => {
                    self.cleanup_error =
                        Some(format!("An old shortcut could not be released: {error}"))
                }
            }
        }
    }
    fn startup(&mut self, settings: &AppSettings, port: &mut dyn Port) {
        let invalid = validation(settings);
        for action in ACTIONS {
            if let Some(error) = invalid.get(&action) {
                self.fail(action, settings, error.clone(), true);
                continue;
            }
            let Some(key) = parsed(action.value(settings)).unwrap() else {
                continue;
            };
            match port.register(key) {
                Ok(()) => {
                    self.active.insert(action, key);
                    self.owned.insert(key.id(), key);
                }
                Err(error) => {
                    self.fail(
                        action,
                        settings,
                        format!("Shortcut conflict: {error}"),
                        true,
                    );
                }
            }
        }
    }
    fn change<T>(
        &mut self,
        settings: &AppSettings,
        targets: &[Action],
        port: &mut dyn Port,
        save: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let invalid = validation(settings);
        for action in targets {
            if let Some(error) = invalid.get(action) {
                return Err(self.fail(*action, settings, error.clone(), true));
            }
        }
        for action in targets {
            let Some(key) = parsed(action.value(settings))? else {
                continue;
            };
            if !self.owned.contains_key(&key.id()) {
                if let Err(error) = port.register(key) {
                    self.cleanup(port);
                    return Err(self.fail(*action, settings, format!("Shortcut conflict: {error}. The previous shortcut is still active if available."), true));
                }
                self.owned.insert(key.id(), key);
            }
        }
        let saved = match save() {
            Ok(saved) => saved,
            Err(error) => {
                self.cleanup(port);
                return Err(error);
            }
        };
        for action in targets {
            match parsed(action.value(settings))? {
                Some(key) => {
                    self.active.insert(*action, key);
                }
                None => {
                    self.active.remove(action);
                }
            }
            self.problems.remove(action);
        }
        self.cleanup(port);
        Ok(saved)
    }
    fn route(&self, key: Shortcut) -> Option<Action> {
        self.active
            .iter()
            .find(|(_, value)| **value == key)
            .map(|(action, _)| *action)
    }
}
#[derive(Default)]
pub struct Service(Mutex<State>);
fn injected() -> bool {
    crate::context::acceptance()
}
struct NativePort<'a>(&'a tauri::AppHandle);
impl Port for NativePort<'_> {
    fn register(&mut self, key: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .on_shortcut(key, |app, key, event| {
                if event.state == ShortcutState::Pressed {
                    let app = app.clone();
                    let key = *key;
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Err(error) = trigger(&app, key) {
                            let _ = app.emit("capture:error", error.to_string());
                        }
                    });
                }
            })
            .map_err(|error| error.to_string())
    }
    fn unregister(&mut self, key: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(key)
            .map_err(|error| error.to_string())
    }
}
#[derive(Default)]
struct FixturePort {
    conflicts: BTreeSet<u32>,
}
impl Port for FixturePort {
    fn register(&mut self, key: Shortcut) -> Result<(), String> {
        if self.conflicts.contains(&key.id()) {
            Err("The combination is already registered by another application".into())
        } else {
            Ok(())
        }
    }
    fn unregister(&mut self, _: Shortcut) -> Result<(), String> {
        Ok(())
    }
}
fn with_port<T>(
    app: &tauri::AppHandle,
    state: &mut State,
    work: impl FnOnce(&mut State, &mut dyn Port) -> T,
) -> T {
    if injected() {
        let mut port = FixturePort {
            conflicts: state.conflicts.clone(),
        };
        work(state, &mut port)
    } else {
        work(state, &mut NativePort(app))
    }
}
fn publish(app: &tauri::AppHandle) {
    if let Ok(snapshot) = snapshot(app) {
        let _ = app.emit("shortcuts:changed", &snapshot);
        let island = snapshot
            .rows
            .iter()
            .find(|row| row.id == Action::Island)
            .unwrap();
        #[cfg(windows)]
        if let Some(manager) = app.try_state::<std::sync::Arc<crate::island::Manager>>() {
            manager.shortcut_status(
                if island.active_shortcut.is_some() || island.shortcut.is_empty() {
                    None
                } else {
                    island.problem.as_ref().map(|p| p.message.clone())
                },
            );
        }
        #[cfg(not(windows))]
        let _ = island;
        let timer = snapshot
            .rows
            .iter()
            .find(|row| row.id == Action::Timer)
            .unwrap();
        app.state::<std::sync::Arc<crate::timer::Service>>()
            .shortcut_status(
                if timer.active_shortcut.is_some() || timer.shortcut.is_empty() {
                    None
                } else {
                    timer.problem.as_ref().map(|p| p.message.clone())
                },
            );
        let note = snapshot
            .rows
            .iter()
            .find(|row| row.id == Action::QuickNote)
            .unwrap();
        let _ = app
            .state::<AppState>()
            .db
            .notes_shortcut_status(note.active_shortcut.is_none() && !note.shortcut.is_empty());
        let selection = snapshot
            .rows
            .iter()
            .find(|row| row.id == Action::Selection)
            .unwrap();
        if let Ok(conn) = app.state::<AppState>().db.conn.lock() {
            let _ = crate::notes::sync_store::set_meta(
                &conn,
                "notes/selection_shortcut_error",
                if selection.active_shortcut.is_none() && !selection.shortcut.is_empty() {
                    "The selected-text shortcut is unavailable. Choose another shortcut in Settings."
                } else {
                    ""
                },
            );
        }
    }
}
pub fn startup(app: &tauri::AppHandle, settings: &AppSettings) -> crate::error::Result<()> {
    let service = app.state::<Service>();
    let mut state = service.0.lock().map_err(|_| msg("Shortcuts are busy"))?;
    if injected() {
        if let Ok(value) = std::env::var("NABBIT_ACCEPTANCE_SHORTCUT_CONFLICTS") {
            let keys: Vec<String> = serde_json::from_str(&value)?;
            state.conflicts = keys
                .into_iter()
                .filter_map(|key| parsed(&key).ok().flatten().map(|key| key.id()))
                .collect();
        }
    }
    with_port(app, &mut state, |state, port| state.startup(settings, port));
    drop(state);
    publish(app);
    Ok(())
}
pub fn save(
    app: &tauri::AppHandle,
    settings: &AppSettings,
    targets: &[Action],
    write: impl FnOnce() -> crate::error::Result<AppSettings>,
) -> crate::error::Result<AppSettings> {
    let service = app.state::<Service>();
    let mut state = service.0.lock().map_err(|_| msg("Shortcuts are busy"))?;
    let result = with_port(app, &mut state, |state, port| {
        state.change(settings, targets, port, || {
            write().map_err(|error| error.to_string())
        })
    });
    drop(state);
    publish(app);
    result.map_err(msg)
}
fn snapshot(app: &tauri::AppHandle) -> crate::error::Result<Snapshot> {
    let settings = app.state::<AppState>().db.get_settings()?;
    Ok(app
        .state::<Service>()
        .0
        .lock()
        .map_err(|_| msg("Shortcuts are busy"))?
        .snapshot(&settings, injected()))
}
fn caller(window: &tauri::WebviewWindow) -> crate::error::Result<()> {
    if matches!(window.label(), "settings" | "main") {
        Ok(())
    } else {
        Err(msg("Open settings to manage shortcuts"))
    }
}
#[tauri::command]
pub async fn shortcuts_snapshot(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> crate::error::Result<Snapshot> {
    caller(&window)?;
    snapshot(&app)
}
#[tauri::command]
pub async fn shortcuts_recording(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    token: String,
    active: bool,
) -> crate::error::Result<()> {
    caller(&window)?;
    if token.is_empty() || token.len() > 80 {
        return Err(msg("Invalid recorder session"));
    }
    let service = app.state::<Service>();
    let mut state = service.0.lock().map_err(|_| msg("Shortcuts are busy"))?;
    if active {
        state.recording = Some((window.label().into(), token));
    } else if state.recording.as_ref() == Some(&(window.label().into(), token)) {
        state.recording = None;
    }
    Ok(())
}
pub fn close_recording(app: &tauri::AppHandle, label: &str) {
    if app
        .get_webview_window(label)
        .is_some_and(|window| window.is_focused().unwrap_or(false))
    {
        return;
    }
    if let Some(service) = app.try_state::<Service>() {
        if let Ok(mut state) = service.0.lock() {
            if state
                .recording
                .as_ref()
                .is_some_and(|(owner, _)| owner == label)
            {
                state.recording = None;
            }
        }
    }
}
fn trigger(app: &tauri::AppHandle, key: Shortcut) -> crate::error::Result<Option<Action>> {
    let (recording, action) = {
        let service = app.state::<Service>();
        let state = service.0.lock().map_err(|_| msg("Shortcuts are busy"))?;
        (state.recording.clone(), state.route(key))
    };
    let focused = recording.as_ref().is_some_and(|(owner, _)| {
        app.get_webview_window(owner)
            .is_some_and(|window| window.is_focused().unwrap_or(false))
    });
    if deliver_recording(app, &recording, focused, key)? {
        return Ok(None);
    }
    if let Some(action) = action {
        dispatch(app, action)?;
    }
    Ok(action)
}
fn recording_delivery(
    recording: &Option<(String, String)>,
    focused: bool,
) -> Option<&(String, String)> {
    recording.as_ref().filter(|_| focused)
}
fn deliver_recording(
    app: &tauri::AppHandle,
    recording: &Option<(String, String)>,
    focused: bool,
    key: Shortcut,
) -> crate::error::Result<bool> {
    if let Some((owner, token)) = recording_delivery(recording, focused) {
        app.emit_to(
            owner,
            "shortcuts:recorded",
            serde_json::json!({"token":token,"shortcut":key.to_string()}),
        )?;
        return Ok(true);
    }
    Ok(false)
}
fn dispatch(app: &tauri::AppHandle, action: Action) -> crate::error::Result<()> {
    match action {
        Action::Island => crate::dispatch_island_shortcut(app, None).map_err(msg),
        Action::QuickNote => {
            crate::notes::capture::hotkey(app);
            Ok(())
        }
        Action::Download => {
            crate::capture::hotkey(app);
            Ok(())
        }
        Action::Clipboard => {
            crate::commands::settings::patch(
                app,
                &app.state::<AppState>(),
                serde_json::json!({"lastTab":"clipboard"}),
            )?;
            crate::show_popover(app)?;
            app.emit("shortcut:clipboard-search", ())?;
            Ok(())
        }
        Action::Timer => {
            app.state::<std::sync::Arc<crate::timer::Service>>()
                .hotkey();
            Ok(())
        }
        Action::HideIsland => {
            crate::commands::settings::patch(
                app,
                &app.state::<AppState>(),
                serde_json::json!({"islandActivity":{"hiddenUntilMs":chrono::Utc::now().timestamp_millis().saturating_add(3_600_000)}}),
            )?;
            Ok(())
        }
        Action::Selection => {
            crate::context::selection::hotkey(app);
            Ok(())
        }
        Action::ToggleTray => crate::toggle_popover(app),
    }
}
#[tauri::command]
pub async fn shortcuts_fixture(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    conflicts: Vec<String>,
    key: Option<String>,
) -> crate::error::Result<Snapshot> {
    caller(&window)?;
    if !injected() {
        return Err(msg("Shortcut fixture is disabled"));
    }
    let service = app.state::<Service>();
    let mut state = service.0.lock().map_err(|_| msg("Shortcuts are busy"))?;
    state.conflicts = conflicts
        .iter()
        .map(|key| {
            parsed(key)
                .and_then(|key| key.ok_or_else(|| "Empty fixture key".into()))
                .map(|key| key.id())
        })
        .collect::<Result<_, _>>()
        .map_err(msg)?;
    if let Some(key) = key {
        let key = parsed(&key)
            .map_err(msg)?
            .ok_or_else(|| msg("Empty fixture key"))?;
        let action = state.route(key);
        let recording = state.recording.clone();
        drop(state);
        // Focus is injected for this owned WebView only; never activate it.
        let captured = deliver_recording(
            &app,
            &recording,
            recording
                .as_ref()
                .is_some_and(|(owner, _)| owner == window.label()),
            key,
        )?;
        app.emit_to(
            window.label(),
            "shortcuts:fixture-route",
            serde_json::json!({"key":key.to_string(),"action":if captured { None } else { action },"recording":recording,"captured":captured,"injected":true}),
        )?;
    } else {
        drop(state);
    }
    snapshot(&app)
}

#[cfg(test)]
mod tests;
