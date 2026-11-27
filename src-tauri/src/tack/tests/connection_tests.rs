use super::{
    fake::{Fake, PASSWORD},
    MemoryVault,
};
use crate::{
    db::Database,
    notes::{
        preferences::{Preferences, Setup},
        store::NoteDraft,
    },
    tack::{
        model::{ErrorCode, SyncStatus},
        service::Service,
        session::Password,
    },
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

fn db() -> Database {
    Database::open(
        &std::env::temp_dir().join(format!("nabbit-connect-test-{}", uuid::Uuid::new_v4())),
    )
    .unwrap()
}
fn setup(service: &Service, workspace: &str, preferences: Preferences, upload: bool) -> Setup {
    let connection = service.snapshot().unwrap();
    Setup {
        workspace_id: workspace.into(),
        expected_user_id: connection.user.unwrap().id,
        expected_base_url: connection.base_url.unwrap(),
        preferences,
        upload_local: upload,
    }
}
fn ready(service: &Service, fake: &Fake) {
    service.status(fake.endpoint.base().as_str()).unwrap();
    let reply = service
        .login("Fixture", Password::new(PASSWORD.into()))
        .unwrap();
    if let Some(code) = reply.recovery_code {
        service.confirm(code.value().into()).unwrap();
    }
}
struct Stop(Service);
impl Drop for Stop {
    fn drop(&mut self) {
        self.0.stop();
    }
}
#[test]
fn connection_requires_explicit_workspace_confirmation_and_keeps_scope_preferences_after_restart() {
    let fake = Fake::start();
    let db = db();
    let vault = Arc::new(MemoryVault::default());
    db.create_note_card(NoteDraft {
        title: "local before connecting".into(),
        ..Default::default()
    })
    .unwrap();
    let service =
        Service::test_connection(db.clone(), fake.endpoint.clone(), vault, Arc::new(|_| {}))
            .unwrap();
    let _stop = Stop(service.clone());
    ready(&service, &fake);
    assert!(service.snapshot().unwrap().ready);
    assert!(!db.tack_enabled().unwrap());
    assert_eq!(fake.state.lock().unwrap().sync_calls, 0);
    let chosen = Preferences {
        show_tasks: false,
        filter_labels: true,
        labels: vec!["Build".into()],
    };
    service
        .start_scope(setup(&service, "team", chosen, true))
        .unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while service.sync_snapshot().unwrap().state != SyncStatus::UpToDate {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(db.list_note_cards().unwrap().len(), 1);
    assert_eq!(db.tack_profile().unwrap().local_count, 0);
    assert!(db.list_note_cards().unwrap()[0].value["ref"]
        .as_str()
        .unwrap()
        .starts_with("tck-"));
    let path = db.path().parent().unwrap().to_path_buf();
    service.stop();
    let reopened = Database::open(&path).unwrap();
    let profile = reopened.tack_profile().unwrap();
    assert_eq!(profile.username, "fixture");
    assert!(!profile.preferences.show_tasks);
    assert_eq!(profile.preferences.labels, vec!["Build"]);
    assert_eq!(
        reopened.notes_state().unwrap().preferences.labels,
        vec!["Build"]
    );
}
#[test]
fn stale_setup_or_invalid_labels_never_enable_sync_or_migrate_local_notes() {
    let fake = Fake::start();
    let db = db();
    db.create_note_card(NoteDraft {
        title: "kept local".into(),
        ..Default::default()
    })
    .unwrap();
    let service = Service::test_connection(
        db.clone(),
        fake.endpoint.clone(),
        Arc::new(MemoryVault::default()),
        Arc::new(|_| {}),
    )
    .unwrap();
    let _stop = Stop(service.clone());
    ready(&service, &fake);
    let mut request = setup(&service, "team", Preferences::default(), true);
    request.expected_user_id = "stale-account".into();
    assert_eq!(
        service.start_scope(request).unwrap_err().code,
        ErrorCode::WorkspaceChanged
    );
    assert!(!db.tack_enabled().unwrap());
    assert_eq!(db.tack_profile().unwrap().local_count, 1);
    assert_eq!(fake.state.lock().unwrap().sync_calls, 0);
    assert_eq!(
        service
            .start_scope(setup(
                &service,
                "personal",
                Preferences {
                    filter_labels: true,
                    ..Default::default()
                },
                true
            ))
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    assert!(!db.tack_enabled().unwrap());
    assert_eq!(db.tack_profile().unwrap().local_count, 1);
}
#[test]
fn read_only_scope_rejects_writes_and_uploads_and_keeps_outbox_unmutated() {
    let fake = Fake::start();
    let db = db();
    let identity = crate::notes::sync_store::Identity {
        base_url: fake.endpoint.base().to_string(),
        user_id: "user-1".into(),
        workspace_id: "guest".into(),
    };
    let context = db
        .tack_configure(&identity, Some((Preferences::default(), true)))
        .unwrap();
    assert!(db
        .create_note_card_in(
            NoteDraft {
                title: "forbidden".into(),
                ..Default::default()
            },
            Some(&context)
        )
        .is_err());
    assert!(db.tack_upload_local(&context).is_err());
    assert!(db
        .tack_save_reminder(&context, "r", serde_json::json!({"id":"r"}))
        .is_err());
    assert!(db.list_note_cards().unwrap().is_empty());
    assert!(db.tack_queue(&context).unwrap().is_empty());
    assert!(db.notes_state().unwrap().read_only);
}
#[test]
fn read_only_membership_pulls_cards_but_never_uploads_local_notes() {
    let fake = Fake::start();
    fake.state.lock().unwrap().extra_guest = true;
    let db = db();
    let mut remote = db
        .create_note_card(NoteDraft {
            title: "Local remains local".into(),
            ..Default::default()
        })
        .unwrap()
        .value;
    remote["id"] = serde_json::json!("guest-card");
    remote["title"] = serde_json::json!("Shared read-only note");
    fake.state
        .lock()
        .unwrap()
        .seed_for("guest", "cards", "guest-card", remote, true);
    let service = Service::test_connection(
        db.clone(),
        fake.endpoint.clone(),
        Arc::new(MemoryVault::default()),
        Arc::new(|_| {}),
    )
    .unwrap();
    let _stop = Stop(service.clone());
    ready(&service, &fake);
    assert_eq!(
        service
            .start_scope(setup(&service, "guest", Preferences::default(), true))
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    assert!(!db.tack_enabled().unwrap());
    assert_eq!(db.tack_profile().unwrap().local_count, 1);
    service
        .start_scope(setup(&service, "guest", Preferences::default(), false))
        .unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while service.sync_snapshot().unwrap().state != SyncStatus::UpToDate {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
    let state = db.notes_state().unwrap();
    assert!(state.read_only);
    assert_eq!(state.cards[0].value["title"], "Shared read-only note");
    assert_eq!(db.tack_profile().unwrap().local_count, 1);
    assert!(fake.state.lock().unwrap().batches.iter().all(|n| *n == 0));
}
#[test]
fn workspace_view_preferences_are_partitioned_without_changing_the_active_scope() {
    let db = db();
    let mut identity = crate::notes::sync_store::Identity {
        base_url: "https://fixture.invalid/tack/".into(),
        user_id: "user".into(),
        workspace_id: "personal".into(),
    };
    let personal = db
        .tack_configure(
            &identity,
            Some((
                Preferences {
                    show_tasks: false,
                    filter_labels: true,
                    labels: vec!["Ideas".into()],
                },
                false,
            )),
        )
        .unwrap();
    identity.workspace_id = "studio".into();
    let studio = db
        .tack_configure(&identity, Some((Preferences::default(), false)))
        .unwrap();
    let saved = db.tack_profile_for(Some(&personal)).unwrap();
    assert!(!saved.preferences.show_tasks);
    assert_eq!(saved.preferences.labels, vec!["Ideas"]);
    assert_eq!(db.notes_context().unwrap(), Some(studio));
    assert!(db.tack_profile().unwrap().preferences.show_tasks);
}
