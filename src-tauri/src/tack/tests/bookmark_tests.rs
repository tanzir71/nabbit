use super::{client, fake::Fake, login, MemoryVault};
use crate::{
    db::Database,
    notes::{
        links::{
            parse::Bookmark,
            store::{Options, Plan},
        },
        sync_store::Identity,
    },
    tack::sync,
};
use std::sync::Arc;
#[test]
fn bookmark_import_upload_and_group_undo_use_real_fifty_mutation_batches() {
    let fake = Fake::start();
    let db = Database::open(
        &std::env::temp_dir().join(format!("nabbit-bookmark-sync-{}", uuid::Uuid::new_v4())),
    )
    .unwrap();
    let plan = Plan {
        id: uuid::Uuid::new_v4().to_string(),
        scope: None,
        bookmarks: (0..56)
            .map(|i| Bookmark {
                title: format!("Link {i}"),
                url: format!("https://example.invalid/doc/{i}"),
                labels: vec!["Design".into()],
                created_at: Some("2024-01-01T00:00:00.000Z".into()),
            })
            .collect(),
        options: Options::default(),
        skipped: 0,
        files: vec!["fixture/Bookmarks".into()],
    };
    let imported = db.import_bookmarks(&plan, |_, _| {}).unwrap();
    assert_eq!(imported.imported, 56);
    let mut http = client(&fake, Arc::new(MemoryVault::default()));
    login(&mut http);
    let scope = db
        .tack_activate(&Identity {
            base_url: fake.endpoint.base().to_string(),
            user_id: "user-1".into(),
            workspace_id: "personal".into(),
        })
        .unwrap();
    assert_eq!(db.tack_upload_local(&scope).unwrap(), 56);
    assert_eq!(db.tack_upload_local(&scope).unwrap(), 0);
    let history = db.bookmark_imports(Some(&scope)).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].id, plan.id);
    assert_ne!(history[0].first_card_id, imported.first_card_id);
    assert!(history[0].undo_available);
    sync::cycle(&db, &scope, &mut http).unwrap();
    assert_eq!(
        fake.state
            .lock()
            .unwrap()
            .batches
            .iter()
            .copied()
            .filter(|n| *n > 0)
            .collect::<Vec<_>>(),
        vec![50, 6]
    );
    let notes = db.list_note_cards().unwrap();
    assert_eq!(notes.len(), 56);
    assert!(notes.iter().all(|n| n.value["kind"] == "bookmark"
        && n.value["createdAt"] == "2024-01-01T00:00:00.000Z"
        && n.value["priority"] == "later"
        && n.value["labels"] == serde_json::json!(["Design"])
        && !n.value["ref"].as_str().unwrap().is_empty()));
    assert_eq!(db.undo_bookmark_import(&plan.id, Some(&scope)).unwrap(), 56);
    assert_eq!(db.undo_bookmark_import(&plan.id, Some(&scope)).unwrap(), 0);
    sync::cycle(&db, &scope, &mut http).unwrap();
    assert_eq!(
        fake.state
            .lock()
            .unwrap()
            .batches
            .iter()
            .copied()
            .filter(|n| *n > 0)
            .collect::<Vec<_>>(),
        vec![50, 6, 50, 6]
    );
    assert!(db
        .list_note_cards()
        .unwrap()
        .iter()
        .all(|n| !n.value["trashedAt"].is_null()));
    assert!(db.tack_queue(&scope).unwrap().is_empty());
}
