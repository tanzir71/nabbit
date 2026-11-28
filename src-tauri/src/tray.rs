//! Native tray commands share the same settings and stores as the app surfaces.
use crate::{
    db::models::AppSettings,
    error::{msg, Result},
    AppState,
};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{
    menu::{
        CheckMenuItem, IconMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu,
    },
    Emitter, Listener, Manager,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    kind: &'static str,
    id: String,
    text: String,
    enabled: bool,
    checked: Option<bool>,
    children: Vec<Entry>,
}
fn item(id: &str, text: &str) -> Entry {
    Entry {
        kind: "item",
        id: id.into(),
        text: text.into(),
        enabled: true,
        checked: None,
        children: vec![],
    }
}
fn check(id: &str, text: &str, checked: bool) -> Entry {
    Entry {
        kind: "check",
        checked: Some(checked),
        ..item(id, text)
    }
}
fn submenu(id: &str, text: &str, children: Vec<Entry>) -> Entry {
    Entry {
        kind: "submenu",
        children,
        ..item(id, text)
    }
}
fn separator() -> Entry {
    Entry {
        kind: "separator",
        ..item("separator", "")
    }
}
fn shortcut(id: &str, text: &str, key: &str) -> Entry {
    item(
        id,
        &if key.trim().is_empty() {
            text.into()
        } else {
            format!("{text}\t{}", key.replace("CmdOrCtrl", "Ctrl"))
        },
    )
}
fn safe_name(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(100)
        .collect::<String>()
        .replace('&', "&&")
}
fn entries(settings: &AppSettings, pins: &[crate::files::PinView]) -> Vec<Entry> {
    let mut numbered: Vec<_> = pins
        .iter()
        .filter(|p| p.pin.slot.is_some_and(|n| (1..=9).contains(&n)))
        .collect();
    numbered.sort_by_key(|p| p.pin.slot);
    let mut pins: Vec<_> = numbered
        .into_iter()
        .map(|p| {
            let name = p
                .pin
                .label
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    p.pin
                        .path
                        .rsplit(['\\', '/'])
                        .find(|s| !s.is_empty())
                        .unwrap_or(&p.pin.path)
                });
            Entry {
                enabled: p.available,
                ..item(
                    &format!("pin:{}", p.pin.id),
                    &format!(
                        "{}. {}{}",
                        p.pin.slot.unwrap(),
                        safe_name(name),
                        if p.available { "" } else { " (unavailable)" }
                    ),
                )
            }
        })
        .collect();
    if pins.is_empty() {
        pins.push(Entry {
            enabled: false,
            ..item("pins-empty", "No numbered pins")
        });
    }
    pins.extend([separator(), item("files", "Manage pins…")]);
    let prefs = &settings.island;
    vec![
        shortcut("open", "Open Nabbit", &settings.island_shortcut),
        shortcut("new-note", "New note", crate::notes::capture::SHORTCUT),
        shortcut(
            "download-clipboard",
            "Download link on clipboard",
            &settings.quick_download_shortcut,
        ),
        shortcut(
            "clipboard",
            "Clipboard history",
            &settings.clipboard_search_shortcut,
        ),
        separator(),
        submenu(
            "island",
            "Island",
            vec![
                check("island-show", "Show island", prefs.enabled),
                check(
                    "island-fullscreen",
                    "Hide over fullscreen apps",
                    prefs.hide_over_fullscreen,
                ),
                check(
                    "island-maximized",
                    "Fade over maximised windows",
                    prefs.fade_over_maximized,
                ),
                check(
                    "shape-island",
                    "Shape: Floating island",
                    prefs.shape == crate::island::model::Shape::Island,
                ),
                check(
                    "shape-notch",
                    "Shape: Notch",
                    prefs.shape == crate::island::model::Shape::Notch,
                ),
                check(
                    "monitor-follow",
                    "Monitor: Follow mouse",
                    prefs.monitor_mode == crate::island::model::MonitorMode::FollowMouse,
                ),
                check(
                    "monitor-primary",
                    "Monitor: Primary",
                    prefs.monitor_mode == crate::island::model::MonitorMode::Primary,
                ),
                check(
                    "monitor-all",
                    "Monitor: All",
                    prefs.monitor_mode == crate::island::model::MonitorMode::All,
                ),
                item("island-settings", "Island settings…"),
            ],
        ),
        submenu(
            "mode",
            "Mode",
            crate::modes::MENU_IDS
                .into_iter()
                .zip(["Island + tray", "Tray only", "Island only"])
                .zip(crate::modes::MODES)
                .map(|((id, text), mode)| check(id, text, settings.display_mode == mode))
                .collect(),
        ),
        submenu(
            "widgets",
            "Widgets",
            vec![
                item("widgets-restore", "Restore sticky notes"),
                item("widgets-notes", "Open notes to pop out a sticky"),
                item("widgets-settings", "Widget settings…"),
            ],
        ),
        submenu("pins", "Pins", pins),
        check(
            "pause-capture",
            "Pause clipboard capture",
            settings.pause_clipboard_capture,
        ),
        separator(),
        item("settings", "Settings"),
        item("updates", "Check for updates"),
        item("quit", "Quit Nabbit"),
    ]
}
fn icon(id: &str) -> Result<Option<tauri::image::Image<'static>>> {
    let bytes: &[u8] = match id {
        "open" => include_bytes!("../../src/assets/tray/menu/3e250.png"),
        "new-note" => include_bytes!("../../src/assets/tray/menu/4fac6.png"),
        "download-clipboard" => include_bytes!("../../src/assets/tray/menu/403ff.png"),
        "clipboard" => include_bytes!("../../src/assets/tray/menu/15f08.png"),
        "island" => include_bytes!("../../src/assets/tray/menu/d64a9.png"),
        "widgets" => include_bytes!("../../src/assets/tray/menu/a2549.png"),
        "settings" => include_bytes!("../../src/assets/tray/menu/dafc4.png"),
        "updates" => include_bytes!("../../src/assets/tray/menu/ee21d.png"),
        "quit" => include_bytes!("../../src/assets/tray/menu/6f502.png"),
        _ => return Ok(None),
    };
    let image = image::load_from_memory(bytes)
        .map_err(|e| msg(e.to_string()))?
        .to_rgba8();
    let (width, height) = image.dimensions();
    Ok(Some(tauri::image::Image::new_owned(
        image.into_raw(),
        width,
        height,
    )))
}
fn native(
    app: &tauri::AppHandle,
    entry: &Entry,
    modes: &mut Vec<CheckMenuItem<tauri::Wry>>,
) -> Result<MenuItemKind<tauri::Wry>> {
    if entry.id == "separator" {
        return Ok(MenuItemKind::Predefined(PredefinedMenuItem::separator(
            app,
        )?));
    }
    if !entry.children.is_empty() {
        let menu = Submenu::with_id(app, &entry.id, &entry.text, entry.enabled)?;
        menu.set_icon(icon(&entry.id)?)?;
        for child in &entry.children {
            menu.append(&native(app, child, modes)?)?;
        }
        return Ok(MenuItemKind::Submenu(menu));
    }
    if let Some(checked) = entry.checked {
        let item = CheckMenuItem::with_id(
            app,
            &entry.id,
            &entry.text,
            entry.enabled,
            checked,
            None::<&str>,
        )?;
        if crate::modes::MENU_IDS.contains(&entry.id.as_str()) {
            modes.push(item.clone());
        }
        return Ok(MenuItemKind::Check(item));
    }
    if let Some(image) = icon(&entry.id)? {
        return Ok(MenuItemKind::Icon(IconMenuItem::with_id(
            app,
            &entry.id,
            &entry.text,
            entry.enabled,
            Some(image),
            None::<&str>,
        )?));
    }
    Ok(MenuItemKind::MenuItem(MenuItem::with_id(
        app,
        &entry.id,
        &entry.text,
        entry.enabled,
        None::<&str>,
    )?))
}
fn build(app: &tauri::AppHandle) -> Result<Menu<tauri::Wry>> {
    let state = app.state::<AppState>();
    let tree = entries(&state.db.get_settings()?, &crate::files::list(&state.db)?);
    let menu = Menu::new(app)?;
    let mut modes = vec![];
    for entry in tree {
        menu.append(&native(app, &entry, &mut modes)?)?;
    }
    app.state::<Arc<crate::modes::Service>>()
        .menu(crate::modes::ModeMenu(
            modes.try_into().map_err(|_| msg("Mode menu unavailable"))?,
        ));
    Ok(menu)
}
pub struct Service {
    app: tauri::AppHandle,
    menu: Mutex<Option<Menu<tauri::Wry>>>,
    pending: AtomicBool,
    revision: AtomicU64,
    error: Mutex<Option<String>>,
    notice: Mutex<Option<String>>,
    actions: Mutex<()>,
}
impl Service {
    pub fn start(app: &tauri::AppHandle) -> Result<Arc<Self>> {
        let menu = build(app)?;
        let service = Arc::new(Self {
            app: app.clone(),
            menu: Mutex::new(Some(menu)),
            pending: AtomicBool::new(false),
            revision: AtomicU64::new(0),
            error: Mutex::new(None),
            notice: Mutex::new(None),
            actions: Mutex::new(()),
        });
        for event in ["nabbit://settings-changed", "pins:changed"] {
            let weak = Arc::downgrade(&service);
            app.listen(event, move |_| {
                if let Some(service) = weak.upgrade() {
                    service.refresh();
                }
            });
        }
        Ok(service)
    }
    pub fn menu(&self) -> Menu<tauri::Wry> {
        self.menu
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .unwrap()
            .clone()
    }
    fn refresh(self: &Arc<Self>) {
        self.revision.fetch_add(1, Ordering::AcqRel);
        if self.pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let service = self.clone();
        tauri::async_runtime::spawn_blocking(move || loop {
            let revision = service.revision.load(Ordering::Acquire);
            // Native menu calls marshal to the event thread. File metadata and DB
            // reads happen on this worker, never in a menu callback.
            let result = build(&service.app).and_then(|menu| {
                service
                    .app
                    .tray_by_id("main-tray")
                    .ok_or_else(|| msg("Tray unavailable"))?
                    .set_menu(Some(menu.clone()))?;
                *service.menu.lock().unwrap_or_else(|e| e.into_inner()) = Some(menu);
                Ok(())
            });
            *service.error.lock().unwrap_or_else(|e| e.into_inner()) =
                result.err().map(|e| e.to_string());
            if service.revision.load(Ordering::Acquire) != revision {
                continue;
            }
            service.pending.store(false, Ordering::Release);
            if service.revision.load(Ordering::Acquire) == revision
                || service.pending.swap(true, Ordering::AcqRel)
            {
                break;
            }
        });
    }
    fn notify(&self, message: String) {
        *self.notice.lock().unwrap_or_else(|e| e.into_inner()) = Some(message);
        let _ = self.app.emit("tray:notice", ());
    }
}
fn navigate(app: &tauri::AppHandle, tab: &str) -> Result<()> {
    crate::commands::settings::patch(
        app,
        &app.state::<AppState>(),
        serde_json::json!({"lastTab":tab}),
    )?;
    crate::show_popover(app)
}
pub fn action(app: &tauri::AppHandle, id: &str) -> Result<()> {
    let service = app.state::<Arc<Service>>();
    let _action = service
        .actions
        .lock()
        .map_err(|_| msg("Tray actions are busy"))?;
    if crate::modes::menu_action(app, id)? {
        return Ok(());
    }
    let state = app.state::<AppState>();
    let settings = state.db.get_settings()?;
    let change = match id {
        "island-show" => Some(serde_json::json!({"island":{"enabled":!settings.island.enabled}})),
        "island-fullscreen" => Some(
            serde_json::json!({"island":{"hideOverFullscreen":!settings.island.hide_over_fullscreen}}),
        ),
        "island-maximized" => Some(
            serde_json::json!({"island":{"fadeOverMaximized":!settings.island.fade_over_maximized}}),
        ),
        "shape-island" => Some(serde_json::json!({"island":{"shape":"island"}})),
        "shape-notch" => Some(serde_json::json!({"island":{"shape":"notch"}})),
        "monitor-follow" => {
            Some(serde_json::json!({"island":{"monitorMode":"followMouse","monitorId":null}}))
        }
        "monitor-primary" => {
            Some(serde_json::json!({"island":{"monitorMode":"primary","monitorId":null}}))
        }
        "monitor-all" => Some(serde_json::json!({"island":{"monitorMode":"all","monitorId":null}})),
        "pause-capture" => {
            Some(serde_json::json!({"pauseClipboardCapture":!settings.pause_clipboard_capture}))
        }
        _ => None,
    };
    if let Some(change) = change {
        crate::commands::settings::patch(app, &state, change)?;
        return Ok(());
    }
    match id {
        "open" => crate::show_popover(app),
        "new-note" => crate::notes::capture::open(app, crate::notes::capture::NotesIntent::Capture),
        "download-clipboard" => {
            crate::capture::hotkey(app);
            Ok(())
        }
        "clipboard" => {
            navigate(app, "clipboard")?;
            app.emit("shortcut:clipboard-search", ())?;
            Ok(())
        }
        "files" => navigate(app, "files"),
        "widgets-notes" => navigate(app, "notes"),
        "widgets-restore" => {
            crate::sticky::restore(app);
            Ok(())
        }
        "settings" => crate::settings_window::open(app),
        "island-settings" => crate::settings_window::open_page(app, "island"),
        "widgets-settings" => crate::settings_window::open_page(app, "widgets"),
        "updates" => {
            let updater_app = app.clone();
            tauri::async_runtime::spawn(async move {
                let status = crate::commands::app::check_app_update(updater_app.clone()).await;
                let message = if let Some(error) = status.error {
                    format!("Updates could not be checked: {error}")
                } else if status.available {
                    format!(
                        "Nabbit {} is available. Open Privacy & about in settings for details.",
                        status.version.unwrap_or_default()
                    )
                } else {
                    "Nabbit is up to date.".into()
                };
                updater_app.state::<Arc<Service>>().notify(message);
            });
            crate::show_popover(app)
        }
        "quit" => {
            crate::tools::request_quit(app);
            Ok(())
        }
        id if id.starts_with("pin:") => {
            let pin = state.db.pin_target(Some(&id[4..]), None)?;
            let facts = crate::files::paths::facts(&pin.path)?;
            if facts.directory != (pin.kind == "folder") {
                return Err(msg("The pinned path changed. Open Files to locate it."));
            }
            if crate::island::acceptance_session() {
                crate::files::commands::Owned {
                    root: state.app_data_dir.clone(),
                }
                .guard(&pin.path)?;
            } else {
                crate::files::native::action(pin.path.clone(), "open".into())?;
            }
            state.db.touch_pin(&pin.id)?;
            app.emit("pins:action",serde_json::json!({"path":pin.path,"action":"open","injected":crate::island::acceptance_session()}))?;
            Ok(())
        }
        _ => Err(msg("Unknown tray action")),
    }
}
pub fn dispatch(app: &tauri::AppHandle, id: &str) {
    let app = app.clone();
    let id = id.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = action(&app, &id) {
            app.state::<Arc<Service>>().notify(error.to_string());
            let _ = crate::show_popover(&app);
        }
        if let Some(service) = app.try_state::<Arc<Service>>() {
            service.refresh();
        }
    });
}
#[tauri::command]
pub fn tray_ready(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<()> {
    if window.label() != "main" {
        return Err(msg("Only the tray can register its drop target"));
    }
    #[cfg(windows)]
    crate::files::drop::install(&window);
    let _ = app;
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub entries: Vec<Entry>,
    pub error: Option<String>,
}
fn inspect(items: Vec<MenuItemKind<tauri::Wry>>) -> Result<Vec<Entry>> {
    items
        .into_iter()
        .map(|item| {
            Ok(match item {
                MenuItemKind::MenuItem(item) => Entry {
                    enabled: item.is_enabled()?,
                    ..super::tray::item(item.id().as_ref(), &item.text()?)
                },
                MenuItemKind::Check(item) => Entry {
                    enabled: item.is_enabled()?,
                    ..check(item.id().as_ref(), &item.text()?, item.is_checked()?)
                },
                MenuItemKind::Icon(item) => Entry {
                    kind: "icon",
                    enabled: item.is_enabled()?,
                    ..super::tray::item(item.id().as_ref(), &item.text()?)
                },
                MenuItemKind::Submenu(item) => Entry {
                    enabled: item.is_enabled()?,
                    ..submenu(item.id().as_ref(), &item.text()?, inspect(item.items()?)?)
                },
                _ => separator(),
            })
        })
        .collect()
}
#[tauri::command]
pub fn tray_snapshot(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Snapshot> {
    crate::tools::commands::caller(&app, &window)?;
    let service = app.state::<Arc<Service>>();
    let error = service
        .error
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    Ok(Snapshot {
        entries: inspect(service.menu().items()?)?,
        error,
    })
}
#[tauri::command]
pub fn tray_take_notice(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>> {
    if window.label() != "main" {
        return Err(msg("Only the tray can consume a tray notice"));
    }
    let service = app.state::<Arc<Service>>();
    let notice = service
        .notice
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    Ok(notice)
}
#[tauri::command]
pub async fn tray_fixture(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<()> {
    crate::tools::commands::caller(&app, &window)?;
    if !crate::island::acceptance_session() {
        return Err(msg("Tray fixture is disabled"));
    }
    // Do not route real clipboard, updater/network, shell exit or restore work
    // from an acceptance fixture. Those adapters have their own owned seams.
    if matches!(
        id.as_str(),
        "download-clipboard" | "updates" | "quit" | "widgets-restore"
    ) {
        return Err(msg("Use the owned adapter fixture for this action"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        fn auto_toggle(items: Vec<MenuItemKind<tauri::Wry>>, id: &str) -> Result<()> {
            for item in items {
                match item {
                    MenuItemKind::Check(item) if item.id().as_ref() == id => {
                        item.set_checked(!item.is_checked()?)?
                    }
                    MenuItemKind::Submenu(menu) => auto_toggle(menu.items()?, id)?,
                    _ => {}
                }
            }
            Ok(())
        }
        // Muda toggles a check item before delivering its menu event.
        auto_toggle(app.state::<Arc<Service>>().menu().items()?, &id)?;
        let result = action(&app, &id);
        app.state::<Arc<Service>>().refresh();
        result
    })
    .await
    .map_err(|e| msg(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn menu_tracks_preferences_numbered_pin_identity_and_missing_paths() {
        let settings = AppSettings {
            pause_clipboard_capture: true,
            ..Default::default()
        };
        let pin = |id: &str, slot: Option<u8>, available: bool| crate::files::PinView {
            pin: crate::pins::Pin {
                id: id.into(),
                kind: "folder".into(),
                path: "D:\\owned\\folder".into(),
                label: Some("A&B\n\tName".into()),
                slot,
            },
            always_move: false,
            available,
            cloud: false,
            network: false,
        };
        let tree = entries(
            &settings,
            &[
                pin("nine", Some(9), true),
                pin("none", None, true),
                pin("one", Some(1), false),
            ],
        );
        let pins = &tree.iter().find(|e| e.id == "pins").unwrap().children;
        assert_eq!(pins[0].id, "pin:one");
        assert!(!pins[0].enabled);
        assert_eq!(pins[0].text, "1. A&&BName (unavailable)");
        assert_eq!(pins[1].id, "pin:nine");
        assert!(!pins.iter().any(|e| e.id == "pin:none"));
        assert_eq!(
            tree.iter()
                .find(|e| e.id == "pause-capture")
                .unwrap()
                .checked,
            Some(true)
        );
        let mode = &tree.iter().find(|e| e.id == "mode").unwrap().children;
        assert_eq!(mode.iter().filter(|e| e.checked == Some(true)).count(), 1);
        let island = &tree.iter().find(|e| e.id == "island").unwrap().children;
        assert_eq!(
            island
                .iter()
                .find(|e| e.id == "island-fullscreen")
                .unwrap()
                .checked,
            Some(true)
        );
        assert_eq!(tree[0].text, "Open Nabbit\tAlt+Space");
        let empty = entries(&settings, &[]);
        assert!(!empty.iter().find(|e| e.id == "pins").unwrap().children[0].enabled);
    }
    #[test]
    fn native_menu_exports_keep_the_original_optical_geometry() {
        for id in [
            "open",
            "new-note",
            "download-clipboard",
            "clipboard",
            "island",
            "widgets",
            "settings",
            "updates",
            "quit",
        ] {
            let image = icon(id).unwrap().unwrap();
            assert_eq!((image.width(), image.height()), (16, 16));
            assert!(image.rgba().chunks_exact(4).any(|pixel| pixel[3] > 0));
        }
        assert!(icon("unknown").unwrap().is_none());
    }
}
