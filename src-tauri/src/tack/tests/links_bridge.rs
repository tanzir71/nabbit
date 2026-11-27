//! Test-only source/picker/open providers; all parsing, scope, capture and writes
//! use production modules. This adapter never inspects installed browsers.
use crate::{
    db::Database,
    notes::links::{self, sources::Roots, store::Guard},
    tack::{
        model::{Error, ErrorCode, Result},
        service::Service,
    },
};
use serde_json::{json, Map, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
};
pub(super) struct Fixture {
    imports: links::service::Service,
    roots: Roots,
    html: PathBuf,
    _live: Mutex<rusqlite::Connection>,
    title_url: String,
    stop: Arc<AtomicBool>,
    title_thread: Option<std::thread::JoinHandle<()>>,
    opened: Mutex<Vec<String>>,
}
impl Fixture {
    pub fn new(directory: &Path) -> Self {
        let local = directory.join("browser-fixtures/local");
        let roaming = directory.join("browser-fixtures/roaming");
        let rows: Vec<Value> = (0..56).map(|i| json!({"type":"url","name":format!("Fixture link {i:02}"),"url":format!("https://example.invalid/doc/{i}"),"date_added":"13348540800000000"})).collect();
        for (root, count) in [
            ("Google/Chrome/User Data", 56),
            ("Microsoft/Edge/User Data", 2),
            ("BraveSoftware/Brave-Browser/User Data", 2),
            ("Vivaldi/User Data", 2),
        ] {
            let dir = local.join(root);
            std::fs::create_dir_all(dir.join("Default")).unwrap();
            std::fs::write(dir.join("Local State"), r#"{"profile":{"info_cache":{"Default":{"name":"Acceptance"},"../../History":{"name":"Forbidden"}}}}"#).unwrap();
            let mut children = rows[..count].to_vec();
            children.push(rows[0].clone());
            children.push(json!({"type":"url","name":"Bookmarklet","url":"javascript:alert(1)"}));
            std::fs::write(dir.join("Default/Bookmarks"), json!({"roots":{"bookmark_bar":{"type":"folder","name":"Bookmarks bar","children":[{"type":"folder","name":"Design","children":[{"type":"folder","name":"Fonts","children":children}]}]}}}).to_string()).unwrap();
            for name in ["History", "Cookies", "Login Data"] {
                std::fs::write(dir.join("Default").join(name), b"FORBIDDEN SOURCE").unwrap();
            }
        }
        let firefox = roaming.join("Mozilla/Firefox/Profiles/acceptance.default");
        std::fs::create_dir_all(&firefox).unwrap();
        let live = rusqlite::Connection::open(firefox.join("places.sqlite")).unwrap();
        live.execute_batch("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE moz_places(id INTEGER PRIMARY KEY,url TEXT,title TEXT);CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY,fk INTEGER,type INTEGER,parent INTEGER,title TEXT,dateAdded INTEGER);INSERT INTO moz_places VALUES(1,'https://example.invalid/doc/0','Fixture link 00'),(2,'https://example.invalid/doc/1','Fixture link 01'),(3,'https://private-history.invalid/','Forbidden history'),(4,'javascript:alert(1)','Bookmarklet');INSERT INTO moz_bookmarks VALUES(1,NULL,2,0,'Bookmarks Toolbar',0),(2,NULL,2,1,'Design',0),(3,NULL,2,2,'Fonts',0),(4,1,1,3,'Fixture link 00',1704067200000000),(5,2,1,3,'Fixture link 01',1704067200000000),(6,1,1,3,'Fixture link 00',1704067200000000),(7,4,1,3,'Bookmarklet',0);").unwrap();
        let html = directory.join("browser-fixtures/export.html");
        std::fs::write(&html, r#"<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Bookmarks Menu</H3><DL><p><DT><H3>Design</H3><DL><p><DT><H3>Fonts</H3><DL><p><DT><A HREF="https://example.invalid/doc/0" ADD_DATE="1704067200">Fixture link 00</A><DT><A HREF="https://example.invalid/doc/1" ADD_DATE="1704067200">Fixture link 01</A><DT><A HREF="https://example.invalid/doc/0" ADD_DATE="1704067200">Fixture link 00</A><DT><A HREF="javascript:alert(1)">Bookmarklet</A></DL></DL></DL></DL>"#).unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let title_url = format!("http://{}/page", server.server_addr());
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let title_thread = std::thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                if let Some(request) = server
                    .recv_timeout(std::time::Duration::from_millis(50))
                    .unwrap()
                {
                    assert!(request
                        .headers()
                        .iter()
                        .all(|h| !h.field.equiv("Cookie") && !h.field.equiv("Authorization")));
                    let _ = request.respond(tiny_http::Response::from_string("<html><head><title>Ignored page title</title><meta property='og:title' content='Owned fixture title &amp; links'></head></html>"));
                }
            }
        });
        Self {
            imports: Default::default(),
            roots: Roots {
                local: Some(local),
                roaming: Some(roaming),
            },
            html,
            _live: Mutex::new(live),
            title_url,
            stop,
            title_thread: Some(title_thread),
            opened: Mutex::new(vec![]),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.title_thread.take() {
            t.join().unwrap();
        }
    }
}
fn encode(value: impl serde::Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| Error::new(ErrorCode::InvalidResponse))
}
fn decode<T: serde::de::DeserializeOwned>(args: &mut Map<String, Value>, key: &str) -> Result<T> {
    serde_json::from_value(args.remove(key).unwrap_or(Value::Null))
        .map_err(|_| Error::new(ErrorCode::InvalidInput))
}
pub(super) fn handles(command: &str) -> bool {
    command == "save_link"
        || command.starts_with("bookmarks_")
        || command.starts_with("links_")
        || command.starts_with("link_")
        || command == "test.links"
        || command == "test.parse_html"
}
pub(super) fn route(
    db: &Database,
    service: &Service,
    f: &Fixture,
    owner: &str,
    command: &str,
    mut args: Map<String, Value>,
    events: &Mutex<Vec<mpsc::Sender<String>>>,
) -> Result<Value> {
    let result = match command {
        "test.links" => {
            return Ok(
                json!({"titleUrl":f.title_url,"opened":f.opened.lock().unwrap().clone(),"html":std::fs::read_to_string(&f.html).unwrap(),"nativeHtml":links::parse::html(&std::fs::read_to_string(&f.html).unwrap())?.bookmarks}),
            )
        }
        "test.parse_html" => {
            return encode(links::parse::html(
                args.get("html").and_then(Value::as_str).unwrap_or(""),
            )?)
        }
        "save_link" => {
            let request: crate::notes::capture::CaptureRequest = decode(&mut args, "request")?;
            if !request.draft.url.starts_with(&f.title_url) {
                return Err(Error::new(ErrorCode::InvalidInput));
            }
            encode(links::capture::save(db, request, None)?)
        }
        "bookmarks_discover" => return encode(f.imports.discover(owner, &f.roots)?),
        "bookmarks_pick_html" => {
            return encode(Some(f.imports.add_html(
                owner,
                args.get("sessionId").and_then(Value::as_str).unwrap_or(""),
                &f.html,
            )?))
        }
        "bookmarks_preview" => {
            return encode(
                f.imports
                    .preview(db, owner, decode(&mut args, "request")?)?,
            )
        }
        "bookmarks_release" => {
            f.imports.release(
                owner,
                args.get("sessionId").and_then(Value::as_str).unwrap_or(""),
            )?;
            return Ok(Value::Null);
        }
        "bookmarks_commit" => {
            let scope: Option<crate::notes::sync_store::Context> =
                decode(&mut args, "expectedScope")?;
            let id = args.get("planId").and_then(Value::as_str).unwrap_or("");
            encode(f.imports.commit(db,owner,id,scope.as_ref(),|done,total|{
                let packet=json!({"event":"notes:import-progress","payload":{"id":id,"done":done,"total":total,"state":"running"}});
                events.lock().unwrap().retain(|s|s.send(format!("data: {packet}\n\n")).is_ok());
            })?)
        }
        "bookmarks_history" => {
            return encode(
                db.bookmark_imports(
                    decode::<Option<crate::notes::sync_store::Context>>(
                        &mut args,
                        "expectedScope",
                    )?
                    .as_ref(),
                )?,
            )
        }
        "bookmarks_undo" => {
            let scope =
                decode::<Option<crate::notes::sync_store::Context>>(&mut args, "expectedScope")?;
            encode(db.undo_bookmark_import(
                args.get("id").and_then(Value::as_str).unwrap_or(""),
                scope.as_ref(),
            )?)
        }
        "links_bulk" => {
            let scope =
                decode::<Option<crate::notes::sync_store::Context>>(&mut args, "expectedScope")?;
            let guards = decode::<Vec<Guard>>(&mut args, "guards")?;
            encode(db.bulk_links(scope.as_ref(), &guards, &decode(&mut args, "action")?)?)
        }
        "links_open" => {
            let scope =
                decode::<Option<crate::notes::sync_store::Context>>(&mut args, "expectedScope")?;
            let guards = decode::<Vec<Guard>>(&mut args, "guards")?;
            let urls = db.selected_link_urls(scope.as_ref(), &guards)?;
            let n = urls.len();
            f.opened.lock().unwrap().extend(urls);
            return encode(n);
        }
        "link_open_url" => {
            let url = args.get("url").and_then(Value::as_str).unwrap_or("");
            links::parse::web_url(url)?;
            f.opened.lock().unwrap().push(url.into());
            return Ok(Value::Null);
        }
        "link_clean" => {
            return encode(links::parse::clean_url(
                args.get("url").and_then(Value::as_str).unwrap_or(""),
            )?)
        }
        _ => return Err(Error::new(ErrorCode::InvalidInput)),
    };
    if result.is_ok() {
        service.edited();
    }
    result
}
