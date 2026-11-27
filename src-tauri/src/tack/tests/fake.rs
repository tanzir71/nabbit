//! In-process API v4 fixture server; never built into the app. Behaviour derives
//! from the pinned PHP files listed in tests/fixtures/tack/README.md.
use super::merge::{merge_fields, merge_protocol_write};
use crate::tack::{
    endpoint::Endpoint,
    model::{Mutation, Record},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

pub(super) const STAMP: &str = "2026-11-27T00:00:00.000Z";
pub(super) const PASSWORD: &str = "fixture-passphrase-42";
#[derive(Clone)]
struct Session {
    csrf: String,
    signed_in: bool,
    workspace: String,
}
#[derive(Clone)]
struct Row {
    record: Record,
    seq: u64,
    visible: bool,
}
#[derive(Clone, Default)]
struct Workspace {
    records: HashMap<(String, String), Row>,
    refs: HashMap<String, String>,
    counter: u64,
}
#[derive(Clone)]
pub(super) struct Fault {
    pub status: u16,
    pub value: Value,
    pub headers: Vec<(String, String)>,
}
#[derive(Default)]
pub(super) struct State {
    pub batches: Vec<usize>,
    pub cursors: Vec<u64>,
    pub after_write: Option<Box<dyn FnOnce() + Send>>,
    pub after_commit_fault: Option<u16>,
    pub fail_sync_at: Option<(usize, u16)>,
    pub sync_calls: usize,
    pub sync_bytes: Vec<usize>,
    sessions: HashMap<String, Session>,
    workspaces: HashMap<String, Workspace>,
    serial: u64,
    seq: u64,
    recovery_hash: Vec<u8>,
    confirmed: bool,
    now: u64,
    attempts: HashMap<String, (u64, u64)>,
    pub fault: Option<Fault>,
    pub requests: usize,
    pub actions: Vec<String>,
    pub limits: (usize, usize),
}
impl State {
    fn token(&mut self, prefix: &str) -> String {
        self.serial += 1;
        format!("{prefix}{:032x}", self.serial)
    }
    fn connection(&self, session: &Session) -> Value {
        json!({"available":true,"version":4,"user":if session.signed_in {json!({"id":"user-1","username":"fixture"})}else{Value::Null},"workspace":if session.signed_in{workspace(&session.workspace)}else{Value::Null},"workspaces":if session.signed_in{json!([workspace("personal"),workspace("team")])}else{json!([])},"requiresLogin":false,"workspaceAccessChanged":false,"recoveryPending":session.signed_in&&!self.confirmed,"csrf":session.csrf})
    }
    pub fn advance(&mut self, seconds: u64) {
        self.now += seconds;
    }
    pub fn seed(&mut self, table: &str, id: &str, value: Value, visible: bool) {
        self.seed_for("personal", table, id, value, visible);
    }
    pub fn seed_for(
        &mut self,
        workspace: &str,
        table: &str,
        id: &str,
        value: Value,
        visible: bool,
    ) {
        self.seq += 1;
        let version = self
            .workspaces
            .get(workspace)
            .and_then(|w| w.records.get(&(table.into(), id.into())))
            .map_or(1, |r| r.record.version + 1);
        self.workspaces
            .entry(workspace.into())
            .or_default()
            .records
            .insert(
                (table.into(), id.into()),
                Row {
                    record: Record {
                        table: table.into(),
                        id: id.into(),
                        version,
                        value,
                    },
                    seq: self.seq,
                    visible,
                },
            );
    }
    fn rate(&mut self, key: String, limit: u64) -> bool {
        let entry = self.attempts.entry(key).or_insert((self.now, 0));
        if self.now >= entry.0 + 900 {
            *entry = (self.now, 0);
        }
        entry.1 += 1;
        entry.1 > limit
    }
    fn sync(&mut self, session: &Session, input: Value) -> (u16, Value) {
        let Ok(mutations) = serde_json::from_value::<Vec<Mutation>>(
            input.get("mutations").cloned().unwrap_or(json!([])),
        ) else {
            return error(400);
        };
        let mut keys = HashSet::new();
        if mutations.len() > 50 || mutations.iter().any(|m| !keys.insert((&m.table, &m.id))) {
            return error(400);
        }
        let mut workspace = self
            .workspaces
            .get(&session.workspace)
            .cloned()
            .unwrap_or_default();
        let mut conflicts = vec![];
        let mut seq = self.seq;
        let reference_pattern = regex::Regex::new(r"^[a-z]{1,3}-[1-9][0-9]{0,14}$").unwrap();
        for mut m in mutations {
            if !["cards", "reminders", "settings"].contains(&m.table.as_str())
                || m.id.is_empty()
                || m.id.len() > 200
                || m.id.contains(['\r', '\n'])
                || (!m.value.is_null()
                    && m.value
                        .get(if m.table == "settings" { "key" } else { "id" })
                        .and_then(Value::as_str)
                        != Some(&m.id))
            {
                return error(400);
            }
            if serde_json::to_vec(&m.value).unwrap().len() > 3_000_000 {
                return error(413);
            }
            let key = (m.table.clone(), m.id.clone());
            let current = workspace.records.get(&key).map(|r| r.record.clone());
            if let Some(current) = &current {
                if current.version != m.base_version {
                    if let Some(value) =
                        merge_protocol_write(&m.base_value, &current.value, &m.value, STAMP)
                            .or_else(|| {
                                merge_fields(&m.base_value, &current.value, &m.value, STAMP)
                            })
                    {
                        m.value = value;
                        m.base_version = current.version;
                    }
                }
            }
            let version = current.as_ref().map_or(0, |r| r.version);
            let previous = current.as_ref().map_or(&Value::Null, |r| &r.value);
            if version != m.base_version
                && previous != &m.value
                && !(m.table == "settings" && m.id == "tack.refCounter")
            {
                conflicts.push(current.unwrap_or(Record {
                    table: m.table,
                    id: m.id,
                    version: 0,
                    value: Value::Null,
                }));
                continue;
            }
            if m.table == "cards" && !m.value.is_null() {
                let reference = if let Some(reference) = workspace.refs.get(&m.id) {
                    reference.clone()
                } else {
                    let label = m
                        .value
                        .get("labels")
                        .or_else(|| m.value.get("tags"))
                        .and_then(Value::as_array)
                        .and_then(|a| a.first())
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let prefix = label
                        .to_ascii_lowercase()
                        .chars()
                        .filter(char::is_ascii_lowercase)
                        .take(3)
                        .collect::<String>();
                    let requested = m.value.get("ref").and_then(Value::as_str).unwrap_or("");
                    let valid = reference_pattern.is_match(requested);
                    let reference = if valid && !workspace.refs.values().any(|r| r == requested) {
                        workspace.counter = workspace
                            .counter
                            .max(requested.rsplit('-').next().unwrap().parse().unwrap());
                        requested.to_owned()
                    } else {
                        loop {
                            workspace.counter += 1;
                            let candidate = format!(
                                "{}-{}",
                                if prefix.is_empty() { "tck" } else { &prefix },
                                workspace.counter
                            );
                            if !workspace.refs.values().any(|r| r == &candidate) {
                                break candidate;
                            }
                        }
                    };
                    workspace.refs.insert(m.id.clone(), reference.clone());
                    reference
                };
                m.value["ref"] = json!(reference);
            }
            if previous == &m.value {
                continue;
            }
            if let Some(rank) = m.value.get("rank") {
                let key = if let Some(text) = rank.as_str() {
                    if crate::notes::rank::validate(text).is_err() {
                        return error(400);
                    }
                    text.to_owned()
                } else if let Some(number) = rank.as_f64() {
                    let Ok(key) = crate::notes::rank::legacy(number) else {
                        return error(400);
                    };
                    key
                } else {
                    return error(400);
                };
                let key = if key.starts_with('k') && key.len() == 12 {
                    format!(
                        "{}{}V",
                        key,
                        m.id.as_bytes()
                            .iter()
                            .map(|b| format!("{b:02x}"))
                            .collect::<String>()
                    )
                } else {
                    key
                };
                m.value["rank"] = json!(key);
            }
            if let Some(object) = m.value.as_object_mut() {
                object.insert("updatedBy".into(), json!("user-1"));
            }
            seq += 1;
            workspace.records.insert(
                key,
                Row {
                    record: Record {
                        table: m.table.clone(),
                        id: m.id.clone(),
                        version: version + 1,
                        value: m.value.clone(),
                    },
                    seq,
                    visible: true,
                },
            );
            if m.table == "cards" {
                let kind = if m.value.is_null()
                    || m.value.get("archived") == Some(&json!(true))
                    || m.value.get("trashedAt").is_some_and(|v| !v.is_null())
                {
                    "archived"
                } else if version == 0 {
                    "created"
                } else {
                    "brief_edited"
                };
                let id = format!("event-{seq}");
                seq += 1;
                workspace.records.insert(("events".into(),id.clone()),Row{record:Record{table:"events".into(),id:id.clone(),version:1,value:json!({"id":id,"projectId":m.id,"itemKind":"card","kind":kind,"actor":"You","at":STAMP,"updatedBy":"user-1"})},seq,visible:true});
            }
        }
        if workspace.counter > 0 {
            let key = ("settings".into(), "tack.refCounter".into());
            let value = json!({"key":"tack.refCounter","value":workspace.counter.to_string(),"updatedBy":"user-1"});
            if workspace
                .records
                .get(&key)
                .is_none_or(|r| r.record.value != value)
            {
                let version = workspace
                    .records
                    .get(&key)
                    .map_or(1, |r| r.record.version + 1);
                seq += 1;
                workspace.records.insert(
                    key,
                    Row {
                        record: Record {
                            table: "settings".into(),
                            id: "tack.refCounter".into(),
                            version,
                            value,
                        },
                        seq,
                        visible: true,
                    },
                );
            }
        }
        let count = workspace
            .records
            .values()
            .filter(|r| !r.record.value.is_null())
            .count();
        let bytes = workspace
            .records
            .values()
            .map(|r| serde_json::to_vec(&r.record.value).unwrap().len())
            .sum::<usize>();
        if count > self.limits.0 || bytes > self.limits.1 {
            return error(413);
        }
        self.seq = seq;
        self.workspaces
            .insert(session.workspace.clone(), workspace.clone());
        let mut cursor = input
            .get("cursor")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let mut rows = workspace
            .records
            .values()
            .filter(|r| r.seq > cursor)
            .collect::<Vec<_>>();
        rows.sort_by_key(|r| r.seq);
        let mut changes = vec![];
        let mut bytes = 0;
        let mut more = false;
        for (i, row) in rows.into_iter().enumerate() {
            let size = if row.record.value.is_null() {
                0
            } else {
                serde_json::to_vec(&row.record.value).unwrap().len()
            };
            if i >= 200 || (bytes + size > 3_000_000 && !changes.is_empty()) {
                more = true;
                break;
            }
            cursor = row.seq;
            if !row.visible {
                continue;
            }
            bytes += size;
            changes.push(row.record.clone());
        }
        (
            200,
            json!({"changes":changes,"cursor":cursor,"more":more,"conflicts":conflicts,"userId":"user-1","workspaceId":session.workspace,"referenceIssues":[],"access":null,"accessReset":false}),
        )
    }
}
pub(super) fn workspace(id: &str) -> Value {
    json!({"id":id,"name":if id=="personal"{"Personal"}else{"Team"},"role":"owner","displayName":"Fixture","userId":"user-1","sessionEpoch":1})
}
fn error(status: u16) -> (u16, Value) {
    (
        status,
        json!({"error":"Synthetic server detail (never shown or logged by Nabbit)"}),
    )
}

pub(super) struct Fake {
    pub state: Arc<Mutex<State>>,
    server: Arc<Server>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
    pub endpoint: Endpoint,
}
impl Fake {
    pub fn start() -> Self {
        let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
        let address = server.server_addr().to_ip().unwrap();
        assert!(address.ip().is_loopback());
        let endpoint = Endpoint::loopback(&format!("http://{address}/tack/")).unwrap();
        let state = Arc::new(Mutex::new(State {
            limits: (15_000, 100 * 1024 * 1024),
            ..State::default()
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let (worker, shared, signal) = (server.clone(), state.clone(), stop.clone());
        let thread = thread::spawn(move || {
            while !signal.load(Ordering::Acquire) {
                if let Ok(Some(request)) = worker.recv_timeout(Duration::from_millis(100)) {
                    handle(request, &mut shared.lock().unwrap());
                }
            }
        });
        Self {
            state,
            server,
            stop,
            thread: Some(thread),
            endpoint,
        }
    }
    pub fn fault(&self, status: u16, value: Value, headers: Vec<(String, String)>) {
        self.state.lock().unwrap().fault = Some(Fault {
            status,
            value,
            headers,
        });
    }
}
impl Drop for Fake {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.server.unblock();
        if let Some(worker) = self.thread.take() {
            worker.join().unwrap();
        }
    }
}
fn header(request: &Request, name: &'static str) -> String {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().to_owned())
        .unwrap_or_default()
}
fn handle(mut request: Request, state: &mut State) {
    state.requests += 1;
    let action = request
        .url()
        .split_once("action=")
        .map(|(_, a)| a.split('&').next().unwrap_or(""))
        .unwrap_or("")
        .to_owned();
    state.actions.push(action.clone());
    if let Some(fault) = state.fault.take() {
        respond(request, fault.status, fault.value, fault.headers);
        return;
    }
    if !request.url().starts_with("/tack/api/index.php?") {
        let (status, value) = error(404);
        respond(request, status, value, vec![]);
        return;
    }
    let supplied = header(&request, "Cookie")
        .split(';')
        .find_map(|part| part.trim().strip_prefix("tack_sid=").map(str::to_owned));
    let mut sid = supplied
        .filter(|id| state.sessions.contains_key(id))
        .unwrap_or_default();
    let mut headers = vec![];
    if sid.is_empty() {
        sid = state.token("sid");
        let csrf = state.token("csrf");
        state.sessions.insert(
            sid.clone(),
            Session {
                csrf,
                signed_in: false,
                workspace: "personal".into(),
            },
        );
        headers.push(session_cookie(&sid));
    }
    let mut session = state.sessions.get(&sid).unwrap().clone();
    let (status, value) = if action == "status" && request.method() == &Method::Get {
        (200, state.connection(&session))
    } else if request.method() != &Method::Post {
        error(405)
    } else if header(&request, "X-CSRF-Token") != session.csrf {
        error(403)
    } else {
        let mut raw = Vec::new();
        let read = request
            .as_reader()
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut raw);
        if action == "sync" {
            state.sync_bytes.push(raw.len());
        }
        if read.is_err() || raw.len() > 8 * 1024 * 1024 {
            error(413)
        } else if let Ok(input) = serde_json::from_slice::<Value>(&raw) {
            if action == "login" {
                let name = input.get("username").and_then(Value::as_str).unwrap_or("");
                let password = input.get("password").and_then(Value::as_str).unwrap_or("");
                if state.rate("ip".into(), 60) || state.rate(format!("account:{name}"), 10) {
                    headers.push(("Retry-After".into(), "900".into()));
                    error(429)
                } else if name != "fixture"
                    || Sha256::digest(password.as_bytes()) != Sha256::digest(PASSWORD.as_bytes())
                {
                    error(401)
                } else {
                    state.sessions.remove(&sid);
                    sid = state.token("sid");
                    session.csrf = state.token("csrf");
                    session.signed_in = true;
                    session.workspace = "personal".into();
                    let recovery = if state.confirmed {
                        Value::Null
                    } else {
                        let code = state.token("recovery");
                        state.recovery_hash = Sha256::digest(code.as_bytes()).to_vec();
                        json!(code)
                    };
                    state.sessions.insert(sid.clone(), session.clone());
                    headers.push(session_cookie(&sid));
                    (
                        200,
                        json!({"user":{"id":"user-1","username":"fixture"},"workspace":workspace("personal"),"workspaces":[workspace("personal"),workspace("team")],"csrf":session.csrf,"recoveryCode":recovery}),
                    )
                }
            } else if action == "logout" {
                state.sessions.remove(&sid);
                (200, json!({"ok":true}))
            } else if !session.signed_in {
                error(401)
            } else if header(&request, "X-Workspace-User") != "user-1" {
                error(409)
            } else if action == "recovery-confirm" {
                if input.get("saved") != Some(&json!(true)) {
                    error(400)
                } else if Sha256::digest(
                    input
                        .get("code")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .as_bytes(),
                )
                .as_slice()
                    != state.recovery_hash
                {
                    error(409)
                } else {
                    state.confirmed = true;
                    (200, json!({"ok":true}))
                }
            } else if !state.confirmed {
                error(428)
            } else if header(&request, "X-Tack-Workspace") != session.workspace {
                error(409)
            } else if action == "workspace-switch" {
                let id = input.get("id").and_then(Value::as_str).unwrap_or("");
                if !["personal", "team"].contains(&id) {
                    (
                        403,
                        json!({"workspaceAccessChanged":true,"workspaceId":id,"userId":"user-1"}),
                    )
                } else {
                    session.workspace = id.into();
                    state.sessions.insert(sid, session.clone());
                    (
                        200,
                        json!({"workspace":workspace(id),"workspaces":[workspace("personal"),workspace("team")]}),
                    )
                }
            } else if action == "sync" {
                state.sync_calls += 1;
                let writes = input
                    .get("mutations")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                state.batches.push(writes);
                state.cursors.push(
                    input
                        .get("cursor")
                        .and_then(Value::as_u64)
                        .unwrap_or_default(),
                );
                if let Some((at, status)) =
                    state.fail_sync_at.filter(|(at, _)| *at == state.sync_calls)
                {
                    let _ = at;
                    state.fail_sync_at = None;
                    error(status)
                } else {
                    let result = state.sync(&session, input);
                    if writes > 0 && result.0 == 200 {
                        if let Some(hook) = state.after_write.take() {
                            hook();
                        }
                        if let Some(status) = state.after_commit_fault.take() {
                            respond(request, status, error(status).1, headers);
                            return;
                        }
                    }
                    result
                }
            } else {
                error(404)
            }
        } else {
            error(400)
        }
    };
    respond(request, status, value, headers);
}
fn session_cookie(sid: &str) -> (String, String) {
    (
        "Set-Cookie".into(),
        format!(
            "tack_sid={sid}; Path=/tack/; Expires={}; HttpOnly; SameSite=Lax",
            (chrono::Utc::now() + chrono::Duration::days(30)).format("%a, %d %b %Y %H:%M:%S GMT")
        ),
    )
}
fn respond(request: Request, status: u16, value: Value, headers: Vec<(String, String)>) {
    let mut response = Response::from_string(serde_json::to_string(&value).unwrap())
        .with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap());
    for (name, value) in headers {
        response.add_header(Header::from_bytes(name, value).unwrap());
    }
    let _ = request.respond(response);
}
