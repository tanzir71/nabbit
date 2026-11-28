//! All passive intake stages review. Only the explicit clipboard hotkey enqueues.
use crate::{
    db::{models::DownloadMetadata, Database},
    error::{msg, Result},
    util::{extract_first_url, normalize_video_url},
};
use std::sync::{Arc, Condvar, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

pub fn web_url(input: &str) -> Result<String> {
    let input = input.trim();
    if input.len() > 16_384
        || input.chars().any(|c| c.is_control() || c.is_whitespace())
        || input.contains('\\')
        || !input.split_once("://").is_some_and(|(scheme, _)| {
            scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("http")
        })
        || !valid_escapes(input)
        || input.contains('\u{fffd}')
    {
        return Err(msg("Enter an http or https link"));
    }
    let mut url = Url::parse(input).map_err(|_| msg("Enter a valid web link"))?;
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(msg("Enter a web link without embedded credentials"));
    }
    url.set_fragment(None);
    Ok(normalize_video_url(url.as_str()).unwrap_or_else(|| url.into()))
}

pub fn clipboard_url(input: &str) -> Result<String> {
    web_url(&extract_first_url(input).ok_or_else(|| msg("Copy a web link first"))?)
}

pub fn deep_link(input: &str) -> Result<String> {
    if input.len() > 65_536 || input.chars().any(char::is_control) || !valid_escapes(input) {
        return Err(msg("Invalid Nabbit link"));
    }
    let link = Url::parse(input).map_err(|_| msg("Invalid Nabbit link"))?;
    if link.scheme() != "nabbit"
        || link.host_str() != Some("nab")
        || !matches!(link.path(), "" | "/")
        || !link.username().is_empty()
        || link.password().is_some()
        || link.port().is_some()
        || link.fragment().is_some()
    {
        return Err(msg("Invalid Nabbit link"));
    }
    let pairs: Vec<_> = link.query_pairs().collect();
    if pairs.len() != 1 || pairs[0].0 != "url" {
        return Err(msg("Nabbit links need exactly one url"));
    }
    web_url(&pairs[0].1)
}

fn valid_escapes(input: &str) -> bool {
    let bytes = input.as_bytes();
    bytes.iter().enumerate().all(|(i, b)| {
        *b != b'%'
            || bytes.get(i + 1).is_some_and(u8::is_ascii_hexdigit)
                && bytes.get(i + 2).is_some_and(u8::is_ascii_hexdigit)
    })
}

fn placeholder(url: String) -> DownloadMetadata {
    let host = Url::parse(&url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_default();
    DownloadMetadata {
        url: url.clone(),
        normalized_url: url.clone(),
        title: host,
        channel: None,
        duration: None,
        thumbnail: None,
        is_playlist: url.contains("list="),
        playlist_count: None,
        extractor: Some("capture".into()),
        qualities: vec![],
        details: None,
        live_pending: None,
    }
}

#[derive(Default)]
struct State {
    revision: u64,
    current: Option<DownloadMetadata>,
    pending: Option<(u64, String)>,
    stopped: bool,
}
pub struct Service {
    db: Database,
    state: Mutex<State>,
    changed: Condvar,
}
impl Service {
    pub fn new(db: Database) -> Arc<Self> {
        let current = db
            .setting_value("staged_url")
            .ok()
            .flatten()
            .and_then(|url| web_url(&url).ok())
            .map(placeholder);
        let pending = current.as_ref().map(|m| (0, m.normalized_url.clone()));
        Arc::new(Self {
            db,
            state: Mutex::new(State {
                current,
                pending,
                ..State::default()
            }),
            changed: Condvar::new(),
        })
    }
    // Sink runs under the generation lock so the immediate event always precedes enrichment.
    pub fn review(
        &self,
        input: &str,
        sink: impl Fn(&DownloadMetadata),
    ) -> Result<DownloadMetadata> {
        let metadata = placeholder(web_url(input)?);
        let mut state = self
            .state
            .lock()
            .map_err(|_| msg("Capture lock poisoned"))?;
        self.db
            .set_setting_value("staged_url", &metadata.normalized_url)?;
        state.revision += 1;
        state.pending = Some((state.revision, metadata.normalized_url.clone()));
        state.current = Some(metadata.clone());
        sink(&metadata);
        self.changed.notify_one();
        Ok(metadata)
    }
    pub fn current(&self) -> Option<DownloadMetadata> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .current
            .clone()
    }
    pub fn invalidate(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.revision += 1;
        state.pending = None;
    }
    pub fn clear(&self) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| msg("Capture lock poisoned"))?;
        self.db.set_setting_value("staged_url", "")?;
        state.revision += 1;
        state.current = None;
        state.pending = None;
        Ok(())
    }
    pub fn clear_if_current(&self, url: &str) -> Result<bool> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| msg("Capture lock poisoned"))?;
        if state
            .current
            .as_ref()
            .is_some_and(|m| m.normalized_url == url)
        {
            self.db.set_setting_value("staged_url", "")?;
            state.revision += 1;
            state.current = None;
            state.pending = None;
            return Ok(true);
        }
        Ok(false)
    }
    pub fn stop(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).stopped = true;
        self.changed.notify_one();
    }
    fn work(
        &self,
        probe: impl Fn(&str) -> Result<DownloadMetadata>,
        sink: impl Fn(&DownloadMetadata),
    ) {
        loop {
            let (revision, url) = {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                while state.pending.is_none() && !state.stopped {
                    state = self.changed.wait(state).unwrap_or_else(|e| e.into_inner());
                }
                if state.stopped {
                    return;
                }
                state.pending.take().expect("pending capture")
            };
            let Ok(mut metadata) = probe(&url) else {
                continue;
            };
            // Never trust an extractor to replace the validated capture URL.
            metadata.url.clone_from(&url);
            metadata.normalized_url = url;
            self.complete(revision, metadata, &sink);
        }
    }
    fn complete(
        &self,
        revision: u64,
        metadata: DownloadMetadata,
        sink: impl Fn(&DownloadMetadata),
    ) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.revision == revision && !state.stopped {
            state.current = Some(metadata.clone());
            sink(&metadata);
        }
    }
    pub fn start(self: &Arc<Self>, app: AppHandle, app_data_dir: std::path::PathBuf) {
        let service = self.clone();
        std::thread::Builder::new()
            .name("nabbit-capture".into())
            .spawn(move || {
                service.work(
                    |url| crate::download::probe::probe(&app_data_dir, url),
                    |metadata| {
                        if let Some(bus) = app.try_state::<Arc<crate::island::activity_bus::Bus>>()
                        {
                            bus.enrich_link(
                                &metadata.normalized_url,
                                &metadata.title,
                                metadata.duration.map(|s| s as u32),
                            );
                        }
                        let _ = app.emit("url:detected", metadata);
                    },
                );
            })
            .expect("spawn capture worker");
    }
}

pub fn review(app: &AppHandle, input: &str) -> Result<DownloadMetadata> {
    let state = app.state::<crate::AppState>();
    state.capture.review(input, |metadata| {
        crate::island::activity_bus::publish(
            app,
            crate::island::activity::ActivityEvent::LinkDetected {
                url: metadata.normalized_url.clone(),
                title: None,
                duration: None,
                site: metadata.title.clone(),
            },
        );
        let _ = app.emit("url:detected", metadata);
    })
}

pub fn open_deep_link(app: &AppHandle, input: &str) -> Result<()> {
    let url = deep_link(input)?;
    review(app, &url)?;
    #[cfg(windows)]
    if let Some(manager) = app.try_state::<Arc<crate::island::Manager>>() {
        if manager.open_capture_review().map_err(msg)? {
            return Ok(());
        }
    }
    let state = app.state::<crate::AppState>();
    crate::commands::settings::patch(app, &state, serde_json::json!({"lastTab":"download"}))?;
    let _ = app.emit("capture:review", ());
    crate::show_popover(app)?;
    Ok(())
}

// Injectable read/enqueue seams keep acceptance away from the user's clipboard and real keys.
pub fn explicit_hotkey<T>(
    read: impl FnOnce() -> Result<String>,
    enqueue: impl FnOnce(String) -> Result<T>,
) -> Result<T> {
    enqueue(clipboard_url(&read()?)?)
}
pub fn hotkey(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let result = explicit_hotkey(
            || {
                crate::clipboard::watcher::note_hotkey_text(&state.db)
                    .ok_or_else(|| msg("The clipboard link is private or unavailable"))
            },
            |url| state.downloads.enqueue_remembered(url),
        );
        match result {
            Ok(job) => {
                download_started(&app, &job.url);
            }
            Err(error) => {
                let _ = app.emit("capture:error", error.to_string());
            }
        }
    });
}

pub fn download_started(app: &AppHandle, url: &str) {
    let state = app.state::<crate::AppState>();
    if state.capture.clear_if_current(url).unwrap_or(false) {
        crate::island::activity_bus::publish(
            app,
            crate::island::activity::ActivityEvent::ClipboardChanged,
        );
        let _ = app.emit("url:cleared", url);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};
    fn database() -> Database {
        Database::open(
            &std::env::temp_dir().join(format!("nabbit-capture-{}", uuid::Uuid::new_v4())),
        )
        .unwrap()
    }
    #[test]
    fn captures_normalize_hosts_youtube_variants_and_strip_fragments() {
        for input in [
            "https://youtu.be/example?si=tracking",
            "https://m.youtube.com/shorts/example#time",
            "http://youtube.com/embed/example",
        ] {
            assert_eq!(
                web_url(input).unwrap(),
                "https://www.youtube.com/watch?v=example"
            );
        }
        assert_eq!(
            web_url(" HTTPS://EXAMPLE.COM/video?q=ok#section ").unwrap(),
            "https://example.com/video?q=ok"
        );
        assert_eq!(
            clipboard_url("Watch https://youtu.be/example.").unwrap(),
            "https://www.youtube.com/watch?v=example"
        );
        assert_eq!(
            clipboard_url("HTTPS://EXAMPLE.COM/video").unwrap(),
            "https://example.com/video"
        );
    }
    #[test]
    fn deep_links_decode_exactly_once_and_cannot_smuggle_actions() {
        assert_eq!(
            deep_link("nabbit://nab?url=https%3A%2F%2Fyoutu.be%2Fexample%3Flist%3DPL1%26t%3D10")
                .unwrap(),
            "https://www.youtube.com/watch?v=example&list=PL1"
        );
        assert_eq!(
            deep_link("nabbit://nab?url=https%3A%2F%2Fexample.com%2Fa%252Fb").unwrap(),
            "https://example.com/a%2Fb"
        );
        for input in [
            "nabbit://nab",
            "nabbit://other?url=https://example.com",
            "nabbit://nab/run?url=https://example.com",
            "nabbit://nab?url=javascript%3Aalert(1)",
            "nabbit://nab?url=file%3A%2F%2F%2Fprivate",
            "nabbit://nab?url=data%3Atext/plain,hello",
            "nabbit://nab?url=https%253A%252F%252Fexample.com",
            "nabbit://nab?url=https://example.com&download=1",
            "nabbit://nab?url=https://a.com&url=https://b.com",
            "nabbit://nab?url=https://example.com#download",
            "nabbit://user@nab?url=https://a.com",
            "nabbit://nab:44?url=https://a.com",
            "nabbit://nab?url=https%3A%2F%2Fexample.com%0A--exec",
            "nabbit://nab?url=%zz",
            "nabbit://nab?url=https://example.com/%FF",
        ] {
            assert!(deep_link(input).is_err(), "{input}");
        }
    }
    #[test]
    fn invalid_review_urls_cannot_reach_the_extractor() {
        for input in [
            "",
            "--exec=calc",
            "javascript:alert(1)",
            "file:///private",
            "ftp://example.com",
            "https://user:pass@example.com",
            "https://",
            "https://example.com\n--exec",
            "https://example.com\\@bad.com",
            "https://example.com/%",
            "http:example.com",
        ] {
            assert!(web_url(input).is_err(), "{input}");
        }
    }
    #[test]
    fn passive_capture_paths_emit_immediately_store_review_and_create_no_jobs() {
        let db = database();
        let service = Service::new(db.clone());
        let events = Mutex::new(vec![]);
        let capture = |url: &str| {
            service
                .review(url, |m| events.lock().unwrap().push(m.clone()))
                .unwrap()
        };
        capture(&clipboard_url("Copied https://youtu.be/clipboard").unwrap());
        capture("https://example.com/drag");
        capture(&deep_link("nabbit://nab?url=https%3A%2F%2Fexample.com%2Fbookmarklet").unwrap());
        let events = events.into_inner().unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[1].title, "example.com");
        assert_eq!(events[1].duration, None);
        assert_eq!(
            db.setting_value("staged_url").unwrap().unwrap(),
            "https://example.com/bookmarklet"
        );
        assert!(db.list_downloads().unwrap().is_empty());
        let restored = Service::new(db);
        assert_eq!(
            restored.current().unwrap().normalized_url,
            "https://example.com/bookmarklet"
        );
        assert!(restored.state.lock().unwrap().pending.is_some());
    }
    #[test]
    fn worker_coalesces_pending_links_and_discards_slow_stale_results() {
        let service = Service::new(database());
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let worker = service.clone();
        let task = std::thread::spawn(move || {
            worker.work(
                |url| {
                    started_tx.send(url.to_owned()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    let mut m = placeholder(url.into());
                    m.title = "Enriched title".into();
                    m.duration = Some(768.0);
                    Ok(m)
                },
                |m| {
                    result_tx.send(m.clone()).unwrap();
                },
            )
        });
        service.review("https://example.com/old", |_| {}).unwrap();
        assert_eq!(
            started_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            "https://example.com/old"
        );
        service
            .review("https://example.com/middle", |_| {})
            .unwrap();
        service.review("https://example.com/new", |_| {}).unwrap();
        release_tx.send(()).unwrap();
        assert_eq!(
            started_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            "https://example.com/new"
        );
        assert!(result_rx.try_recv().is_err());
        release_tx.send(()).unwrap();
        let result = result_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(result.normalized_url, "https://example.com/new");
        assert_eq!(result.duration, Some(768.0));
        service.stop();
        task.join().unwrap();
    }
    #[test]
    fn clear_and_clipboard_change_cancel_enrichment_without_changing_a_newer_capture() {
        let service = Service::new(database());
        service.review("https://example.com/old", |_| {}).unwrap();
        service.review("https://example.com/new", |_| {}).unwrap();
        service.clear_if_current("https://example.com/old").unwrap();
        assert!(service.current().unwrap().normalized_url.ends_with("/new"));
        service.invalidate();
        assert!(service.state.lock().unwrap().pending.is_none());
        service.complete(2, placeholder("https://example.com/new".into()), |_| {
            panic!("clipboard change revived pill")
        });
        let revision = service.state.lock().unwrap().revision;
        service.clear().unwrap();
        service.complete(
            revision,
            placeholder("https://example.com/new".into()),
            |_| panic!("clear revived review"),
        );
        assert!(service.current().is_none());
    }
    #[test]
    fn hotkey_reads_current_clipboard_and_resolves_that_sites_remembered_preset() {
        let db = database();
        db.set_setting_value("staged_url", "https://older.example/video")
            .unwrap();
        let options =
            crate::download::options::DownloadOptions::from_legacy("audio_mp3", "video", None)
                .unwrap();
        db.remember_download_preset("https://www.youtube.com/watch?v=previous", &options)
            .unwrap();
        let preset = explicit_hotkey(
            || Ok("https://youtu.be/current".into()),
            |url| {
                assert_eq!(url, "https://www.youtube.com/watch?v=current");
                db.download_preset(&url, "1080p")
            },
        )
        .unwrap();
        assert_eq!(preset.id, crate::download::presets::PresetId::Mp3320);
        assert!(explicit_hotkey(
            || Ok("no link".into()),
            |_| -> Result<()> { panic!("invalid clipboard enqueued") }
        )
        .is_err());
        assert!(explicit_hotkey(
            || Err(msg("unavailable")),
            |_| -> Result<()> { panic!("unavailable clipboard enqueued") }
        )
        .is_err());
    }
}
