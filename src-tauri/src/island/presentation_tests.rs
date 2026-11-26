use super::{
    activity::*,
    input::{FadeInput, Gate},
    model::Shape,
    presentation::{compact, Draw},
    surface::{DropPayload, Mode, Session},
};
fn clock(ms: u64) -> Time {
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
            monitor: "primary".into(),
            base: Gate::Visible,
            mode: Gate::Visible,
        }],
        clock(0),
    );
    e
}
#[test]
fn idle_and_notch_keep_fixed_reference_geometry() {
    let idle = compact(None, Shape::Island);
    assert_eq!(
        (idle.width, idle.height, idle.top, idle.radius),
        (112.0, 26.0, 6.0, 13.0)
    );
    assert!(idle.primary.is_empty());
    let notch = compact(None, Shape::Notch);
    assert_eq!(
        (notch.width, notch.height, notch.top, notch.radius),
        (168.0, 24.0, 0.0, 12.0)
    );
    assert!(notch.notch);
}
#[test]
fn every_v2_compact_payload_has_visible_drawing_and_bounded_text() {
    let cases = vec![
        ActivityEvent::LinkDetected {
            url: "https://example.invalid".into(),
            title: None,
            duration: Some(768),
            site: "example.invalid".into(),
        },
        ActivityEvent::DownloadProgress {
            job_id: "d".into(),
            title: "A long title that must ellipsize instead of changing the host".into(),
            percent: 38.0,
            speed: None,
            eta: None,
        },
        ActivityEvent::DownloadDone {
            job_id: "d".into(),
            path: "C:\\Capture\\video.mp4".into(),
        },
        ActivityEvent::DownloadFailed {
            job_id: "d".into(),
            error: ErrorKind::Unknown,
        },
        ActivityEvent::MediaChanged {
            session_id: "m".into(),
            title: "Night Drive".into(),
            artist: "Kiln".into(),
            playing: true,
            timeline: None,
            art: None,
        },
        ActivityEvent::TimerTick {
            id: "t".into(),
            remaining_s: 1453,
            label: "Focus".into(),
        },
        ActivityEvent::TimerEnded { id: "t".into() },
        ActivityEvent::PrivacyChanged {
            mic: vec!["Fixture".into()],
            camera: vec![],
        },
        ActivityEvent::PowerChanged {
            percent: 82,
            charging: true,
        },
        ActivityEvent::NoteSaved {
            card_id: "n".into(),
            destination: "Inbox".into(),
        },
        ActivityEvent::LinkSaved {
            card_id: "n".into(),
            title: "A saved link".into(),
        },
        ActivityEvent::FilesMoved {
            op_id: "f".into(),
            count: 3,
            destination: "C:\\Capture\\Invoices".into(),
            verb: MoveVerb::Moved,
            undoable: true,
        },
        ActivityEvent::ToolJob {
            job_id: "j".into(),
            tool_id: "fit".into(),
            label: "Fit for Discord".into(),
            percent: 64.0,
            state: JobState::Running,
        },
        ActivityEvent::ToolResult {
            job_id: "j".into(),
            path: "C:\\Capture\\clip.mp4".into(),
            before_bytes: 42000000,
            after_bytes: 19600000,
            note: Some("Fits Discord".into()),
        },
        ActivityEvent::VolumeChanged {
            percent: 64,
            muted: false,
        },
    ];
    for event in cases {
        let mut e = engine();
        e.submit(event, None, clock(0));
        let view = &e.snapshot().views[0];
        for shape in [Shape::Island, Shape::Notch] {
            let scene = compact(Some(view), shape);
            assert_eq!(scene.height, 32.0);
            assert!((232.0..=348.0).contains(&scene.width));
            assert!(!scene.primary.is_empty());
            for command in &scene.primary {
                match command {
                    Draw::Text { x, width, .. }
                    | Draw::Button { x, width, .. }
                    | Draw::Level { x, width, .. } => {
                        assert!(*x >= 0.0 && *width >= 0.0 && *x + *width <= scene.primary_width)
                    }
                    _ => {}
                }
            }
        }
    }
}
#[test]
fn a_secondary_activity_is_one_bubble_without_resizing_the_host() {
    let mut e = engine();
    e.submit(
        ActivityEvent::DownloadProgress {
            job_id: "d".into(),
            title: "Download".into(),
            percent: 38.0,
            speed: None,
            eta: None,
        },
        None,
        clock(0),
    );
    e.submit(
        ActivityEvent::TimerTick {
            id: "t".into(),
            remaining_s: 1453,
            label: "Focus".into(),
        },
        None,
        clock(0),
    );
    let scene = compact(Some(&e.snapshot().views[0]), Shape::Island);
    assert_eq!(scene.primary_width, 260.0);
    assert_eq!(scene.width, 298.0);
    assert_eq!(scene.bubble.len(), 1);
}
#[test]
fn volume_feedback_expires_while_hidden_and_repeated_input_refreshes_its_deadline() {
    let mut e = engine();
    let volume = ActivityEvent::VolumeChanged {
        percent: 64,
        muted: false,
    };
    e.submit(volume.clone(), None, clock(0));
    assert_eq!(e.next_wait_ms(clock(0)), Some(1500));
    e.submit(volume, None, clock(1000));
    assert_eq!(e.next_wait_ms(clock(1000)), Some(1500));
    e.monitors(
        vec![Monitor {
            label: "island".into(),
            monitor: "primary".into(),
            base: Gate::Hidden,
            mode: Gate::Hidden,
        }],
        clock(1100),
    );
    e.tick(clock(2500));
    assert!(e.snapshot().views[0].queue.is_empty());
    assert!(e.snapshot().views[0].primary.is_none());
    assert_eq!(e.next_wait_ms(clock(2500)), None);
}
#[test]
fn fading_releases_input_at_200ms_and_reduced_hidden_forced_modes_skip_it() {
    let mut fade = FadeInput::default();
    assert_eq!(fade.gate(Gate::Faded, true, 100, false), Gate::Visible);
    assert_eq!(fade.gate(Gate::Faded, false, 299, false), Gate::Visible);
    assert_eq!(fade.gate(Gate::Faded, false, 300, false), Gate::Faded);
    assert_eq!(fade.gate(Gate::Faded, true, 400, true), Gate::Faded);
    fade.gate(Gate::Faded, true, 500, false);
    assert_eq!(fade.gate(Gate::Hidden, false, 501, false), Gate::Hidden);
    assert_eq!(fade.gate(Gate::Faded, false, 502, false), Gate::Faded);
}
#[test]
fn collapsing_under_the_pointer_requires_leave_before_another_hover_peek() {
    let mut s = Session::default();
    s.request(Mode::Expanded);
    s.request(Mode::Live);
    s.sample(true, false, false, 0, Mode::Live);
    s.sample(true, false, false, 1000, Mode::Live);
    assert_eq!(s.pending, None);
    s.sample(false, false, false, 1100, Mode::Live);
    s.sample(true, false, false, 1200, Mode::Live);
    s.sample(true, false, false, 1380, Mode::Live);
    assert_eq!(s.pending, Some(Mode::Peek));
}
#[test]
fn drop_staging_rejects_virtual_files_and_routes_only_supported_payloads() {
    assert!(DropPayload {
        files: vec!["virtual.png".into()],
        ..Default::default()
    }
    .validate("note")
    .is_err());
    assert!(DropPayload::default().validate("shelf").is_err());
    assert!(DropPayload {
        text: Some("A note".into()),
        ..Default::default()
    }
    .validate("note")
    .is_ok());
    assert!(DropPayload {
        text: Some("A note".into()),
        ..Default::default()
    }
    .validate("shelf")
    .is_err());
    assert!(DropPayload {
        url: Some("javascript:alert(1)".into()),
        ..Default::default()
    }
    .validate("note")
    .is_err());
    let path = std::env::temp_dir().join(format!("nabbit-drop-{}.png", uuid::Uuid::new_v4()));
    std::fs::write(&path, b"owned fixture").unwrap();
    let p = DropPayload {
        files: vec![path.to_string_lossy().into()],
        ..Default::default()
    };
    assert!(p.validate("shelf").is_ok());
    assert!(p.validate("note").is_ok());
    std::fs::remove_file(path).unwrap();
}
#[test]
fn artwork_decoding_is_local_bounded_and_returns_premultiplied_pixels() {
    use base64::Engine as _;
    let value = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(include_bytes!("../../icons/32x32.png"))
    );
    let pixels = super::artwork::decode(&value).unwrap();
    assert_eq!((pixels.width, pixels.height), (32, 32));
    assert!(pixels
        .rgba
        .chunks_exact(4)
        .all(|pixel| pixel[..3].iter().all(|channel| *channel <= pixel[3])));
    assert!(super::artwork::decode("https://example.invalid/art.png").is_none());
    assert!(super::artwork::decode("data:image/png;base64,not-a-png").is_none());
}
