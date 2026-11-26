use super::super::options::{DownloadOptions, Format};
use super::*;
use chrono::Utc;

fn job(log: &str) -> DownloadJob {
    DownloadJob {
        id: "error-fixture".into(),
        url: "https://www.youtube.com/watch?v=fixture".into(),
        title: "Fixture media".into(),
        thumbnail: None,
        status: "failed".into(),
        progress: 30.0,
        speed: None,
        eta: None,
        output_path: None,
        error: Some(log.into()),
        failure: None,
        quality: "1080p".into(),
        options: Some(DownloadOptions {
            output_dir: Some("D:\\Videos".into()),
            ..Default::default()
        }),
        playlist_mode: "video".into(),
        playlist_range: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}
#[test]
fn every_error_kind_maps_fixture_stderr_to_copy_and_at_most_two_actions_without_raw_logs() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("fixtures/errors.json")).unwrap();
    let mut kinds = std::collections::BTreeSet::new();
    for fixture in fixtures {
        let raw = fixture["stderr"].as_str().unwrap();
        let expected: ErrorKind = serde_json::from_value(fixture["kind"].clone()).unwrap();
        assert_eq!(classify(raw), expected, "{raw}");
        assert!(
            matches!(crate::island::activity_bus::download_event(&job(raw)),crate::island::activity::ActivityEvent::DownloadFailed{error,..} if error==expected)
        );
        let failure = for_job(&job(raw)).unwrap();
        assert_eq!(serde_json::to_value(&failure).unwrap(), fixture["failure"]);
        assert_eq!(failure.kind, expected);
        assert!(!failure.title.is_empty());
        assert!(failure.actions.len() <= 2 && !failure.actions.is_empty());
        let public = serde_json::to_string(&failure).unwrap();
        assert!(
            !public.contains("Traceback")
                && !public.contains("ERROR:")
                && !public.contains("fixture.py")
        );
        kinds.insert(format!("{expected:?}"));
    }
    assert_eq!(kinds.len(), 9);
    assert_eq!(classify(""), ErrorKind::Unknown);
}
#[test]
fn recovery_uses_validated_job_snapshots_and_never_changes_a_preset_or_bypasses_drm() {
    let mut quality = job("ERROR: Requested format is not available");
    let mut options = apply_recovery(&quality, &Recovery::BestAvailable).unwrap();
    assert_eq!(options.height, None);
    assert_eq!(quality.options.as_ref().unwrap().height, Some(1080));
    options.format = Format::M4a;
    assert_eq!(
        apply_recovery(
            &quality,
            &Recovery::Options {
                options: options.clone(),
                browser: None
            }
        )
        .unwrap(),
        options
    );
    quality.status = "running".into();
    assert!(apply_recovery(&quality, &Recovery::Retry).is_err());
    let drm = job("ERROR: DRM protected content");
    for recovery in [
        Recovery::Retry,
        Recovery::BestAvailable,
        Recovery::SignIn {
            browser: super::super::options::Browser::Chrome,
        },
        Recovery::Options {
            options: Default::default(),
            browser: None,
        },
        Recovery::WaitForVideo,
    ] {
        assert!(apply_recovery(&drm, &recovery).is_err());
    }
    let disk = job("ERROR: No space left on device");
    assert_eq!(for_job(&disk).unwrap().title, "Not enough space on D:");
    assert_eq!(
        apply_recovery(
            &disk,
            &Recovery::Folder {
                output_dir: " E:\\Other ".into()
            }
        )
        .unwrap()
        .output_dir
        .as_deref(),
        Some("E:\\Other")
    );
    assert!(apply_recovery(
        &disk,
        &Recovery::Folder {
            output_dir: " ".into()
        }
    )
    .is_err());
    assert!(apply_recovery(&disk, &Recovery::WaitForVideo).is_err());
}
#[test]
fn offline_and_replay_wait_resume_only_pending_jobs_and_stop_after_cancel_or_another_error() {
    let mut offline = job("ERROR: getaddrinfo failed");
    assert!(super::super::deferred::eligible(&offline));
    offline.status = "cancelled".into();
    assert!(!super::super::deferred::eligible(&offline));
    let mut live = job("ERROR: This is still live");
    assert!(!super::super::deferred::eligible(&live));
    live.options = Some(apply_recovery(&live, &Recovery::WaitForVideo).unwrap());
    assert!(super::super::deferred::eligible(&live));
    live.error = Some("ERROR: DRM protected".into());
    assert!(!super::super::deferred::eligible(&live));
    let waiting = live.options.as_ref().unwrap();
    let args = super::super::options::build(
        &waiting
            .with_defaults("fixture output", super::super::options::DEFAULT_TEMPLATE)
            .unwrap(),
        None,
        None,
        false,
    )
    .unwrap();
    let index = args.iter().position(|a| a == "--wait-for-video").unwrap();
    assert_eq!(args[index + 1], "30");
    assert!(!waiting.rememberable().unwrap().wait_for_video);
}
#[test]
fn recovered_options_and_raw_error_survive_sqlite_without_persisting_browser_choice() {
    let path = std::env::temp_dir().join(format!("nabbit-error-{}", uuid::Uuid::new_v4()));
    let db = crate::db::Database::open(&path).unwrap();
    let mut failed = job("ERROR: No space left on device\r\nTraceback: original raw detail");
    db.insert_download(&failed).unwrap();
    let loaded = db.get_download(&failed.id).unwrap();
    assert_eq!(loaded.failure.as_ref().unwrap().kind, ErrorKind::Disk);
    assert_eq!(loaded.error, failed.error);
    failed.options = Some(
        apply_recovery(
            &failed,
            &Recovery::Folder {
                output_dir: "E:\\Other".into(),
            },
        )
        .unwrap(),
    );
    db.update_download(&failed).unwrap();
    drop(db);
    let db = crate::db::Database::open(&path).unwrap();
    let loaded = db.get_download(&failed.id).unwrap();
    assert_eq!(loaded.options, failed.options);
    assert_eq!(loaded.error, failed.error);
    assert!(!serde_json::to_string(&loaded.options)
        .unwrap()
        .contains("browser"));
    assert_eq!(
        db.download_preset(&failed.url, "1080p")
            .unwrap()
            .options
            .output_dir,
        None
    );
}
#[test]
fn live_probe_requires_an_explicit_ended_or_nonlive_signal() {
    for status in [
        "is_live",
        "is_upcoming",
        "post_live",
        "not_live",
        "was_live",
    ] {
        let metadata = super::super::ytdlp::metadata_from_value(
            &serde_json::json!({"title":"fixture","live_status":status}),
            "https://example.invalid/watch",
        )
        .unwrap();
        assert_eq!(
            metadata.live_pending,
            Some(matches!(status, "is_live" | "is_upcoming" | "post_live"))
        );
    }
    assert_eq!(
        super::super::ytdlp::metadata_from_value(
            &serde_json::json!({}),
            "https://example.invalid/watch"
        )
        .unwrap()
        .live_pending,
        None
    );
}
