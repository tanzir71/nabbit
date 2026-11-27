use super::model::*;
use crate::{
    db::Database,
    error::{msg, Result},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedCard {
    pub id: String,
    pub expected_scope: Option<crate::notes::sync_store::Context>,
    pub reference: String,
    pub title: String,
}
pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS focus_sessions(id TEXT PRIMARY KEY,label TEXT NOT NULL,card_id TEXT,started_at TEXT NOT NULL,planned_s INTEGER NOT NULL,ended_at TEXT,phase TEXT NOT NULL,outcome TEXT NOT NULL,card_scope TEXT); CREATE TABLE IF NOT EXISTS focus_timer(singleton INTEGER PRIMARY KEY CHECK(singleton=1),value TEXT NOT NULL);")?;
    Ok(())
}
pub fn load(db: &Database) -> Result<Model> {
    let conn = db.conn.lock().map_err(|_| msg("database lock poisoned"))?;
    let raw: Option<String> = conn
        .query_row("SELECT value FROM focus_timer WHERE singleton=1", [], |r| {
            r.get(0)
        })
        .optional()?;
    let model: Model = raw
        .map(|v| serde_json::from_str(&v))
        .transpose()?
        .unwrap_or_default();
    model.config.validate().map_err(msg)?;
    if let Some(s) = &model.session {
        if s.id.is_empty()
            || s.round == 0
            || s.round > model.config.rounds
            || s.planned_s == 0
            || s.planned_s > 86400
            || s.remaining_ms < 0
            || (s.status == Status::Running && s.deadline_ms.is_none())
            || (s.status == Status::Paused && s.deadline_ms.is_some())
            || (s.status == Status::Ended && s.ended_at_ms.is_none())
        {
            return Err(msg("Invalid saved focus timer."));
        }
    }
    Ok(model)
}
pub fn linked(db: &Database, binding: &CardLink) -> Result<LinkedCard> {
    let conn = db.conn.lock().map_err(|_| msg("database lock poisoned"))?;
    crate::notes::sync_store::ensure(&conn, binding.expected_scope.as_ref())?;
    let key = binding
        .expected_scope
        .as_ref()
        .map_or("", |c| c.key.as_str());
    let raw: String = conn
        .query_row(
            "SELECT value FROM note_cards WHERE scope=?1 AND id=?2",
            params![key, binding.id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| msg("The linked card is unavailable."))?;
    let v: serde_json::Value = serde_json::from_str(&raw)?;
    if !v["trashedAt"].is_null() {
        return Err(msg("The linked card is in Trash."));
    }
    Ok(LinkedCard {
        id: binding.id.clone(),
        expected_scope: binding.expected_scope.clone(),
        reference: v["ref"].as_str().unwrap_or("").chars().take(80).collect(),
        title: v["title"]
            .as_str()
            .unwrap_or("Untitled card")
            .chars()
            .take(200)
            .collect(),
    })
}
fn timestamp(ms: i64) -> Result<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|v| v.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| msg("Invalid timer date."))
}
pub fn save(db: &Database, old: &Model, next: &Model, now: i64) -> Result<()> {
    let mut conn = db.conn.lock().map_err(|_| msg("database lock poisoned"))?;
    let tx = conn.transaction()?;
    if let Some(previous) = &old.session {
        if next.session.as_ref().map(|s| &s.id) != Some(&previous.id)
            && previous.status != Status::Ended
        {
            tx.execute(
                "UPDATE focus_sessions SET ended_at=?2,outcome='stopped' WHERE id=?1",
                params![previous.id, timestamp(now)?],
            )?;
        }
    }
    if let Some(s) = &next.session {
        let scope = next
            .config
            .card
            .as_ref()
            .and_then(|c| c.expected_scope.as_ref())
            .map(|c| c.key.clone());
        let card = next.config.card.as_ref().map(|c| c.id.clone());
        tx.execute("INSERT INTO focus_sessions(id,label,card_id,started_at,planned_s,ended_at,phase,outcome,card_scope) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at,outcome=excluded.outcome,card_id=excluded.card_id,card_scope=excluded.card_scope",params![s.id,next.config.label,card,timestamp(s.started_at_ms)?,s.planned_s,s.ended_at_ms.map(timestamp).transpose()?,if s.phase==Phase::Focus {"focus"} else {"break"},if s.status==Status::Ended {"completed"} else {"active"},scope])?;
    }
    tx.execute("INSERT INTO focus_timer(singleton,value) VALUES(1,?1) ON CONFLICT(singleton) DO UPDATE SET value=excluded.value",[serde_json::to_string(next)?])?;
    tx.commit()?;
    Ok(())
}
