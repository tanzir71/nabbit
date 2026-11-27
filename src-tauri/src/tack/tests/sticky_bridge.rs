//! Browser acceptance seam for the window-bound sticky API. Real native
//! lifecycle/styles are verified by the owned HWND smoke, not this adapter.
use crate::{
    db::Database,
    notes::{store::StoredNote, sync_store::Context},
    sticky::{geometry::Profile, store::Draft, Binding},
    tack::{
        model::{Error, ErrorCode, Result},
        service::Service,
    },
};
use serde_json::{json, Map, Value};
use std::{collections::HashMap, sync::Mutex};
#[derive(Clone)]
struct Bound {
    binding: Binding,
    profile: Profile,
}
#[derive(Default)]
pub(super) struct Windows(Mutex<HashMap<String, Bound>>);
fn encode<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| Error::new(ErrorCode::InvalidResponse))
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| Error::new(ErrorCode::InvalidInput))
}
fn bind(db: &Database, windows: &Windows, id: &str, scope: Option<Context>) -> Result<String> {
    let note = db.note_editor(id, scope.as_ref())?.note;
    let mut map = windows.0.lock().unwrap();
    if let Some((label, _)) = map
        .iter()
        .find(|(_, w)| w.binding.card_id == id && w.binding.scope == scope)
    {
        return Ok(label.clone());
    }
    let label = format!("sticky-acceptance-{}", uuid::Uuid::new_v4());
    let binding = Binding {
        instance: uuid::Uuid::new_v4().to_string(),
        card_id: id.into(),
        scope,
    };
    let profile = Profile {
        monitor: "acceptance-display".into(),
        x: 32.,
        y: 64.,
        width: 280.,
        height: 200.,
        pinned: true,
        opacity: 100,
    };
    db.sticky_remember(&binding, &profile, true, Some(&note))?;
    map.insert(label.clone(), Bound { binding, profile });
    Ok(label)
}
fn snapshot(db: &Database, value: &Bound) -> Result<Value> {
    Ok(
        json!({"binding":value.binding,"profile":value.profile,"content":db.sticky_content(&value.binding)?,"theme":db.get_settings()?.theme,"nativeOpacity":false,"monitors":[{"id":"acceptance-display","name":"Fixture display","primary":true,"scaleFactor":1}]}),
    )
}
pub(super) fn route(
    db: &Database,
    service: &Service,
    windows: &Windows,
    label: &str,
    command: &str,
    mut args: Map<String, Value>,
) -> Result<Value> {
    if command == "open_sticky" || command == "test.bind_sticky" {
        let scope = decode(args.remove("expectedScope").unwrap_or(Value::Null))?;
        return encode(bind(
            db,
            windows,
            args.get("id").and_then(Value::as_str).unwrap_or(""),
            scope,
        )?);
    }
    if !command.starts_with("sticky_") {
        return Err(Error::new(ErrorCode::InvalidInput));
    }
    let value = windows
        .0
        .lock()
        .unwrap()
        .get(label)
        .cloned()
        .ok_or_else(|| Error::new(ErrorCode::InvalidInput))?;
    if !["sticky_snapshot", "sticky_drag", "sticky_leave"].contains(&command)
        && args.get("instance").and_then(Value::as_str) != Some(&value.binding.instance)
    {
        return Err(Error::new(ErrorCode::InvalidInput));
    }
    let sequence = args.get("sequence").and_then(Value::as_u64).unwrap_or(0);
    match command {
        "sticky_snapshot" => snapshot(db, &value),
        "sticky_ready" | "sticky_drag" => Ok(Value::Null), // No native-window claim.
        "sticky_checkpoint" => {
            let draft: Draft = decode(args.remove("draft").unwrap_or(Value::Null))?;
            db.sticky_checkpoint(&value.binding, sequence, draft)?;
            Ok(Value::Null)
        }
        "sticky_clear_checkpoint" => {
            db.sticky_clear_checkpoint(&value.binding, sequence)?;
            Ok(Value::Null)
        }
        "sticky_save" => {
            let base: StoredNote = decode(args.remove("base").unwrap_or(Value::Null))?;
            let saved = db.sticky_save_bound(
                &value.binding,
                base,
                args.remove("patch").unwrap_or(Value::Null),
            )?;
            service.edited();
            db.sticky_clear_checkpoint(&value.binding, sequence)?;
            encode(saved)
        }
        "sticky_reload" => {
            let scope = db.notes_state()?.scope;
            if crate::sticky::store::scope_key(scope.as_ref())
                != crate::sticky::store::scope_key(value.binding.scope.as_ref())
            {
                return Err(Error::new(ErrorCode::WorkspaceChanged));
            }
            db.note_editor(&value.binding.card_id, scope.as_ref())?;
            db.sticky_discard_checkpoint(&value.binding)?;
            let mut next = value;
            next.binding.scope = scope;
            windows.0.lock().unwrap().insert(label.into(), next.clone());
            snapshot(db, &next)
        }
        "sticky_close" | "sticky_leave" => {
            if args.get("discard").and_then(Value::as_bool) == Some(true) {
                db.sticky_discard_checkpoint(&value.binding)?;
            }
            db.sticky_remember(&value.binding, &value.profile, false, None)?;
            windows.0.lock().unwrap().remove(label);
            Ok(Value::Null)
        }
        "sticky_save_as_new" => {
            let saved = db.capture_note(decode(args.remove("request").unwrap_or(Value::Null))?)?;
            service.edited();
            encode(bind(
                db,
                windows,
                saved.value["id"].as_str().unwrap_or(""),
                saved.scope,
            )?)
        }
        _ => Err(Error::new(ErrorCode::InvalidInput)),
    }
}
