use super::*;
use model::*;
fn fixture() -> RegistrySnapshot {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/privacy/registry.json"
    ))
    .unwrap()
}
#[test]
fn packaged_nonpackaged_teams_virtual_camera_and_stale_records() {
    let active = resolve(&fixture());
    assert_eq!(active.mic, ["Microsoft Teams", "Recorder"]);
    assert_eq!(active.camera, ["Virtual Camera Host"]);
    assert_eq!(active.pids, [42, 43, 44]);
}
#[test]
fn process_reuse_and_full_identity_are_required() {
    let mut v = fixture();
    for p in &mut v.processes {
        p.created_at = 9999;
    }
    assert_eq!(resolve(&v), Active::default());
    let mut v = fixture();
    for p in &mut v.processes {
        p.image = "D:\\Other\\Teams.exe".into();
        p.package_family = Some("Other_family".into());
    }
    assert_eq!(resolve(&v), Active::default());
}
#[test]
fn missing_or_malformed_timestamps_never_mean_in_use() {
    for start in [None, Some(0)] {
        let mut v = fixture();
        for e in &mut v.entries {
            e.last_used_time_start = start;
        }
        assert_eq!(resolve(&v), Active::default());
    }
    for stop in [None, Some(1000)] {
        let mut v = fixture();
        for e in &mut v.entries {
            e.last_used_time_stop = stop;
        }
        assert_eq!(resolve(&v), Active::default());
    }
}
#[test]
fn names_are_bounded_deduplicated_and_records_may_be_nested() {
    let mut v = fixture();
    v.entries.push(v.entries[0].clone());
    v.entries[0].key.push_str("\\Device\\Virtual");
    assert_eq!(resolve(&v).mic, ["Microsoft Teams", "Recorder"]);
    v.processes[0].display_name = format!("  {}\n", "x".repeat(200));
    assert!(resolve(&v).mic.iter().any(|n| n.len() <= 120));
}
#[test]
fn subscribed_service_pushes_changes_clears_crashes_and_reads_only_cache() {
    let provider = Arc::new(recorded::Recorded::default());
    let outputs = Arc::new(Mutex::new(vec![]));
    let copy = outputs.clone();
    let service = Service::new(
        provider.clone(),
        Arc::new(move |s, e| copy.lock().unwrap().push((s, e))),
    );
    provider.replace(Ok(fixture()));
    assert_eq!(outputs.lock().unwrap().len(), 1);
    for _ in 0..1000 {
        assert_eq!(service.snapshot().mic.len(), 2);
    }
    assert_eq!(provider.audit()["subscriptions"], 1);
    assert_eq!(provider.audit()["polls"], 0);
    provider.replace(Ok(fixture()));
    assert_eq!(outputs.lock().unwrap().len(), 1);
    let mut dead = fixture();
    for p in &mut dead.processes {
        p.alive = false;
    }
    provider.replace(Ok(dead));
    assert!(service.snapshot().mic.is_empty());
    assert!(
        matches!(&outputs.lock().unwrap()[1].1,ActivityEvent::PrivacyChanged{mic,camera} if mic.is_empty() && camera.is_empty())
    );
    provider.replace(Err("Unavailable".into()));
    assert_eq!(service.snapshot().error.as_deref(), Some("Unavailable"));
    provider.replace(Ok(fixture()));
    assert!(service.snapshot().error.is_none());
    service.resume();
    assert_eq!(provider.audit()["resumes"], 1);
    service.stop();
    provider.replace(Ok(Default::default()));
    assert_eq!(service.snapshot().mic.len(), 2);
    assert_eq!(provider.audit()["stops"], 1);
}
#[test]
fn privacy_is_top_priority_and_respects_hidden_policy() {
    use crate::island::{activity::*, input::Gate};
    let mut engine = Engine::new(Preferences::default());
    let now = Time {
        mono_ms: 0,
        unix_ms: 0,
    };
    engine.monitors(
        vec![Monitor {
            monitor: "m".into(),
            label: "island".into(),
            mode: Gate::Visible,
            base: Gate::Visible,
        }],
        now,
    );
    engine.submit(
        ActivityEvent::TimerTick {
            id: "t".into(),
            remaining_s: 10,
            label: "Focus".into(),
        },
        None,
        now,
    );
    let active = resolve(&fixture());
    engine.submit(
        ActivityEvent::PrivacyChanged {
            mic: active.mic,
            camera: active.camera,
        },
        None,
        now,
    );
    assert_eq!(
        engine.snapshot().views[0]
            .primary
            .as_ref()
            .unwrap()
            .category,
        Kind::Privacy
    );
    engine.submit(
        ActivityEvent::Fullscreen {
            monitor: "m".into(),
            active: true,
        },
        None,
        now,
    );
    assert_eq!(engine.snapshot().views[0].gate, Gate::Hidden);
    engine.submit(
        ActivityEvent::PrivacyChanged {
            mic: vec![],
            camera: vec![],
        },
        None,
        now,
    );
    let snapshot = engine.snapshot();
    assert!(snapshot.views[0]
        .primary
        .as_ref()
        .is_none_or(|v| v.category != Kind::Privacy));
    assert!(snapshot.views[0]
        .queue
        .iter()
        .all(|v| v.category != Kind::Privacy));
}
