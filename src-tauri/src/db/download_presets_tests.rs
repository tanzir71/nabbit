use super::*;
use crate::download::options::{Format, PlaylistMode, TimeRange};

fn directory() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nabbit-presets-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}
fn cleanup(dir: PathBuf) {
    let target = fs::canonicalize(&dir).unwrap();
    let temporary_root = fs::canonicalize(std::env::temp_dir()).unwrap();
    assert!(target.starts_with(temporary_root));
    assert_eq!(target.file_name(), dir.file_name());
    assert!(target
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("nabbit-presets-"));
    fs::remove_dir_all(target).unwrap();
}

fn job(id: &str, options: Option<DownloadOptions>) -> DownloadJob {
    DownloadJob {
        id: id.into(),
        url: "https://www.youtube.com/watch?v=fixture".into(),
        title: "Fixture".into(),
        thumbnail: None,
        status: "queued".into(),
        progress: 0.0,
        speed: None,
        eta: None,
        output_path: None,
        error: None,
        failure: None,
        quality: "1080p".into(),
        playlist_mode: "video".into(),
        playlist_range: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        options,
    }
}
#[test]
fn defaults_and_reading_saving_presets_never_enqueue_downloads() {
    let dir = directory();
    let db = Database::open(&dir).unwrap();
    let defaults = presets::defaults();
    assert_eq!(
        defaults
            .iter()
            .map(|p| p.label.as_str())
            .collect::<Vec<_>>(),
        ["MP4 · 1080p", "MP4 · 720p", "MP3 · 320", "M4A", "Custom…"]
    );
    assert_eq!(
        db.download_preset("https://youtu.be/fixture", "720p")
            .unwrap()
            .options
            .height,
        Some(720)
    );
    db.remember_download_preset(
        "https://youtu.be/fixture",
        &DownloadOptions {
            format: Format::Opus,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(db.list_downloads().unwrap().is_empty());
    drop(db);
    cleanup(dir);
}

#[test]
fn playlist_batch_is_atomic_remembers_source_site_and_preserves_per_item_retry_options() {
    let dir = directory();
    let db = Database::open(&dir).unwrap();
    let source = "https://example.invalid/playlist";
    db.remember_download_preset(source, &DownloadOptions::default())
        .unwrap();
    let options = DownloadOptions {
        format: Format::M4a,
        height: None,
        speed_limit: Some("2M".into()),
        ..Default::default()
    };
    let first = job("batch-a", Some(options.clone()));
    let mut second = job("batch-a", Some(options.clone()));
    assert!(db
        .insert_download_batch(&[first.clone(), second.clone()], true, source)
        .is_err());
    assert!(db.list_downloads().unwrap().is_empty());
    assert_eq!(
        db.download_preset(source, "1080p").unwrap().options.format,
        Format::Mp4
    );
    second.id = "batch-b".into();
    second.url = "https://example.invalid/second".into();
    db.insert_download_batch(&[first.clone(), second.clone()], true, source)
        .unwrap();
    assert_eq!(db.list_downloads().unwrap().len(), 2);
    assert_eq!(
        db.download_preset(source, "1080p").unwrap().options.format,
        Format::M4a
    );
    let mut failed = db.get_download(&first.id).unwrap();
    failed.status = "failed".into();
    failed.error = Some("fixture failure".into());
    db.update_download(&failed).unwrap();
    assert_eq!(db.get_download(&second.id).unwrap().status, "queued");
    drop(db);
    let db = Database::open(&dir).unwrap();
    let mut retry = db.get_download(&first.id).unwrap();
    assert_eq!(retry.options.as_ref(), Some(&options));
    retry.status = "queued".into();
    retry.error = None;
    db.update_download(&retry).unwrap();
    assert_eq!(db.get_download(&first.id).unwrap().options, Some(options));
    drop(db);
    cleanup(dir);
}

#[test]
fn large_playlist_queue_keeps_every_actionable_item_and_caps_only_finished_history() {
    let dir = directory();
    let db = Database::open(&dir).unwrap();
    let mut jobs: Vec<_> = (0..205)
        .map(|i| job(&format!("active-{i}"), Some(DownloadOptions::default())))
        .collect();
    jobs[0].status = "failed".into();
    jobs[1].status = "paused".into();
    jobs[2].status = "interrupted".into();
    jobs.extend((0..205).map(|i| {
        let mut j = job(&format!("done-{i}"), Some(DownloadOptions::default()));
        j.status = "completed".into();
        j
    }));
    db.insert_download_batch(&jobs, false, "https://example.invalid/playlist")
        .unwrap();
    let visible = db.list_downloads().unwrap();
    assert_eq!(visible.len(), 405);
    assert_eq!(
        visible.iter().filter(|j| j.status == "completed").count(),
        200
    );
    for i in 0..205 {
        assert!(visible.iter().any(|j| j.id == format!("active-{i}")));
    }
    drop(db);
    cleanup(dir);
}
#[test]
fn per_site_preset_survives_restart_and_youtube_aliases_share_it() {
    let dir = directory();
    {
        let db = Database::open(&dir).unwrap();
        db.remember_download_preset(
            "https://youtu.be/fixture?tracking=discarded",
            &DownloadOptions {
                format: Format::Mp3,
                ..Default::default()
            },
        )
        .unwrap();
        db.remember_download_preset(
            "https://vimeo.com/42",
            &DownloadOptions {
                height: Some(720),
                ..Default::default()
            },
        )
        .unwrap();
    }
    let db = Database::open(&dir).unwrap();
    for url in [
        "https://www.youtube.com/watch?v=other",
        "https://music.youtube.com/watch?v=other",
        "https://m.youtube.com/watch?v=other",
    ] {
        assert_eq!(
            db.download_preset(url, "1080p").unwrap().options.format,
            Format::Mp3
        );
    }
    assert_eq!(
        db.download_preset("https://vimeo.com/99", "1080p")
            .unwrap()
            .options
            .height,
        Some(720)
    );
    assert_eq!(
        db.download_preset("https://youtube.com.evil.invalid/99", "1080p")
            .unwrap()
            .options
            .format,
        Format::Mp4
    );
    let conn = db.conn.lock().unwrap();
    let keys: String = conn
        .query_row("SELECT group_concat(site) FROM download_presets", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(!keys.contains("tracking") && !keys.contains("fixture"));
    drop(conn);
    drop(db);
    cleanup(dir);
}
#[test]
fn snapshots_retain_trim_and_queue_updates_cannot_change_them() {
    let dir = directory();
    let db = Database::open(&dir).unwrap();
    let options = DownloadOptions {
        sections: vec![TimeRange {
            start_ms: 0,
            end_ms: 3000,
        }],
        precise_cuts: true,
        playlist_mode: PlaylistMode::Playlist,
        playlist_items: Some("1-5".into()),
        output_dir: Some("job-folder".into()),
        ..Default::default()
    };
    let mut job = job("job", Some(options.clone()));
    db.insert_download_and_preset(&job, true).unwrap();
    job.status = "paused".into();
    db.update_download(&job).unwrap();
    drop(db);
    let db = Database::open(&dir).unwrap();
    assert_eq!(db.get_download("job").unwrap().options, Some(options));
    let remembered = db
        .download_preset("https://youtube.com/other", "best")
        .unwrap()
        .options;
    assert!(
        remembered.sections.is_empty()
            && remembered.output_dir.is_none()
            && remembered.playlist_items.is_none()
    );
    assert!(!remembered.precise_cuts);
    assert_eq!(remembered.playlist_mode, PlaylistMode::Video);
    db.mark_interrupted_downloads().unwrap();
    assert_eq!(db.get_download("job").unwrap().status, "interrupted");
    drop(db);
    cleanup(dir);
}
#[test]
fn enqueue_and_remember_are_atomic_and_invalid_options_leave_no_rows() {
    let dir = directory();
    let db = Database::open(&dir).unwrap();
    let first = job("same", Some(Default::default()));
    db.insert_download_and_preset(&first, true).unwrap();
    let duplicate = job(
        "same",
        Some(DownloadOptions {
            format: Format::Opus,
            ..Default::default()
        }),
    );
    assert!(db.insert_download_and_preset(&duplicate, true).is_err());
    assert_eq!(
        db.download_preset(&first.url, "best")
            .unwrap()
            .options
            .format,
        Format::Mp4
    );
    let invalid = job(
        "invalid",
        Some(DownloadOptions {
            height: Some(0),
            ..Default::default()
        }),
    );
    assert!(db.insert_download_and_preset(&invalid, true).is_err());
    assert_eq!(db.list_downloads().unwrap().len(), 1);
    drop(db);
    cleanup(dir);
}
#[test]
fn migrating_a_v01_database_preserves_jobs_and_is_idempotent() {
    let dir = directory();
    let conn = Connection::open(dir.join("nabbit.sqlite3")).unwrap();
    conn.execute_batch("CREATE TABLE downloads(id TEXT PRIMARY KEY,url TEXT NOT NULL,title TEXT NOT NULL,thumbnail TEXT,status TEXT NOT NULL,progress REAL NOT NULL DEFAULT 0,speed TEXT,eta TEXT,output_path TEXT,error TEXT,quality TEXT NOT NULL,playlist_mode TEXT NOT NULL DEFAULT 'video',playlist_range TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); INSERT INTO downloads(id,url,title,status,quality,created_at,updated_at) VALUES('legacy','https://youtu.be/old','Preserved','completed','720p','2026-07-09T00:00:00Z','2026-07-09T00:00:00Z');").unwrap();
    drop(conn);
    for _ in 0..2 {
        let db = Database::open(&dir).unwrap();
        assert_eq!(db.get_download("legacy").unwrap().title, "Preserved");
        assert!(db.get_download("legacy").unwrap().options.is_none());
        assert_eq!(db.list_downloads().unwrap().len(), 1);
    }
    assert!(!fs::read_dir(&dir).unwrap().any(|p| p
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains("corrupt")));
    cleanup(dir);
}
#[test]
fn host_keys_reject_non_http_inputs_and_default_choice_stays_unmodified() {
    for url in [
        "javascript:alert(1)",
        "file:///video",
        "nabbit://nab",
        "not a URL",
    ] {
        assert!(presets::site_key(url).is_err(), "{url}");
    }
    assert_eq!(
        presets::site_key("HTTPS://WWW.VIMEO.COM./path").unwrap(),
        "vimeo.com"
    );
    assert_eq!(
        presets::site_key("https://www.xn--bcher-kva.example/path").unwrap(),
        "xn--bcher-kva.example"
    );
    let standard = presets::defaults();
    assert_eq!(
        presets::from_options(&standard[0].options).unwrap().id,
        standard[0].id
    );
}
