use super::*;

#[test]
fn version_fixtures_validate_identity_and_minimums() {
    for (name,fixture,expected) in [
        ("yt-dlp","2026.11.23\n","2026.11.23"),
        ("yt-dlp","2026.11.24.232910\n","2026.11.24.232910"),
        ("deno","deno 2.9.8 (stable, release, x86_64-pc-windows-msvc)\nv8 14.8\ntypescript 5.9","2.9.8"),
        ("ffmpeg","ffmpeg version 8.0-essentials_build-www.gyan.dev Copyright (c) 2000-2026\nbuilt with gcc","8.0-essentials_build-www.gyan.dev"),
    ] {assert_eq!(parse_version(name,fixture).as_deref(),Some(expected));}
    for (name, fixture) in [
        ("deno", "deno 1.46.0"),
        ("deno", "deno 2.2.1"),
        ("yt-dlp", "2025.10.22"),
        ("yt-dlp", "corrupt"),
        ("ffmpeg", "deno 2.9.8"),
        ("deno", ""),
    ] {
        assert!(parse_version(name, fixture).is_none(), "{name}: {fixture}");
    }
}
#[test]
fn explicit_runtime_path_is_one_argument_and_missing_helper_is_typed() {
    let args = runtime_args(Some(Path::new("C:\\Program Files\\Nabbit\\deno.exe"))).unwrap();
    assert_eq!(
        args,
        [
            "--ignore-config",
            "--no-js-runtimes",
            "--js-runtimes",
            "deno:C:\\Program Files\\Nabbit\\deno.exe"
        ]
    );
    assert!(runtime_args(None)
        .unwrap_err()
        .to_string()
        .starts_with("MissingJsRuntime:"));
}
#[test]
fn daily_schedule_handles_boundaries_bad_dates_and_clock_rollback() {
    let now = chrono::DateTime::parse_from_rfc3339("2026-11-26T10:00:00Z")
        .unwrap()
        .timestamp();
    assert_eq!(seconds_until_check(None, now), 0);
    assert_eq!(seconds_until_check(Some("bad"), now), 0);
    assert_eq!(seconds_until_check(Some("2026-11-26T10:00:00Z"), now), DAY);
    assert_eq!(seconds_until_check(Some("2026-11-25T10:00:01Z"), now), 1);
    assert_eq!(seconds_until_check(Some("2026-11-25T10:00:00Z"), now), 0);
    assert_eq!(seconds_until_check(Some("2026-11-27T10:00:00Z"), now), 0);
}
#[test]
fn extraction_reports_pass_failure_and_non_gating_offline_timeout() {
    let output = |success, stdout: &str, stderr: &str| {
        Ok(ProbeOutput {
            success,
            stdout: stdout.into(),
            stderr: stderr.into(),
        })
    };
    assert_eq!(
        extraction_result(output(true, "e6rhUvwB5Y8\n", "")).result,
        "passed"
    );
    assert_eq!(
        extraction_result(output(true, "not json", "")).result,
        "failed"
    );
    assert_eq!(
        extraction_result(output(false, "", "HTTP Error 403: Forbidden")).result,
        "failed"
    );
    assert_eq!(
        extraction_result(output(false, "", "getaddrinfo failed")).result,
        "skipped"
    );
    assert_eq!(
        extraction_result(Err(msg("Engine probe timed out."))).result,
        "skipped"
    );
}
#[test]
fn health_error_is_one_reserved_activity_and_recovers_without_jobs() {
    let mut status = EngineStatus {
        failure: Some(ErrorKind::MissingJsRuntime),
        ..Default::default()
    };
    assert_eq!(
        health_activity(&status),
        ActivityEvent::DownloadFailed {
            job_id: HEALTH_JOB.into(),
            error: ErrorKind::MissingJsRuntime
        }
    );
    status.failure = None;
    assert_eq!(
        health_activity(&status),
        ActivityEvent::DownloadRemoved {
            job_id: HEALTH_JOB.into()
        }
    );
}
#[test]
fn checksum_rejects_corrupt_or_missing_digest() {
    let bytes = b"engine fixture";
    let digest = format!("{:x}", Sha256::digest(bytes));
    verify_checksum(bytes, &digest).unwrap();
    assert!(verify_checksum(b"changed", &digest).is_err());
    assert!(verify_checksum(bytes, "").is_err());
}
#[test]
fn atomic_swap_and_invalid_candidate_preserve_working_file() {
    let dir = std::env::temp_dir().join(format!("nabbit-engine-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let destination = dir.join(executable("yt-dlp"));
    fs::write(&destination, b"existing").unwrap();
    assert!(prepare(&dir, "yt-dlp", b"not executable").is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"existing");
    let staged = dir.join("candidate");
    fs::write(&staged, b"verified replacement").unwrap();
    atomic_replace(&staged, &destination).unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"verified replacement");
    assert!(!staged.exists());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn target_assets_do_not_ship_x64_under_an_arm_name() {
    assert_eq!(
        ytdlp_asset("aarch64-pc-windows-msvc"),
        Some("yt-dlp_arm64.exe")
    );
    assert_eq!(
        ytdlp_asset("aarch64-unknown-linux-gnu"),
        Some("yt-dlp_linux_aarch64")
    );
    assert!(ytdlp_asset("unknown").is_none());
}
#[test]
fn health_cache_round_trips_and_legacy_status_survives() {
    let mut status: EngineStatus =
        serde_json::from_str(r#"{"missing":["deno"],"ytdlpVersion":"2026.11.23"}"#).unwrap();
    assert_eq!(status.channel, Channel::Stable);
    status.failure = Some(ErrorKind::MissingJsRuntime);
    let value = serde_json::to_string(&status).unwrap();
    let restored: EngineStatus = serde_json::from_str(&value).unwrap();
    assert_eq!(restored.failure, status.failure);
}

#[test]
fn persisted_health_survives_restart_and_getter_creates_no_jobs() {
    let dir = std::env::temp_dir().join(format!("nabbit-health-cache-{}", uuid::Uuid::new_v4()));
    let db = Database::open(&dir).unwrap();
    let saved = EngineStatus {
        channel: Channel::Nightly,
        busy: true,
        last_update_check: Some("2026-11-26T09:00:00Z".into()),
        failure: Some(ErrorKind::MissingJsRuntime),
        missing: vec!["deno".into()],
        ..Default::default()
    };
    db.set_setting_value("engine_health", &serde_json::to_string(&saved).unwrap())
        .unwrap();
    let service = Service::new(db.clone(), dir.clone());
    assert_eq!(service.snapshot().channel, Channel::Nightly);
    assert_eq!(
        service.snapshot().failure,
        Some(ErrorKind::MissingJsRuntime)
    );
    assert!(!service.snapshot().busy);
    assert_eq!(
        seconds_until_check(
            service.snapshot().last_update_check.as_deref(),
            chrono::DateTime::parse_from_rfc3339("2026-11-26T10:00:00Z")
                .unwrap()
                .timestamp()
        ),
        23 * 3600
    );
    assert!(db.list_downloads().unwrap().is_empty());
    drop(service);
    drop(db);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn actual_process_timeout_reaps_the_owned_tree() {
    #[cfg(windows)]
    let (path, args) = (
        PathBuf::from("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"),
        vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            "Start-Sleep -Seconds 10".into(),
        ],
    );
    #[cfg(unix)]
    let (path, args) = (
        PathBuf::from("/bin/sh"),
        vec!["-c".into(), "sleep 10".into()],
    );
    let start = std::time::Instant::now();
    assert!(run_bounded(&path, &args, Duration::from_millis(100)).is_err());
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[test]
#[ignore = "online-only engine probe; network is not an acceptance gate"]
fn online_engine_smoke() {
    let dir = std::env::temp_dir().join(format!("nabbit-health-online-{}", uuid::Uuid::new_v4()));
    let db = Database::open(&dir).unwrap();
    let service = Service::new(db, dir.clone());
    let mut status = service.local();
    status.extraction = extract(&dir);
    println!(
        "ENGINE_HEALTH_SMOKE={}",
        serde_json::to_string(&status).unwrap()
    );
    for name in ["yt-dlp", "deno", "ffmpeg"] {
        assert!(
            !status.missing.iter().any(|n| n == name),
            "{name} did not probe"
        );
    }
    let path = ytdlp::resolve_engine(&dir, "yt-dlp").unwrap();
    let help = run_bounded(
        &path,
        &["--ignore-config".into(), "--help".into()],
        Duration::from_secs(3),
    )
    .unwrap();
    assert!(help.success);
    assert!(help.stdout.contains("--js-runtimes RUNTIME[:PATH]"));
    assert!(help.stdout.contains("--no-js-runtimes"));
    let candidate = prepare(
        &dir,
        "deno",
        &fs::read(ytdlp::resolve_engine(&dir, "deno").unwrap()).unwrap(),
    )
    .unwrap();
    atomic_replace(&candidate, &dir.join(executable("deno"))).unwrap();
    assert_eq!(
        probe_version(&dir.join(executable("deno")), "deno").unwrap(),
        status.deno_version.unwrap()
    );
    drop(service);
    fs::remove_dir_all(dir).unwrap();
}
