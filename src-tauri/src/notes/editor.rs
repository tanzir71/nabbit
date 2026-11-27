//! An editor snapshot and optimistic reminder writes share the card transaction.
use super::{
    store::StoredNote,
    sync_store::{self, Context},
};
use crate::{
    db::Database,
    error::{msg, Result},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub value: Value,
    pub edit_token: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReminderEdit {
    pub id: String,
    pub expected_token: Option<String>,
    pub value: Value,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorData {
    pub note: StoredNote,
    pub reminders: Vec<Reminder>,
    pub attachments: Vec<Value>,
    pub revisions: Vec<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorSave {
    pub id: String,
    pub expected_revision: u64,
    pub expected_scope: Option<Context>,
    pub expected_edit_token: String,
    pub patch: Value,
    pub reminders: Vec<ReminderEdit>,
}
fn token(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}
pub(crate) fn write_reminders(
    conn: &Connection,
    scope: Option<&Context>,
    card_id: &str,
    edits: &[ReminderEdit],
) -> Result<()> {
    if edits.len() > 100 {
        return Err(msg("Too many reminders"));
    }
    let key = scope.map_or("", |s| s.key.as_str());
    let mut ids = HashSet::new();
    for edit in edits {
        if edit.id.is_empty() || edit.id.len() > 256 || !ids.insert(&edit.id) {
            return Err(msg("Invalid reminder ID"));
        }
        let previous: Option<String> = conn
            .query_row(
                "SELECT value FROM note_reminders WHERE scope=?1 AND id=?2",
                params![key, edit.id],
                |r| r.get(0),
            )
            .optional()?;
        if previous.as_deref().map(token) != edit.expected_token {
            return Err(msg(
                "This reminder changed elsewhere. Your draft is preserved; reload before saving.",
            ));
        }
        let old: Value = previous
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or(Value::Null);
        if !old.is_null() && (old["entityType"] != "card" || old["entityId"] != card_id) {
            return Err(msg("This reminder belongs to another note"));
        }
        if !edit.value.is_null() {
            let v = &edit.value;
            let date = v["at"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
            if !v.is_object()
                || v["id"] != edit.id
                || v["entityId"] != card_id
                || v["entityType"] != "card"
                || date.is_none()
                || v["revision"]
                    .as_u64()
                    .is_none_or(|n| n > 9_007_199_254_740_991)
                || !v["enabled"].is_boolean()
                || !["none", "daily", "weekdays", "weekly", "monthly"]
                    .iter()
                    .any(|s| v["repeat"] == *s)
                || v["timeZone"]
                    .as_str()
                    .is_none_or(|s| s.is_empty() || s.len() > 100)
                || v["anchorDay"]
                    .as_u64()
                    .is_none_or(|n| !(1..=31).contains(&n))
                || ["snoozedUntil", "lastCompletedAt"].iter().any(|k| {
                    !v[*k].is_null()
                        && v[*k]
                            .as_str()
                            .is_none_or(|s| chrono::DateTime::parse_from_rfc3339(s).is_err())
                })
                || serde_json::to_vec(v)?.len() > 3_000_000
            {
                return Err(msg("Choose a valid reminder date, time zone and repeat"));
            }
            conn.execute("INSERT INTO note_reminders(scope,id,value) VALUES(?1,?2,?3) ON CONFLICT(scope,id) DO UPDATE SET value=excluded.value",params![key,edit.id,v.to_string()])?;
        } else {
            conn.execute(
                "DELETE FROM note_reminders WHERE scope=?1 AND id=?2",
                params![key, edit.id],
            )?;
        }
        if let Some(context) = scope {
            sync_store::queue(conn, context, "reminders", &edit.id, &edit.value)?;
        }
    }
    Ok(())
}
impl Database {
    pub fn note_editor(&self, id: &str, scope: Option<&Context>) -> Result<EditorData> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        sync_store::ensure(&conn, scope)?;
        let key = scope.map_or("", |s| s.key.as_str());
        let (raw, local_only, edit_token): (String, bool, String) = conn
            .query_row(
                "SELECT value,local_only,edit_token FROM note_cards WHERE scope=?1 AND id=?2",
                params![key, id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| msg("This note no longer exists"))?;
        let value: Value = serde_json::from_str(&raw)?;
        let reminders=conn.prepare("SELECT value FROM note_reminders WHERE scope=?1 AND json_extract(value,'$.entityType')='card' AND json_extract(value,'$.entityId')=?2 ORDER BY id")?.query_map(params![key,id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?.into_iter().map(|raw|Ok(Reminder{edit_token:token(&raw),value:serde_json::from_str(&raw)?})).collect::<Result<Vec<_>>>()?;
        let mut attachments = vec![];
        let mut preview_bytes = 0;
        for id in value["attachmentIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .take(100)
        {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT value FROM tack_mirror WHERE scope=?1 AND tbl='attachments' AND id=?2",
                    params![key, id],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(raw) = raw {
                let attachment: Value = serde_json::from_str(&raw)?;
                if valid_attachment(&attachment) && preview_bytes + raw.len() <= 6_000_000 {
                    preview_bytes += raw.len();
                    attachments.push(attachment);
                }
            }
        }
        let revisions=conn.prepare("SELECT value,reason,saved_at FROM note_revisions WHERE scope=?1 AND tbl='cards' AND id=?2 ORDER BY saved_at DESC,history_id DESC LIMIT 50")?.query_map(params![key,id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?.into_iter().map(|(raw,reason,saved)|Ok(serde_json::json!({"value":serde_json::from_str::<Value>(&raw)?,"reason":reason,"savedAt":saved}))).collect::<Result<Vec<_>>>()?;
        Ok(EditorData {
            note: StoredNote {
                value,
                local_only,
                scope: scope.cloned(),
                edit_token,
            },
            reminders,
            attachments,
            revisions,
        })
    }
    pub fn save_note_editor(&self, request: EditorSave) -> Result<StoredNote> {
        self.update_note_editor_in(
            &request.id,
            request.expected_revision,
            request.expected_scope.as_ref(),
            Some(&request.expected_edit_token),
            request.patch,
            &request.reminders,
        )
    }
}
pub(crate) fn valid_attachment(v: &Value) -> bool {
    v["mime"]
        .as_str()
        .is_some_and(|m| ["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&m))
        && v["data"]
            .as_str()
            .is_some_and(|s| s.len() <= 3_000_000 && !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::{store::NoteDraft, sync_store::Identity};
    use serde_json::json;
    fn db() -> Database {
        Database::open(
            &std::env::temp_dir().join(format!("nabbit-editor-{}", uuid::Uuid::new_v4())),
        )
        .unwrap()
    }
    fn note(db: &Database) -> StoredNote {
        db.create_note_card(NoteDraft {
            title: "Original".into(),
            ..Default::default()
        })
        .unwrap()
    }
    fn reminder(id: &str, card: &StoredNote) -> Value {
        json!({"id":id,"revision":0,"entityId":card.value["id"],"entityType":"card","at":"2026-12-01T09:00:00.000Z","timeZone":"Asia/Dhaka","repeat":"weekdays","anchorDay":1,"snoozedUntil":null,"lastCompletedAt":null,"enabled":true,"future":{"kept":true}})
    }
    fn save(db: &Database, card: &StoredNote, reminders: Vec<ReminderEdit>) -> Result<StoredNote> {
        db.save_note_editor(EditorSave {
            id: card.value["id"].as_str().unwrap().into(),
            expected_revision: card.value["revision"].as_u64().unwrap(),
            expected_scope: card.scope.clone(),
            expected_edit_token: card.edit_token.clone(),
            patch: json!({"body":"Edited body"}),
            reminders,
        })
    }
    #[test]
    fn local_editor_is_atomic_and_preserves_reminder_future_fields() {
        let db = db();
        let note = note(&db);
        let id = note.value["id"].as_str().unwrap();
        let r = reminder("r", &note);
        let saved = save(
            &db,
            &note,
            vec![ReminderEdit {
                id: "r".into(),
                expected_token: None,
                value: r.clone(),
            }],
        )
        .unwrap();
        let snapshot = db.note_editor(id, None).unwrap();
        assert_eq!(snapshot.note.value["body"], "Edited body");
        assert_eq!(snapshot.reminders[0].value, r);
        let mut invalid = r.clone();
        invalid["at"] = json!("not-a-date");
        assert!(save(
            &db,
            &saved,
            vec![ReminderEdit {
                id: "r".into(),
                expected_token: Some(snapshot.reminders[0].edit_token.clone()),
                value: invalid
            }]
        )
        .is_err());
        let after = db.note_editor(id, None).unwrap();
        assert_eq!(after.note.edit_token, saved.edit_token);
        assert_eq!(after.reminders[0].value, r);
        assert!(db.tack_summary().unwrap().scope.is_none());
    }
    #[test]
    fn a_stale_reminder_rejects_the_entire_card_write() {
        let db = db();
        let note = note(&db);
        let mut r = reminder("r", &note);
        let saved = save(
            &db,
            &note,
            vec![ReminderEdit {
                id: "r".into(),
                expected_token: None,
                value: r.clone(),
            }],
        )
        .unwrap();
        let opened = db
            .note_editor(note.value["id"].as_str().unwrap(), None)
            .unwrap();
        r["repeat"] = json!("monthly");
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE note_reminders SET value=?1 WHERE scope='' AND id='r'",
                [r.to_string()],
            )
            .unwrap();
        assert!(save(
            &db,
            &saved,
            vec![ReminderEdit {
                id: "r".into(),
                expected_token: Some(opened.reminders[0].edit_token.clone()),
                value: Value::Null
            }]
        )
        .is_err());
        assert_eq!(
            db.note_editor(note.value["id"].as_str().unwrap(), None)
                .unwrap()
                .note
                .edit_token,
            saved.edit_token
        );
    }
    #[test]
    fn editor_rejects_foreign_reminders_stale_cards_and_workspace_changes() {
        let db = db();
        let first = note(&db);
        let second = note(&db);
        let r = reminder("r", &first);
        save(
            &db,
            &first,
            vec![ReminderEdit {
                id: "r".into(),
                expected_token: None,
                value: r,
            }],
        )
        .unwrap();
        assert!(save(&db, &first, vec![]).is_err());
        let token = db
            .note_editor(first.value["id"].as_str().unwrap(), None)
            .unwrap()
            .reminders[0]
            .edit_token
            .clone();
        assert!(save(
            &db,
            &second,
            vec![ReminderEdit {
                id: "r".into(),
                expected_token: Some(token),
                value: reminder("r", &second)
            }]
        )
        .is_err());
        db.tack_activate(&Identity {
            base_url: "https://fixture.invalid/".into(),
            user_id: "u".into(),
            workspace_id: "w".into(),
        })
        .unwrap();
        assert!(db
            .note_editor(first.value["id"].as_str().unwrap(), None)
            .is_err());
        assert!(save(&db, &second, vec![]).is_err());
    }
    #[test]
    fn local_reminders_upload_once_with_their_remapped_card() {
        let db = db();
        let note = note(&db);
        save(
            &db,
            &note,
            vec![ReminderEdit {
                id: "local-r".into(),
                expected_token: None,
                value: reminder("local-r", &note),
            }],
        )
        .unwrap();
        let scope = db
            .tack_activate(&Identity {
                base_url: "https://fixture.invalid/".into(),
                user_id: "u".into(),
                workspace_id: "w".into(),
            })
            .unwrap();
        assert_eq!(db.tack_upload_local(&scope).unwrap(), 1);
        assert_eq!(db.tack_upload_local(&scope).unwrap(), 0);
        let card = db.list_note_cards().unwrap().remove(0);
        let editor = db
            .note_editor(card.value["id"].as_str().unwrap(), Some(&scope))
            .unwrap();
        assert_eq!(editor.reminders.len(), 1);
        let value = &editor.reminders[0].value;
        assert_eq!(value["entityId"], card.value["id"]);
        assert_ne!(value["id"], "local-r");
        assert_eq!(value["future"]["kept"], true);
        let conn = db.conn.lock().unwrap();
        let count: u64 = conn
            .query_row("SELECT count(*) FROM tack_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
        let local: u64 = conn
            .query_row(
                "SELECT count(*) FROM note_reminders WHERE scope=''",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(local, 0);
    }
}
