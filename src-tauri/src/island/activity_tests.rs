use super::activity::*;
use super::input::Gate;
fn at(ms: u64) -> Time {
    Time {
        mono_ms: ms,
        unix_ms: ms as i64,
    }
}
fn facts(label: &str, mode: Gate) -> Monitor {
    Monitor {
        label: label.into(),
        monitor: label.into(),
        mode,
        base: mode,
    }
}
fn engine(mode: Gate) -> Engine {
    let mut e = Engine::new(Preferences::default());
    e.monitors(vec![facts("island", mode)], at(0));
    e
}
fn send(e: &mut Engine, event: ActivityEvent, ms: u64) {
    e.submit(event, None, at(ms));
}
fn download(id: &str) -> ActivityEvent {
    ActivityEvent::DownloadProgress {
        job_id: id.into(),
        title: id.into(),
        percent: 30.0,
        speed: None,
        eta: None,
    }
}
fn note(id: &str) -> ActivityEvent {
    ActivityEvent::NoteSaved {
        card_id: id.into(),
        destination: "Local".into(),
    }
}
fn view(e: &Engine) -> View {
    e.snapshot().views[0].clone()
}
#[test]
fn moved_result_has_eight_seconds_of_visible_undo_and_respects_hidden_policy() {
    let mut e = engine(Gate::Visible);
    let event = ActivityEvent::FilesMoved {
        op_id: "owned".into(),
        count: 3,
        destination: "Invoices".into(),
        verb: MoveVerb::Moved,
        undoable: true,
    };
    send(&mut e, event.clone(), 0);
    assert_eq!(e.next_wait_ms(at(0)), Some(8000));
    send(&mut e, event, 2000);
    e.tick(at(7999));
    assert!(view(&e).primary.is_some());
    e.tick(at(8000));
    assert!(view(&e).primary.is_none());
    e.monitors(vec![facts("island", Gate::Hidden)], at(9000));
    send(
        &mut e,
        ActivityEvent::FilesMoved {
            op_id: "hidden".into(),
            count: 1,
            destination: "Folder".into(),
            verb: MoveVerb::Copied,
            undoable: true,
        },
        9000,
    );
    assert_eq!(e.next_wait_ms(at(9000)), None);
    assert_eq!(view(&e).gate, Gate::Hidden);
}
#[test]
fn link_metadata_preserves_age_and_cannot_revive_dismissed_or_replaced_links() {
    let mut e = engine(Gate::Visible);
    let link = |url: &str| ActivityEvent::LinkDetected {
        url: url.into(),
        title: None,
        duration: None,
        site: "example.com".into(),
    };
    send(&mut e, link("https://example.com/one"), 0);
    e.enrich_link("https://example.com/one", "Title", Some(768))
        .unwrap();
    assert_eq!(e.next_wait_ms(at(7000)), Some(1000));
    send(&mut e, link("https://example.com/two"), 7000);
    assert!(e
        .enrich_link("https://example.com/one", "Old", None)
        .is_none());
    send(&mut e, ActivityEvent::Dismissed { id: "link".into() }, 7100);
    assert!(e
        .enrich_link("https://example.com/two", "New", None)
        .is_none());
    assert!(view(&e).primary.is_none());
}
fn categories(view: &View) -> Vec<Kind> {
    view.primary
        .iter()
        .chain(view.bubble.iter())
        .chain(view.queue.iter())
        .map(|item| item.category)
        .collect()
}
#[test]
fn default_priority_split_and_replacement_cover_all_activity_categories() {
    let mut e = engine(Gate::Visible);
    for event in [
        ActivityEvent::PowerChanged {
            percent: Some(10),
            charging: false,
            plugged_in: Some(false),
        },
        ActivityEvent::TimerTick {
            id: "long".into(),
            remaining_s: 60,
            label: "Focus".into(),
        },
        ActivityEvent::MediaChanged {
            session_id: "m".into(),
            title: "Song".into(),
            artist: "Artist".into(),
            playing: true,
            timeline: None,
            art: None,
        },
        note("n"),
        ActivityEvent::LinkDetected {
            url: "https://example.invalid".into(),
            title: None,
            duration: None,
            site: "fixture".into(),
        },
        ActivityEvent::ToolJob {
            job_id: "t".into(),
            tool_id: "fit".into(),
            label: "Fit".into(),
            percent: 10.0,
            state: JobState::Running,
        },
        download("d"),
        ActivityEvent::TimerTick {
            id: "short".into(),
            remaining_s: 59,
            label: "Focus".into(),
        },
        ActivityEvent::PrivacyChanged {
            mic: vec!["Fixture".into()],
            camera: vec![],
        },
    ] {
        send(&mut e, event, 0);
    }
    let v = view(&e);
    assert_eq!(categories(&v), ORDER);
    assert_eq!(v.queue.len(), 7);
    for _ in 0..500 {
        send(&mut e, download("d"), 1);
    }
    assert_eq!(categories(&view(&e)).len(), 9);
    send(
        &mut e,
        ActivityEvent::DownloadRemoved { job_id: "d".into() },
        2,
    );
    assert!(!categories(&view(&e)).contains(&Kind::Download));
    send(
        &mut e,
        ActivityEvent::PrivacyChanged {
            mic: vec![],
            camera: vec![],
        },
        3,
    );
    assert_eq!(view(&e).primary.unwrap().category, Kind::TimerEnding);
}
#[test]
fn queued_and_hidden_alerts_get_four_seconds_of_actual_primary_or_bubble_exposure() {
    let mut e = engine(Gate::Visible);
    send(
        &mut e,
        ActivityEvent::PrivacyChanged {
            mic: vec!["Fixture".into()],
            camera: vec![],
        },
        0,
    );
    send(&mut e, download("d"), 0);
    send(&mut e, note("n"), 0);
    e.tick(at(60_000));
    assert_eq!(view(&e).queue.len(), 1);
    send(
        &mut e,
        ActivityEvent::PrivacyChanged {
            mic: vec![],
            camera: vec![],
        },
        60_000,
    );
    assert!(view(&e).bubble.unwrap().alert);
    e.tick(at(63_999));
    assert!(view(&e).bubble.is_some());
    e.tick(at(64_000));
    assert!(view(&e).bubble.is_none());
    e.monitors(vec![facts("island", Gate::Hidden)], at(70_000));
    send(&mut e, note("hidden"), 70_000);
    assert_eq!(e.next_wait_ms(at(70_000)), None);
    e.tick(at(90_000));
    assert_eq!(view(&e).queue.len(), 2);
    assert_eq!(view(&e).gate, Gate::Hidden);
    e.monitors(vec![facts("island", Gate::Visible)], at(90_000));
    assert_eq!(e.next_wait_ms(at(90_000)), Some(4000));
    e.tick(at(94_000));
    assert!(view(&e).bubble.is_none());
}
#[test]
fn fullscreen_exception_is_opt_in_and_only_timer_end_and_download_failure() {
    let mut e = engine(Gate::Hidden);
    for event in [
        note("n"),
        ActivityEvent::DownloadDone {
            job_id: "done".into(),
            path: "out.mp4".into(),
        },
        ActivityEvent::TimerEnded { id: "timer".into() },
        ActivityEvent::DownloadFailed {
            job_id: "failed".into(),
            error: ErrorKind::Offline,
        },
    ] {
        send(&mut e, event, 0);
    }
    assert_eq!(view(&e).gate, Gate::Hidden);
    assert_eq!(view(&e).queue.len(), 4);
    let mut preferences = e.preferences.clone();
    preferences.show_alerts_over_fullscreen = true;
    send(
        &mut e,
        ActivityEvent::PreferencesChanged { preferences },
        10_000,
    );
    let v = view(&e);
    assert_eq!(v.gate, Gate::Visible);
    assert!(matches!(
        v.primary.unwrap().event,
        ActivityEvent::TimerEnded { .. }
    ));
    assert!(matches!(
        v.bubble.unwrap().event,
        ActivityEvent::DownloadFailed { .. }
    ));
    assert_eq!(v.queue.len(), 2);
    e.tick(at(100_000));
    assert!(matches!(
        view(&e).primary.unwrap().event,
        ActivityEvent::DownloadFailed { .. }
    ));
    send(
        &mut e,
        ActivityEvent::Dismissed {
            id: "downloadFailed:failed".into(),
        },
        100_001,
    );
    assert_eq!(view(&e).gate, Gate::Hidden);
    e.monitors(vec![facts("island", Gate::Visible)], at(100_002));
    assert!(view(&e).primary.unwrap().alert);
}
#[test]
fn one_hour_hide_focus_and_wall_clock_changes_do_not_release_fullscreen_or_expire_queued_alerts() {
    let mut e = engine(Gate::Visible);
    let mut preferences = e.preferences.clone();
    preferences.hidden_until_ms = Some(3_600_000);
    send(&mut e, ActivityEvent::PreferencesChanged { preferences }, 0);
    send(&mut e, note("n"), 0);
    assert_eq!(e.next_wait_ms(at(0)), Some(3_600_000));
    e.tick(Time {
        mono_ms: 999,
        unix_ms: 3_599_999,
    });
    assert_eq!(view(&e).gate, Gate::Hidden);
    // Wall-clock jump/resume is independent of the monotonic alert clock.
    e.tick(Time {
        mono_ms: 1000,
        unix_ms: 3_600_000,
    });
    assert_eq!(view(&e).gate, Gate::Visible);
    assert!(view(&e).primary.unwrap().alert);
    assert_eq!(
        e.next_wait_ms(Time {
            mono_ms: 1000,
            unix_ms: 3_600_000
        }),
        Some(4000)
    );
    let mut preferences = e.preferences.clone();
    preferences.focus_mode = true;
    send(
        &mut e,
        ActivityEvent::PreferencesChanged { preferences },
        3_600_001,
    );
    assert_eq!(view(&e).gate, Gate::Hidden);
    let mut preferences = e.preferences.clone();
    preferences.focus_mode = false;
    preferences.hidden_until_ms = None;
    send(
        &mut e,
        ActivityEvent::PreferencesChanged { preferences },
        3_600_002,
    );
    e.monitors(vec![facts("island", Gate::Hidden)], at(3_600_003));
    assert_eq!(view(&e).gate, Gate::Hidden);
}
#[test]
fn link_shrinks_at_eight_seconds_and_clipboard_change_removes_its_bubble() {
    let mut e = engine(Gate::Visible);
    send(
        &mut e,
        ActivityEvent::LinkDetected {
            url: "https://example.invalid".into(),
            title: None,
            duration: None,
            site: "fixture".into(),
        },
        0,
    );
    e.tick(at(7999));
    assert_eq!(view(&e).primary.unwrap().category, Kind::Link);
    e.tick(at(8000));
    assert!(view(&e).primary.is_none());
    assert!(view(&e).bubble.unwrap().bubble_only);
    assert_eq!(e.next_wait_ms(at(8000)), None);
    send(&mut e, ActivityEvent::ClipboardChanged, 8001);
    assert!(view(&e).bubble.is_none());
}
#[test]
fn errors_stay_until_dismissed_and_retry_replaces_the_error() {
    let mut e = engine(Gate::Visible);
    send(
        &mut e,
        ActivityEvent::DownloadFailed {
            job_id: "d".into(),
            error: ErrorKind::Disk,
        },
        0,
    );
    e.tick(at(10_000_000));
    assert!(view(&e).primary.unwrap().alert);
    assert_eq!(e.next_wait_ms(at(10_000_000)), None);
    send(&mut e, download("d"), 10_000_001);
    assert!(!view(&e).primary.unwrap().alert);
    send(
        &mut e,
        ActivityEvent::DownloadFailed {
            job_id: "d".into(),
            error: ErrorKind::Unknown,
        },
        10_000_002,
    );
    send(
        &mut e,
        ActivityEvent::Dismissed {
            id: "downloadFailed:d".into(),
        },
        10_000_003,
    );
    assert!(view(&e).primary.is_none());
}
#[test]
fn mixed_monitor_alert_exposure_is_global_without_replaying_already_seen_alerts() {
    let mut e = engine(Gate::Hidden);
    e.monitors(
        vec![facts("island", Gate::Hidden), facts("left", Gate::Visible)],
        at(0),
    );
    send(&mut e, note("n"), 0);
    let s = e.snapshot();
    assert_eq!(s.views[0].gate, Gate::Hidden);
    assert!(s.views[1].primary.is_some());
    e.tick(at(4000));
    e.monitors(
        vec![facts("island", Gate::Visible), facts("left", Gate::Visible)],
        at(5000),
    );
    assert!(e.snapshot().views.iter().all(|v| v.primary.is_none()));
}
#[test]
fn order_disable_fade_and_cleanup_are_deterministic() {
    let mut e = engine(Gate::Faded);
    assert_eq!(view(&e).gate, Gate::Faded);
    send(&mut e, download("d"), 0);
    assert_eq!(view(&e).gate, Gate::Visible);
    send(
        &mut e,
        ActivityEvent::PowerChanged {
            percent: Some(12),
            charging: false,
            plugged_in: Some(false),
        },
        0,
    );
    let preferences = Preferences {
        order: vec![Kind::Power, Kind::Power],
        disabled: vec![Kind::Download, Kind::Download],
        ..Preferences::default()
    };
    send(&mut e, ActivityEvent::PreferencesChanged { preferences }, 1);
    assert_eq!(e.preferences.order.len(), ORDER.len());
    assert_eq!(e.preferences.disabled.len(), 1);
    assert_eq!(view(&e).primary.unwrap().category, Kind::Power);
    send(&mut e, ActivityEvent::PowerRemoved, 2);
    assert_eq!(view(&e).gate, Gate::Faded);
    send(
        &mut e,
        ActivityEvent::SyncState {
            state: SyncStatus::Offline,
        },
        3,
    );
    assert_eq!(e.snapshot().sync_state, SyncStatus::Offline);
    assert!(view(&e).primary.is_none());
}
#[test]
fn producer_lifecycles_remove_finished_tools_media_timers_and_preserve_result_payloads() {
    let mut e = engine(Gate::Visible);
    send(
        &mut e,
        ActivityEvent::ToolJob {
            job_id: "t".into(),
            tool_id: "fit".into(),
            label: "Fit".into(),
            percent: 1.0,
            state: JobState::Running,
        },
        0,
    );
    send(
        &mut e,
        ActivityEvent::ToolResult {
            job_id: "t".into(),
            path: "result.mp4".into(),
            before_bytes: 100,
            after_bytes: 50,
            note: None,
        },
        1,
    );
    assert_eq!(view(&e).primary.unwrap().id, "toolResult:t");
    e.tick(at(4001));
    assert!(view(&e).primary.is_none());
    send(
        &mut e,
        ActivityEvent::MediaChanged {
            session_id: "m".into(),
            title: "Song".into(),
            artist: "A".into(),
            playing: true,
            timeline: None,
            art: None,
        },
        4002,
    );
    send(
        &mut e,
        ActivityEvent::MediaChanged {
            session_id: "m".into(),
            title: "Song".into(),
            artist: "A".into(),
            playing: false,
            timeline: None,
            art: None,
        },
        4003,
    );
    assert!(view(&e).primary.is_none());
    send(
        &mut e,
        ActivityEvent::TimerTick {
            id: "f".into(),
            remaining_s: 60,
            label: "Focus".into(),
        },
        4004,
    );
    assert_eq!(view(&e).primary.unwrap().category, Kind::Timer);
    send(
        &mut e,
        ActivityEvent::TimerTick {
            id: "f".into(),
            remaining_s: 59,
            label: "Focus".into(),
        },
        4005,
    );
    assert_eq!(view(&e).primary.unwrap().category, Kind::TimerEnding);
    send(&mut e, ActivityEvent::TimerEnded { id: "f".into() }, 4006);
    assert!(view(&e).primary.unwrap().alert);
    assert!(view(&e).bubble.is_none());
}
#[test]
fn idle_has_no_deadline_and_repeated_unchanged_monitor_samples_emit_nothing() {
    let mut e = engine(Gate::Visible);
    let revision = e.snapshot().revision;
    for ms in 1..1000 {
        assert!(e
            .monitors(vec![facts("island", Gate::Visible)], at(ms))
            .is_none());
        assert_eq!(e.next_wait_ms(at(ms)), None);
    }
    assert_eq!(e.snapshot().revision, revision);
    e.monitors(vec![], at(1000));
    send(&mut e, note("n"), 1000);
    assert_eq!(e.next_wait_ms(at(1000)), None);
}
#[test]
fn disabled_alerts_are_not_replayed_when_the_category_is_reenabled() {
    let mut e = engine(Gate::Hidden);
    send(&mut e, note("old"), 0);
    let mut preferences = e.preferences.clone();
    preferences.disabled = vec![Kind::Result];
    send(&mut e, ActivityEvent::PreferencesChanged { preferences }, 1);
    send(&mut e, note("disabled"), 2);
    let preferences = Preferences::default();
    send(&mut e, ActivityEvent::PreferencesChanged { preferences }, 3);
    e.monitors(vec![facts("island", Gate::Visible)], at(4));
    assert!(view(&e).primary.is_none());
    assert!(view(&e).queue.is_empty());
    assert_eq!(e.next_wait_ms(at(4)), None);
}
#[test]
fn events_use_the_camel_case_contract_and_keep_target_and_revision() {
    let mut e = engine(Gate::Visible);
    let message = e.submit(download("d"), Some("island".into()), at(0));
    let value = serde_json::to_value(message).unwrap();
    assert_eq!(value["kind"], "downloadProgress");
    assert_eq!(value["jobId"], "d");
    assert!(value.get("job_id").is_none());
    assert_eq!(value["target"], "island");
    assert!(value["snapshot"]["revision"].as_u64().unwrap() > 0);
    for event in [
        ActivityEvent::FilesMoved {
            op_id: "op".into(),
            count: 2,
            destination: "Folder".into(),
            verb: MoveVerb::Copied,
            undoable: true,
        },
        ActivityEvent::LinkSaved {
            card_id: "c".into(),
            title: "Link".into(),
        },
        ActivityEvent::DownloadFailed {
            job_id: "d".into(),
            error: ErrorKind::SignInRequired,
        },
        ActivityEvent::DragEnter {
            kinds: vec![DragKind::Url, DragKind::File, DragKind::Text],
        },
        ActivityEvent::DragLeave,
    ] {
        let raw = serde_json::to_value(&event).unwrap();
        assert_eq!(serde_json::from_value::<ActivityEvent>(raw).unwrap(), event);
    }
}
