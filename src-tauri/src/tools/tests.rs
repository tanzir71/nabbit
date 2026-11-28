use super::*;
use std::{
    fs,
    time::{Duration, Instant},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("nabbit-v57-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        Self(dir)
    }
    fn service(&self) -> Arc<Service> {
        Service::create(
            Database::open(&self.0).unwrap(),
            self.0.clone(),
            Arc::new(|_| {}),
        )
        .unwrap()
    }
    fn image(&self) -> PathBuf {
        let path = self.0.join("source.png");
        image::RgbImage::new(64, 48).save(&path).unwrap();
        path
    }
    fn request(&self, path: &Path) -> Request {
        Request {
            request_id: uuid::Uuid::new_v4().to_string(),
            tool_id: "to-jpg".into(),
            input: path.to_string_lossy().into(),
            preset_id: "jpg".into(),
            options: crate::tools::media::Options::default(),
            image_options: crate::tools::images::Options::default(),
            document_options: crate::tools::documents::Options::default(),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn finished(service: &Service, id: &str) -> Job {
    let start = Instant::now();
    loop {
        let job = service
            .jobs()
            .unwrap()
            .into_iter()
            .find(|j| j.id == id)
            .unwrap();
        if !matches!(job.status.as_str(), "queued" | "running") {
            return job;
        }
        assert!(start.elapsed() < Duration::from_secs(20));
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn registry_and_presets_are_unique_and_match_supported_inputs() {
    let tools = registry::catalog();
    let ids = tools
        .iter()
        .map(|t| t.id)
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), tools.len());
    for tool in tools {
        assert_eq!(tool.accepts.text, tool.id == "encode-qr");
        assert_eq!(tool.accepts.link, tool.id == "encode-qr");
        for preset in tool.presets {
            assert!(registry::presets().iter().any(|p| p.id == *preset));
        }
        assert!(tool.accepts_path(Path::new(&format!(
            "fixture.{}",
            tool.accepts.filetypes[0].to_ascii_uppercase()
        ))));
        assert!(!tool.accepts_path(Path::new("wrong.exe")));
    }
    for p in registry::presets() {
        registry::validate_preset(&p).unwrap();
    }
}
#[test]
fn drop_suggestions_use_saved_cap_and_conversion_priority() {
    let suggest = |name, bytes, cap| registry::suggestion(Path::new(name), bytes, cap);
    assert_eq!(suggest("clip.MOV", 90_000_000, 20), Some("to-mp4"));
    assert_eq!(suggest("clip.mkv", 10, 20), Some("to-mp4"));
    assert_eq!(suggest("clip.mp4", 20_000_001, 20), Some("fit-size"));
    assert_eq!(suggest("clip.mp4", 20_000_000, 20), None);
    assert_eq!(suggest("clip.webm", 20_000_001, 25), None);
    assert_eq!(suggest("audio.mp3", 90_000_000, 20), None);
    assert_eq!(suggest("image.png", 10, 20), None);
    assert_eq!(suggest("image.pdf", 10, 20), None);
}
#[test]
fn output_naming_is_atomic_and_never_overwrites() {
    let f = Fixture::new();
    let source = f.image();
    let temp = f.0.join("temp.jpg");
    fs::write(&temp, b"result").unwrap();
    let original = files::hash(&source).unwrap();
    let one = files::publish(&temp, &source, "To JPG", "jpg", |_| Ok(())).unwrap();
    if !temp.exists() {
        fs::write(&temp, b"result").unwrap();
    }
    let two = files::publish(&temp, &source, "To JPG", "jpg", |_| Ok(())).unwrap();
    assert_eq!(one.file_name().unwrap(), "source (To JPG).jpg");
    assert_eq!(two.file_name().unwrap(), "source (To JPG) 2.jpg");
    assert_eq!(files::hash(&source).unwrap(), original);
    assert_eq!(fs::read(one).unwrap(), b"result");
}
#[test]
fn real_job_dates_idempotency_undo_and_restart() {
    let f = Fixture::new();
    let source = f.image();
    let original = files::hash(&source).unwrap();
    let before = fs::metadata(&source).unwrap();
    let service = f.service();
    let request = f.request(&source);
    let job = service.submit(request.clone()).unwrap();
    let done = finished(&service, &job.id);
    assert_eq!(done.status, "completed", "{:?}", done.error);
    assert_eq!(service.submit(request.clone()).unwrap().id, job.id);
    let mut wrong = request;
    wrong.input = f.0.join("other.png").to_string_lossy().into();
    assert!(service.submit(wrong).is_err());
    let output = Path::new(done.output.as_ref().unwrap());
    assert_eq!(image::open(output).unwrap().width(), 64);
    assert_eq!(
        fs::metadata(output).unwrap().modified().unwrap(),
        before.modified().unwrap()
    );
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        assert_eq!(
            fs::metadata(output).unwrap().creation_time(),
            before.creation_time()
        );
    }
    assert_eq!(files::hash(&source).unwrap(), original);
    let quarantine = f.0.join("injected-recycle.jpg");
    service
        .undo_with(&job.id, |p| {
            fs::rename(p, &quarantine)?;
            Ok(())
        })
        .unwrap();
    assert!(quarantine.exists());
    assert_eq!(service.jobs().unwrap()[0].status, "undone");
    assert!(service
        .undo_with(&job.id, |_| panic!("only undo once"))
        .is_err());
    service.stop();
    drop(service);
    let restarted = f.service();
    assert_eq!(restarted.jobs().unwrap()[0].status, "undone");
    restarted.stop();
}
#[test]
fn edited_output_is_never_removed_and_failures_retry_as_new_jobs() {
    let f = Fixture::new();
    let source = f.image();
    let service = f.service();
    let job = service.submit(f.request(&source)).unwrap();
    let done = finished(&service, &job.id);
    fs::write(done.output.unwrap(), b"user edit").unwrap();
    assert!(service
        .undo_with(&job.id, |_| panic!("never remove user edit"))
        .is_err());
    fs::write(&source, b"invalid image").unwrap();
    let failed = service.submit(f.request(&source)).unwrap();
    let done = finished(&service, &failed.id);
    assert_eq!(done.status, "failed");
    assert!(done.output.is_none());
    fs::remove_file(&source).unwrap();
    let source = f.image();
    let mut changed = service
        .inner
        .db
        .tool_presets()
        .unwrap()
        .into_iter()
        .find(|p| p.id == "jpg")
        .unwrap();
    changed.quality = 30;
    service.inner.db.save_tool_preset(&changed).unwrap();
    let retried = service.retry(&failed.id).unwrap();
    assert_eq!(retried.preset.quality, 85);
    assert_eq!(retried.attempt, 2);
    assert!(activity_events(&retried)
        .iter()
        .any(|e| matches!(e,ActivityEvent::Dismissed{id}if id==&format!("tool:{}",failed.id))));
    assert_ne!(retried.id, failed.id);
    assert_eq!(finished(&service, &retried.id).status, "completed");
    assert!(source.exists());
    service.stop();
}
#[test]
fn persisted_presets_validate_numbers_and_survive_restart() {
    let f = Fixture::new();
    let db = Database::open(&f.0).unwrap();
    let mut preset = db.tool_presets().unwrap().remove(0);
    assert_eq!(preset.max_mb, Some(20));
    preset.max_mb = Some(8);
    db.save_tool_preset(&preset).unwrap();
    assert_eq!(db.tool_presets().unwrap()[0].max_mb, Some(8));
    preset.max_mb = Some(0);
    assert!(db.save_tool_preset(&preset).is_err());
    preset.max_mb = Some(8);
    preset.name = "../../escape".into();
    assert!(db.save_tool_preset(&preset).is_err());
}

#[test]
fn recovery_recognizes_its_published_inode_and_never_claims_a_collision() {
    let f = Fixture::new();
    let source = f.image();
    let service = f.service();
    let job = service.submit(f.request(&source)).unwrap();
    let done = finished(&service, &job.id);
    service.stop();
    drop(service);
    let db = Database::open(&f.0).unwrap();
    let mut pending = done.clone();
    pending.status = "publishing".into();
    let staged = f.0.join("owned-publishing.jpg");
    fs::hard_link(done.output.as_ref().unwrap(), &staged).unwrap();
    pending.staging_path = Some(staged.to_string_lossy().into());
    db.save_tool_job(&pending).unwrap();
    let restarted = f.service();
    let recovered = restarted.jobs().unwrap().remove(0);
    assert_eq!(recovered.status, "completed");
    assert!(!staged.exists());
    restarted.stop();
    drop(restarted);
    let output = Path::new(done.output.as_ref().unwrap());
    fs::remove_file(output).unwrap();
    fs::write(output, b"someone else's output").unwrap();
    pending.staging_path = None;
    db.save_tool_job(&pending).unwrap();
    let restarted = f.service();
    let recovered = restarted.jobs().unwrap().remove(0);
    assert_eq!(recovered.status, "failed");
    assert!(recovered.output.is_none());
    assert_eq!(fs::read(output).unwrap(), b"someone else's output");
    restarted.stop();
}
#[test]
fn quit_warning_is_only_for_unconfirmed_active_work() {
    assert!(quit_requires_confirmation(true, false));
    assert!(!quit_requires_confirmation(false, false));
    assert!(!quit_requires_confirmation(true, true));
}
#[test]
#[ignore = "owned ffmpeg process acceptance; requires the pinned setup sidecar"]
fn owned_ffmpeg_cancellation_retry_and_typed_progress() {
    let f = Fixture::new();
    let ffmpeg = crate::download::ffmpeg::verified(&f.0).expect("fetch the pinned sidecar first");
    #[cfg(windows)]
    {
        let engine = f.0.join("engine");
        fs::create_dir(&engine).unwrap();
        fs::write(engine.join("ffmpeg.exe"), b"old unverified engine").unwrap();
        assert!(!crate::download::ffmpeg::current(&f.0));
        assert_eq!(crate::download::ffmpeg::verified(&f.0).unwrap(), ffmpeg);
        let offline = reqwest::blocking::Client::builder()
            .proxy(reqwest::Proxy::all("http://127.0.0.1:9").unwrap())
            .timeout(Duration::from_secs(1))
            .build()
            .unwrap();
        crate::download::ffmpeg::install(&offline, &engine).unwrap();
        assert!(crate::download::ffmpeg::current(&f.0));
        assert_eq!(
            crate::download::ffmpeg::verified(&f.0).unwrap(),
            engine.join("ffmpeg.exe")
        );
    }
    let source = f.0.join("fixture.avi");
    let args = [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=24:duration=12",
        "-an",
        "-c:v",
        "mpeg4",
        "-q:v",
        "5",
        "-y",
    ]
    .into_iter()
    .map(String::from)
    .chain([source.to_string_lossy().into_owned()])
    .collect::<Vec<_>>();
    assert!(
        crate::download::engine::run_bounded(&ffmpeg, &args, Duration::from_secs(30))
            .unwrap()
            .success
    );
    let hash = files::hash(&source).unwrap();
    let events = Arc::new(Mutex::new(Vec::<Job>::new()));
    let record = events.clone();
    let service = Service::create(
        Database::open(&f.0).unwrap(),
        f.0.clone(),
        Arc::new(move |job| record.lock().unwrap().push(job.clone())),
    )
    .unwrap();
    let request = Request {
        request_id: uuid::Uuid::new_v4().to_string(),
        tool_id: "trim-video".into(),
        input: source.to_string_lossy().into(),
        preset_id: "trim".into(),
        options: media::Options {
            trim: Some(media::Range {
                start_ms: 0,
                end_ms: 12000,
            }),
            ..media::Options::default()
        },
        image_options: images::Options::default(),
        document_options: documents::Options::default(),
    };
    let job = service.submit(request).unwrap();
    let start = Instant::now();
    // The second Processing push is emitted after the child is attached.
    loop {
        let pushes = {
            let records = events.lock().unwrap();
            records
                .iter()
                .filter(|j| {
                    j.id == job.id
                        && j.status == "running"
                        && j.note
                            .as_deref()
                            .is_some_and(|s| s.contains("Processing media"))
                })
                .count()
        };
        if pushes >= 2 {
            break;
        }
        let current = service
            .jobs()
            .unwrap()
            .into_iter()
            .find(|j| j.id == job.id)
            .unwrap();
        assert!(
            matches!(current.status.as_str(), "queued" | "running"),
            "Job failed before ffmpeg attached: {current:?}"
        );
        assert!(
            start.elapsed() < Duration::from_secs(30),
            "No attached ffmpeg push: {current:?}; running pushes={pushes}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(service.active());
    assert!(quit_requires_confirmation(service.active(), false));
    let image = f.image();
    let queued = service.submit(f.request(&image)).unwrap();
    service.cancel(&queued.id).unwrap();
    service.cancel(&job.id).unwrap();
    assert_eq!(finished(&service, &job.id).status, "cancelled");
    assert_eq!(finished(&service, &queued.id).status, "cancelled");
    assert_eq!(service.jobs().unwrap().len(), 2);
    assert!(!service.active());
    let retry = service.retry(&job.id).unwrap();
    let done = finished(&service, &retry.id);
    assert_eq!(done.status, "completed", "{:?}", done.error);
    assert_ne!(done.id, job.id);
    assert_eq!(files::hash(&source).unwrap(), hash);
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|j| j.id == retry.id && j.status == "running" && j.percent > 0. && j.percent < 100.));
    assert!(activity_events(&done)
        .iter()
        .any(|event| matches!(event,ActivityEvent::ToolResult{job_id,..}if job_id==&retry.id)));
    assert!(!fs::read_dir(&f.0).unwrap().any(|p| p
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".nabbit-")));
    service.stop();
}
