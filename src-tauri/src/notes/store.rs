//! The local-only store and future Tack mirror share the same full JSON values.
//! Patches touch known editable fields; everything else survives untouched.
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    db::Database,
    error::{msg, Result},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredNote {
    pub value: Value,
    pub local_only: bool,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct NoteDraft {
    pub title: String,
    pub body: String,
    pub kind: Option<String>,
    pub url: String,
    pub items: Vec<String>,
    pub labels: Vec<String>,
    pub priority: Option<String>,
    pub color: Option<String>,
}

const EDITABLE: &[&str] = &[
    "title",
    "body",
    "kind",
    "url",
    "items",
    "labels",
    "priority",
    "color",
    "pinned",
    "archived",
    "trashedAt",
    "completed",
    "status",
];
const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// New local cards only need integer predecessors. The generalized between-key
// port, including arbitrary fractional ranks received from Tack, belongs to V4.3.
fn rank_before(first: Option<&str>) -> Result<String> {
    let Some(first) = first else {
        return Ok("a0".into());
    };
    let mut key = first.as_bytes().to_vec();
    let head = *key.first().ok_or_else(|| msg("Invalid note rank"))?;
    let length = match head {
        b'a'..=b'z' => (head - b'a') as usize + 2,
        b'A'..=b'Z' => (b'Z' - head) as usize + 2,
        _ => return Err(msg("Invalid note rank")),
    };
    if key.len() != length || !key[1..].iter().all(|b| DIGITS.contains(b)) {
        return Err(msg("This note order needs the Tack rank upgrade"));
    }
    for i in (1..key.len()).rev() {
        let digit = DIGITS.iter().position(|b| *b == key[i]).unwrap();
        if digit > 0 {
            key[i] = DIGITS[digit - 1];
            return String::from_utf8(key).map_err(|_| msg("Invalid note rank"));
        }
        key[i] = b'z';
    }
    match head {
        b'A' => return Err(msg("This note order needs the Tack rank upgrade")),
        b'a' => key[0] = b'Z',
        b'b'..=b'z' => {
            key[0] -= 1;
            key.pop();
        }
        b'B'..=b'Z' => {
            key[0] -= 1;
            key.push(b'z');
        }
        _ => unreachable!(),
    }
    String::from_utf8(key).map_err(|_| msg("Invalid note rank"))
}

fn text<'a>(value: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    let s = value[key]
        .as_str()
        .ok_or_else(|| msg(format!("Invalid note {key}")))?;
    if s.encode_utf16().count() > max {
        return Err(msg(format!(
            "Note {key} is too long (maximum {max} characters)"
        )));
    }
    Ok(s)
}

pub fn validate_card(value: &Value) -> Result<()> {
    if !value.is_object() || serde_json::to_vec(value)?.len() > 3_000_000 {
        return Err(msg("This note is too large"));
    }
    text(value, "id", 256)?;
    text(value, "ref", 300)?;
    let title = text(value, "title", 300)?;
    let body = text(value, "body", 200_000)?;
    text(value, "doneWhen", 200_000)?;
    text(value, "frontmatter", 200_000)?;
    text(value, "rank", 1024)?;
    let kind = text(value, "kind", 20)?;
    if !["note", "checklist", "bookmark", "task"].contains(&kind)
        || !["inbox", "now", "next", "later"].contains(&text(value, "priority", 20)?)
        || !["default", "blue", "purple", "green", "pink", "gray"]
            .contains(&text(value, "color", 20)?)
    {
        return Err(msg("Choose a supported note kind, priority and colour"));
    }
    if let Some(status) = value.get("status") {
        if ![
            json!("open"),
            json!("active"),
            json!("blocked"),
            json!("done"),
        ]
        .contains(status)
        {
            return Err(msg("Choose a supported task status"));
        }
    }
    let url = text(value, "url", 200_000)?;
    if kind == "bookmark" {
        let url = url::Url::parse(url).map_err(|_| msg("Enter an http or https link"))?;
        if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none() {
            return Err(msg("Enter an http or https link"));
        }
    }
    let items = value["items"]
        .as_array()
        .ok_or_else(|| msg("Invalid checklist items"))?;
    let mut ids = std::collections::HashSet::new();
    for item in items {
        let id = text(item, "id", 256)?;
        text(item, "text", 200_000)?;
        if id.is_empty() || !ids.insert(id) || !item["checked"].is_boolean() {
            return Err(msg(
                "Checklist items need unique IDs, text and a checked state",
            ));
        }
    }
    if title.trim().is_empty() && body.trim().is_empty() && items.is_empty() && kind != "bookmark" {
        return Err(msg("Write a title, note or checklist item before saving"));
    }
    for key in ["labels", "attachmentIds"] {
        let list = value[key]
            .as_array()
            .ok_or_else(|| msg(format!("Invalid note {key}")))?;
        if list.iter().any(|item| !item.is_string()) {
            return Err(msg(format!("Invalid note {key}")));
        }
    }
    for key in ["pinned", "archived", "completed"] {
        if !value[key].is_boolean() {
            return Err(msg(format!("Invalid note {key}")));
        }
    }
    if value["revision"]
        .as_u64()
        .is_none_or(|n| n > 9_007_199_254_740_991)
    {
        return Err(msg("Invalid note revision"));
    }
    for key in ["createdAt", "updatedAt"] {
        chrono::DateTime::parse_from_rfc3339(text(value, key, 100)?)
            .map_err(|_| msg(format!("Invalid note {key}")))?;
    }
    if !value["trashedAt"].is_null() {
        chrono::DateTime::parse_from_rfc3339(text(value, "trashedAt", 100)?)
            .map_err(|_| msg("Invalid note trash date"))?;
    }
    Ok(())
}

impl Database {
    pub fn list_note_cards(&self) -> Result<Vec<StoredNote>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let mut statement = conn.prepare("SELECT value,local_only FROM note_cards ORDER BY json_extract(value,'$.rank') COLLATE BINARY,id")?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(raw, local_only)| {
                Ok(StoredNote {
                    value: serde_json::from_str(&raw)?,
                    local_only,
                })
            })
            .collect()
    }

    pub fn create_note_card(&self, draft: NoteDraft) -> Result<StoredNote> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        let first: Option<String> = tx.query_row("SELECT json_extract(value,'$.rank') FROM note_cards ORDER BY json_extract(value,'$.rank') COLLATE BINARY,id LIMIT 1", [], |row| row.get(0)).optional()?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let id = Uuid::new_v4().to_string();
        let items: Vec<_> = draft
            .items
            .into_iter()
            .filter(|s| !s.trim().is_empty())
            .map(|s| json!({"id":Uuid::new_v4().to_string(),"text":s,"checked":false}))
            .collect();
        let value = json!({
            "id":id,"revision":0,"assigneeId":null,"priority":draft.priority.unwrap_or_else(|| "inbox".into()),
            "ref":"","doneWhen":"","frontmatter":"","kind":draft.kind.unwrap_or_else(|| "note".into()),
            "title":draft.title,"body":draft.body,"url":draft.url,"labels":draft.labels,"items":items,
            "attachmentIds":[],"pinned":false,"archived":false,"trashedAt":null,"completed":false,
            "color":draft.color.unwrap_or_else(|| "default".into()),"rank":rank_before(first.as_deref())?,
            "projectId":null,"createdAt":now,"updatedAt":now,"sourceId":null
        });
        validate_card(&value)?;
        tx.execute(
            "INSERT INTO note_cards(id,value,local_only,updated_at) VALUES(?1,?2,1,?3)",
            params![id, serde_json::to_string(&value)?, now],
        )?;
        tx.commit()?;
        Ok(StoredNote {
            value,
            local_only: true,
        })
    }

    pub fn update_note_card(
        &self,
        id: &str,
        expected_revision: u64,
        patch: Value,
    ) -> Result<StoredNote> {
        let patch = patch.as_object().ok_or_else(|| msg("Invalid note edit"))?;
        if patch.is_empty() || patch.keys().any(|key| !EDITABLE.contains(&key.as_str())) {
            return Err(msg("This note edit contains unsupported fields"));
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        let (raw, local_only): (String, bool) = tx
            .query_row(
                "SELECT value,local_only FROM note_cards WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| msg("This note no longer exists"))?;
        // Connected cards must later be updated with their outbox atomically.
        if !local_only {
            return Err(msg("This card needs Tack sync before editing"));
        }
        let mut value: Value = serde_json::from_str(&raw)?;
        if value["revision"].as_u64() != Some(expected_revision) {
            return Err(msg("This note changed in another window. Your draft is still here; reopen the latest note before saving."));
        }
        value
            .as_object_mut()
            .ok_or_else(|| msg("Invalid stored note"))?
            .extend(patch.clone());
        value["revision"] = expected_revision
            .checked_add(1)
            .ok_or_else(|| msg("Invalid note revision"))?
            .into();
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        value["updatedAt"] = now.clone().into();
        validate_card(&value)?;
        tx.execute(
            "UPDATE note_cards SET value=?1,updated_at=?2 WHERE id=?3",
            params![serde_json::to_string(&value)?, now, id],
        )?;
        tx.commit()?;
        Ok(StoredNote { value, local_only })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> (std::path::PathBuf, Database) {
        let dir = std::env::temp_dir().join(format!("nabbit-notes-test-{}", Uuid::new_v4()));
        let db = Database::open(&dir).unwrap();
        (dir, db)
    }
    fn create(db: &Database, title: &str) -> StoredNote {
        db.create_note_card(NoteDraft {
            title: title.into(),
            ..Default::default()
        })
        .unwrap()
    }
    #[test]
    fn local_cards_are_full_tack_values_and_survive_restart_without_other_data_loss() {
        let (dir, db) = database();
        db.add_clipboard_text("retained v1 text", None).unwrap();
        let a = create(&db, "First");
        let b = create(&db, "Second");
        assert!(a.local_only && b.local_only);
        assert_eq!(a.value["revision"], 0);
        assert_eq!(a.value["ref"], "");
        assert_eq!(
            Uuid::parse_str(a.value["id"].as_str().unwrap())
                .unwrap()
                .get_version_num(),
            4
        );
        assert!(b.value["rank"].as_str().unwrap() < a.value["rank"].as_str().unwrap());
        assert!(a.value["createdAt"].as_str().unwrap().ends_with('Z'));
        drop(db);
        let db = Database::open(&dir).unwrap();
        db.migrate().unwrap();
        assert_eq!(db.list_note_cards().unwrap()[0].value, b.value);
        assert_eq!(db.list_clipboard_entries(None).unwrap().len(), 1);
        let mut settings = db.get_settings().unwrap();
        settings.last_tab = "notes".into();
        db.save_settings(&settings).unwrap();
        assert_eq!(db.get_settings().unwrap().last_tab, "notes");
    }
    #[test]
    fn edits_preserve_unknown_nested_fields_and_immutable_metadata() {
        let (_dir, db) = database();
        let note = create(&db, "Original");
        let mut value = note.value;
        let id = value["id"].as_str().unwrap().to_owned();
        value["futureServerField"] = json!({"nested":[1,{"new":true}]});
        value["agentState"] = json!({"status":"open","future":"keep"});
        value["items"] = json!([{"id":"one","text":"step","checked":false,"future":42}]);
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE note_cards SET value=?1 WHERE id=?2",
                params![value.to_string(), id],
            )
            .unwrap();
        let edited = db
            .update_note_card(
                &id,
                0,
                json!({"title":"Edited","color":"purple","labels":["Build"],"priority":"now"}),
            )
            .unwrap();
        for key in [
            "futureServerField",
            "agentState",
            "items",
            "id",
            "ref",
            "createdAt",
            "rank",
            "attachmentIds",
        ] {
            assert_eq!(edited.value[key], value[key], "{key}");
        }
        assert_eq!(edited.value["revision"], 1);
        assert!(db
            .update_note_card(&id, 0, json!({"body":"stale"}))
            .unwrap_err()
            .to_string()
            .contains("another window"));
        assert_eq!(db.list_note_cards().unwrap()[0].value, edited.value);
        assert!(db.update_note_card(&id, 1, json!({"id":"other"})).is_err());
    }
    #[test]
    fn checklist_edits_archive_and_trash_are_persisted_soft_changes() {
        let (_dir, db) = database();
        let mut note = db
            .create_note_card(NoteDraft {
                title: "List".into(),
                kind: Some("checklist".into()),
                items: vec!["one".into(), "two".into()],
                ..Default::default()
            })
            .unwrap();
        let id = note.value["id"].as_str().unwrap().to_owned();
        note.value["items"][1]["checked"] = true.into();
        note = db
            .update_note_card(&id, 0, json!({"items":note.value["items"],"pinned":true}))
            .unwrap();
        assert_eq!(note.value["items"][1]["text"], "two");
        note = db
            .update_note_card(&id, 1, json!({"archived":true}))
            .unwrap();
        assert_eq!(note.value["archived"], true);
        let stamp = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        note = db
            .update_note_card(&id, 2, json!({"trashedAt":stamp}))
            .unwrap();
        assert_eq!(note.value["trashedAt"], stamp);
        assert_eq!(db.list_note_cards().unwrap().len(), 1);
        note = db
            .update_note_card(&id, 3, json!({"trashedAt":null,"archived":false}))
            .unwrap();
        assert_eq!(note.value["revision"], 4);
        assert!(note.value["trashedAt"].is_null());
    }
    #[test]
    fn validation_failures_never_change_or_insert_rows() {
        let (_dir, db) = database();
        for draft in [
            NoteDraft::default(),
            NoteDraft {
                title: "x".repeat(301),
                ..Default::default()
            },
            NoteDraft {
                title: "link".into(),
                kind: Some("bookmark".into()),
                url: "javascript:alert(1)".into(),
                ..Default::default()
            },
        ] {
            assert!(db.create_note_card(draft).is_err());
        }
        assert!(db.list_note_cards().unwrap().is_empty());
        let note = create(&db, "Valid");
        let id = note.value["id"].as_str().unwrap();
        for patch in [
            json!({"title":"📝".repeat(151)}),
            json!({"color":"yellow"}),
            json!({"pinned":1}),
            json!({"items":[{"id":"x","text":"a","checked":false},{"id":"x","text":"b","checked":true}]}),
            json!({"trashedAt":"invalid"}),
            json!({"body":"x".repeat(200001)}),
        ] {
            assert!(db.update_note_card(id, 0, patch).is_err());
        }
        assert_eq!(db.list_note_cards().unwrap()[0].value, note.value);
    }
    #[test]
    fn integer_predecessors_remain_valid_base62_keys_across_boundaries() {
        assert_eq!(rank_before(None).unwrap(), "a0");
        for (before, after) in [
            ("a0", "Zz"),
            ("Zz", "Zy"),
            ("Z0", "Yzz"),
            ("b00", "az"),
            ("Y00", "Xzzz"),
        ] {
            assert_eq!(rank_before(Some(before)).unwrap(), after);
            assert!(after < before);
        }
        let mut key = "a0".to_string();
        for _ in 0..10000 {
            let next = rank_before(Some(&key)).unwrap();
            assert!(next < key);
            key = next;
        }
    }
}
