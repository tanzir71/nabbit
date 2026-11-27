use super::paths;
use crate::{
    db::Database,
    error::{msg, Result},
    pins::Pin,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinView {
    #[serde(flatten)]
    pub pin: Pin,
    pub always_move: bool,
    pub available: bool,
    pub cloud: bool,
    pub network: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinDraft {
    pub id: Option<String>,
    pub path: String,
    pub label: Option<String>,
    pub slot: Option<u8>,
    pub always_move: bool,
}
pub fn list(db: &Database) -> Result<Vec<PinView>> {
    let pins = db.list_pins()?;
    let verbs: std::collections::HashMap<String, Option<String>> = {
        let conn = db.conn.lock().map_err(|_| msg("Database unavailable"))?;
        let mut stmt = conn.prepare("SELECT id,verb FROM pins")?;
        let values = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        values
    };
    Ok(pins
        .into_iter()
        .map(|pin| {
            let facts = paths::facts(&pin.path).ok();
            PinView {
                always_move: verbs.get(&pin.id).and_then(|v| v.as_deref()) == Some("move"),
                available: facts
                    .as_ref()
                    .is_some_and(|f| f.directory == (pin.kind == "folder")),
                cloud: facts.as_ref().is_some_and(|f| f.cloud),
                network: facts.as_ref().is_some_and(|f| f.network),
                pin,
            }
        })
        .collect())
}
pub fn save(db: &Database, draft: PinDraft) -> Result<String> {
    if draft.slot.is_some_and(|n| !(1..=9).contains(&n)) {
        return Err(msg("Choose a slot from 1 to 9"));
    }
    let label = draft
        .label
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if label
        .as_ref()
        .is_some_and(|s| s.len() > 200 || s.contains(['\0', '\n', '\r']))
    {
        return Err(msg("Use a pin name under 200 characters"));
    }
    let path = paths::canonical(&draft.path)?;
    let facts = paths::facts(&path)?;
    let mut conn = db.conn.lock().map_err(|_| msg("Database unavailable"))?;
    let tx = conn.transaction()?;
    let new_pin = draft.id.is_none();
    let slot = if new_pin && draft.slot.is_none() {
        let mut stmt = tx.prepare("SELECT slot FROM pins WHERE slot IS NOT NULL")?;
        let used = stmt
            .query_map([], |r| r.get::<_, u8>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        (1..=9).find(|slot| !used.contains(slot))
    } else {
        draft.slot
    };
    let (id, oldslot) = if let Some(id) = draft.id {
        let old: Option<Option<u8>> = tx
            .query_row("SELECT slot FROM pins WHERE id=?1", [&id], |r| r.get(0))
            .optional()?;
        (id, old.ok_or_else(|| msg("This pin was removed"))?)
    } else {
        let count: usize = tx.query_row("SELECT COUNT(*) FROM pins", [], |r| r.get(0))?;
        if count >= 256 {
            return Err(msg("You can keep up to 256 pins"));
        }
        (uuid::Uuid::new_v4().to_string(), None)
    };
    let duplicate: bool = tx.query_row(
        if cfg!(windows) {
            "SELECT EXISTS(SELECT 1 FROM pins WHERE lower(path)=lower(?1) AND id<>?2)"
        } else {
            "SELECT EXISTS(SELECT 1 FROM pins WHERE path=?1 AND id<>?2)"
        },
        params![path, id],
        |r| r.get(0),
    )?;
    if duplicate {
        return Err(msg("This path is already pinned"));
    }
    tx.execute("UPDATE pins SET slot=NULL WHERE id=?1", [&id])?;
    if let Some(slot) = slot {
        tx.execute(
            "UPDATE pins SET slot=?1 WHERE slot=?2",
            params![oldslot, slot],
        )?;
    }
    tx.execute("INSERT INTO pins(id,kind,path,label,slot,verb,added_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,path=excluded.path,label=excluded.label,slot=excluded.slot,verb=excluded.verb",params![id,if facts.directory{"folder"}else{"file"},path,label,slot,if draft.always_move{Some("move")}else{None},chrono::Utc::now().to_rfc3339()])?;
    tx.commit()?;
    Ok(id)
}
pub fn remove(db: &Database, id: &str) -> Result<()> {
    db.conn
        .lock()
        .map_err(|_| msg("Database unavailable"))?
        .execute("DELETE FROM pins WHERE id=?1", [id])?;
    Ok(())
}
pub fn always_move(db: &Database, id: &str) -> Result<bool> {
    let verb: Option<String> = db
        .conn
        .lock()
        .map_err(|_| msg("Database unavailable"))?
        .query_row("SELECT verb FROM pins WHERE id=?1", [id], |r| r.get(0))?;
    Ok(verb.as_deref() == Some("move"))
}
