use super::*;
use crate::island::{
    activity::{Engine, Kind, Monitor, Preferences, Time},
    input::Gate,
};
fn raw(ac: u8, flags: u8, percent: u8) -> RawStatus {
    RawStatus {
        ac_line_status: ac,
        battery_flag: flags,
        battery_life_percent: percent,
    }
}
type Events = Arc<Mutex<Vec<ActivityEvent>>>;
fn fixture() -> (Arc<Service>, Arc<Recorded>, Events) {
    let provider = Arc::new(Recorded::default());
    let events = Arc::new(Mutex::new(vec![]));
    let copy = events.clone();
    let service = Service::new(
        provider.clone(),
        Arc::new(move |_, event| {
            if let Some(event) = event {
                copy.lock().unwrap().push(event)
            }
        }),
    );
    (service, provider, events)
}
fn replace(s: &Service, p: &Recorded, v: RawStatus) {
    p.replace(Ok(v));
    s.refresh();
}
fn at(ms: u64) -> Time {
    Time {
        mono_ms: ms,
        unix_ms: ms as i64,
    }
}
fn engine() -> Engine {
    let mut e = Engine::new(Preferences::default());
    e.monitors(
        vec![Monitor {
            label: "island".into(),
            monitor: "m".into(),
            mode: Gate::Visible,
            base: Gate::Visible,
        }],
        at(0),
    );
    e
}
#[test]
fn raw_sentinels_no_battery_and_charging_flags_are_truthful() {
    assert_eq!(decode(raw(1, 128, 100)), None);
    assert_eq!(decode(raw(255, 255, 255)), None);
    assert_eq!(
        decode(raw(255, 0, 255)),
        Some(Status {
            percent: None,
            charging: false,
            plugged_in: None
        })
    );
    assert_eq!(
        decode(raw(1, 9, 82)),
        Some(Status {
            percent: Some(82),
            charging: true,
            plugged_in: Some(true)
        })
    );
    assert!(!decode(raw(0, 8, 15)).unwrap().charging);
    assert_eq!(decode(raw(0, 0, 101)).unwrap().percent, None);
}
#[test]
fn startup_is_baseline_and_plug_unplug_are_changes_at_any_percent() {
    let (s, p, events) = fixture();
    replace(&s, &p, raw(0, 1, 82));
    assert!(events.lock().unwrap().is_empty());
    replace(&s, &p, raw(1, 9, 82));
    assert!(matches!(
        events.lock().unwrap().last(),
        Some(ActivityEvent::PowerChanged {
            percent: Some(82),
            charging: true,
            plugged_in: Some(true)
        })
    ));
    replace(&s, &p, raw(0, 1, 82));
    assert!(matches!(
        events.lock().unwrap().last(),
        Some(ActivityEvent::PowerChanged {
            percent: Some(82),
            charging: false,
            plugged_in: Some(false)
        })
    ));
    assert_eq!(events.lock().unwrap().len(), 2);
}
#[test]
fn twenty_percent_is_inclusive_and_stable_or_high_updates_are_quiet() {
    let (s, p, events) = fixture();
    replace(&s, &p, raw(0, 0, 22));
    replace(&s, &p, raw(0, 0, 21));
    assert!(events.lock().unwrap().is_empty());
    replace(&s, &p, raw(0, 0, 20));
    replace(&s, &p, raw(0, 0, 20));
    assert_eq!(events.lock().unwrap().len(), 1);
    replace(&s, &p, raw(0, 0, 19));
    assert_eq!(events.lock().unwrap().len(), 2);
    replace(&s, &p, raw(0, 0, 21));
    assert!(matches!(
        events.lock().unwrap().last(),
        Some(ActivityEvent::PowerRemoved)
    ));
    replace(&s, &p, raw(1, 8, 50));
    events.lock().unwrap().clear();
    replace(&s, &p, raw(1, 8, 51));
    assert!(events.lock().unwrap().is_empty());
}
#[test]
fn cache_reads_and_duplicate_notifications_do_not_resample_or_revive_activity() {
    let (s, p, events) = fixture();
    replace(&s, &p, raw(0, 0, 82));
    replace(&s, &p, raw(1, 8, 82));
    let before = p.reads();
    let snapshot = s.snapshot();
    for _ in 0..1000 {
        assert_eq!(s.snapshot(), snapshot)
    }
    assert_eq!(p.reads(), before);
    let event = events.lock().unwrap()[0].clone();
    let mut e = engine();
    e.submit(event.clone(), None, at(0));
    e.submit(event, None, at(3000));
    assert_eq!(e.next_wait_ms(at(3000)), Some(1000));
    e.tick(at(4000));
    assert!(e.snapshot().views[0].primary.is_none());
    assert_eq!(e.next_wait_ms(at(4000)), None);
    s.refresh();
    assert_eq!(events.lock().unwrap().len(), 1);
    assert_eq!(s.snapshot(), snapshot);
}
#[test]
fn full_battery_and_unknown_percent_have_honest_copy() {
    assert_eq!(title(Some(82), false, None), "Battery");
    assert_eq!(title(Some(100), false, Some(true)), "Plugged in");
    assert_eq!(title(Some(82), false, Some(false)), "On battery");
    assert_eq!(title(Some(20), false, Some(false)), "Battery low");
    let (s, p, events) = fixture();
    replace(&s, &p, raw(0, 0, 50));
    replace(&s, &p, raw(1, 8, 255));
    assert!(matches!(
        events.lock().unwrap().last(),
        Some(ActivityEvent::PowerChanged { percent: None, .. })
    ));
    replace(&s, &p, raw(1, 0, 100));
    assert!(!s.snapshot().status.unwrap().charging);
}
#[test]
fn error_absence_and_recovery_remove_stale_activity_without_startup_alert() {
    let (s, p, events) = fixture();
    replace(&s, &p, raw(0, 0, 50));
    replace(&s, &p, raw(1, 8, 50));
    p.replace(Err("OS error".into()));
    s.refresh();
    assert!(s.snapshot().error.is_some());
    assert!(matches!(
        events.lock().unwrap().last(),
        Some(ActivityEvent::PowerRemoved)
    ));
    let count = events.lock().unwrap().len();
    replace(&s, &p, raw(1, 8, 50));
    assert_eq!(events.lock().unwrap().len(), count);
    assert!(s.snapshot().error.is_none());
    replace(&s, &p, raw(1, 128, 255));
    assert!(s.snapshot().status.is_none());
    assert!(matches!(
        events.lock().unwrap().last(),
        Some(ActivityEvent::PowerRemoved)
    ));
}
#[test]
fn queued_hidden_disabled_and_fullscreen_power_expires_on_wall_clock() {
    for hidden in [false, true] {
        let mut e = engine();
        e.submit(
            ActivityEvent::PrivacyChanged {
                mic: vec!["A".into()],
                camera: vec![],
            },
            None,
            at(0),
        );
        e.submit(
            ActivityEvent::TimerTick {
                id: "t".into(),
                remaining_s: 10,
                label: "Focus".into(),
            },
            None,
            at(0),
        );
        if hidden {
            e.submit(
                ActivityEvent::Fullscreen {
                    monitor: "m".into(),
                    active: true,
                },
                None,
                at(0),
            );
        }
        e.submit(
            ActivityEvent::PowerChanged {
                percent: Some(20),
                charging: false,
                plugged_in: Some(false),
            },
            None,
            at(0),
        );
        assert!(e.snapshot().views[0]
            .queue
            .iter()
            .any(|i| i.category == Kind::Power));
        assert_eq!(e.next_wait_ms(at(0)), Some(4000));
        e.tick(at(4000));
        let v = e.snapshot().views.remove(0);
        assert!(!v
            .queue
            .iter()
            .chain(v.primary.iter())
            .chain(v.bubble.iter())
            .any(|i| i.category == Kind::Power));
    }
    let mut e = engine();
    let mut prefs = e.preferences.clone();
    prefs.show_alerts_over_fullscreen = true;
    prefs.disabled = vec![Kind::Power];
    e.submit(
        ActivityEvent::PreferencesChanged { preferences: prefs },
        None,
        at(0),
    );
    e.submit(
        ActivityEvent::PowerChanged {
            percent: Some(20),
            charging: false,
            plugged_in: Some(false),
        },
        None,
        at(0),
    );
    assert!(e.snapshot().views[0].primary.is_none());
    e.tick(at(4000));
    assert_eq!(e.next_wait_ms(at(4000)), None);
}
