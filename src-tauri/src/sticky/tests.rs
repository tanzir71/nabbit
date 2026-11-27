use super::{geometry::Profile, store::Draft, Binding};
use crate::{
    db::Database,
    notes::{
        store::NoteDraft,
        sync_store::{Context, Identity},
    },
};
use serde_json::json;
fn database() -> Database {
    Database::open(&std::env::temp_dir().join(format!("nabbit-sticky-{}", uuid::Uuid::new_v4())))
        .unwrap()
}
fn binding(card: &crate::notes::store::StoredNote) -> Binding {
    Binding {
        instance: uuid::Uuid::new_v4().to_string(),
        card_id: card.value["id"].as_str().unwrap().into(),
        scope: card.scope.clone(),
    }
}
fn profile(monitor: &str) -> Profile {
    Profile {
        monitor: monitor.into(),
        x: 36.,
        y: 42.,
        width: 280.,
        height: 200.,
        pinned: true,
        opacity: 100,
    }
}
fn activate(db: &Database, workspace: &str) -> Context {
    db.tack_activate(&Identity {
        base_url: "https://fixture.invalid/".into(),
        user_id: "u".into(),
        workspace_id: workspace.into(),
    })
    .unwrap()
}
fn note(db: &Database, scope: Option<&Context>) -> crate::notes::store::StoredNote {
    db.create_note_card_in(
        NoteDraft {
            title: "Keep this".into(),
            ..Default::default()
        },
        scope,
    )
    .unwrap()
}
fn draft(note: &crate::notes::store::StoredNote, text: &str) -> Draft {
    let mut value = note.value.clone();
    value["body"] = json!(text);
    Draft {
        base: note.clone(),
        value,
        copy_id: Some(uuid::Uuid::new_v4().to_string()),
        copy_request: None,
    }
}
#[test]
fn bounded_checkpoint_fits_two_full_cards_and_a_frozen_copy_packet() {
    let db = database();
    let mut first = note(&db, None);
    first.value["items"] =
        json!([{"id":"stable","text":"Keep this","checked":false,"future": "x".repeat(2_200_000)}]);
    crate::notes::store::validate_card(&first.value).unwrap();
    let binding = binding(&first);
    let mut journal = draft(&first, "Draft with a future item field");
    journal.copy_request = Some(crate::notes::capture::CaptureRequest {
        request_id: journal.copy_id.clone().unwrap(),
        expected_scope: None,
        draft: NoteDraft {
            title: "Recovered".into(),
            ..Default::default()
        },
        patch: json!({"items": first.value["items"]}),
        reminders: vec![],
    });
    db.sticky_checkpoint(&binding, 1, journal.clone()).unwrap();
    let kept = db.sticky_content(&binding).unwrap().checkpoint.unwrap();
    assert_eq!(
        kept.draft.copy_request.unwrap().patch["items"][0]["future"]
            .as_str()
            .unwrap()
            .len(),
        2_200_000
    );
    journal.value["futureOversized"] = json!("x".repeat(3_000_000));
    assert!(db.sticky_checkpoint(&binding, 2, journal).is_err());
    assert_eq!(
        db.sticky_content(&binding)
            .unwrap()
            .checkpoint
            .unwrap()
            .sequence,
        1
    );
}

#[test]
fn independent_card_monitor_profiles_and_open_state_survive_reopen() {
    let db = database();
    let first = note(&db, None);
    let a = binding(&first);
    let second = note(&db, None);
    let b = binding(&second);
    let left = profile("left");
    let mut right = profile("right");
    right.width = 480.;
    right.opacity = 60;
    right.pinned = false;
    db.sticky_remember(&a, &left, true, Some(&first)).unwrap();
    db.sticky_remember(&a, &right, true, None).unwrap();
    db.sticky_remember(&b, &left, false, Some(&second)).unwrap();
    let path = db.path().parent().unwrap().to_path_buf();
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.sticky_profile(None, &a.card_id, "left").unwrap(),
        Some(left)
    );
    assert_eq!(
        db.sticky_profile(None, &a.card_id, "right").unwrap(),
        Some(right)
    );
    let open = db.sticky_saved(None, true).unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].card_id, a.card_id);
    assert_eq!(open[0].monitor, "right");
    assert!(db
        .sticky_profile(None, &b.card_id, "right")
        .unwrap()
        .is_none());
}
#[test]
fn checkpoint_order_and_acknowledgement_cannot_erase_newer_edits_or_instance() {
    let db = database();
    let first = note(&db, None);
    let a = binding(&first);
    db.sticky_checkpoint(&a, 8, draft(&first, "newer")).unwrap();
    db.sticky_checkpoint(&a, 7, draft(&first, "older")).unwrap();
    db.sticky_clear_checkpoint(&a, 7).unwrap();
    let kept = db.sticky_content(&a).unwrap().checkpoint.unwrap();
    assert_eq!(kept.sequence, 8);
    assert_eq!(kept.draft.value["body"], "newer");
    let mut reopened = a.clone();
    reopened.instance = "reopened".into();
    db.sticky_checkpoint(&reopened, 1, kept.draft).unwrap();
    db.sticky_clear_checkpoint(&a, 99).unwrap();
    assert_eq!(
        db.sticky_content(&reopened)
            .unwrap()
            .checkpoint
            .unwrap()
            .instance,
        "reopened"
    );
    db.sticky_clear_checkpoint(&reopened, 1).unwrap();
    assert!(db.sticky_content(&reopened).unwrap().checkpoint.is_none());
}
#[test]
fn removed_card_keeps_cached_value_and_durable_draft_without_recreating_original() {
    let db = database();
    let first = note(&db, None);
    let a = binding(&first);
    db.sticky_remember(&a, &profile("only"), true, Some(&first))
        .unwrap();
    db.sticky_checkpoint(&a, 2, draft(&first, "unsaved"))
        .unwrap();
    db.conn
        .lock()
        .unwrap()
        .execute("DELETE FROM note_cards WHERE id=?1", [&a.card_id])
        .unwrap();
    let path = db.path().parent().unwrap().to_path_buf();
    drop(db);
    let db = Database::open(&path).unwrap();
    let content = db.sticky_content(&a).unwrap();
    assert_eq!(content.status, "gone");
    assert_eq!(content.note.unwrap().value, first.value);
    assert_eq!(content.checkpoint.unwrap().draft.value["body"], "unsaved");
    assert!(db
        .sticky_save_bound(&a, first, json!({"body":"must not recreate"}))
        .is_err());
    assert!(db.list_note_cards().unwrap().is_empty());
}
#[test]
fn workspace_epoch_and_identity_changes_keep_drafts_scoped_and_block_writes() {
    let db = database();
    let scope = activate(&db, "a");
    let first = note(&db, Some(&scope));
    let a = binding(&first);
    db.sticky_remember(&a, &profile("only"), true, Some(&first))
        .unwrap();
    db.sticky_checkpoint(&a, 1, draft(&first, "A draft"))
        .unwrap();
    let b = activate(&db, "b");
    let content = db.sticky_content(&a).unwrap();
    assert_eq!(content.status, "scopeChanged");
    assert_eq!(content.current_scope, Some(b.clone()));
    assert_eq!(content.checkpoint.unwrap().draft.value["body"], "A draft");
    assert!(db.sticky_saved(Some(&b), true).unwrap().is_empty());
    assert!(db
        .sticky_profile(Some(&b), &a.card_id, "only")
        .unwrap()
        .is_none());
    assert!(db
        .sticky_save_bound(&a, first.clone(), json!({"body":"wrong workspace"}))
        .is_err());
    let current = activate(&db, "a");
    assert_ne!(scope, current);
    assert_eq!(db.sticky_content(&a).unwrap().status, "scopeChanged");
    assert!(db
        .sticky_save_bound(&a, first, json!({"body":"stale epoch"}))
        .is_err());
}
#[test]
fn guarded_save_preserves_unknown_fields_and_rejects_stale_or_unbound_mutations() {
    let db = database();
    let first = note(&db, None);
    let a = binding(&first);
    let first=db.update_note_card_in(&a.card_id,0,None,Some(&first.edit_token),json!({"items":[{"id":"stable","text":"Verify","checked":false,"future":{"kept":true}}]})).unwrap();
    let saved=db.sticky_save_bound(&a,first.clone(),json!({"items":[{"id":"stable","text":"Verify","checked":true,"future":{"kept":true}}]})).unwrap();
    assert_eq!(saved.value["items"][0]["future"]["kept"], true);
    assert_eq!(saved.value["items"][0]["id"], "stable");
    assert!(db
        .sticky_save_bound(&a, first, json!({"body":"stale token"}))
        .is_err());
    assert!(db
        .sticky_save_bound(&a, saved.clone(), json!({"color":"blue"}))
        .is_err());
    let other = note(&db, None);
    assert!(db
        .sticky_save_bound(&a, other.clone(), json!({"title":"wrong card"}))
        .is_err());
    assert!(db
        .sticky_checkpoint(&a, 1, draft(&other, "wrong card"))
        .is_err());
    let mut invalid = profile("only");
    invalid.opacity = 59;
    assert!(db
        .sticky_remember(&a, &invalid, true, Some(&saved))
        .is_err());
}
#[test]
fn read_only_workspace_displays_cached_card_and_rejects_sticky_writes() {
    let db = database();
    let scope = activate(&db, "readonly");
    let first = note(&db, Some(&scope));
    let a = binding(&first);
    let conn = db.conn.lock().unwrap();
    crate::notes::sync_store::set_meta(&conn, &format!("read_only/{}", scope.key), "true").unwrap();
    drop(conn);
    assert!(db.sticky_content(&a).unwrap().read_only);
    assert!(db
        .sticky_save_bound(&a, first.clone(), json!({"body":"blocked"}))
        .is_err());
    assert_eq!(
        db.note_editor(&a.card_id, Some(&scope)).unwrap().note.value,
        first.value
    );
}
