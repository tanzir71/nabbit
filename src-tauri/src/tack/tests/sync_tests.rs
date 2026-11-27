use super::{
    client,
    fake::{Fake, PASSWORD},
    login, MemoryVault,
};
use crate::{
    db::Database,
    notes::{
        store::{NoteDraft, StoredNote},
        sync_store::{Context, Identity, Resolution},
    },
    tack::{
        client::Client,
        model::{ErrorCode, Mutation, SyncReply, SyncStatus},
        service::Service,
        sync,
    },
};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

fn database() -> Database {
    Database::open(&std::env::temp_dir().join(format!("nabbit-sync-test-{}", uuid::Uuid::new_v4())))
        .unwrap()
}
fn identity(fake: &Fake, workspace: &str) -> Identity {
    Identity {
        base_url: fake.endpoint.base().to_string(),
        user_id: "user-1".into(),
        workspace_id: workspace.into(),
    }
}
fn connected(fake: &Fake) -> (Database, Client, Context) {
    let db = database();
    let mut http = client(fake, Arc::new(MemoryVault::default()));
    login(&mut http);
    let context = db.tack_activate(&identity(fake, "personal")).unwrap();
    (db, http, context)
}
fn create(db: &Database, context: &Context, title: &str) -> StoredNote {
    db.create_note_card_in(
        NoteDraft {
            title: title.into(),
            body: "alpha beta gamma".into(),
            ..Default::default()
        },
        Some(context),
    )
    .unwrap()
}
fn edit(db: &Database, note: &StoredNote, patch: Value) -> StoredNote {
    db.update_note_card_in(
        note.value["id"].as_str().unwrap(),
        note.value["revision"].as_u64().unwrap(),
        note.scope.as_ref(),
        Some(&note.edit_token),
        patch,
    )
    .unwrap()
}
fn note(db: &Database) -> StoredNote {
    db.list_note_cards().unwrap().into_iter().next().unwrap()
}
fn other(fake: &Fake) -> Client {
    let mut client = client(fake, Arc::new(MemoryVault::default()));
    login(&mut client);
    client
}
fn server_edit(client: &mut Client, id: &str, patch: Value) {
    let mut cursor = 0;
    let remote = loop {
        let page = client.sync(cursor, &[]).unwrap();
        if let Some(card) = page
            .changes
            .into_iter()
            .find(|r| r.table == "cards" && r.id == id)
        {
            break card;
        }
        assert!(page.more, "expected remote card in paged workspace");
        cursor = page.cursor;
    };
    let mut value = remote.value.clone();
    value
        .as_object_mut()
        .unwrap()
        .extend(patch.as_object().unwrap().clone());
    value["revision"] = json!(value["revision"].as_u64().unwrap() + 1);
    client
        .sync(
            0,
            &[Mutation {
                table: "cards".into(),
                id: id.into(),
                base_version: remote.version,
                base_value: remote.value,
                value,
            }],
        )
        .unwrap();
}

#[test]
fn create_edit_every_card_property_and_reminder_roundtrip_through_durable_outbox() {
    let fake = Fake::start();
    let (db, mut http, context) = connected(&fake);
    let first = create(&db, &context, "Checklist");
    let id = first.value["id"].as_str().unwrap().to_owned();
    let local = edit(
        &db,
        &first,
        json!({"kind":"checklist","items":[{"id":"item","text":"step","checked":true,"futureItem":{"x":1}}],"labels":["Build"],"color":"purple","pinned":true,"priority":"now","archived":true,"trashedAt":"2026-11-27T10:00:00.000Z"}),
    );
    assert_eq!(db.tack_queue(&context).unwrap().len(), 1);
    assert_eq!(db.tack_queue(&context).unwrap()[0].mutation.base_version, 0);
    sync::cycle(&db, &context, &mut http).unwrap();
    let saved = note(&db);
    assert_eq!(saved.value["ref"], "bui-1");
    assert!(db.tack_queue(&context).unwrap().is_empty());
    assert!(!saved.local_only);
    for key in [
        "items",
        "labels",
        "color",
        "pinned",
        "priority",
        "archived",
        "trashedAt",
    ] {
        assert_eq!(saved.value[key], local.value[key]);
    }
    let restored = edit(&db, &saved, json!({"archived":false,"trashedAt":null}));
    let reminder = json!({"id":"reminder-1","revision":0,"entityId":id,"entityType":"card","at":"2026-12-01T03:00:00.000Z","timeZone":"Asia/Dhaka","repeat":"weekly","anchorDay":1,"snoozedUntil":null,"lastCompletedAt":null,"enabled":true,"future":{"keep":true}});
    db.tack_save_reminder(&context, "reminder-1", reminder.clone())
        .unwrap();
    sync::cycle(&db, &context, &mut http).unwrap();
    assert_eq!(note(&db).value["revision"], restored.value["revision"]);
    let conn = db.conn.lock().unwrap();
    let raw: String = conn
        .query_row(
            "SELECT value FROM note_reminders WHERE scope=?1 AND id='reminder-1'",
            [&context.key],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&raw).unwrap()["future"],
        reminder["future"]
    );
}

#[test]
fn editor_reads_synced_attachments_and_rejects_read_only_writes() {
    let fake = Fake::start();
    let (db, mut http, context) = connected(&fake);
    let created = create(&db, &context, "Image note");
    let id = created.value["id"].as_str().unwrap();
    sync::cycle(&db, &context, &mut http).unwrap();
    let mut device = other(&fake);
    let image = json!({"id":"img","revision":0,"name":"A picture","mime":"image/png","data":"data:image/png;base64,iVBORw0KGgo=","size":8,"createdAt":"2026-11-27T00:00:00Z"});
    assert_eq!(
        device
            .sync(
                0,
                &[Mutation {
                    table: "attachments".into(),
                    id: "img".into(),
                    base_version: 0,
                    base_value: Value::Null,
                    value: image.clone()
                }]
            )
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    // A previously uploaded Tack attachment is read over HTTP; Nabbit cannot upload one.
    fake.state
        .lock()
        .unwrap()
        .seed("attachments", "img", image, true);
    server_edit(
        &mut device,
        id,
        json!({"attachmentIds":["img"],"future":{"untouched":true}}),
    );
    sync::cycle(&db, &context, &mut http).unwrap();
    let data = db.note_editor(id, Some(&context)).unwrap();
    assert_eq!(data.attachments.len(), 1);
    assert_eq!(data.attachments[0]["name"], "A picture");
    {
        let conn = db.conn.lock().unwrap();
        crate::notes::sync_store::set_meta(&conn, &format!("read_only/{}", context.key), "true")
            .unwrap();
    }
    assert!(db
        .save_note_editor(crate::notes::editor::EditorSave {
            id: id.into(),
            expected_revision: data.note.value["revision"].as_u64().unwrap(),
            expected_scope: Some(context.clone()),
            expected_edit_token: data.note.edit_token.clone(),
            patch: json!({"body":"blocked"}),
            reminders: vec![]
        })
        .is_err());
    assert_eq!(
        db.note_editor(id, Some(&context)).unwrap().note.value["future"]["untouched"],
        true
    );
}

#[test]
fn upload_is_atomic_once_only_and_batches_over_fifty() {
    let fake = Fake::start();
    let db = database();
    for i in 0..56 {
        db.create_note_card(NoteDraft {
            title: format!("local {i}"),
            ..Default::default()
        })
        .unwrap();
    }
    let mut http = other(&fake);
    let context = db.tack_activate(&identity(&fake, "personal")).unwrap();
    assert!(db.list_note_cards().unwrap().is_empty());
    assert_eq!(db.tack_upload_local(&context).unwrap(), 56);
    assert_eq!(db.tack_upload_local(&context).unwrap(), 0);
    assert_eq!(db.tack_queue(&context).unwrap().len(), 56);
    sync::cycle(&db, &context, &mut http).unwrap();
    let batches = fake.state.lock().unwrap().batches.clone();
    assert_eq!(
        batches.into_iter().filter(|n| *n > 0).collect::<Vec<_>>(),
        vec![50, 6]
    );
    let rows = db.list_note_cards().unwrap();
    assert_eq!(rows.len(), 56);
    assert!(rows
        .iter()
        .all(|n| !n.value["ref"].as_str().unwrap().is_empty()));
    let ids = rows
        .iter()
        .map(|n| n.value["id"].as_str().unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), 56);
    assert!(db.tack_queue(&context).unwrap().is_empty());
    let path = db.path().parent().unwrap().to_path_buf();
    drop(db);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(reopened.tack_upload_local(&context).unwrap(), 0);
    assert_eq!(reopened.list_note_cards().unwrap().len(), 56);
}

#[test]
fn lost_successful_response_replays_after_restart_without_duplicate_creation() {
    let fake = Fake::start();
    let (db, mut http, context) = connected(&fake);
    create(&db, &context, "durable");
    fake.state.lock().unwrap().after_commit_fault = Some(503);
    assert_eq!(
        sync::cycle(&db, &context, &mut http).unwrap_err().code,
        ErrorCode::Offline
    );
    let queued = db.tack_queue(&context).unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].attempts, 1);
    let path = db.path().parent().unwrap().to_path_buf();
    drop(db);
    let db = Database::open(&path).unwrap();
    sync::cycle(&db, &context, &mut http).unwrap();
    assert!(db.tack_queue(&context).unwrap().is_empty());
    assert_eq!(db.list_note_cards().unwrap().len(), 1);
    assert_eq!(note(&db).value["ref"], "tck-1");
    assert_eq!(
        fake.state
            .lock()
            .unwrap()
            .batches
            .iter()
            .filter(|n| **n > 0)
            .count(),
        1
    );
}

#[test]
fn edits_during_http_ack_rebase_over_server_fields_and_remain_queued() {
    let fake = Fake::start();
    let (db, mut http, context) = connected(&fake);
    create(&db, &context, "initial");
    sync::cycle(&db, &context, &mut http).unwrap();
    let initial = note(&db);
    let id = initial.value["id"].as_str().unwrap().to_owned();
    let queued = edit(&db, &initial, json!({"title":"PC title"}));
    let mut second = other(&fake);
    server_edit(
        &mut second,
        &id,
        json!({"body":"remote body","newServerField":{"keep":[1,2]}}),
    );
    let race_db = db.clone();
    fake.state.lock().unwrap().after_write = Some(Box::new(move || {
        edit(&race_db, &queued, json!({"color":"blue","pinned":true}));
    }));
    sync::cycle(&db, &context, &mut http).unwrap();
    let pending = db.tack_queue(&context).unwrap();
    assert_eq!(pending.len(), 1);
    let value = &pending[0].mutation.value;
    assert_eq!(value["title"], "PC title");
    assert_eq!(value["body"], "remote body");
    assert_eq!(value["color"], "blue");
    assert_eq!(value["newServerField"], json!({"keep":[1,2]}));
    assert_eq!(value["ref"], "tck-1");
    assert!(pending[0].mutation.base_version >= 3);
    sync::cycle(&db, &context, &mut http).unwrap();
    assert!(db.tack_queue(&context).unwrap().is_empty());
    assert_eq!(note(&db).value["newServerField"], json!({"keep":[1,2]}));
}

#[test]
fn two_device_text_conflicts_both_resolutions_preserve_the_losing_body() {
    for choice in [Resolution::KeepLocal, Resolution::UseRemote] {
        let fake = Fake::start();
        let (db, mut http, context) = connected(&fake);
        create(&db, &context, "conflict");
        sync::cycle(&db, &context, &mut http).unwrap();
        let base = note(&db);
        let id = base.value["id"].as_str().unwrap().to_owned();
        let local = edit(&db, &base, json!({"body":"LEFT beta gamma"}));
        let mut second = other(&fake);
        server_edit(
            &mut second,
            &id,
            json!({"body":"RIGHT beta gamma","futureRemote":true}),
        );
        sync::cycle(&db, &context, &mut http).unwrap();
        let conflict = db.tack_conflicts(&context).unwrap().remove(0);
        assert_eq!(note(&db).value["body"], local.value["body"]);
        assert_eq!(conflict.remote.value["body"], "RIGHT beta gamma");
        assert!(db
            .tack_resolve(
                &context,
                "cards",
                &id,
                "stale-token",
                conflict.remote.version,
                choice
            )
            .is_err());
        db.tack_resolve(
            &context,
            "cards",
            &id,
            &conflict.token,
            conflict.remote.version,
            choice,
        )
        .unwrap();
        assert!(db.tack_conflicts(&context).unwrap().is_empty());
        match choice {
            Resolution::KeepLocal => {
                assert_eq!(
                    db.tack_queue(&context).unwrap()[0].mutation.base_version,
                    conflict.remote.version
                );
                sync::cycle(&db, &context, &mut http).unwrap();
                assert_eq!(note(&db).value["body"], "LEFT beta gamma");
            }
            Resolution::UseRemote => assert_eq!(note(&db).value["body"], "RIGHT beta gamma"),
        }
        assert_eq!(note(&db).value["futureRemote"], true);
        assert!(db.tack_queue(&context).unwrap().is_empty());
        let raw: String = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT value FROM note_revisions WHERE scope=?1",
                [&context.key],
                |r| r.get(0),
            )
            .unwrap();
        let body = serde_json::from_str::<Value>(&raw).unwrap()["body"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            body,
            match choice {
                Resolution::KeepLocal => "RIGHT beta gamma",
                Resolution::UseRemote => "LEFT beta gamma",
            }
        );
    }
}

#[test]
fn hidden_and_unknown_pages_advance_cursor_and_resume_after_interruption() {
    let fake = Fake::start();
    let (db, mut http, context) = connected(&fake);
    let value = db
        .create_note_card_in(
            NoteDraft {
                title: "temporary".into(),
                ..Default::default()
            },
            Some(&context),
        )
        .unwrap()
        .value;
    {
        let conn = db.conn.lock().unwrap();
        conn.execute("DELETE FROM note_cards WHERE scope=?1", [&context.key])
            .unwrap();
        conn.execute("DELETE FROM tack_outbox WHERE scope=?1", [&context.key])
            .unwrap();
    }
    {
        let mut state = fake.state.lock().unwrap();
        for i in 0..205 {
            state.seed(
                "projects",
                &format!("ignored-{i}"),
                json!({"id":format!("ignored-{i}")}),
                i >= 200,
            );
        }
        state.seed("cards", value["id"].as_str().unwrap(), value.clone(), true);
        state.seed(
            "settings",
            "tack.labels",
            json!({"key":"tack.labels","value":"[\"Build\"]"}),
            true,
        );
        state.fail_sync_at = Some((2, 503));
    }
    assert_eq!(
        sync::cycle(&db, &context, &mut http).unwrap_err().code,
        ErrorCode::Offline
    );
    let cursor = db.tack_cursor(&context).unwrap();
    assert_eq!(cursor, 200);
    assert!(db.list_note_cards().unwrap().is_empty());
    let path = db.path().parent().unwrap().to_path_buf();
    drop(db);
    let db = Database::open(&path).unwrap();
    sync::cycle(&db, &context, &mut http).unwrap();
    assert_eq!(note(&db).value["title"], "temporary");
    assert!(db.tack_cursor(&context).unwrap() > cursor);
    let conn = db.conn.lock().unwrap();
    assert_eq!(
        conn.query_row::<u64, _, _>(
            "SELECT count(*) FROM tack_mirror WHERE scope=?1 AND tbl='projects'",
            [&context.key],
            |r| r.get(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(conn.query_row::<u64,_,_>("SELECT count(*) FROM tack_mirror WHERE scope=?1 AND tbl='settings' AND id='tack.labels'",[&context.key],|r|r.get(0)).unwrap(),1);
}

#[test]
fn bad_page_rolls_back_mirrors_cards_outbox_and_cursor_together() {
    let fake = Fake::start();
    let (db, _http, context) = connected(&fake);
    let original = create(&db, &context, "local");
    let before = db.tack_data_revision().unwrap();
    let mut remote = original.value.clone();
    remote["id"] = json!("remote-one");
    let mut reply = SyncReply {
        changes: vec![crate::tack::model::Record {
            table: "cards".into(),
            id: "remote-one".into(),
            version: 1,
            value: remote,
        }],
        cursor: 2,
        more: false,
        conflicts: vec![],
        user_id: "user-1".into(),
        workspace_id: "personal".into(),
        reference_issues: vec![],
        access: None,
        access_reset: false,
    };
    reply.changes.push(crate::tack::model::Record {
        table: "cards".into(),
        id: "bad".into(),
        version: 1,
        value: json!({"id":"bad"}),
    });
    assert!(db.tack_apply(&context, &reply, &[]).is_err());
    assert_eq!(db.tack_data_revision().unwrap(), before);
    assert_eq!(db.tack_cursor(&context).unwrap(), 0);
    assert_eq!(db.list_note_cards().unwrap().len(), 1);
    assert_eq!(db.tack_queue(&context).unwrap().len(), 1);
    assert_eq!(
        db.conn
            .lock()
            .unwrap()
            .query_row::<u64, _, _>("SELECT count(*) FROM tack_mirror", [], |r| r.get(0))
            .unwrap(),
        0
    );
    reply.changes.pop();
    db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_test_cursor BEFORE UPDATE OF cursor ON tack_scopes BEGIN SELECT RAISE(ABORT,'injected disk transaction failure'); END;").unwrap();
    assert!(db.tack_apply(&context, &reply, &[]).is_err());
    assert_eq!(db.tack_data_revision().unwrap(), before);
    assert_eq!(db.tack_cursor(&context).unwrap(), 0);
    assert_eq!(db.list_note_cards().unwrap().len(), 1);
    assert_eq!(db.tack_queue(&context).unwrap().len(), 1);
}

#[test]
fn status_only_sync_and_unrelated_cursor_pages_do_not_invalidate_notes() {
    let fake = Fake::start();
    let (db, mut http, context) = connected(&fake);
    let empty = db.tack_data_revision().unwrap();
    sync::cycle(&db, &context, &mut http).unwrap();
    assert_eq!(db.tack_data_revision().unwrap(), empty);
    for i in 0..205 {
        fake.state.lock().unwrap().seed(
            "projects",
            &format!("project-{i}"),
            json!({"id":format!("project-{i}")}),
            true,
        );
    }
    sync::cycle(&db, &context, &mut http).unwrap();
    assert!(db.tack_cursor(&context).unwrap() >= 205);
    assert_eq!(db.tack_data_revision().unwrap(), empty);
    let local = create(&db, &context, "one change");
    assert!(db.tack_data_revision().unwrap() > empty);
    sync::cycle(&db, &context, &mut http).unwrap();
    let acknowledged = db.tack_data_revision().unwrap();
    sync::cycle(&db, &context, &mut http).unwrap();
    assert_eq!(db.tack_data_revision().unwrap(), acknowledged);
    server_edit(
        &mut other(&fake),
        local.value["id"].as_str().unwrap(),
        json!({"body":"remote update"}),
    );
    sync::cycle(&db, &context, &mut http).unwrap();
    assert!(db.tack_data_revision().unwrap() > acknowledged);
    assert_eq!(note(&db).value["body"], "remote update");
    let before_switch = db.tack_data_revision().unwrap();
    db.tack_activate(&identity(&fake, "team")).unwrap();
    assert!(db.tack_data_revision().unwrap() > before_switch);
}

#[test]
fn workspace_partitions_stale_epochs_and_optimistic_tokens_prevent_cross_writes() {
    let fake = Fake::start();
    let (db, mut http, personal) = connected(&fake);
    let first = create(&db, &personal, "personal");
    sync::cycle(&db, &personal, &mut http).unwrap();
    // Reference/actor acknowledgements do not invalidate an unchanged draft.
    let saved = db
        .update_note_card_in(
            first.value["id"].as_str().unwrap(),
            0,
            Some(&personal),
            Some(&first.edit_token),
            json!({"color":"blue"}),
        )
        .unwrap();
    sync::cycle(&db, &personal, &mut http).unwrap();
    let editor = note(&db);
    let mut remote = editor.value.clone();
    remote["body"] = json!("server change with an unchanged card revision");
    fake.state.lock().unwrap().seed(
        "cards",
        remote["id"].as_str().unwrap(),
        remote.clone(),
        true,
    );
    sync::cycle(&db, &personal, &mut http).unwrap();
    assert!(db
        .update_note_card_in(
            first.value["id"].as_str().unwrap(),
            saved.value["revision"].as_u64().unwrap(),
            Some(&personal),
            Some(&editor.edit_token),
            json!({"title":"stale before the real server edit"})
        )
        .is_err());
    let mut team_value = note(&db).value.clone();
    team_value["title"] = json!("team");
    fake.state.lock().unwrap().seed_for(
        "team",
        "cards",
        team_value["id"].as_str().unwrap(),
        team_value.clone(),
        true,
    );
    http.switch_workspace("team").unwrap();
    let team = db.tack_activate(&identity(&fake, "team")).unwrap();
    sync::cycle(&db, &team, &mut http).unwrap();
    assert_eq!(note(&db).value["title"], "team");
    assert!(db
        .create_note_card_in(
            NoteDraft {
                title: "stale".into(),
                ..Default::default()
            },
            Some(&personal)
        )
        .is_err());
    assert!(db.tack_cursor(&personal).is_err());
    http.switch_workspace("personal").unwrap();
    let returned = db.tack_activate(&identity(&fake, "personal")).unwrap();
    assert_ne!(returned.epoch, personal.epoch);
    assert_eq!(note(&db).value["title"], "personal");
    assert_ne!(
        personal.key,
        Identity {
            base_url: "https://other.invalid/tack/".into(),
            ..identity(&fake, "personal")
        }
        .key()
    );
    assert_ne!(
        personal.key,
        Identity {
            user_id: "another-user".into(),
            ..identity(&fake, "personal")
        }
        .key()
    );
}

#[test]
fn signout_exports_before_pause_and_keeps_unsynced_data_without_auth_secrets() {
    let fake = Fake::start();
    let (db, _http, context) = connected(&fake);
    create(&db, &context, "unsynced");
    let export = db.tack_pause_and_export().unwrap().unwrap();
    assert!(export
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("unsynced-"));
    let bytes = std::fs::read(&export).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains(PASSWORD));
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["changes"].as_array().unwrap().len(), 1);
    assert_eq!(value["identity"]["workspaceId"], "personal");
    assert!(!db.tack_enabled().unwrap());
    let current = db.notes_context().unwrap().unwrap();
    assert_ne!(current.epoch, context.epoch);
    assert_eq!(db.tack_queue(&current).unwrap().len(), 1);
    assert_eq!(note(&db).value["title"], "unsynced");
    let mut conn = db.conn.lock().unwrap();
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    let _ = &mut conn;
    drop(conn);
    assert!(!std::fs::read(db.path())
        .unwrap()
        .windows(PASSWORD.len())
        .any(|w| w == PASSWORD.as_bytes()));
}

#[test]
fn worker_pushes_status_sleeps_between_signals_and_stops_its_owned_thread() {
    let fake = Fake::start();
    let (db, http, context) = connected(&fake);
    create(&db, &context, "worker");
    let events = Arc::new(Mutex::new(vec![]));
    let collected = events.clone();
    let service = Service::test_start(
        db.clone(),
        http,
        Arc::new(move |snapshot| collected.lock().unwrap().push(snapshot)),
    )
    .unwrap();
    struct Stop(Service);
    impl Drop for Stop {
        fn drop(&mut self) {
            self.0.stop();
        }
    }
    let _stop = Stop(service.clone());
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if service.sync_snapshot().unwrap().state == SyncStatus::UpToDate {
            break;
        }
        assert!(Instant::now() < until, "worker did not finish");
        std::thread::sleep(Duration::from_millis(10));
    }
    let calls = fake.state.lock().unwrap().requests;
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(fake.state.lock().unwrap().requests, calls);
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|e| e.state == SyncStatus::Syncing));
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|e| e.state == SyncStatus::UpToDate));
    edit(&db, &note(&db), json!({"pinned":true}));
    service.edited();
    assert_eq!(fake.state.lock().unwrap().requests, calls);
    service.request_sync();
    let until = Instant::now() + Duration::from_secs(5);
    while !db.tack_queue(&context).unwrap().is_empty() {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
    service.stop();
}

#[test]
fn offline_restart_retains_credentials_and_reauthenticates_on_network_regain() {
    let fake = Fake::start();
    let db = database();
    let vault = Arc::new(MemoryVault::default());
    let mut http = client(&fake, vault.clone());
    login(&mut http);
    let context = db.tack_activate(&identity(&fake, "personal")).unwrap();
    create(&db, &context, "restart offline");
    let directory = db.path().parent().unwrap().to_path_buf();
    drop(http);
    drop(db);
    let db = Database::open(&directory).unwrap();
    fake.fault(503, json!({"error":"offline during restore"}), vec![]);
    let service = Service::test_resume(db.clone(), fake.endpoint.clone(), vault).unwrap();
    struct Stop(Service);
    impl Drop for Stop {
        fn drop(&mut self) {
            self.0.stop();
        }
    }
    let _stop = Stop(service.clone());
    let snapshot = service.sync_snapshot().unwrap();
    assert_eq!(snapshot.state, SyncStatus::Offline);
    assert!(snapshot.next_attempt_ms.is_some());
    assert_eq!(db.tack_queue(&context).unwrap().len(), 1);
    service.network_regained();
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if service.sync_snapshot().unwrap().state == SyncStatus::UpToDate {
            break;
        }
        assert!(Instant::now() < until, "restarted worker did not recover");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(note(&db).value["ref"], "tck-1");
    assert!(db.tack_queue(&context).unwrap().is_empty());
}

#[test]
fn local_only_worker_never_connects_even_when_focus_edit_or_network_signals_arrive() {
    let fake = Fake::start();
    let db = database();
    db.create_note_card(NoteDraft {
        title: "local only".into(),
        ..Default::default()
    })
    .unwrap();
    let service = Service::test_idle(db.clone()).unwrap();
    service.edited();
    service.visibility(true, true);
    service.network_regained();
    service.request_sync();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(fake.state.lock().unwrap().requests, 0);
    let snapshot = service.sync_snapshot().unwrap();
    assert_eq!(snapshot.state, SyncStatus::LocalOnly);
    assert!(snapshot.scope.is_none());
    assert_eq!(snapshot.next_attempt_ms, None);
    assert!(note(&db).local_only);
    service.stop();
}

#[test]
fn migration_preserves_v41_json_and_all_other_v1_data_and_is_idempotent() {
    let db = database();
    let note = db
        .create_note_card(NoteDraft {
            title: "v41 card".into(),
            ..Default::default()
        })
        .unwrap();
    db.add_clipboard_text("retained migration fixture", None)
        .unwrap();
    let mut value = note.value;
    value["future"] = json!({"nested":[1,true]});
    let id = value["id"].as_str().unwrap();
    let directory = db.path().parent().unwrap().to_path_buf();
    {
        let mut conn = db.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute_batch("CREATE TABLE legacy_cards(id TEXT PRIMARY KEY,value TEXT NOT NULL,local_only INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);").unwrap();
        tx.execute(
            "INSERT INTO legacy_cards VALUES(?1,?2,1,'old')",
            rusqlite::params![id, value.to_string()],
        )
        .unwrap();
        tx.execute_batch("DROP TABLE note_cards;ALTER TABLE legacy_cards RENAME TO note_cards;")
            .unwrap();
        tx.commit().unwrap();
    }
    drop(db);
    let upgraded = Database::open(&directory).unwrap();
    assert_eq!(note_value(&upgraded), value);
    assert_eq!(upgraded.list_clipboard_entries(None).unwrap().len(), 1);
    upgraded.migrate().unwrap();
    assert_eq!(note_value(&upgraded), value);
    assert!(!std::fs::read_dir(directory).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("nabbit.corrupt")));
    fn note_value(db: &Database) -> Value {
        db.list_note_cards().unwrap().remove(0).value
    }
}

#[test]
fn byte_bounded_batches_drain_large_echo_pages_and_full_merge_bases() {
    let fake = Fake::start();
    let (db, mut http, context) = connected(&fake);
    for i in 0..32 {
        db.create_note_card_in(
            NoteDraft {
                title: format!("large {i}"),
                body: "x".repeat(200_000),
                ..Default::default()
            },
            Some(&context),
        )
        .unwrap();
    }
    sync::cycle(&db, &context, &mut http).unwrap();
    assert!(db.tack_queue(&context).unwrap().is_empty());
    assert_eq!(db.list_note_cards().unwrap().len(), 32);
    let first_batches = fake
        .state
        .lock()
        .unwrap()
        .batches
        .iter()
        .filter(|n| **n > 0)
        .count();
    assert!(first_batches >= 2);
    for row in db.list_note_cards().unwrap() {
        edit(&db, &row, json!({"color":"blue"}));
    }
    sync::cycle(&db, &context, &mut http).unwrap();
    assert!(db.tack_queue(&context).unwrap().is_empty());
    assert!(db
        .list_note_cards()
        .unwrap()
        .iter()
        .all(|n| n.value["color"] == "blue"));
    let state = fake.state.lock().unwrap();
    assert!(state.batches.iter().all(|n| *n <= 50));
    assert!(state.sync_bytes.iter().all(|n| *n < 8 * 1024 * 1024));
    assert!(state.batches.iter().filter(|n| **n > 0).count() >= first_batches + 3);
    assert!(state.batches.iter().filter(|n| **n == 0).count() > 2);
}

#[test]
fn failed_unsynced_export_persists_pause_and_does_not_clear_credentials_or_notes() {
    use crate::tack::session::Vault;
    let fake = Fake::start();
    let db = database();
    let vault = Arc::new(MemoryVault::default());
    let mut http = client(&fake, vault.clone());
    login(&mut http);
    let context = db.tack_activate(&identity(&fake, "personal")).unwrap();
    create(&db, &context, "export must succeed first");
    fake.fault(
        429,
        json!({"error":"wait"}),
        vec![("Retry-After".into(), "900".into())],
    );
    let service = Service::test_start(db.clone(), http, Arc::new(|_| {})).unwrap();
    struct Stop(Service);
    impl Drop for Stop {
        fn drop(&mut self) {
            self.0.stop();
        }
    }
    let _stop = Stop(service.clone());
    let until = Instant::now() + Duration::from_secs(5);
    while service.sync_snapshot().unwrap().state != SyncStatus::RateLimited {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
    let blocker = db.path().parent().unwrap().join("Nabbit");
    std::fs::write(&blocker, b"owned fixture blocks the export directory").unwrap();
    let calls = fake.state.lock().unwrap().requests;
    assert_eq!(service.logout().unwrap_err().code, ErrorCode::LocalStorage);
    assert!(!db.tack_enabled().unwrap());
    assert!(service.snapshot().unwrap().user.is_some());
    assert!(vault.load(fake.endpoint.scope()).unwrap().is_some());
    assert_eq!(fake.state.lock().unwrap().requests, calls);
    let current = db.notes_context().unwrap().unwrap();
    assert_eq!(db.tack_queue(&current).unwrap().len(), 1);
    assert_eq!(note(&db).value["title"], "export must succeed first");
    assert_eq!(service.sync_snapshot().unwrap().next_attempt_ms, None);
    std::fs::remove_file(blocker).unwrap();
}
