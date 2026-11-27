//! Test-only browser-to-service bridge. The production app has no bridge,
//! plaintext vault, loopback override, fault injector or acceptance endpoint.
use super::{fake::Fake, MemoryVault};
use crate::{
    db::Database,
    notes::{preferences::Setup, store::NoteDraft},
    tack::{
        model::{Error, ErrorCode, Result},
        service::Service,
        session::Password,
    },
};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tiny_http::{Header, Response, Server};
use zeroize::Zeroizing;
const ALIAS: &str = "https://fixture.invalid/tack/";
fn encode<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| Error::new(ErrorCode::InvalidResponse))
}
fn stream(
    request: tiny_http::Request,
    origin: &str,
    receiver: mpsc::Receiver<String>,
    stop: Arc<AtomicBool>,
) -> std::io::Result<()> {
    // tiny_http's generic streaming response buffers chunked bodies. Native
    // Tauri events are immediate: flush each owned test-bridge event explicitly.
    let mut writer = request.into_writer();
    write!(writer,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: {origin}\r\nVary: Origin\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")?;
    writer.flush()?;
    while !stop.load(Ordering::Acquire) {
        let text = match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(value) => value,
            Err(mpsc::RecvTimeoutError::Timeout) => ": waiting\n\n".into(),
            Err(_) => break,
        };
        write!(writer, "{:x}\r\n", text.len())?;
        writer.write_all(text.as_bytes())?;
        writer.write_all(b"\r\n")?;
        writer.flush()?;
    }
    writer.write_all(b"0\r\n\r\n")?;
    writer.flush()
}
fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}
fn rewrite(value: &mut Value, actual: &str) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if key == "baseUrl" && value.as_str() == Some(actual) {
                    *value = json!(ALIAS);
                } else {
                    rewrite(value, actual);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                rewrite(item, actual)
            }
        }
        _ => {}
    }
}
#[test]
#[ignore = "Owned browser automation invokes this test with an isolated bridge directory and origin"]
fn browser_connection_bridge() {
    let directory = std::path::PathBuf::from(
        std::env::var("NABBIT_TACK_TEST_BRIDGE_DIR").expect("owned test directory"),
    );
    assert!(directory.is_absolute());
    std::fs::create_dir_all(&directory).unwrap();
    let origin = std::env::var("NABBIT_TACK_TEST_ORIGIN").expect("owned loopback preview origin");
    assert!(origin.starts_with("http://127.0.0.1:"));
    assert_eq!(
        url::Url::parse(&origin)
            .unwrap()
            .origin()
            .ascii_serialization(),
        origin
    );
    let fake = Arc::new(Fake::start());
    let db = Database::open(&directory.join("profile")).unwrap();
    db.create_note_card(NoteDraft {
        title: "Local to upload".into(),
        body: "Preserved before connecting".into(),
        ..Default::default()
    })
    .unwrap();
    let token = uuid::Uuid::new_v4().to_string();
    let stop = Arc::new(AtomicBool::new(false));
    let subscribers = Arc::new(Mutex::new(Vec::<mpsc::Sender<String>>::new()));
    let events = subscribers.clone();
    let observed = db.clone();
    let revision = AtomicU64::new(db.tack_data_revision().unwrap());
    let service = Service::test_connection(
        db.clone(),
        fake.endpoint.clone(),
        Arc::new(MemoryVault::default()),
        Arc::new(move |snapshot| {
            let mut packets = vec![json!({"event":"tack:sync","payload":snapshot})];
            let next = observed.tack_data_revision().unwrap();
            if next > revision.fetch_max(next, Ordering::AcqRel) {
                packets.push(json!({"event":"notes:updated","payload":null}));
            }
            let data = packets
                .into_iter()
                .map(|packet| format!("data: {packet}\n\n"))
                .collect::<String>();
            events
                .lock()
                .unwrap()
                .retain(|sender| sender.send(data.clone()).is_ok());
        }),
    )
    .unwrap();
    let server = Server::http("127.0.0.1:0").unwrap();
    let address = server.server_addr().to_ip().unwrap();
    assert!(address.ip().is_loopback());
    let mut info = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join("info.json"))
        .unwrap();
    serde_json::to_writer(
        &mut info,
        &json!({"url":format!("http://{address}"),"token":token,"alias":ALIAS}),
    )
    .unwrap();
    info.flush().unwrap();
    let copied = Arc::new(AtomicU64::new(0));
    let sticky = Arc::new(super::sticky_bridge::Windows::default());
    let links = Arc::new(super::links_bridge::Fixture::new(&directory));
    let mut workers = vec![];
    while !stop.load(Ordering::Acquire) {
        let Some(mut request) = server.recv_timeout(Duration::from_millis(100)).unwrap() else {
            continue;
        };
        let (service, db, fake, stop, events, copied, token, origin, sticky, links) = (
            service.clone(),
            db.clone(),
            fake.clone(),
            stop.clone(),
            subscribers.clone(),
            copied.clone(),
            token.clone(),
            origin.clone(),
            sticky.clone(),
            links.clone(),
        );
        workers.push(std::thread::spawn(move||{
            let cors=vec![header("Access-Control-Allow-Origin",&origin),header("Vary","Origin"),header("Access-Control-Allow-Headers","Content-Type, X-Nabbit-Test"),header("Access-Control-Allow-Methods","POST, GET, OPTIONS")];
            if request.method()==&tiny_http::Method::Options {let mut response=Response::empty(204);for h in cors{response.add_header(h);}request.respond(response).unwrap();return;}
            let authorized=request.headers().iter().any(|h|h.field.equiv("X-Nabbit-Test")&&h.value.as_str()==token);
            let allowed_origin=request.headers().iter().find(|h|h.field.equiv("Origin")).is_none_or(|h|h.value.as_str()==origin);
            if !authorized||!allowed_origin {let _=request.respond(Response::empty(403));return;}
            if request.url()=="/events" {
                let (sender,receiver)=mpsc::channel();sender.send(": connected\n\n".into()).unwrap();events.lock().unwrap().push(sender);
                let _=stream(request,&origin,receiver,stop);return;
            }
            let mut raw=Zeroizing::new(Vec::new());request.as_reader().take(1024*1024).read_to_end(&mut raw).unwrap();
            let mut input:Value=serde_json::from_slice(&raw).unwrap_or(Value::Null);
            let window_label=input.get("window").and_then(Value::as_str).unwrap_or("main").to_string();
            let command=input.get("command").and_then(Value::as_str).unwrap_or("").to_owned();let mut args=input.get_mut("args").and_then(Value::as_object_mut).map(std::mem::take).unwrap_or_default();
            let result:Result<Value>=(||{
                match command.as_str(){
                    "tack_status"=>{if args.get("baseUrl").and_then(Value::as_str)!=Some(ALIAS){return Err(Error::new(ErrorCode::InvalidServer));}encode(service.status(fake.endpoint.base().as_str())?)},
                    "tack_snapshot"=>encode(service.snapshot()?),
                    "tack_profile"=>encode(service.profile()?),
                    "tack_sync_snapshot"=>encode(service.sync_snapshot()?),
                    "tack_sync_now"=>{service.request_sync();encode(service.sync_snapshot()?)},
                    "tack_conflicts"=>{let scope=serde_json::from_value(args.remove("scope").unwrap_or(Value::Null)).map_err(|_|Error::new(ErrorCode::InvalidInput))?;encode(service.conflicts(&scope)?)},
                    "tack_resolve_conflict"=>{let scope=serde_json::from_value(args.remove("scope").unwrap_or(Value::Null)).map_err(|_|Error::new(ErrorCode::InvalidInput))?;let choice=serde_json::from_value(args.remove("choice").unwrap_or(Value::Null)).map_err(|_|Error::new(ErrorCode::InvalidInput))?;service.resolve(&scope,args.get("table").and_then(Value::as_str).unwrap_or(""),args.get("id").and_then(Value::as_str).unwrap_or(""),args.get("token").and_then(Value::as_str).unwrap_or(""),args.get("remoteVersion").and_then(Value::as_u64).unwrap_or(0),choice)?;Ok(Value::Null)},
                    "tack_workspace_profile"=>encode(service.workspace_profile(args.get("id").and_then(Value::as_str).unwrap_or(""))?),
                    "tack_login"=>{let password=args.remove("password").and_then(|v|v.as_str().map(str::to_owned)).unwrap_or_default();encode(service.login(args.get("username").and_then(Value::as_str).unwrap_or(""),Password::new(password))?)},
                    "tack_confirm_recovery"=>encode(service.confirm(args.remove("code").and_then(|v|v.as_str().map(str::to_owned)).unwrap_or_default())?),
                    "tack_copy_recovery"=>{if args.get("code").and_then(Value::as_str).is_none_or(str::is_empty){return Err(Error::new(ErrorCode::InvalidInput));}copied.fetch_add(1,Ordering::AcqRel);Ok(Value::Null)},
                    "tack_start_sync"=>{let mut setup:Setup=serde_json::from_value(args.remove("request").unwrap_or(Value::Null)).map_err(|_|Error::new(ErrorCode::InvalidInput))?;if setup.expected_base_url!=ALIAS{return Err(Error::new(ErrorCode::InvalidServer));}setup.expected_base_url=fake.endpoint.base().to_string();encode(service.start_scope(setup)?)},
                    "tack_logout"=>encode(service.logout()?),
                    "tack_local_mode"=>{service.local_mode()?;Ok(Value::Null)},
                    "tack_open"=>Ok(Value::Null), // Never opens a browser or a user account.
                    "get_notes_state"=>encode(db.notes_state()?),
                    "capture_note"=>{let request=serde_json::from_value(args.remove("request").unwrap_or(Value::Null)).map_err(|_|Error::new(ErrorCode::InvalidInput))?;let saved=db.capture_note(request)?;service.edited();encode(saved)},
                    "notes_open"=>{let intent=serde_json::from_value(args.remove("intent").unwrap_or(Value::Null)).map_err(|_|Error::new(ErrorCode::InvalidInput))?;db.queue_notes_intent(intent)?;Ok(Value::Null)},
                    "take_notes_intent"=>encode(db.take_notes_intent()?),
                    "get_note_editor"=>{let scope:Option<crate::notes::sync_store::Context>=serde_json::from_value(args.remove("expectedScope").unwrap_or(Value::Null)).map_err(|_|Error::new(ErrorCode::InvalidInput))?;encode(db.note_editor(args.get("id").and_then(Value::as_str).unwrap_or(""),scope.as_ref())?)},
                    "save_note_editor"=>{let request=serde_json::from_value(args.remove("request").unwrap_or(Value::Null)).map_err(|_|Error::new(ErrorCode::InvalidInput))?;let saved=db.save_note_editor(request)?;service.edited();encode(saved)},
                    "update_note_card"=>{let scope:Option<crate::notes::sync_store::Context>=serde_json::from_value(args.remove("expectedScope").unwrap_or(Value::Null)).map_err(|_|Error::new(ErrorCode::InvalidInput))?;let saved=db.update_note_card_in(args.get("id").and_then(Value::as_str).unwrap_or(""),args.get("expectedRevision").and_then(Value::as_u64).unwrap_or(0),scope.as_ref(),args.get("expectedEditToken").and_then(Value::as_str),args.get("patch").cloned().unwrap_or(Value::Null))?;service.edited();encode(saved)},
                    "test.remote_edit"=>{let table=args.get("table").and_then(Value::as_str).unwrap_or("cards");let id=args.get("id").and_then(Value::as_str).unwrap_or("");let patch=args.get("patch").and_then(Value::as_object).ok_or_else(||Error::new(ErrorCode::InvalidInput))?;let mut client=super::client(&fake,Arc::new(MemoryVault::default()));super::login(&mut client);let mut cursor=0;let remote=loop{let page=client.sync(cursor,&[])?;if let Some(record)=page.changes.into_iter().find(|r|r.table==table&&r.id==id){break record;}
if !page.more{return Err(Error::new(ErrorCode::InvalidInput));}cursor=page.cursor;};let mut value=remote.value.clone();value.as_object_mut().ok_or_else(||Error::new(ErrorCode::InvalidInput))?.extend(patch.clone());value["revision"]=json!(value["revision"].as_u64().unwrap_or(0)+1);encode(client.sync(0,&[crate::tack::model::Mutation{table:table.into(),id:id.into(),base_version:remote.version,base_value:remote.value,value}])?)},
                    "list_note_cards"=>encode(db.list_note_cards()?),
                    "create_note_card"=>{let draft:NoteDraft=serde_json::from_value(args.remove("draft").unwrap_or(Value::Null)).map_err(|_|Error::new(ErrorCode::InvalidInput))?;let scope:Option<crate::notes::sync_store::Context>=serde_json::from_value(args.remove("expectedScope").unwrap_or(Value::Null)).map_err(|_|Error::new(ErrorCode::InvalidInput))?;encode(db.create_note_card_in(draft,scope.as_ref())?)},
                    "test.inspect"=>{let state=fake.state.lock().unwrap();Ok(json!({"syncCalls":state.sync_calls,"batches":state.batches,"actions":state.actions,"copyCount":copied.load(Ordering::Acquire),"notes":db.notes_state()?.cards,"profile":service.profile()?,"sync":service.sync_snapshot()?,"enabled":db.tack_enabled()?}))},
                    "test.fault"=>{let status=args.get("status").and_then(Value::as_u64).unwrap_or(503)as u16;let headers=if status==429 {vec![("Retry-After".into(),"1".into())]}else{vec![]};let body=if args.get("accessChanged").and_then(Value::as_bool)==Some(true){json!({"workspaceAccessChanged":true,"workspaceId":"elsewhere"})}else{json!({"error":"untrusted fixture response detail"})};fake.fault(status,body,headers);Ok(Value::Null)},
                    "test.stop"=>{stop.store(true,Ordering::Release);Ok(Value::Null)},
                    _ if super::links_bridge::handles(&command) => super::links_bridge::route(&db,&service,&links,&window_label,&command,args,&events),
                    _=>super::sticky_bridge::route(&db,&service,&sticky,&window_label,&command,args),
                }
            })();
            let mut reply=match result{Ok(value)=>json!({"ok":true,"value":value}),Err(error)=>json!({"ok":false,"error":error})};rewrite(&mut reply,fake.endpoint.base().as_str());
            let mut response=Response::from_string(reply.to_string()).with_header(header("Content-Type","application/json"));for h in cors{response.add_header(h);}let _=request.respond(response);
        }));
    }
    service.stop();
    for worker in workers {
        worker.join().unwrap();
    }
}
