//! Durable workspace boundaries, merge bases and queue transactions.
use crate::{
    db::Database,
    error::{msg, Result},
    tack::model::{Mutation, Record, SyncReply},
};
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub key: String,
    pub epoch: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub base_url: String,
    pub user_id: String,
    pub workspace_id: String,
}
impl Identity {
    pub fn key(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(self).expect("identity serialization"))
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Queued {
    pub token: String,
    pub mutation: Mutation,
    pub attempts: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub scope: Context,
    pub table: String,
    pub id: String,
    pub token: String,
    pub local: Value,
    pub remote: Record,
}
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Resolution {
    KeepLocal,
    UseRemote,
}
#[derive(Default)]
pub(crate) struct Summary {
    pub scope: Option<Context>,
    pub pending: u64,
    pub conflicts: u64,
    pub reference_issues: u64,
    pub last_synced: Option<String>,
}
pub(crate) fn stamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn migrate(conn: &mut Connection) -> Result<()> {
    let scoped = conn
        .prepare("PRAGMA table_info(note_cards)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .iter()
        .any(|c| c == "scope");
    let tx = conn.transaction()?;
    if !scoped {
        tx.execute_batch("CREATE TABLE note_cards_v43(scope TEXT NOT NULL DEFAULT '',id TEXT NOT NULL,value TEXT NOT NULL,local_only INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,edit_token TEXT NOT NULL,PRIMARY KEY(scope,id));
        INSERT INTO note_cards_v43 SELECT '',id,value,local_only,updated_at,lower(hex(randomblob(16))) FROM note_cards;
        DROP TABLE note_cards;ALTER TABLE note_cards_v43 RENAME TO note_cards;")?;
    }
    tx.execute_batch("CREATE TABLE IF NOT EXISTS tack_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tack_scopes(scope TEXT PRIMARY KEY,identity TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,last_synced TEXT);
        CREATE TABLE IF NOT EXISTS tack_mirror(scope TEXT NOT NULL,tbl TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,tbl,id));
        CREATE TABLE IF NOT EXISTS tack_outbox(scope TEXT NOT NULL,tbl TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,queued_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,token TEXT NOT NULL,base_version INTEGER NOT NULL,base_value TEXT NOT NULL,PRIMARY KEY(scope,tbl,id));
        CREATE TABLE IF NOT EXISTS tack_conflicts(scope TEXT NOT NULL,tbl TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,tbl,id));
        CREATE TABLE IF NOT EXISTS tack_reference_issues(scope TEXT NOT NULL,tbl TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,tbl,id));
        CREATE TABLE IF NOT EXISTS note_reminders(scope TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,id));
        CREATE TABLE IF NOT EXISTS note_revisions(history_id TEXT PRIMARY KEY,scope TEXT NOT NULL,tbl TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,reason TEXT NOT NULL,saved_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tack_uploads(local_id TEXT PRIMARY KEY,scope TEXT NOT NULL,remote_id TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_tack_queue ON tack_outbox(scope,queued_at,tbl,id);")?;
    if meta(&tx, "editor_attachments_v45")?.is_none() {
        tx.execute("UPDATE tack_scopes SET cursor=0", [])?;
        set_meta(&tx, "editor_attachments_v45", "true")?;
    }
    tx.commit()?;
    Ok(())
}
pub(crate) fn meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM tack_meta WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional()?)
}
pub(crate) fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute("INSERT INTO tack_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value])?;
    Ok(())
}
fn epoch(conn: &Connection) -> Result<u64> {
    meta(conn, "epoch")?
        .map(|v| v.parse().map_err(|_| msg("Invalid Tack generation")))
        .unwrap_or(Ok(0))
}
fn bump(conn: &Connection) -> Result<u64> {
    let n = epoch(conn)?
        .checked_add(1)
        .ok_or_else(|| msg("Invalid Tack generation"))?;
    set_meta(conn, "epoch", &n.to_string())?;
    Ok(n)
}
fn data_revision(conn: &Connection) -> Result<u64> {
    meta(conn, "notes_revision")?
        .map(|v| v.parse().map_err(|_| msg("Invalid notes data revision")))
        .unwrap_or(Ok(0))
}
pub(crate) fn changed(conn: &Connection) -> Result<()> {
    let next = data_revision(conn)?
        .checked_add(1)
        .ok_or_else(|| msg("Notes data revision is exhausted"))?;
    set_meta(conn, "notes_revision", &next.to_string())
}
pub(crate) fn current(conn: &Connection) -> Result<Option<Context>> {
    meta(conn, "active_scope")?
        .filter(|s| !s.is_empty())
        .map(|key| epoch(conn).map(|epoch| Context { key, epoch }))
        .transpose()
}
pub(crate) fn ensure(conn: &Connection, expected: Option<&Context>) -> Result<()> {
    if current(conn)?.as_ref() != expected {
        return Err(msg("WorkspaceChanged: The Notes workspace changed. Your draft is preserved; reload this view before saving."));
    }
    Ok(())
}
pub(crate) fn queue(
    conn: &Connection,
    context: &Context,
    table: &str,
    id: &str,
    value: &Value,
) -> Result<()> {
    super::preferences::writable(conn, Some(context))?;
    let base = conn
        .query_row(
            "SELECT version,value FROM tack_mirror WHERE scope=?1 AND tbl=?2 AND id=?3",
            params![context.key, table, id],
            |r| Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
        .unwrap_or((0, "null".into()));
    conn.execute("INSERT INTO tack_outbox(scope,tbl,id,value,queued_at,token,base_version,base_value) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(scope,tbl,id) DO UPDATE SET value=excluded.value,queued_at=excluded.queued_at,token=excluded.token,attempts=0",params![context.key,table,id,value.to_string(),stamp(),Uuid::new_v4().to_string(),base.0,base.1])?;
    conn.execute(
        "DELETE FROM tack_reference_issues WHERE scope=?1 AND tbl=?2 AND id=?3",
        params![context.key, table, id],
    )?;
    Ok(())
}
fn read_queued(row: &rusqlite::Row<'_>) -> Result<Queued> {
    Ok(Queued {
        token: row.get(0)?,
        mutation: Mutation {
            table: row.get(1)?,
            id: row.get(2)?,
            base_version: row.get(3)?,
            base_value: serde_json::from_str(&row.get::<_, String>(4)?)?,
            value: serde_json::from_str(&row.get::<_, String>(5)?)?,
        },
        attempts: row.get(6)?,
    })
}
fn outbox_one(
    conn: &Connection,
    context: &Context,
    table: &str,
    id: &str,
) -> Result<Option<Queued>> {
    let mut stmt=conn.prepare("SELECT token,tbl,id,base_version,base_value,value,attempts FROM tack_outbox WHERE scope=?1 AND tbl=?2 AND id=?3")?;
    let mut rows = stmt.query(params![context.key, table, id])?;
    rows.next()?.map(read_queued).transpose()
}
#[cfg(test)]
fn outbox(conn: &Connection, context: &Context) -> Result<Vec<Queued>> {
    let mut stmt=conn.prepare("SELECT token,tbl,id,base_version,base_value,value,attempts FROM tack_outbox WHERE scope=?1 ORDER BY queued_at,tbl,id")?;
    let mut rows = stmt.query([&context.key])?;
    let mut output = vec![];
    while let Some(row) = rows.next()? {
        output.push(read_queued(row)?);
    }
    Ok(output)
}

pub(crate) fn write_value(
    conn: &Connection,
    context: &Context,
    table: &str,
    id: &str,
    value: &Value,
) -> Result<()> {
    match table {
        "cards" => {
            if value.is_null() {
                let removed = conn.execute(
                    "DELETE FROM note_cards WHERE scope=?1 AND id=?2",
                    params![context.key, id],
                )?;
                if removed > 0 {
                    changed(conn)?;
                }
            } else {
                let previous: Option<(String, String)> = conn
                    .query_row(
                        "SELECT value,edit_token FROM note_cards WHERE scope=?1 AND id=?2",
                        params![context.key, id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                let has_changed = previous.as_ref().is_none_or(|(raw, _)| {
                    serde_json::from_str::<Value>(raw).ok().as_ref() != Some(value)
                });
                let edit_token = if let Some((raw, token)) = previous.filter(|(raw, _)| {
                    serde_json::from_str::<Value>(raw)
                        .is_ok_and(|old| super::store::editable_equal(&old, value))
                }) {
                    let _ = raw;
                    token
                } else {
                    Uuid::new_v4().to_string()
                };
                conn.execute("INSERT INTO note_cards(scope,id,value,local_only,updated_at,edit_token) VALUES(?1,?2,?3,0,?4,?5) ON CONFLICT(scope,id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,edit_token=excluded.edit_token",params![context.key,id,value.to_string(),stamp(),edit_token])?;
                if has_changed {
                    changed(conn)?;
                }
            }
        }
        "reminders" => {
            if value.is_null() {
                let removed = conn.execute(
                    "DELETE FROM note_reminders WHERE scope=?1 AND id=?2",
                    params![context.key, id],
                )?;
                if removed > 0 {
                    changed(conn)?;
                }
            } else {
                let previous: Option<String> = conn
                    .query_row(
                        "SELECT value FROM note_reminders WHERE scope=?1 AND id=?2",
                        params![context.key, id],
                        |r| r.get(0),
                    )
                    .optional()?;
                conn.execute("INSERT INTO note_reminders(scope,id,value) VALUES(?1,?2,?3) ON CONFLICT(scope,id) DO UPDATE SET value=excluded.value",params![context.key,id,value.to_string()])?;
                if previous
                    .as_deref()
                    .and_then(|v| serde_json::from_str::<Value>(v).ok())
                    .as_ref()
                    != Some(value)
                {
                    changed(conn)?;
                }
            }
        }
        _ => {}
    };
    Ok(())
}
fn history(
    conn: &Connection,
    context: &Context,
    table: &str,
    id: &str,
    value: &Value,
    reason: &str,
) -> Result<()> {
    conn.execute("INSERT INTO note_revisions(history_id,scope,tbl,id,value,reason,saved_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![Uuid::new_v4().to_string(),context.key,table,id,value.to_string(),reason,stamp()])?;
    Ok(())
}
const SERVER_FIELDS: &[&str] = &[
    "ref",
    "revision",
    "updatedAt",
    "updatedBy",
    "authorId",
    "authorName",
];
fn satisfied(base: &Value, local: &Value, remote: &Value) -> bool {
    if local.is_null() {
        return remote.is_null();
    }
    let (Some(local), Some(remote)) = (local.as_object(), remote.as_object()) else {
        return false;
    };
    let empty = serde_json::Map::new();
    let base = base.as_object().unwrap_or(&empty);
    base.keys()
        .chain(local.keys())
        .filter(|k| !SERVER_FIELDS.contains(&k.as_str()))
        .all(|key| base.get(key) == local.get(key) || remote.get(key) == local.get(key))
}
// Rebase only edits made after the sent snapshot. Keep every other echoed field.
fn overlay(base: &Value, local: &Value, remote: &Value) -> Value {
    if local.is_null() {
        return Value::Null;
    }
    let (Some(local), Some(remote)) = (local.as_object(), remote.as_object()) else {
        return local.clone();
    };
    let empty = serde_json::Map::new();
    let base = base.as_object().unwrap_or(&empty);
    let mut value = remote.clone();
    for key in base.keys().chain(local.keys()).collect::<HashSet<_>>() {
        if SERVER_FIELDS.contains(&key.as_str()) || base.get(key) == local.get(key) {
            continue;
        }
        if let Some(v) = local.get(key) {
            value.insert(key.clone(), v.clone());
        } else {
            value.remove(key);
        }
    }
    let revision = local
        .get("revision")
        .and_then(Value::as_u64)
        .unwrap_or_default()
        .max(
            remote
                .get("revision")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
        )
        .saturating_add(1);
    value.insert("revision".into(), json!(revision));
    if let Some(at) = local.get("updatedAt") {
        value.insert("updatedAt".into(), at.clone());
    }
    Value::Object(value)
}

impl Database {
    pub(crate) fn tack_data_revision(&self) -> Result<u64> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        data_revision(&conn)
    }
    pub(crate) fn tack_summary(&self) -> Result<Summary> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let context = current(&conn)?;
        let Some(c) = &context else {
            return Ok(Summary::default());
        };
        let pending = conn.query_row(
            "SELECT count(*) FROM tack_outbox WHERE scope=?1",
            [&c.key],
            |r| r.get(0),
        )?;
        let conflicts = conn.query_row(
            "SELECT count(*) FROM tack_conflicts WHERE scope=?1",
            [&c.key],
            |r| r.get(0),
        )?;
        let issues = conn.query_row(
            "SELECT count(*) FROM tack_reference_issues WHERE scope=?1",
            [&c.key],
            |r| r.get(0),
        )?;
        let last = conn.query_row(
            "SELECT last_synced FROM tack_scopes WHERE scope=?1",
            [&c.key],
            |r| r.get(0),
        )?;
        Ok(Summary {
            scope: context,
            pending,
            conflicts,
            reference_issues: issues,
            last_synced: last,
        })
    }
    pub(crate) fn notes_context(&self) -> Result<Option<Context>> {
        current(
            &*self
                .conn
                .lock()
                .map_err(|_| msg("database lock poisoned"))?,
        )
    }
    pub(crate) fn tack_activate(&self, identity: &Identity) -> Result<Context> {
        self.tack_configure(identity, None)
    }
    pub(crate) fn tack_configure(
        &self,
        identity: &Identity,
        preferences: Option<(super::preferences::Preferences, bool)>,
    ) -> Result<Context> {
        let preferences = preferences
            .map(|(p, ro)| p.normalized().map(|p| (p, ro)))
            .transpose()?;
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        let context = Context {
            key: identity.key(),
            epoch: bump(&tx)?,
        };
        tx.execute(
            "INSERT OR IGNORE INTO tack_scopes(scope,identity) VALUES(?1,?2)",
            params![context.key, serde_json::to_string(identity)?],
        )?;
        set_meta(&tx, "active_scope", &context.key)?;
        set_meta(
            &tx,
            "enabled",
            if preferences.is_some() {
                "false"
            } else {
                "true"
            },
        )?;
        if let Some((preferences, read_only)) = preferences {
            set_meta(
                &tx,
                &format!("preferences/{}", context.key),
                &serde_json::to_string(&preferences)?,
            )?;
            set_meta(
                &tx,
                &format!("read_only/{}", context.key),
                if read_only { "true" } else { "false" },
            )?;
        }
        changed(&tx)?;
        tx.commit()?;
        Ok(context)
    }
    pub(crate) fn tack_enable(&self, context: &Context) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        ensure(&conn, Some(context))?;
        set_meta(&conn, "enabled", "true")
    }
    pub(crate) fn tack_identity(&self, context: &Context) -> Result<Identity> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        ensure(&conn, Some(context))?;
        let raw: String = conn.query_row(
            "SELECT identity FROM tack_scopes WHERE scope=?1",
            [&context.key],
            |r| r.get(0),
        )?;
        Ok(serde_json::from_str(&raw)?)
    }
    pub(crate) fn tack_enabled(&self) -> Result<bool> {
        Ok(meta(
            &*self
                .conn
                .lock()
                .map_err(|_| msg("database lock poisoned"))?,
            "enabled",
        )?
        .as_deref()
            == Some("true"))
    }
    pub(crate) fn tack_cursor(&self, context: &Context) -> Result<u64> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        ensure(&conn, Some(context))?;
        Ok(conn.query_row(
            "SELECT cursor FROM tack_scopes WHERE scope=?1",
            [&context.key],
            |r| r.get(0),
        )?)
    }
    #[cfg(test)]
    pub(crate) fn tack_queue(&self, context: &Context) -> Result<Vec<Queued>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        ensure(&conn, Some(context))?;
        outbox(&conn, context)
    }
    pub(crate) fn tack_batch(
        &self,
        context: &Context,
        visited: &HashSet<(String, String)>,
    ) -> Result<Vec<Queued>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        ensure(&conn, Some(context))?;
        if super::preferences::read_only(&conn, Some(context))? {
            return Ok(vec![]);
        }
        let mut batch = vec![];
        let mut bytes = 128;
        let mut statement=conn.prepare("SELECT token,tbl,id,base_version,base_value,value,attempts FROM tack_outbox o WHERE scope=?1 AND NOT EXISTS(SELECT 1 FROM tack_conflicts c WHERE c.scope=o.scope AND c.tbl=o.tbl AND c.id=o.id) AND NOT EXISTS(SELECT 1 FROM tack_reference_issues i WHERE i.scope=o.scope AND i.tbl=o.tbl AND i.id=o.id) ORDER BY queued_at,tbl,id")?;
        let mut rows = statement.query([&context.key])?;
        while let Some(row) = rows.next()? {
            let key = (row.get::<_, String>(1)?, row.get::<_, String>(2)?);
            if visited.contains(&key) {
                continue;
            }
            let entry = read_queued(row)?;
            let m = &entry.mutation;
            let size = serde_json::to_vec(m)?.len() + 1;
            if !batch.is_empty() && (batch.len() == 50 || bytes + size > 6_000_000) {
                break;
            }
            if size > 8 * 1024 * 1024 - 128 {
                return Err(msg(
                    "StorageFull: This queued record exceeds Tack's request limit.",
                ));
            }
            bytes += size;
            batch.push(entry);
        }
        Ok(batch)
    }
    pub(crate) fn tack_attempt(&self, context: &Context, batch: &[Queued]) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        ensure(&tx, Some(context))?;
        for entry in batch {
            tx.execute("UPDATE tack_outbox SET attempts=min(attempts+1,1000000) WHERE scope=?1 AND tbl=?2 AND id=?3 AND token=?4",params![context.key,entry.mutation.table,entry.mutation.id,entry.token])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn tack_apply(
        &self,
        context: &Context,
        reply: &SyncReply,
        sent: &[Queued],
    ) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        ensure(&tx, Some(context))?;
        let identity: Identity = serde_json::from_str(&tx.query_row::<String, _, _>(
            "SELECT identity FROM tack_scopes WHERE scope=?1",
            [&context.key],
            |r| r.get(0),
        )?)?;
        if reply.user_id != identity.user_id
            || reply.workspace_id != identity.workspace_id
            || reply.access_reset
        {
            return Err(msg("WorkspaceChanged: Tack changed the active account or workspace access. Reconnect before syncing."));
        }
        let previous_cursor: u64 = tx.query_row(
            "SELECT cursor FROM tack_scopes WHERE scope=?1",
            [&context.key],
            |r| r.get(0),
        )?;
        if reply.cursor > i64::MAX as u64
            || reply.cursor < previous_cursor
            || (reply.more && reply.cursor == previous_cursor)
        {
            return Err(msg("InvalidResponse: Tack cursor did not progress"));
        }
        let mut keys = HashSet::new();
        let mut blocked = HashSet::new();
        for conflict in &reply.conflicts {
            blocked.insert((conflict.table.clone(), conflict.id.clone()));
        }
        for issue in &reply.reference_issues {
            let (Some(table), Some(id)) = (
                issue.get("table").and_then(Value::as_str),
                issue.get("id").and_then(Value::as_str),
            ) else {
                return Err(msg("InvalidResponse: Invalid Tack reference issue"));
            };
            blocked.insert((table.into(), id.into()));
            tx.execute("INSERT INTO tack_reference_issues(scope,tbl,id,value) VALUES(?1,?2,?3,?4) ON CONFLICT(scope,tbl,id) DO UPDATE SET value=excluded.value",params![context.key,table,id,issue.to_string()])?;
        }
        for (is_change, record) in reply
            .changes
            .iter()
            .map(|r| (true, r))
            .chain(reply.conflicts.iter().map(|r| (false, r)))
        {
            if !["cards", "reminders", "attachments"].contains(&record.table.as_str())
                && !(record.table == "settings" && record.id == "tack.labels")
            {
                continue;
            }

            if is_change && !keys.insert((record.table.clone(), record.id.clone())) {
                return Err(msg("InvalidResponse: Duplicate Tack change"));
            }
            if record.version > i64::MAX as u64
                || (is_change && record.version == 0)
                || (!record.value.is_null()
                    && record
                        .value
                        .get(if record.table == "settings" {
                            "key"
                        } else {
                            "id"
                        })
                        .and_then(Value::as_str)
                        != Some(&record.id))
            {
                return Err(msg("InvalidResponse: Invalid Tack record identity"));
            }
            let display = if record.table == "cards" && !record.value.is_null() {
                super::store::remote_card(&record.value)?
            } else {
                record.value.clone()
            };
            let old: Option<(u64, String)> = tx
                .query_row(
                    "SELECT version,value FROM tack_mirror WHERE scope=?1 AND tbl=?2 AND id=?3",
                    params![context.key, record.table, record.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if old.as_ref().is_some_and(|(v, raw)| {
                *v > record.version
                    || (*v == record.version
                        && serde_json::from_str::<Value>(raw).ok().as_ref() != Some(&record.value))
            }) {
                return Err(msg("InvalidResponse: Tack record version regressed"));
            }
            tx.execute("INSERT INTO tack_mirror(scope,tbl,id,version,value) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(scope,tbl,id) DO UPDATE SET version=excluded.version,value=excluded.value",params![context.key,record.table,record.id,record.version,record.value.to_string()])?;
            if ["settings", "attachments"].contains(&record.table.as_str())
                && old
                    .as_ref()
                    .and_then(|(_, raw)| serde_json::from_str::<Value>(raw).ok())
                    .as_ref()
                    != Some(&record.value)
            {
                changed(&tx)?;
            }
            let queued = outbox_one(&tx, context, &record.table, &record.id)?;
            if !is_change && queued.is_some() {
                tx.execute("INSERT INTO tack_conflicts(scope,tbl,id,version,value) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(scope,tbl,id) DO UPDATE SET version=excluded.version,value=excluded.value",params![context.key,record.table,record.id,record.version,record.value.to_string()])?;
            }
            if let Some(queued) = queued {
                let key = (record.table.clone(), record.id.clone());
                let accepted = sent
                    .iter()
                    .find(|q| q.mutation.table == record.table && q.mutation.id == record.id)
                    .filter(|_| !blocked.contains(&key));
                let ack = accepted.is_some_and(|q| {
                    record.version > q.mutation.base_version
                        || satisfied(&q.mutation.base_value, &q.mutation.value, &record.value)
                });
                if ack
                    || (!blocked.contains(&key)
                        && satisfied(
                            &queued.mutation.base_value,
                            &queued.mutation.value,
                            &record.value,
                        ))
                {
                    if let Some(sent) = accepted.filter(|q| q.token != queued.token) {
                        let value =
                            overlay(&sent.mutation.value, &queued.mutation.value, &record.value);
                        tx.execute("UPDATE tack_outbox SET value=?1,base_version=?2,base_value=?3 WHERE scope=?4 AND tbl=?5 AND id=?6 AND token=?7",params![value.to_string(),record.version,record.value.to_string(),context.key,record.table,record.id,queued.token])?;
                        let display = if record.table == "cards" && !value.is_null() {
                            super::store::remote_card(&value)?
                        } else {
                            value
                        };
                        write_value(&tx, context, &record.table, &record.id, &display)?;
                    } else {
                        tx.execute("DELETE FROM tack_outbox WHERE scope=?1 AND tbl=?2 AND id=?3 AND token=?4",params![context.key,record.table,record.id,queued.token])?;
                        tx.execute(
                            "DELETE FROM tack_conflicts WHERE scope=?1 AND tbl=?2 AND id=?3",
                            params![context.key, record.table, record.id],
                        )?;
                        write_value(&tx, context, &record.table, &record.id, &display)?;
                    }
                } else {
                    // A pull can advance the mirror, but the queued edit keeps
                    // its original three-way base until the server accepts it.
                    tx.execute("UPDATE tack_conflicts SET version=?1,value=?2 WHERE scope=?3 AND tbl=?4 AND id=?5",params![record.version,record.value.to_string(),context.key,record.table,record.id])?;
                }
            } else {
                write_value(&tx, context, &record.table, &record.id, &display)?;
            }
        }
        tx.execute(
            "UPDATE tack_scopes SET cursor=?1 WHERE scope=?2",
            params![reply.cursor, context.key],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn tack_finish(&self, context: &Context) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        ensure(&conn, Some(context))?;
        conn.execute(
            "UPDATE tack_scopes SET last_synced=?1 WHERE scope=?2",
            params![stamp(), context.key],
        )?;
        Ok(())
    }
    pub(crate) fn tack_conflicts(&self, context: &Context) -> Result<Vec<Conflict>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        ensure(&conn, Some(context))?;
        let mut stmt=conn.prepare("SELECT c.tbl,c.id,c.version,c.value,o.token,o.value FROM tack_conflicts c JOIN tack_outbox o USING(scope,tbl,id) WHERE c.scope=?1 ORDER BY c.tbl,c.id")?;
        let rows = stmt
            .query_map([&context.key], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, u64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(table, id, version, remote, token, local)| {
                Ok(Conflict {
                    scope: context.clone(),
                    table: table.clone(),
                    id: id.clone(),
                    token,
                    local: serde_json::from_str(&local)?,
                    remote: Record {
                        table,
                        id,
                        version,
                        value: serde_json::from_str(&remote)?,
                    },
                })
            })
            .collect()
    }
    pub(crate) fn tack_resolve(
        &self,
        context: &Context,
        table: &str,
        id: &str,
        token: &str,
        remote_version: u64,
        choice: Resolution,
    ) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        ensure(&tx, Some(context))?;
        let entry = outbox_one(&tx, context, table, id)?
            .filter(|q| q.token == token)
            .ok_or_else(|| msg("Conflict: This local conflict changed. Reload both versions."))?;
        let (version, raw): (u64, String) = tx
            .query_row(
                "SELECT version,value FROM tack_conflicts WHERE scope=?1 AND tbl=?2 AND id=?3",
                params![context.key, table, id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| msg("Conflict: This conflict was already resolved."))?;
        if version != remote_version {
            return Err(msg(
                "Conflict: The Tack version changed. Reload both versions.",
            ));
        }
        let remote: Value = serde_json::from_str(&raw)?;
        if matches!(choice, Resolution::KeepLocal) {
            super::preferences::writable(&tx, Some(context))?;
        }
        match choice {
            Resolution::KeepLocal => {
                history(&tx, context, table, id, &remote, "kept-this-pc")?;
                let value = overlay(&entry.mutation.base_value, &entry.mutation.value, &remote);
                tx.execute("UPDATE tack_outbox SET value=?1,base_version=?2,base_value=?3,token=?4,queued_at=?5,attempts=0 WHERE scope=?6 AND tbl=?7 AND id=?8",params![value.to_string(),version,raw,Uuid::new_v4().to_string(),stamp(),context.key,table,id])?;
                write_value(&tx, context, table, id, &value)?;
            }
            Resolution::UseRemote => {
                history(
                    &tx,
                    context,
                    table,
                    id,
                    &entry.mutation.value,
                    "used-tack-version",
                )?;
                tx.execute(
                    "DELETE FROM tack_outbox WHERE scope=?1 AND tbl=?2 AND id=?3",
                    params![context.key, table, id],
                )?;
                let display = if table == "cards" && !remote.is_null() {
                    super::store::remote_card(&remote)?
                } else {
                    remote
                };
                write_value(&tx, context, table, id, &display)?;
            }
        }
        tx.execute(
            "DELETE FROM tack_conflicts WHERE scope=?1 AND tbl=?2 AND id=?3",
            params![context.key, table, id],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn tack_upload_local(&self, context: &Context) -> Result<usize> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        super::preferences::writable(&tx, Some(context))?;
        let rows=tx.prepare("SELECT id,value FROM note_cards WHERE scope='' AND local_only=1 ORDER BY json_extract(value,'$.rank') COLLATE BINARY,id")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut count = 0;
        for (local_id, raw) in rows {
            if tx.query_row::<bool, _, _>(
                "SELECT EXISTS(SELECT 1 FROM tack_uploads WHERE local_id=?1)",
                [&local_id],
                |r| r.get(0),
            )? {
                continue;
            }
            let id = Uuid::new_v4().to_string();
            let mut value: Value = serde_json::from_str(&raw)?;
            value["id"] = json!(id);
            value["ref"] = json!("");
            value["revision"] = json!(0);
            value["updatedAt"] = json!(stamp());
            let first:Option<String>=tx.query_row("SELECT json_extract(value,'$.rank') FROM note_cards WHERE scope=?1 ORDER BY json_extract(value,'$.rank') COLLATE BINARY,id LIMIT 1",[&context.key],|r|r.get(0)).optional()?;
            value["rank"] = json!(super::rank::with_nonce(None, first.as_deref(), &id)?);
            super::store::validate_card(&value)?;
            write_value(&tx, context, "cards", &id, &value)?;
            queue(&tx, context, "cards", &id, &value)?;
            tx.execute(
                "INSERT INTO tack_uploads(local_id,scope,remote_id) VALUES(?1,?2,?3)",
                params![local_id, context.key, id],
            )?;
            let reminders = tx.prepare("SELECT id,value FROM note_reminders WHERE scope='' AND json_extract(value,'$.entityType')='card' AND json_extract(value,'$.entityId')=?1")?.query_map([&local_id], |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
            for (local_reminder, raw) in reminders {
                let reminder_id = Uuid::new_v4().to_string();
                let mut reminder: Value = serde_json::from_str(&raw)?;
                reminder["id"] = json!(reminder_id);
                reminder["entityId"] = json!(id);
                reminder["revision"] = json!(0);
                write_value(&tx, context, "reminders", &reminder_id, &reminder)?;
                queue(&tx, context, "reminders", &reminder_id, &reminder)?;
                tx.execute(
                    "DELETE FROM note_reminders WHERE scope='' AND id=?1",
                    [local_reminder],
                )?;
            }
            tx.execute(
                "DELETE FROM note_cards WHERE scope='' AND id=?1",
                [local_id],
            )?;
            count += 1;
        }
        tx.commit()?;
        Ok(count)
    }
    pub(crate) fn tack_pause_and_export(&self) -> Result<Option<PathBuf>> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        let context = current(&tx)?;
        bump(&tx)?;
        set_meta(&tx, "enabled", "false")?;
        changed(&tx)?;
        tx.commit()?;
        // Keep the connection lock through the export snapshot, but persist the
        // pause first so a failed export cannot restart background uploads.
        let count: u64 = if let Some(context) = &context {
            conn.query_row(
                "SELECT count(*) FROM tack_outbox WHERE scope=?1",
                [&context.key],
                |r| r.get(0),
            )?
        } else {
            0
        };
        let path = if count == 0 {
            None
        } else {
            let directory = self
                .path()
                .parent()
                .ok_or_else(|| msg("Invalid notes export directory"))?
                .join("Nabbit");
            fs::create_dir_all(&directory)?;
            let path = directory.join(format!(
                "unsynced-{}-{}.json",
                Utc::now().format("%Y%m%d-%H%M%S"),
                Uuid::new_v4()
            ));
            let scope = &context
                .as_ref()
                .ok_or_else(|| msg("Invalid notes export scope"))?
                .key;
            let identity: Value = serde_json::from_str(&conn.query_row::<String, _, _>(
                "SELECT identity FROM tack_scopes WHERE scope=?1",
                [scope],
                |r| r.get(0),
            )?)?;
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)?;
            file.write_all(b"{\"format\":\"nabbit-unsynced-v1\",\"exportedAt\":")?;
            serde_json::to_writer(&mut file, &stamp())?;
            file.write_all(b",\"identity\":")?;
            serde_json::to_writer(&mut file, &identity)?;
            file.write_all(b",\"changes\":[")?;
            let mut statement=conn.prepare("SELECT token,tbl,id,base_version,base_value,value,attempts FROM tack_outbox WHERE scope=?1 ORDER BY queued_at,tbl,id")?;
            let mut rows = statement.query([scope])?;
            let mut first = true;
            while let Some(row) = rows.next()? {
                if !first {
                    file.write_all(b",")?;
                }
                first = false;
                serde_json::to_writer(&mut file, &read_queued(row)?)?;
            }
            file.write_all(b"]}\n")?;
            file.sync_all()?;
            Some(path)
        };
        Ok(path)
    }
    pub(crate) fn tack_local_mode(&self) -> Result<()> {
        if self.tack_enabled()? {
            return Err(msg("Pause Tack before selecting local-only Notes"));
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        set_meta(&tx, "active_scope", "")?;
        changed(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn tack_save_reminder(
        &self,
        context: &Context,
        id: &str,
        value: Value,
    ) -> Result<()> {
        if !value.is_null()
            && (!value.is_object()
                || value.get("id").and_then(Value::as_str) != Some(id)
                || serde_json::to_vec(&value)?.len() > 3_000_000)
        {
            return Err(msg("Invalid reminder"));
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        ensure(&tx, Some(context))?;
        write_value(&tx, context, "reminders", id, &value)?;
        queue(&tx, context, "reminders", id, &value)?;
        tx.commit()?;
        Ok(())
    }
}
