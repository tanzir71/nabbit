use super::*;
#[test]
fn budgets_audio_first_step_resolution_without_upscaling_and_validate_trim() {
    let info = Info {
        duration_ms: 180_000,
        width: 1920,
        height: 1080,
        fps: 30.,
        video: true,
        audio: true,
        channels: 1,
        ..Info::default()
    };
    let options = Options::default();
    let p = plan(&info, &options, 20, None).unwrap();
    assert_eq!(p.audio_kbps, 96);
    assert!(p.mono);
    assert_eq!((p.width, p.height), (852, 480));
    assert_eq!(p.video_kbps, 766);
    assert!(p.estimated_bytes < 20_000_000);
    let retained = plan(
        &info,
        &Options {
            downscale: false,
            ..options.clone()
        },
        20,
        None,
    )
    .unwrap();
    assert_eq!(retained.height, 1080);
    let low = Info {
        width: 640,
        height: 360,
        ..info.clone()
    };
    let p = plan(&low, &options, 20, None).unwrap();
    assert_eq!((p.width, p.height), (640, 360));
    assert!(Options {
        trim: Some(Range {
            start_ms: 0,
            end_ms: 180_001
        }),
        ..options.clone()
    }
    .seconds(&info)
    .is_err());
    assert!(Options {
        gif_fps: 16,
        ..options.clone()
    }
    .validate()
    .is_err());
    assert!(Options {
        max_mb: Some(0),
        ..options
    }
    .validate()
    .is_err());
}
#[test]
fn retry_spends_less_and_audio_only_uses_the_same_decimal_cap() {
    let info = Info {
        duration_ms: 60_000,
        audio: true,
        channels: 2,
        ..Info::default()
    };
    let p = plan(&info, &Options::default(), 1, None).unwrap();
    assert_eq!(p.audio_kbps, 128);
    assert_eq!(p.video_kbps, 0);
    let next = retry_bitrate(&p, 1_200_000, false).unwrap();
    assert!(next < 128);
    let p2 = plan(&info, &Options::default(), 1, Some(next)).unwrap();
    assert_eq!(p2.audio_kbps, next);
    assert_eq!(
        Kind::Fit.extension(std::path::Path::new("a.mp3"), Some(&info)),
        "m4a"
    );
}
#[test]
fn real_stream_descriptions_ignore_cover_art_and_keep_known_duration() {
    let text="Duration: 00:03:00.12, start: 0\nStream #0:0: Video: mjpeg, yuvj420p, 600x600 (attached pic)\nStream #0:1: Video: h264 (High), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 30 fps\nStream #0:2: Audio: aac (LC), 48000 Hz, mono, fltp\n";
    let info = parse_info(text, 42_000_000).unwrap();
    assert_eq!(info.duration_ms, 180_120);
    assert_eq!(info.width, 1920);
    assert_eq!(info.fps, 30.);
    assert_eq!(info.channels, 1);
    assert_eq!(info.video_codec.as_deref(), Some("h264"));
    assert!(parse_info("Duration: N/A\n", 0).is_err());
}
#[test]
fn gpu_probe_order_requires_a_real_success_and_cache_tracks_driver_and_engine() {
    let mut calls = Vec::new();
    let (selected, probes) = gpu::choose_with(|name| {
        calls.push(name.to_owned());
        if name == "h264_amf" {
            Ok(())
        } else {
            Err(crate::error::msg("no device"))
        }
    });
    assert_eq!(calls, ["h264_nvenc", "h264_qsv", "h264_amf"]);
    assert_eq!(selected.as_deref(), Some("h264_amf"));
    assert!(!probes[0].working);
    assert!(probes[2].working);
    let a = vec![gpu::Adapter {
        id: "gpu".into(),
        driver: Some(12),
    }];
    let b = vec![gpu::Adapter {
        id: "gpu".into(),
        driver: Some(13),
    }];
    assert_ne!(gpu::cache_key("engine1", &a), gpu::cache_key("engine1", &b));
    assert_ne!(gpu::cache_key("engine1", &a), gpu::cache_key("engine2", &a));
    assert!(gpu::cache_key(
        "engine1",
        &[gpu::Adapter {
            id: "unknown".into(),
            driver: None
        }]
    )
    .is_none());
    assert!(gpu::choose_with(|_| Err(crate::error::msg("timeout")))
        .0
        .is_none());
}

#[test]
#[ignore = "owned real ffmpeg/ffprobe media acceptance; requires the pinned setup sidecar and verification-only probe"]
fn owned_media_jobs_and_size_targets() {
    use crate::download::engine::run_bounded;
    use crate::tools::{Request, Service};
    use std::{
        path::PathBuf,
        sync::Arc,
        time::{Duration, Instant},
    };
    let root = std::env::temp_dir().join(format!("nabbit-v59-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    struct Owned(PathBuf);
    impl Drop for Owned {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _owned = Owned(root.clone());
    let ffmpeg = crate::download::ffmpeg::verified(&root).unwrap();
    let probe = PathBuf::from(
        std::env::var("NABBIT_MEDIA_FFPROBE_TEST_EXE")
            .expect("Set the verified test-only probe path"),
    );
    let db = crate::db::Database::open(&root).unwrap();
    let service = Service::create(db.clone(), root.clone(), Arc::new(|_| {})).unwrap();
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let capabilities = gpu::capabilities(&ffmpeg, &db, true, &cancel).unwrap();
    let measure = |path: &str| -> serde_json::Value {
        let args = [
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            path,
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
        let out = run_bounded(&probe, &args, Duration::from_secs(15)).unwrap();
        assert!(out.success, "{}", out.stderr);
        serde_json::from_str(&out.stdout).unwrap()
    };
    let submit = |input: &Path, tool: &str, preset: &str, options: Options| {
        let job = service
            .submit(Request {
                request_id: uuid::Uuid::new_v4().to_string(),
                input: input.to_string_lossy().into(),
                tool_id: tool.into(),
                preset_id: preset.into(),
                options,
            })
            .unwrap();
        let start = Instant::now();
        loop {
            let current = service
                .jobs()
                .unwrap()
                .into_iter()
                .find(|j| j.id == job.id)
                .unwrap();
            if !matches!(current.status.as_str(), "queued" | "running" | "publishing") {
                assert_eq!(current.status, "completed", "{}: {:?}", tool, current.error);
                break current;
            }
            assert!(start.elapsed() < Duration::from_secs(1200), "{current:?}");
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    let mut rows = Vec::new();
    let mut source10 = None;
    for length in [10, 60, 180] {
        let input = root.join(format!("source-{length}.mp4"));
        let args = [
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc2=size=1920x1080:rate=15:duration={length}"),
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency=440:sample_rate=48000:duration={length}"),
            "-c:v",
            "mpeg4",
            "-q:v",
            "2",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-metadata",
            "creation_time=2020-01-02T03:04:05Z",
            "-metadata",
            "location=+23.0000+090.0000/",
            "-movflags",
            "+use_metadata_tags",
            "-y",
        ]
        .into_iter()
        .map(str::to_owned)
        .chain([input.to_string_lossy().into()])
        .collect::<Vec<_>>();
        assert!(
            run_bounded(&ffmpeg, &args, Duration::from_secs(240))
                .unwrap()
                .success
        );
        let original = crate::tools::files::hash(&input).unwrap();
        let inspected = inspect(&ffmpeg, &input, &cancel).unwrap();
        assert_eq!(inspected.width, 1920);
        assert_eq!(inspected.channels, 1);
        for mode in [Mode::Exact, Mode::Fast] {
            if mode == Mode::Fast && capabilities.selected.is_none() {
                continue;
            }
            for cap in [20u32, 25] {
                let job = submit(
                    &input,
                    "fit-size",
                    if cap == 20 { "discord" } else { "email" },
                    Options {
                        mode,
                        ..Options::default()
                    },
                );
                assert!(job.after_bytes <= u64::from(cap) * 1_000_000);
                assert_eq!(crate::tools::files::hash(&input).unwrap(), original);
                let report = job.media_report.as_ref().unwrap();
                assert!((1..=3).contains(&report.attempts.len()));
                assert!(report.attempts.iter().all(|a| a.source_hash == original));
                assert!(report.attempts.last().unwrap().fits);
                let metadata = measure(job.output.as_deref().unwrap());
                let video = metadata["streams"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["codec_type"] == "video")
                    .unwrap();
                assert_eq!(video["codec_name"], "h264");
                let duration = metadata["format"]["duration"]
                    .as_str()
                    .unwrap()
                    .parse::<f64>()
                    .unwrap();
                assert!((duration - f64::from(length)).abs() <= 0.1);
                println!(
                    "owned size: {length}s {mode:?} {cap}MB => {} bytes, {} attempts",
                    job.after_bytes,
                    report.attempts.len()
                );
                rows.push(serde_json::json!({"seconds":length,"mode":mode,"capMb":cap,"job":job,"probe":metadata,"inputUnchanged":true}));
            }
        }
        if length == 10 {
            source10 = Some(input);
        }
    }
    let input = source10.unwrap();
    let original = crate::tools::files::hash(&input).unwrap();
    let trim = Options {
        trim: Some(Range {
            start_ms: 1200,
            end_ms: 3300,
        }),
        ..Options::default()
    };
    for (tool, preset, options, expected_codec, expected_seconds) in [
        ("to-mp4", "mp4", Options::default(), "mpeg4", 10.),
        ("trim-video", "trim", trim, "h264", 2.1),
        ("extract-mp3", "mp3", Options::default(), "mp3", 10.),
        ("extract-m4a", "m4a", Options::default(), "aac", 10.),
        (
            "to-gif",
            "gif",
            Options {
                trim: Some(Range {
                    start_ms: 0,
                    end_ms: 2000,
                }),
                ..Options::default()
            },
            "gif",
            2.,
        ),
        ("strip-metadata", "strip", Options::default(), "mpeg4", 10.),
    ] {
        let job = submit(&input, tool, preset, options);
        let metadata = measure(job.output.as_deref().unwrap());
        assert!(metadata["streams"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["codec_name"] == expected_codec));
        assert!(
            (metadata["format"]["duration"]
                .as_str()
                .unwrap()
                .parse::<f64>()
                .unwrap()
                - expected_seconds)
                .abs()
                <= 0.1
        );
        if tool == "to-mp4" {
            assert!(job.media_report.as_ref().unwrap().remuxed);
        }
        if tool == "to-gif" {
            for s in metadata["streams"].as_array().unwrap() {
                assert!(s["width"].as_u64().unwrap() <= 720);
                assert!(s["height"].as_u64().unwrap() <= 720);
                assert_eq!(s["r_frame_rate"], "15/1");
            }
        }
        if tool == "strip-metadata" {
            for tags in std::iter::once(&metadata["format"]["tags"]).chain(
                metadata["streams"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| &s["tags"]),
            ) {
                if let Some(tags) = tags.as_object() {
                    assert!(
                        !tags
                            .keys()
                            .any(|k| k.to_lowercase().contains("location") || k == "creation_time"),
                        "{tags:?}"
                    );
                }
            }
        }
        assert_eq!(crate::tools::files::hash(&input).unwrap(), original);
        println!("owned quick job: {tool} passed");
        rows.push(
            serde_json::json!({"tool":tool,"job":job,"probe":metadata,"inputUnchanged":true}),
        );
    }
    service.stop();
    let output =
        std::env::var("NABBIT_MEDIA_REPORT_PATH").expect("Set an exclusive acceptance report path");
    let report = serde_json::json!({"passed":true,"capabilities":capabilities,"fastSkipped":capabilities.selected.is_none(),"cases":rows,"scope":"Owned synthetic testsrc2+sine files only; actual durable runner and separately pinned ffmpeg, verification-only ffprobe; no user media or global input"});
    use std::io::Write;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .unwrap()
        .write_all(serde_json::to_string_pretty(&report).unwrap().as_bytes())
        .unwrap();
}
