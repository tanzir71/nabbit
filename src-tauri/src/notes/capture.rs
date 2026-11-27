//! Explicit note capture, idempotent creation and durable navigation handoff.
use super::{
    editor::ReminderEdit,
    store::{self, NoteDraft, StoredNote},
    sync_store::{self, Context},
};
use crate::{
    db::Database,
    error::{msg, Result},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use uuid::Uuid;
pub const SHORTCUT: &str = "Ctrl+Alt+N";
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureRequest {
    pub request_id: String,
    pub expected_scope: Option<Context>,
    pub draft: NoteDraft,
    pub patch: Value,
    pub reminders: Vec<ReminderEdit>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum NotesIntent {
    Capture,
    New {
        request: Box<CaptureRequest>,
    },
    Card {
        id: String,
        #[serde(rename = "expectedScope")]
        expected_scope: Option<Context>,
    },
    All,
    Links,
    Import,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Navigation {
    pub id: String,
    pub intent: NotesIntent,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationReply {
    pub navigation: Option<Navigation>,
    pub shortcut_error: Option<String>,
}
impl Database {
    pub fn capture_note(&self, request: CaptureRequest) -> Result<StoredNote> {
        self.capture_note_enriched(request, None, false)
    }
    pub(crate) fn capture_note_enriched(
        &self,
        mut request: CaptureRequest,
        title: Option<String>,
        link: bool,
    ) -> Result<StoredNote> {
        if Uuid::parse_str(&request.request_id).ok().is_none_or(|id| {
            id.get_version() != Some(uuid::Version::Random) || id.to_string() != request.request_id
        }) {
            return Err(msg("Invalid capture ID"));
        }
        let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&request)?));
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        sync_store::ensure(&tx, request.expected_scope.as_ref())?;
        let scope = request
            .expected_scope
            .as_ref()
            .map_or("", |s| s.key.as_str());
        let previous: Option<(String, String, String)> = tx
            .query_row(
                "SELECT scope,digest,COALESCE(card_id,request_id) FROM note_capture_receipts WHERE request_id=?1",
                [&request.request_id],
                |r| Ok((r.get(0)?, r.get(1)?,r.get(2)?)),
            )
            .optional()?;
        if let Some((owner, previous, card_id)) = previous {
            if owner != scope || previous != digest {
                return Err(msg("This capture was already saved with different details. Your draft is preserved; review the saved note."));
            }
            let (raw, local_only, edit_token): (String, bool, String) = tx
                .query_row(
                    "SELECT value,local_only,edit_token FROM note_cards WHERE scope=?1 AND id=?2",
                    params![scope, card_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?
                .ok_or_else(|| {
                    msg("The captured note was removed. This retry did not create another note.")
                })?;
            return Ok(StoredNote {
                value: serde_json::from_str(&raw)?,
                local_only,
                edit_token,
                scope: request.expected_scope,
            });
        }
        super::preferences::writable(&tx, request.expected_scope.as_ref())?;
        if link {
            let normalized = super::links::parse::normalized_url(
                request
                    .patch
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or(&request.draft.url),
            )?;
            if request
                .patch
                .get("kind")
                .and_then(Value::as_str)
                .or(request.draft.kind.as_deref())
                != Some("bookmark")
            {
                return Err(msg("Link capture requires a bookmark"));
            }
            if let Some(note) = super::links::store::find_duplicate(
                &tx,
                request.expected_scope.as_ref(),
                &normalized,
            )? {
                tx.execute("INSERT INTO note_capture_receipts(request_id,scope,digest,card_id) VALUES(?1,?2,?3,?4)",params![request.request_id,scope,digest,note.value["id"].as_str()])?;
                tx.commit()?;
                return Ok(note);
            }
            if let Some(title) = title {
                request.draft.title = title.clone();
                if request.patch.get("title").is_some() {
                    request.patch["title"] = serde_json::json!(title);
                }
            }
        }
        let note = store::insert_note_card(
            &tx,
            request.draft,
            request.expected_scope.as_ref(),
            &request.request_id,
            &request.patch,
        )?;
        super::editor::write_reminders(
            &tx,
            request.expected_scope.as_ref(),
            &request.request_id,
            &request.reminders,
        )?;
        tx.execute(
            "INSERT INTO note_capture_receipts(request_id,scope,digest) VALUES(?1,?2,?3)",
            params![request.request_id, scope, digest],
        )?;
        tx.commit()?;
        Ok(note)
    }
    pub fn queue_notes_intent(&self, intent: NotesIntent) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        match &intent {
            NotesIntent::New { request } => {
                sync_store::ensure(&tx, request.expected_scope.as_ref())?
            }
            NotesIntent::Card { expected_scope, .. } => {
                sync_store::ensure(&tx, expected_scope.as_ref())?
            }
            _ => {}
        }
        let nav = Navigation {
            id: Uuid::new_v4().to_string(),
            intent,
        };
        sync_store::set_meta(&tx, "notes/ui_intent", &serde_json::to_string(&nav)?)?;
        let initial = serde_json::to_string(&crate::db::models::AppSettings::default())?;
        tx.execute("INSERT INTO settings(key,value,updated_at) VALUES('app_settings',json_set(?1,'$.lastTab','notes'),?2) ON CONFLICT(key) DO UPDATE SET value=json_set(settings.value,'$.lastTab','notes'),updated_at=excluded.updated_at",params![initial,sync_store::stamp()])?;
        tx.commit()?;
        Ok(())
    }
    pub fn take_notes_intent(&self) -> Result<NavigationReply> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        let navigation = sync_store::meta(&tx, "notes/ui_intent")?
            .map(|s| serde_json::from_str::<Navigation>(&s))
            .transpose()?;
        let errors = [
            sync_store::meta(&tx, "notes/shortcut_error")?,
            sync_store::meta(&tx, "notes/selection_shortcut_error")?,
        ]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
        let shortcut_error = (!errors.is_empty()).then(|| errors.join("\n"));
        tx.execute("DELETE FROM tack_meta WHERE key='notes/ui_intent'", [])?;
        tx.commit()?;
        Ok(NavigationReply {
            navigation,
            shortcut_error,
        })
    }
    pub(crate) fn notes_shortcut_status(&self, failed: bool) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        sync_store::set_meta(
            &conn,
            "notes/shortcut_error",
            if failed {
                "Ctrl+Alt+N is unavailable. Open Notes to capture."
            } else {
                ""
            },
        )
    }
}
pub fn open(app: &tauri::AppHandle, intent: NotesIntent) -> Result<()> {
    app.state::<crate::AppState>()
        .db
        .queue_notes_intent(intent)?;
    crate::show_popover(app)?;
    app.emit("notes:open", ())?;
    Ok(())
}
pub fn hotkey(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(text) =
            crate::clipboard::watcher::note_hotkey_text(&app.state::<crate::AppState>().db)
        {
            if let Ok(intent) =
                super::links::intake::url_intent(&app.state::<crate::AppState>().db, &text)
            {
                let _ = open(&app, intent);
                return;
            }
        }
        empty_hotkey(&app);
    });
}
fn empty_hotkey(app: &tauri::AppHandle) {
    #[cfg(windows)]
    if let Some(manager) = app.try_state::<std::sync::Arc<crate::island::Manager>>() {
        match manager.open_notes_capture() {
            Ok(true) => return,
            Err(_) => {
                let _ = app
                    .state::<crate::AppState>()
                    .db
                    .notes_shortcut_status(true);
                return;
            }
            Ok(false) => {}
        }
    }
    let _ = open(app, NotesIntent::Capture);
}
pub fn destination(note: &StoredNote) -> String {
    let priority = note.value["priority"].as_str().unwrap_or("inbox");
    format!(
        "this PC · {}{}",
        priority[..1].to_uppercase(),
        &priority[1..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::sync_store::Identity;
    use serde_json::json;
    fn database() -> Database {
        Database::open(&std::env::temp_dir().join(format!("nabbit-capture-{}", Uuid::new_v4())))
            .unwrap()
    }
    fn request(scope: Option<Context>) -> CaptureRequest {
        let id = Uuid::new_v4().to_string();
        CaptureRequest {
            request_id: id.clone(),
            expected_scope: scope,
            draft: NoteDraft {
                title: "Ship".into(),
                kind: Some("task".into()),
                priority: Some("now".into()),
                labels: vec!["nabbit".into()],
                ..Default::default()
            },
            patch: json!({"body":"Keep this","items":[{"id":"stable","text":"Verify","checked":true,"future":42}]}),
            reminders: vec![ReminderEdit {
                id: format!("reminder:card:{id}"),
                expected_token: None,
                value: json!({"id":format!("reminder:card:{id}"),"revision":0,"entityId":id,"entityType":"card","at":"2026-12-01T03:00:00.000Z","timeZone":"Asia/Dhaka","repeat":"weekdays","anchorDay":1,"snoozedUntil":null,"lastCompletedAt":null,"enabled":true,"future":{"kept":true}}),
            }],
        }
    }
    fn activate(db: &Database) -> Context {
        db.tack_activate(&Identity {
            base_url: "https://fixture.invalid/".into(),
            user_id: "u".into(),
            workspace_id: "w".into(),
        })
        .unwrap()
    }
    #[test]
    fn capture_and_reminder_are_atomic_local_and_idempotent() {
        let db = database();
        let request = request(None);
        let first = db.capture_note(request.clone()).unwrap();
        let replay = db.capture_note(request.clone()).unwrap();
        assert_eq!(first.value, replay.value);
        assert_eq!(first.edit_token, replay.edit_token);
        let editor = db.note_editor(&request.request_id, None).unwrap();
        assert_eq!(editor.reminders.len(), 1);
        assert_eq!(editor.reminders[0].value["future"]["kept"], true);
        assert_eq!(first.value["items"][0]["future"], 42);
        assert!(first.local_only);
        assert_eq!(destination(&first), "this PC · Now");
        assert_eq!(db.list_note_cards().unwrap().len(), 1);
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM tack_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
    #[test]
    fn bad_reminder_rolls_back_card_outbox_and_receipt() {
        let db = database();
        let scope = activate(&db);
        let mut request = request(Some(scope.clone()));
        request.reminders[0].value["entityId"] = json!("foreign");
        assert!(db.capture_note(request).is_err());
        let conn = db.conn.lock().unwrap();
        for table in [
            "note_cards",
            "note_reminders",
            "tack_outbox",
            "note_capture_receipts",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0, "{table}");
        }
    }
    #[test]
    fn connected_capture_queues_exact_card_and_reminder_once() {
        let db = database();
        let scope = activate(&db);
        let request = request(Some(scope.clone()));
        let card = db.capture_note(request.clone()).unwrap();
        db.capture_note(request.clone()).unwrap();
        assert!(!card.local_only);
        assert_eq!(card.scope, Some(scope));
        assert_eq!(card.value["ref"], "");
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM tack_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
        let count: i64 = conn
            .query_row("SELECT count(*) FROM note_capture_receipts", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }
    #[test]
    fn reused_id_changed_payload_removal_readonly_and_scope_are_guarded() {
        let db = database();
        let mut capture = request(None);
        db.capture_note(capture.clone()).unwrap();
        capture.draft.title = "Changed".into();
        assert!(db.capture_note(capture.clone()).is_err());
        capture.draft.title = "Ship".into();
        db.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM note_cards WHERE id=?1", [&capture.request_id])
            .unwrap();
        assert!(db.capture_note(capture.clone()).is_err());
        let scope = activate(&db);
        assert!(db.capture_note(capture).is_err());
        sync_store::set_meta(
            &db.conn.lock().unwrap(),
            &format!("read_only/{}", scope.key),
            "true",
        )
        .unwrap();
        assert!(db.capture_note(request(Some(scope))).is_err());
    }
    #[test]
    fn invalid_ids_and_immutable_patch_do_not_create_rows() {
        let db = database();
        let mut r = request(None);
        r.request_id = "arbitrary".into();
        assert!(db.capture_note(r).is_err());
        let mut r = request(None);
        r.patch = json!({"ref":"forged"});
        assert!(db.capture_note(r).is_err());
        assert!(db.list_note_cards().unwrap().is_empty());
    }
    #[test]
    fn navigation_is_durable_consumed_once_and_preserves_settings() {
        let db = database();
        let original = json!({"lastTab":"download","future":{"keep":42},"theme":"light"});
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO settings(key,value,updated_at) VALUES('app_settings',?1,'now')",
                [original.to_string()],
            )
            .unwrap();
        db.queue_notes_intent(NotesIntent::Capture).unwrap();
        let reply = db.take_notes_intent().unwrap();
        assert!(matches!(
            reply.navigation.unwrap().intent,
            NotesIntent::Capture
        ));
        assert!(db.take_notes_intent().unwrap().navigation.is_none());
        let raw: String = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT value FROM settings WHERE key='app_settings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let settings: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(settings["lastTab"], "notes");
        assert_eq!(settings["future"], original["future"]);
        assert_eq!(settings["theme"], "light");
        db.notes_shortcut_status(true).unwrap();
        assert!(db
            .take_notes_intent()
            .unwrap()
            .shortcut_error
            .unwrap()
            .contains(SHORTCUT));
        db.notes_shortcut_status(false).unwrap();
        assert!(db.take_notes_intent().unwrap().shortcut_error.is_none());
        let old = request(None);
        activate(&db);
        assert!(db
            .queue_notes_intent(NotesIntent::New {
                request: Box::new(old)
            })
            .is_err());
    }
}
