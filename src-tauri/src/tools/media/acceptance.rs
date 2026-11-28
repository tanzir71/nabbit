//! Opt-in acceptance on exclusively owned, short synthetic files.
use super::*;
use crate::{
    download::engine::run_bounded,
    tools::{Request, Service},
};
use std::{fs, path::PathBuf, sync::Arc, time::Instant};
#[test]
#[ignore = "owned media edge acceptance; pinned ffmpeg, verification-only ffprobe and Pillow"]
fn owned_quick_media_edges_dates_numbering_and_restart() {
    let root = std::env::temp_dir().join(format!("nabbit-v59-edges-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    struct Owned(PathBuf);
    impl Drop for Owned {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _owned = Owned(root.clone());
    let ffmpeg = crate::download::ffmpeg::verified(&root).unwrap();
    let probe = PathBuf::from(std::env::var("NABBIT_MEDIA_FFPROBE_TEST_EXE").unwrap());
    let db = crate::db::Database::open(&root).unwrap();
    let service = Service::create(db.clone(), root.clone(), Arc::new(|_| {})).unwrap();
    let cancel = AtomicBool::new(false);
    let measure = |path: &Path| -> serde_json::Value {
        let args = [
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
        ]
        .into_iter()
        .map(str::to_owned)
        .chain([path.to_string_lossy().into()])
        .collect::<Vec<_>>();
        let result = run_bounded(&probe, &args, Duration::from_secs(15)).unwrap();
        assert!(result.success, "{}", result.stderr);
        serde_json::from_str(&result.stdout).unwrap()
    };
    let make = |path: &Path, codec: &str| {
        let args = [
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1280x720:rate=15:duration=3",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=600:sample_rate=48000:duration=3",
            "-c:v",
            codec,
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-metadata",
            "creation_time=2020-01-02T03:04:05Z",
            "-metadata",
            "location=+23.0000+090.0000/",
        ]
        .into_iter()
        .map(str::to_owned)
        .chain(if codec == "mpeg4" {
            vec!["-movflags".into(), "+use_metadata_tags".into()]
        } else {
            vec![]
        })
        .chain([path.to_string_lossy().into()])
        .collect::<Vec<_>>();
        let result = run_bounded(&ffmpeg, &args, Duration::from_secs(60)).unwrap();
        assert!(result.success, "{}", result.stderr);
    };
    let input = root.join("source.mp4");
    make(&input, "mpeg4");
    let unsupported = root.join("fallback.mkv");
    make(&unsupported, "wmv2");
    let positive = measure(&input);
    assert!(positive["format"]["tags"]
        .as_object()
        .unwrap()
        .keys()
        .any(|k| k.contains("location")));
    assert!(positive["format"]["tags"]["creation_time"].is_string());
    let original = crate::tools::files::hash(&input).unwrap();
    let clash = root.join("source (To MP4).mp4");
    fs::write(&clash, b"existing unrelated output").unwrap();
    let submit = |path: &Path, tool: &str, preset: &str, options: Options| {
        let hash = crate::tools::files::hash(path).unwrap();
        let before = fs::metadata(path).unwrap();
        let job = service
            .submit(Request {
                request_id: uuid::Uuid::new_v4().to_string(),
                tool_id: tool.into(),
                input: path.to_string_lossy().into(),
                preset_id: preset.into(),
                options,
                image_options: crate::tools::images::Options::default(),
                document_options: crate::tools::documents::Options::default(),
            })
            .unwrap();
        let start = Instant::now();
        let done = loop {
            let current = service
                .jobs()
                .unwrap()
                .into_iter()
                .find(|j| j.id == job.id)
                .unwrap();
            if !matches!(current.status.as_str(), "queued" | "running" | "publishing") {
                assert_eq!(current.status, "completed", "{tool}: {:?}", current.error);
                break current;
            }
            assert!(start.elapsed() < Duration::from_secs(120));
            std::thread::sleep(Duration::from_millis(25));
        };
        let output = Path::new(done.output.as_ref().unwrap());
        let after = fs::metadata(output).unwrap();
        assert_eq!(before.modified().unwrap(), after.modified().unwrap());
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert_eq!(before.creation_time(), after.creation_time());
        }
        assert_eq!(crate::tools::files::hash(path).unwrap(), hash);
        assert!(output
            .file_stem()
            .unwrap()
            .to_string_lossy()
            .contains(&format!("({})", done.preset.name)));
        done
    };
    let mut rows = Vec::new();
    for keep_audio in [true, false] {
        let job = submit(
            &input,
            "to-mp4",
            "mp4",
            Options {
                keep_audio,
                ..Options::default()
            },
        );
        assert!(job.media_report.as_ref().unwrap().remuxed);
        let metadata = measure(Path::new(job.output.as_ref().unwrap()));
        assert_eq!(
            metadata["streams"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["codec_type"] == "audio"),
            keep_audio
        );
        rows.push(serde_json::json!({"case":"remux","keepAudio":keep_audio,"job":job,"probe":metadata,"datesCopied":true,"inputUnchanged":true}));
    }
    assert_eq!(fs::read(&clash).unwrap(), b"existing unrelated output");
    assert!(rows[0]["job"]["output"]
        .as_str()
        .unwrap()
        .ends_with("(To MP4) 2.mp4"));
    assert!(rows[1]["job"]["output"]
        .as_str()
        .unwrap()
        .ends_with("(To MP4) 3.mp4"));
    let job = submit(&unsupported, "to-mp4", "mp4", Options::default());
    assert!(!job.media_report.as_ref().unwrap().remuxed);
    assert_eq!(job.media_report.as_ref().unwrap().encoder, "libx264");
    let metadata = measure(Path::new(job.output.as_ref().unwrap()));
    assert_eq!(metadata["streams"][0]["codec_name"], "h264");
    rows.push(serde_json::json!({"case":"unsupported-stream-remux-falls-back","job":job,"probe":metadata,"datesCopied":true,"inputUnchanged":true}));
    let audio = submit(&input, "extract-m4a", "m4a", Options::default());
    let job = submit(
        Path::new(audio.output.as_ref().unwrap()),
        "fit-size",
        "custom-fit",
        Options {
            max_mb: Some(1),
            ..Options::default()
        },
    );
    assert!(job.after_bytes <= 1_000_000);
    let metadata = measure(Path::new(job.output.as_ref().unwrap()));
    assert!(metadata["streams"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["codec_type"] == "audio"));
    rows.push(serde_json::json!({"case":"audio-only-size-preset","job":job,"probe":metadata,"datesCopied":true,"inputUnchanged":true}));
    if gpu::capabilities(&ffmpeg, &db, false, &cancel)
        .unwrap()
        .webp
    {
        let job = submit(&input, "animated-webp", "animated-webp", Options::default());
        let args=vec!["-c".into(),"from PIL import Image;import json,sys;im=Image.open(sys.argv[1]);ms=0\nfor n in range(im.n_frames):\n im.seek(n);im.load();ms+=im.info.get('duration',0)\nprint(json.dumps({'format':im.format,'frames':im.n_frames,'width':im.width,'height':im.height,'durationMs':ms}))".into(),job.output.clone().unwrap()];
        let result = run_bounded(Path::new("python"), &args, Duration::from_secs(15)).unwrap();
        assert!(result.success, "{}", result.stderr);
        let decoded: serde_json::Value = serde_json::from_str(&result.stdout).unwrap();
        assert_eq!(decoded["format"], "WEBP");
        assert_eq!(decoded["frames"], 45);
        assert_eq!(decoded["width"], 720);
        assert_eq!(decoded["height"], 404);
        assert!((decoded["durationMs"].as_f64().unwrap() - 3000.).abs() <= 100.);
        rows.push(serde_json::json!({"case":"animated-webp","job":job,"pillow":decoded,"datesCopied":true,"inputUnchanged":true}));
    }
    assert_eq!(crate::tools::files::hash(&input).unwrap(), original);
    let records = service.jobs().unwrap();
    service.stop();
    let reopened = Service::create(db, root.clone(), Arc::new(|_| {})).unwrap();
    assert_eq!(reopened.jobs().unwrap().len(), records.len());
    assert!(reopened
        .jobs()
        .unwrap()
        .iter()
        .all(|j| j.status == "completed"));
    assert!(!reopened.active());
    reopened.stop();
    let report = serde_json::json!({"passed":true,"cases":rows,"sourceTagsPositiveControl":positive,"numberingAndExistingClashPreserved":true,"restartCount":records.len(),"noRestartExecution":true,"scope":"Owned synthetic files; verification-only ffprobe and Pillow; no real media, clipboard, Explorer or settings"});
    use std::io::Write;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(std::env::var("NABBIT_MEDIA_EDGE_REPORT_PATH").unwrap())
        .unwrap()
        .write_all(serde_json::to_string_pretty(&report).unwrap().as_bytes())
        .unwrap();
}
