//! The local-only store and future Tack mirror share the same full JSON values.
//! Patches touch known editable fields; everything else survives untouched.
#[cfg(test)]
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
    pub scope: Option<super::sync_store::Context>,
    pub edit_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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
pub(crate) fn editable_equal(a: &Value, b: &Value) -> bool {
    EDITABLE.iter().all(|key| a.get(*key) == b.get(*key))
}
#[cfg(test)]
fn rank_before(first: Option<&str>) -> Result<String> {
    super::rank::between(None, first)
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
    text(value, "rank", 4096)?;
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesState {
    pub cards: Vec<StoredNote>,
    pub scope: Option<super::sync_store::Context>,
    pub preferences: super::preferences::Preferences,
    pub read_only: bool,
}

pub(crate) fn remote_card(value: &Value) -> Result<Value> {
    let mut value = value.clone();
    if let Some(number) = value
        .get("rank")
        .and_then(Value::as_f64)
        .filter(|_| value["rank"].is_number())
    {
        value["rank"] = json!(super::rank::legacy(number)?);
    }
    let object = value
        .as_object_mut()
        .ok_or_else(|| msg("InvalidResponse: Invalid Tack card"))?;
    for (key, default) in [
        ("assigneeId", Value::Null),
        ("priority", json!("inbox")),
        ("ref", json!("")),
        ("doneWhen", json!("")),
        ("frontmatter", json!("")),
    ] {
        object.entry(key).or_insert(default);
    }
    // Tack permits an empty card. Local capture still requires content.
    let mut checked = value.clone();
    if checked["title"].as_str() == Some("")
        && checked["body"].as_str() == Some("")
        && checked["items"].as_array().is_some_and(Vec::is_empty)
        && checked["kind"] != "bookmark"
    {
        checked["body"] = json!("validation placeholder");
    }
    validate_card(&checked).map_err(|_| {
        msg("InvalidResponse: This Tack card has an unsupported shape. No page was applied.")
    })?;
    super::rank::validate(
        value["rank"]
            .as_str()
            .ok_or_else(|| msg("InvalidResponse: Invalid Tack rank"))?,
    )
    .map_err(|_| msg("InvalidResponse: Invalid Tack rank"))?;
    Ok(value)
}

pub(crate) fn insert_note_card(
    tx: &rusqlite::Transaction<'_>,
    draft: NoteDraft,
    scope: Option<&super::sync_store::Context>,
    id: &str,
    patch: &Value,
) -> Result<StoredNote> {
    let key = scope.map_or("", |s| s.key.as_str());
    let first:Option<String>=tx.query_row("SELECT json_extract(value,'$.rank') FROM note_cards WHERE scope=?1 ORDER BY json_extract(value,'$.rank') COLLATE BINARY,id LIMIT 1",[key],|row|row.get(0)).optional()?;
    let now = super::sync_store::stamp();
    let edit_token = Uuid::new_v4().to_string();
    let items: Vec<_> = draft
        .items
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .map(|s| json!({"id":Uuid::new_v4().to_string(),"text":s,"checked":false}))
        .collect();
    let mut value = json!({"id":id,"revision":0,"assigneeId":null,"priority":draft.priority.unwrap_or_else(||"inbox".into()),"ref":"","doneWhen":"","frontmatter":"","kind":draft.kind.unwrap_or_else(||"note".into()),"title":draft.title,"body":draft.body,"url":draft.url,"labels":draft.labels,"items":items,"attachmentIds":[],"pinned":false,"archived":false,"trashedAt":null,"completed":false,"color":draft.color.unwrap_or_else(||"default".into()),"rank":super::rank::with_nonce(None,first.as_deref(),id)?,"projectId":null,"createdAt":now,"updatedAt":now,"sourceId":null});
    let patch = patch
        .as_object()
        .ok_or_else(|| msg("Invalid note capture fields"))?;
    if patch.keys().any(|key| !EDITABLE.contains(&key.as_str())) {
        return Err(msg("Unsupported note capture field"));
    }
    value
        .as_object_mut()
        .expect("new card object")
        .extend(patch.clone());
    validate_card(&value)?;
    tx.execute("INSERT INTO note_cards(scope,id,value,local_only,updated_at,edit_token) VALUES(?1,?2,?3,?4,?5,?6)",params![key,id,value.to_string(),scope.is_none(),now,edit_token])?;
    if let Some(context) = scope {
        super::sync_store::queue(tx, context, "cards", id, &value)?;
    }
    super::sync_store::changed(tx)?;
    Ok(StoredNote {
        value,
        local_only: scope.is_none(),
        scope: scope.cloned(),
        edit_token,
    })
}

impl Database {
    pub fn notes_state(&self) -> Result<NotesState> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let scope = super::sync_store::current(&conn)?;
        let key = scope.as_ref().map_or("", |s| s.key.as_str());
        let mut statement=conn.prepare("SELECT value,local_only,edit_token FROM note_cards WHERE scope=?1 ORDER BY json_extract(value,'$.rank') COLLATE BINARY,id")?;
        let rows = statement
            .query_map([key], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let cards = rows
            .into_iter()
            .map(|(raw, local_only, edit_token)| {
                Ok(StoredNote {
                    value: serde_json::from_str(&raw)?,
                    local_only,
                    scope: scope.clone(),
                    edit_token,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(NotesState {
            cards,
            preferences: super::preferences::read(&conn, scope.as_ref())?,
            read_only: super::preferences::read_only(&conn, scope.as_ref())?,
            scope,
        })
    }
    pub fn list_note_cards(&self) -> Result<Vec<StoredNote>> {
        Ok(self.notes_state()?.cards)
    }
    pub fn create_note_card(&self, draft: NoteDraft) -> Result<StoredNote> {
        self.create_note_card_in(draft, None)
    }
    pub(crate) fn create_note_card_in(
        &self,
        draft: NoteDraft,
        scope: Option<&super::sync_store::Context>,
    ) -> Result<StoredNote> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        super::sync_store::ensure(&tx, scope)?;
        let note = insert_note_card(&tx, draft, scope, &Uuid::new_v4().to_string(), &json!({}))?;
        tx.commit()?;
        Ok(note)
    }
    pub fn update_note_card(
        &self,
        id: &str,
        expected_revision: u64,
        patch: Value,
    ) -> Result<StoredNote> {
        self.update_note_card_in(id, expected_revision, None, None, patch)
    }
    pub(crate) fn update_note_card_in(
        &self,
        id: &str,
        expected_revision: u64,
        scope: Option<&super::sync_store::Context>,
        expected_token: Option<&str>,
        patch: Value,
    ) -> Result<StoredNote> {
        self.update_note_editor_in(id, expected_revision, scope, expected_token, patch, &[])
    }
    pub(crate) fn update_note_editor_in(
        &self,
        id: &str,
        expected_revision: u64,
        scope: Option<&super::sync_store::Context>,
        expected_token: Option<&str>,
        patch: Value,
        reminders: &[super::editor::ReminderEdit],
    ) -> Result<StoredNote> {
        let patch = patch.as_object().ok_or_else(|| msg("Invalid note edit"))?;
        if patch.is_empty() || patch.keys().any(|k| !EDITABLE.contains(&k.as_str())) {
            return Err(msg("This note edit contains unsupported fields"));
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        super::preferences::writable(&tx, scope)?;
        let key = scope.map_or("", |s| s.key.as_str());
        let (raw, local_only, token): (String, bool, String) = tx
            .query_row(
                "SELECT value,local_only,edit_token FROM note_cards WHERE scope=?1 AND id=?2",
                params![key, id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| msg("This note no longer exists"))?;
        let mut value: Value = serde_json::from_str(&raw)?;
        let current_revision = value["revision"]
            .as_u64()
            .ok_or_else(|| msg("Invalid note revision"))?;
        if (expected_token.is_none() && current_revision != expected_revision)
            || expected_token.is_some_and(|t| t != token)
            || (scope.is_some() && expected_token.is_none())
        {
            return Err(msg("This note changed in another window. Your draft is still here; reopen the latest note before saving."));
        }
        value
            .as_object_mut()
            .ok_or_else(|| msg("Invalid stored note"))?
            .extend(patch.clone());
        value["revision"] = current_revision
            .checked_add(1)
            .ok_or_else(|| msg("Invalid note revision"))?
            .into();
        let now = super::sync_store::stamp();
        value["updatedAt"] = now.clone().into();
        validate_card(&value)?;
        let edit_token = Uuid::new_v4().to_string();
        tx.execute(
            "UPDATE note_cards SET value=?1,updated_at=?2,edit_token=?3 WHERE scope=?4 AND id=?5",
            params![value.to_string(), now, edit_token, key, id],
        )?;
        if let Some(context) = scope {
            super::sync_store::queue(&tx, context, "cards", id, &value)?;
        }
        super::editor::write_reminders(&tx, scope, id, reminders)?;
        super::sync_store::changed(&tx)?;
        tx.commit()?;
        Ok(StoredNote {
            value,
            local_only,
            scope: scope.cloned(),
            edit_token,
        })
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
