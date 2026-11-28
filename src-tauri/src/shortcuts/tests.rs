use super::*;
use std::{cell::RefCell, rc::Rc};
#[derive(Default)]
struct Fake {
    keys: BTreeSet<u32>,
    blocked: BTreeSet<u32>,
    release_error: bool,
    trace: Rc<RefCell<Vec<String>>>,
}
impl Port for Fake {
    fn register(&mut self, key: Shortcut) -> Result<(), String> {
        self.trace.borrow_mut().push(format!("register:{key}"));
        if self.blocked.contains(&key.id()) || !self.keys.insert(key.id()) {
            return Err("RegisterHotKey: already registered".into());
        }
        Ok(())
    }
    fn unregister(&mut self, key: Shortcut) -> Result<(), String> {
        self.trace.borrow_mut().push(format!("unregister:{key}"));
        if self.release_error {
            return Err("owned release failure".into());
        }
        assert!(self.keys.remove(&key.id()));
        Ok(())
    }
}
fn key(value: &str) -> Shortcut {
    value.parse().unwrap()
}
#[test]
fn recording_delivery_requires_the_owned_focus_and_keeps_the_session_token() {
    let recording = Some(("settings".into(), "owned-token".into()));
    assert!(recording_delivery(&recording, false).is_none());
    assert_eq!(
        recording_delivery(&recording, true).unwrap().1,
        "owned-token"
    );
    assert!(recording_delivery(&None, true).is_none());
}
fn setup() -> (State, Fake, AppSettings) {
    let mut state = State::default();
    let mut port = Fake::default();
    let settings = AppSettings::default();
    state.startup(&settings, &mut port);
    assert!(state.problems.is_empty());
    port.trace.borrow_mut().clear();
    (state, port, settings)
}
#[test]
fn every_action_validates_aliases_duplicates_invalid_and_disabled_bindings() {
    let mut settings = AppSettings::default();
    assert!(validate(&settings).is_ok());
    settings.clipboard_search_shortcut = "Alt+Control+D".into();
    assert!(validation(&settings)
        .get(&Action::Clipboard)
        .unwrap()
        .contains("download"));
    settings.clipboard_search_shortcut.clear();
    assert!(validate(&settings).is_ok());
    settings.focus_timer_shortcut = "invalid+key".into();
    assert!(validate(&settings).is_err());
    settings.focus_timer_shortcut.clear();
    settings.quick_note_shortcut.clear();
    settings.hide_island_shortcut = "Alt+Ctrl+N".into();
    assert!(validate(&settings).is_ok());
    assert_eq!(
        supplied(&serde_json::json!({"quickNoteShortcut":"","theme":"dark"})),
        vec![Action::QuickNote]
    );
}
#[test]
fn startup_conflict_skips_only_that_action_and_reports_actual_binding_state() {
    let settings = AppSettings::default();
    let mut state = State::default();
    let mut port = Fake::default();
    port.blocked.insert(key("Ctrl+Alt+H").id());
    state.startup(&settings, &mut port);
    assert_eq!(state.active.len(), 7);
    assert_eq!(state.route(key("Ctrl+Alt+H")), None);
    let snapshot = state.snapshot(&settings, true);
    let hide = snapshot
        .rows
        .iter()
        .find(|r| r.id == Action::HideIsland)
        .unwrap();
    assert!(hide.problem.as_ref().unwrap().conflict);
    assert!(hide.active_shortcut.is_none());
    assert_eq!(state.route(key("Ctrl+Alt+N")), Some(Action::QuickNote));
}
#[test]
fn replacement_acquires_then_saves_then_releases_and_routes_only_the_current_action() {
    let (mut state, mut port, mut settings) = setup();
    settings.quick_note_shortcut = "Ctrl+Alt+F9".into();
    let trace = port.trace.clone();
    state
        .change(&settings, &[Action::QuickNote], &mut port, || {
            trace.borrow_mut().push("save".into());
            Ok(())
        })
        .unwrap();
    let trace = trace.borrow();
    assert!(trace[0].starts_with("register:"));
    assert_eq!(trace[1], "save");
    assert!(trace[2].starts_with("unregister:"));
    assert_eq!(state.route(key("Ctrl+Alt+N")), None);
    assert_eq!(state.route(key("Ctrl+Alt+F9")), Some(Action::QuickNote));
    assert_eq!(state.route(key("Ctrl+Alt+T")), Some(Action::Timer));
}
#[test]
fn rejected_replacement_preserves_the_old_key_and_never_persists() {
    let (mut state, mut port, mut settings) = setup();
    settings.quick_download_shortcut = "Ctrl+Alt+F9".into();
    port.blocked.insert(key("Ctrl+Alt+F9").id());
    assert!(state
        .change(
            &settings,
            &[Action::Download],
            &mut port,
            || -> Result<(), String> { panic!("conflict must not save") }
        )
        .unwrap_err()
        .contains("conflict"));
    assert_eq!(state.route(key("Ctrl+Alt+D")), Some(Action::Download));
    assert_eq!(state.owned.len(), 8);
    assert!(state.problems[&Action::Download]
        .message
        .contains("previous shortcut"));
}
#[test]
fn partial_batch_and_database_failures_rollback_every_new_registration() {
    let (mut state, mut port, mut settings) = setup();
    settings.quick_download_shortcut = "Ctrl+Alt+F8".into();
    settings.clipboard_search_shortcut = "Ctrl+Alt+F9".into();
    port.blocked.insert(key("Ctrl+Alt+F9").id());
    assert!(state
        .change(
            &settings,
            &[Action::Download, Action::Clipboard],
            &mut port,
            || Ok(())
        )
        .is_err());
    assert_eq!(state.route(key("Ctrl+Alt+D")), Some(Action::Download));
    assert_eq!(state.route(key("Ctrl+Alt+V")), Some(Action::Clipboard));
    assert_eq!(port.keys.len(), 8);
    port.blocked.clear();
    assert_eq!(
        state
            .change(
                &settings,
                &[Action::Download, Action::Clipboard],
                &mut port,
                || Err::<(), _>("owned database failure".into())
            )
            .unwrap_err(),
        "owned database failure"
    );
    assert_eq!(port.keys.len(), 8);
    assert_eq!(state.owned.len(), 8);
    assert_eq!(state.route(key("Ctrl+Alt+F8")), None);
}
#[test]
fn aliases_disable_reenable_and_atomic_swaps_preserve_unrelated_bindings() {
    let (mut state, mut port, mut settings) = setup();
    settings.quick_download_shortcut = "Alt+Control+D".into();
    state
        .change(&settings, &[Action::Download], &mut port, || Ok(()))
        .unwrap();
    assert!(port.trace.borrow().is_empty());
    settings.quick_download_shortcut.clear();
    state
        .change(&settings, &[Action::Download], &mut port, || Ok(()))
        .unwrap();
    assert_eq!(state.active.len(), 7);
    settings.quick_download_shortcut = "Ctrl+Alt+V".into();
    settings.clipboard_search_shortcut = "Ctrl+Alt+D".into();
    state
        .change(
            &settings,
            &[Action::Download, Action::Clipboard],
            &mut port,
            || Ok(()),
        )
        .unwrap();
    assert_eq!(state.route(key("Ctrl+Alt+V")), Some(Action::Download));
    assert_eq!(state.route(key("Ctrl+Alt+D")), Some(Action::Clipboard));
    assert_eq!(state.active.len(), 8);
}
#[test]
fn failed_old_key_release_is_visible_and_stale_callbacks_cannot_dispatch() {
    let (mut state, mut port, mut settings) = setup();
    port.release_error = true;
    settings.hide_island_shortcut = "Ctrl+Alt+F9".into();
    state
        .change(&settings, &[Action::HideIsland], &mut port, || Ok(()))
        .unwrap();
    assert!(state.cleanup_error.is_some());
    assert_eq!(state.route(key("Ctrl+Alt+H")), None);
    port.release_error = false;
    state.cleanup(&mut port);
    assert!(state.cleanup_error.is_none());
    assert_eq!(port.keys.len(), 8);
}
#[test]
fn migration_defaults_custom_keys_disabled_keys_and_unknown_fields_survive_restart() {
    let root = std::env::temp_dir().join(format!("nabbit-v64-shortcuts-{}", uuid::Uuid::new_v4()));
    let db = crate::db::Database::open(&root).unwrap();
    let raw = serde_json::json!({"togglePopoverShortcut":"Ctrl+Alt+F6","quickDownloadShortcut":"","quickNoteShortcut":"Ctrl+Alt+F7","focusTimerShortcut":"","hideIslandShortcut":"Ctrl+Alt+F8","future":{"keep":true}});
    db.set_setting_value("app_settings", &raw.to_string())
        .unwrap();
    let settings = db.get_settings().unwrap();
    db.save_settings(&settings).unwrap();
    drop(db);
    let db = crate::db::Database::open(&root).unwrap();
    let settings = db.get_settings().unwrap();
    assert_eq!(settings.quick_note_shortcut, "Ctrl+Alt+F7");
    assert!(settings.focus_timer_shortcut.is_empty());
    assert_eq!(settings.hide_island_shortcut, "Ctrl+Alt+F8");
    assert!(settings.quick_download_shortcut.is_empty());
    assert_eq!(settings.toggle_popover_shortcut, "Ctrl+Alt+F6");
    let saved: serde_json::Value =
        serde_json::from_str(&db.setting_value("app_settings").unwrap().unwrap()).unwrap();
    assert_eq!(saved["future"]["keep"], true);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
