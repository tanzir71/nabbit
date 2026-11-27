use super::title;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tiny_http::{Header, Response, Server};
struct Fixture {
    url: String,
    requests: Arc<Mutex<Vec<(String, bool)>>>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Fixture {
    fn start() -> Self {
        let server = Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.server_addr());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (seen, done) = (requests.clone(), stop.clone());
        let worker = std::thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                let Some(request) = server.recv_timeout(Duration::from_millis(50)).unwrap() else {
                    continue;
                };
                let path = request.url().to_string();
                let private = request
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv("Cookie") || h.field.equiv("Authorization"));
                seen.lock().unwrap().push((path.clone(), private));
                let mut response = if path == "/og" {
                    Response::from_string(
                        "<title>Wrong</title><meta property='og:title' content='Fonts &amp; type'>",
                    )
                } else if path == "/title" {
                    Response::from_string("<title>  Fallback title </title>")
                } else if path == "/big" {
                    Response::from_string("x".repeat(512 * 1024 + 1))
                } else if path == "/slow" {
                    std::thread::sleep(Duration::from_millis(5500));
                    Response::from_string("<title>Too late</title>")
                } else if path.starts_with("/chain/") {
                    let n = path.trim_start_matches("/chain/").parse::<u32>().unwrap();
                    Response::from_string("").with_status_code(302).with_header(
                        Header::from_bytes(
                            "Location",
                            if n == 0 {
                                "/og".into()
                            } else {
                                format!("/chain/{}", n - 1)
                            },
                        )
                        .unwrap(),
                    )
                } else {
                    Response::from_string("")
                        .with_status_code(302)
                        .with_header(Header::from_bytes("Location", "/loop").unwrap())
                };
                response.add_header(
                    Header::from_bytes("Set-Cookie", "fixture=must-not-be-forwarded; Path=/")
                        .unwrap(),
                );
                let _ = request.respond(response);
            }
        });
        Self {
            url,
            requests,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}
#[test]
fn local_metadata_fixture_proves_og_fallback_caps_redirects_timeout_and_no_auth_material() {
    let server = Fixture::start();
    let cached=serde_json::from_value::<crate::db::models::DownloadMetadata>(serde_json::json!({"url":format!("{}/og",server.url),"normalizedUrl":format!("{}/og",server.url),"title":"Existing downloader probe title","isPlaylist":false,"qualities":[],"extractor":"fixture-probe"})).unwrap();
    assert_eq!(
        title::fetch(&format!("{}/og", server.url), Some(&cached)),
        "Existing downloader probe title"
    );
    assert!(server.requests.lock().unwrap().is_empty());
    assert_eq!(
        title::fetch(&format!("{}/og", server.url), None),
        "Fonts & type"
    );
    assert_eq!(
        title::fetch(&format!("{}/title", server.url), None),
        "Fallback title"
    );
    assert_eq!(
        title::fetch(&format!("{}/chain/4", server.url), None),
        "Fonts & type"
    );
    assert_eq!(
        title::fetch(&format!("{}/big", server.url), None),
        "127.0.0.1"
    );
    let before = server.requests.lock().unwrap().len();
    assert_eq!(
        title::fetch(&format!("{}/loop", server.url), None),
        "127.0.0.1"
    );
    let calls = server.requests.lock().unwrap().len() - before;
    assert!((1..=6).contains(&calls));
    let now = Instant::now();
    assert_eq!(
        title::fetch(&format!("{}/slow", server.url), None),
        "127.0.0.1"
    );
    assert!(now.elapsed() < Duration::from_secs(7));
    assert!(server
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|(_, private)| !*private));
}
