use super::*;
use crate::{
    island::{
        activity::{Engine, Monitor, Preferences, Time},
        input::Gate,
    },
    notes::{store::NoteDraft, sync_store::Identity},
};
use serde_json::json;
fn database() -> Database {
    Database::open(
        &std::env::temp_dir().join(format!("nabbit-focus-test-{}", uuid::Uuid::new_v4())),
    )
    .unwrap()
}
fn actor(db: Database, clock: Arc<FixtureClock>) -> (Actor, Arc<Mutex<Vec<ActivityEvent>>>) {
    let model = store::load(&db).unwrap();
    let cache = Arc::new(Mutex::new(snapshot(
        &db,
        &model,
        clock.now_ms(),
        0,
        None,
        None,
    )));
    let events = Arc::new(Mutex::new(vec![]));
    let observed = events.clone();
    (
        Actor {
            db,
            model,
            clock,
            publish: Arc::new(move |_, next| observed.lock().unwrap().extend(next)),
            cache,
            revision: 0,
            coverage: 0,
            viewers: Default::default(),
            shortcut: None,
            error: None,
            last: None,
        },
        events,
    )
}
#[test]
fn utc_deadlines_survive_sleep_and_both_dst_transitions() {
    for (start, end) in [
        ("2026-03-08T01:59:30-05:00", "2026-03-08T03:00:00-04:00"),
        ("2026-11-01T01:59:30-04:00", "2026-11-01T01:00:00-05:00"),
    ] {
        let a = chrono::DateTime::parse_from_rfc3339(start)
            .unwrap()
            .timestamp_millis();
        let b = chrono::DateTime::parse_from_rfc3339(end)
            .unwrap()
            .timestamp_millis();
        let mut m = Model {
            config: Config {
                preset: "custom".into(),
                focus_s: 60,
                break_s: 0,
                rounds: 1,
                ..Config::default()
            },
            ..Model::default()
        };
        m.apply(Action::Start, a, || "test".into()).unwrap();
        assert_eq!(m.session.as_ref().unwrap().remaining_s(b), 30);
        assert_eq!(m.advance(b + 3_600_000), Some("test".into()));
        assert_eq!(m.session.as_ref().unwrap().ended_at_ms, Some(a + 60_000));
        assert_eq!(m.advance(b + 4_000_000), None);
    }
}
#[test]
fn pause_freezes_remaining_and_resume_uses_a_new_utc_deadline() {
    let mut m = Model::default();
    m.apply(Action::Start, 1000, || "s".into()).unwrap();
    m.apply(Action::Pause, 48_000, || unreachable!()).unwrap();
    assert_eq!(m.session.as_ref().unwrap().remaining_s(4_000_000), 1453);
    assert!(m.advance(4_000_000).is_none());
    m.apply(Action::Resume, 4_000_000, || unreachable!())
        .unwrap();
    assert_eq!(m.session.as_ref().unwrap().deadline_ms, Some(5_453_000));
    assert_eq!(
        m.session.as_ref().unwrap().remaining_s(3_000_000),
        2453,
        "A UTC clock rollback recomputes from the persisted deadline"
    );
}
#[test]
fn presets_rounds_and_breaks_require_explicit_start_and_configure_stops() {
    for (preset, focus_s, break_s, rounds) in [
        ("25/5", 1500, 300, 4),
        ("50/10", 3000, 600, 4),
        ("90", 5400, 0, 1),
    ] {
        let c = Config {
            preset: preset.into(),
            focus_s,
            break_s,
            rounds,
            ..Default::default()
        };
        assert!(c.validate().is_ok());
    }
    let mut m = Model::default();
    m.apply(Action::Start, 0, || "focus1".into()).unwrap();
    m.advance(1_500_000);
    assert_eq!(m.session.as_ref().unwrap().status, Status::Ended);
    m.apply(Action::Start, 1_600_000, || "break1".into())
        .unwrap();
    assert_eq!(m.session.as_ref().unwrap().phase, Phase::Break);
    m.advance(1_900_000);
    m.apply(Action::Start, 2_000_000, || "focus2".into())
        .unwrap();
    assert_eq!(m.session.as_ref().unwrap().round, 2);
    m.apply(
        Action::Configure {
            config: Config {
                preset: "90".into(),
                focus_s: 5400,
                break_s: 0,
                rounds: 1,
                ..Default::default()
            },
        },
        2_000_010,
        || unreachable!(),
    )
    .unwrap();
    assert!(m.session.is_none());
    for bad in [
        Config {
            focus_s: 0,
            ..Default::default()
        },
        Config {
            rounds: 13,
            ..Default::default()
        },
        Config {
            preset: "unknown".into(),
            ..Default::default()
        },
        Config {
            label: "".into(),
            ..Default::default()
        },
    ] {
        assert!(bad.validate().is_err());
    }
}
#[test]
fn restart_retains_running_paused_and_completion_and_history_is_local() {
    let db = database();
    let clock = Arc::new(FixtureClock(AtomicI64::new(1_000_000)));
    let (mut a, events) = actor(db.clone(), clock.clone());
    a.action(Action::Start).unwrap();
    let id = a.model.session.as_ref().unwrap().id.clone();
    clock.0.store(1_047_000, Ordering::Relaxed);
    let (mut restarted, _) = actor(
        Database::open(db.path().parent().unwrap()).unwrap(),
        clock.clone(),
    );
    restarted.refresh();
    assert_eq!(restarted.cached().session.unwrap().remaining_s, 1453);
    restarted.action(Action::Pause).unwrap();
    clock.0.store(9_000_000, Ordering::Relaxed);
    let (mut paused, _) = actor(db.clone(), clock.clone());
    paused.refresh();
    assert_eq!(paused.cached().session.unwrap().remaining_s, 1453);
    paused.action(Action::Resume).unwrap();
    clock.0.store(11_000_000, Ordering::Relaxed);
    let (mut expired, expired_events) = actor(db.clone(), clock.clone());
    expired.refresh();
    expired.refresh();
    assert_eq!(expired.cached().session.unwrap().status, Status::Ended);
    assert_eq!(
        expired_events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, ActivityEvent::TimerEnded { .. }))
            .count(),
        1
    );
    let (mut again, again_events) = actor(db.clone(), clock);
    again.refresh();
    assert!(!again_events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, ActivityEvent::TimerEnded { .. })));
    let conn = db.conn.lock().unwrap();
    let row: (String, String) = conn
        .query_row(
            "SELECT outcome,ended_at FROM focus_sessions WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row.0, "completed");
    assert_eq!(row.1, "1970-01-01T02:54:13.000Z");
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, ActivityEvent::TimerTick { .. })));
    let queued: i64 = conn
        .query_row("SELECT count(*) FROM tack_outbox", [], |r| r.get(0))
        .unwrap();
    assert_eq!(queued, 0, "Timer history is never Tack time logging");
}
#[test]
fn scheduler_has_no_idle_or_paused_tick_and_only_visible_second_boundaries() {
    let db = database();
    let clock = Arc::new(FixtureClock(AtomicI64::new(1000)));
    let (mut a, _) = actor(db, clock.clone());
    assert_eq!(a.wait_ms(), None);
    a.action(Action::Start).unwrap();
    assert_eq!(a.wait_ms(), Some(1_500_000));
    a.coverage = 2;
    assert_eq!(
        a.wait_ms(),
        Some(1_441_000),
        "One priority transition for an eligible queued timer"
    );
    a.coverage = 1;
    clock.0.store(1480, Ordering::Relaxed);
    assert_eq!(a.wait_ms(), Some(520));
    a.action(Action::Pause).unwrap();
    assert_eq!(a.wait_ms(), None);
    a.action(Action::Resume).unwrap();
    a.coverage = 0;
    a.viewers.insert(("island".into(), "timer-1".into()));
    assert!(a.wait_ms().unwrap() <= 1000);
    a.viewers.clear();
    assert_eq!(a.wait_ms(), Some(1_499_520));
}
#[test]
fn link_is_guarded_by_workspace_and_never_exposes_a_foreign_card() {
    let db = database();
    let first = db
        .tack_activate(&Identity {
            base_url: "https://fixture.invalid/".into(),
            user_id: "fixture-user".into(),
            workspace_id: "one".into(),
        })
        .unwrap();
    let card = db
        .create_note_card_in(
            NoteDraft {
                title: "Linked task".into(),
                ..Default::default()
            },
            Some(&first),
        )
        .unwrap();
    let id = card.value["id"].as_str().unwrap().to_string();
    {
        let conn = db.conn.lock().unwrap();
        let mut v = card.value;
        v["ref"] = json!("tck-24");
        conn.execute(
            "UPDATE note_cards SET value=?1 WHERE id=?2",
            rusqlite::params![v.to_string(), id],
        )
        .unwrap();
    }
    let clock = Arc::new(FixtureClock(AtomicI64::new(1000)));
    let (mut a, _) = actor(db.clone(), clock);
    let binding = CardLink {
        id,
        expected_scope: Some(first),
    };
    a.action(Action::Link {
        card: Some(binding.clone()),
    })
    .unwrap();
    assert_eq!(a.cached().linked_card.unwrap().reference, "tck-24");
    a.action(Action::Start).unwrap();
    db.tack_activate(&Identity {
        base_url: "https://fixture.invalid/".into(),
        user_id: "fixture-user".into(),
        workspace_id: "two".into(),
    })
    .unwrap();
    a.refresh();
    assert!(a.cached().link_unavailable);
    assert!(a.cached().linked_card.is_none());
    assert_eq!(a.cached().session.unwrap().status, Status::Running);
    let generation = a.model.generation;
    assert!(a
        .action(Action::Link {
            card: Some(binding)
        })
        .is_err());
    assert_eq!(a.model.generation, generation);
}
#[test]
fn completion_alert_is_queued_under_fullscreen_and_respects_the_exception() {
    let clock = Arc::new(FixtureClock(AtomicI64::new(0)));
    let (mut a, events) = actor(database(), clock.clone());
    a.action(Action::Start).unwrap();
    clock.0.store(1_600_000, Ordering::Relaxed);
    a.refresh();
    let mut engine = Engine::new(Preferences::default());
    engine.monitors(
        vec![Monitor {
            label: "island".into(),
            monitor: "primary".into(),
            mode: Gate::Hidden,
            base: Gate::Hidden,
        }],
        Time::default(),
    );
    for e in events.lock().unwrap().clone() {
        engine.submit(e, None, Time::default());
    }
    assert_eq!(engine.snapshot().views[0].gate, Gate::Hidden);
    let mut preferences = engine.preferences.clone();
    preferences.show_alerts_over_fullscreen = true;
    engine.submit(
        ActivityEvent::PreferencesChanged { preferences },
        None,
        Time::default(),
    );
    assert_eq!(engine.snapshot().views[0].gate, Gate::Visible);
    assert!(matches!(
        engine.snapshot().views[0].primary.as_ref().unwrap().event,
        ActivityEvent::TimerEnded { .. }
    ));
}
#[test]
fn service_guards_stale_actions_and_hotkey_toggles_without_os_input() {
    let clock = Arc::new(FixtureClock(AtomicI64::new(1000)));
    let service = Service::new(database(), clock, Arc::new(|_, _| {})).unwrap();
    let ready = service.read().unwrap();
    let running = service.toggle().unwrap();
    assert_eq!(running.session.unwrap().status, Status::Running);
    assert!(service
        .action(Request {
            expected_generation: ready.generation,
            action: Action::Stop
        })
        .is_err());
    assert_eq!(
        service.toggle().unwrap().session.unwrap().status,
        Status::Paused
    );
    assert_eq!(
        service.toggle().unwrap().session.unwrap().status,
        Status::Running
    );
    service.stop();
    let settings = crate::db::models::AppSettings {
        island_shortcut: SHORTCUT.into(),
        ..Default::default()
    };
    assert!(crate::island::keyboard::validate_shortcut(&settings).is_err());
}
#[test]
fn native_coverage_excludes_a_pill_owned_by_a_larger_webview() {
    let clock = Arc::new(FixtureClock(AtomicI64::new(1000)));
    let service = Service::new(database(), clock, Arc::new(|_, _| {})).unwrap();
    let mut engine = Engine::new(Preferences::default());
    engine.monitors(
        vec![Monitor {
            label: "island".into(),
            monitor: "primary".into(),
            mode: Gate::Visible,
            base: Gate::Visible,
        }],
        Time::default(),
    );
    engine.submit(
        ActivityEvent::TimerTick {
            id: "s".into(),
            remaining_s: 100,
            label: "Focus".into(),
        },
        None,
        Time::default(),
    );
    let snapshot = engine.snapshot();
    service.observe(&snapshot);
    assert_eq!(service.coverage.load(Ordering::Relaxed), 3);
    service.native_hosts(Default::default(), &snapshot);
    assert_eq!(
        service.coverage.load(Ordering::Relaxed),
        2,
        "No visible countdown underneath a larger WebView"
    );
    service.native_hosts(["island".to_string()].into_iter().collect(), &snapshot);
    assert_eq!(service.coverage.load(Ordering::Relaxed), 3);
    service.stop();
}
#[test]
fn failed_completion_write_preserves_the_running_deadline_and_retries_without_spinning() {
    let db = database();
    let clock = Arc::new(FixtureClock(AtomicI64::new(1000)));
    let (mut a, events) = actor(db.clone(), clock.clone());
    a.action(Action::Start).unwrap();
    db.conn
        .lock()
        .unwrap()
        .execute_batch("PRAGMA query_only=ON")
        .unwrap();
    clock.0.store(2_000_000, Ordering::Relaxed);
    a.refresh();
    assert!(a.cached().error.is_some());
    assert_eq!(a.model.session.as_ref().unwrap().status, Status::Running);
    assert_eq!(a.wait_ms(), Some(1000));
    assert!(!events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, ActivityEvent::TimerEnded { .. })));
    db.conn
        .lock()
        .unwrap()
        .execute_batch("PRAGMA query_only=OFF")
        .unwrap();
    a.refresh();
    assert!(a.cached().error.is_none());
    assert_eq!(a.model.session.as_ref().unwrap().status, Status::Ended);
}
