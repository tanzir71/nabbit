use super::*;
use crate::island::activity::{Engine, Monitor, Preferences, Time};
fn fixture() -> Snapshot {
    serde_json::from_str(include_str!("../../../tests/fixtures/media/sessions.json")).unwrap()
}
type Emitted = Arc<Mutex<Vec<(Snapshot, Vec<ActivityEvent>)>>>;
fn service() -> (Arc<Service>, Arc<recorded::Recorded>, Emitted) {
    let provider = Arc::new(recorded::Recorded::default());
    provider.replace(fixture());
    let emitted = Arc::new(Mutex::new(vec![]));
    let capture = emitted.clone();
    let service = Service::new(
        provider.clone(),
        Arc::new(move |s, e| capture.lock().unwrap().push((s, e))),
    );
    (service, provider, emitted)
}
#[test]
fn recorded_sessions_select_pause_remove_and_no_timeline_arbitrate() {
    let (service, provider, emitted) = service();
    let mut engine = Engine::new(Preferences::default());
    engine.monitors(
        vec![Monitor {
            label: "island".into(),
            monitor: "primary".into(),
            mode: crate::island::input::Gate::Visible,
            base: crate::island::input::Gate::Visible,
        }],
        Time::default(),
    );
    let initial = service.snapshot();
    assert_eq!(initial.selected.as_deref(), Some("player"));
    assert!(initial.sessions[0].timeline.is_some());
    assert!(initial.sessions[1].timeline.is_none());
    assert!(
        matches!(&emitted.lock().unwrap()[0].1[0],ActivityEvent::MediaChanged {session_id,playing:true,..} if session_id=="player")
    );
    service.select("browser".into()).unwrap();
    assert!(
        matches!(&emitted.lock().unwrap().last().unwrap().1[0],ActivityEvent::MediaRemoved {session_id} if session_id=="player")
    );
    service.toggle().unwrap();
    assert!(service.snapshot().sessions[1].playing);
    for (_, events) in emitted.lock().unwrap().iter() {
        for event in events {
            engine.submit(
                event.clone(),
                None,
                Time {
                    mono_ms: 0,
                    unix_ms: 0,
                },
            );
        }
    }
    assert_eq!(
        engine.snapshot().views[0].primary.as_ref().unwrap().id,
        "media:browser"
    );
    let mut next = fixture();
    next.sessions.remove(1);
    provider.replace(next);
    assert_eq!(service.snapshot().selected.as_deref(), Some("player"));
    provider.replace(Snapshot::default());
    assert!(service.snapshot().sessions.is_empty());
    assert!(service.toggle().is_err());
    assert!(service.select("player".into()).is_err());
}
#[test]
fn cache_reads_never_call_the_provider_and_resume_replaces_subscription() {
    let (service, provider, _) = service();
    for _ in 0..1000 {
        service.snapshot();
    }
    assert_eq!(provider.audit()["actions"], serde_json::json!([]));
    assert_eq!(
        provider.audit()["lifecycle"],
        serde_json::json!(["subscribe"])
    );
    service.resume();
    service.stop();
    assert_eq!(
        provider.audit()["lifecycle"],
        serde_json::json!(["subscribe", "unsubscribe", "subscribe", "unsubscribe"])
    );
    let source = include_str!("windows.rs");
    assert!(source.contains("rx.recv()"));
    for forbidden in [
        "thread::sleep",
        "tokio::time::interval",
        "recv_timeout(Duration::from_millis",
        "GetAsyncKeyState",
    ] {
        assert!(
            !source.contains(forbidden),
            "No provider polling: {forbidden}"
        );
    }
    for event in [
        "SessionsChanged(",
        "CurrentSessionChanged(",
        "MediaPropertiesChanged(",
        "PlaybackInfoChanged(",
        "TimelinePropertiesChanged(",
    ] {
        assert!(source.contains(event));
        assert!(source.contains(&format!("Remove{event}")));
    }
}
#[test]
fn controls_reject_stale_ids_unsupported_seek_nan_and_invalid_volume() {
    let (service, provider, _) = service();
    for action in [
        Action::Next {
            id: "closed".into(),
        },
        Action::Previous {
            id: "browser".into(),
        },
        Action::Seek {
            id: "browser".into(),
            position_s: 10.0,
        },
        Action::Seek {
            id: "player".into(),
            position_s: f64::NAN,
        },
        Action::Seek {
            id: "player".into(),
            position_s: 202.0,
        },
        Action::Volume { percent: 101 },
        Action::VolumeStep {
            direction: 2,
            fine: false,
        },
    ] {
        assert!(service.perform(action).is_err());
    }
    assert_eq!(provider.audit()["actions"], serde_json::json!([]));
    service
        .perform(Action::Seek {
            id: "player".into(),
            position_s: 100.0,
        })
        .unwrap();
    assert_eq!(
        service.snapshot().sessions[0]
            .timeline
            .as_ref()
            .unwrap()
            .position_s,
        100.0
    );
    service
        .perform(Action::VolumeStep {
            direction: 1,
            fine: false,
        })
        .unwrap();
    assert_eq!(service.snapshot().volume.as_ref().unwrap().percent, 66);
    service
        .perform(Action::VolumeStep {
            direction: -1,
            fine: true,
        })
        .unwrap();
    assert_eq!(service.snapshot().volume.as_ref().unwrap().percent, 65);
    service.perform(Action::Mute { muted: true }).unwrap();
    assert!(service.snapshot().volume.as_ref().unwrap().muted);
}
#[test]
fn wheel_accumulates_native_detents_and_round_hit_gate_excludes_transparency() {
    let mut wheel = Wheel::default();
    assert_eq!(wheel.steps(60), 0);
    assert_eq!(wheel.steps(60), 1);
    assert_eq!(wheel.steps(-240), -2);
    assert_eq!(wheel.steps(50), 0);
    assert_eq!(wheel.steps(-120), -1);
    assert_eq!(stepped_volume(99, 1, false), 100);
    assert_eq!(stepped_volume(0, -1, true), 0);
    assert!(pill_hit(136.0, 16.0, 272.0, 32.0, 16.0));
    for (x, y) in [
        (0.0, 0.0),
        (-1.0, 16.0),
        (273.0, 16.0),
        (136.0, 33.0),
        (f64::NAN, 0.0),
    ] {
        assert!(!pill_hit(x, y, 272.0, 32.0, 16.0));
    }
}
#[test]
fn artwork_becomes_bounded_96_pixel_png_and_invalid_data_is_discarded() {
    use base64::Engine;
    let image = image::RgbaImage::from_pixel(300, 200, image::Rgba([230, 80, 40, 255]));
    let mut bytes = std::io::Cursor::new(vec![]);
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    let uri = thumbnail(bytes.get_ref()).unwrap();
    let png = base64::engine::general_purpose::STANDARD
        .decode(uri.strip_prefix("data:image/png;base64,").unwrap())
        .unwrap();
    let decoded = image::load_from_memory(&png).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (96, 96));
    assert!(png.len() < 10000);
    assert!(thumbnail(b"invalid").is_none());
    assert!(thumbnail(&vec![0; 4 * 1024 * 1024 + 1]).is_none());
}

#[test]
fn application_labels_use_player_names_and_are_bounded() {
    assert_eq!(
        application_name("Microsoft.ZuneMusic_fixture!Music"),
        "Media Player"
    );
    assert_eq!(application_name("C:/apps/spotify.exe"), "Spotify");
    assert_eq!(application_name(&"x".repeat(200)).len(), 80);
}
