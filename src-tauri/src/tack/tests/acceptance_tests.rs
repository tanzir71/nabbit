//! Acceptance covers actual Service/HTTP/SQLite boundaries. The vault uses the
//! same Secrets encoding as production; the separate Windows roundtrip tests
//! the real Credential Manager in a disposable .invalid namespace.
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
        model::SyncStatus,
        service::Service,
        session::{Password, RecoveryCode, Secrets},
    },
};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
struct Stop(Service);
impl Drop for Stop {
    fn drop(&mut self) {
        self.0.stop();
    }
}
fn wait(mut action: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(8);
    while !action() {
        assert!(
            Instant::now() < until,
            "owned fake service did not reach the expected state"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn service_errors_keep_queue_and_never_persist_password_or_untrusted_error_text() {
    for (status, access, expected) in [
        (401, false, SyncStatus::SignedOut),
        (403, false, SyncStatus::SignedOut),
        (409, false, SyncStatus::Conflict),
        (409, true, SyncStatus::WorkspaceChanged),
        (413, false, SyncStatus::StorageFull),
        (428, false, SyncStatus::RecoveryPending),
        (429, false, SyncStatus::RateLimited),
        (503, false, SyncStatus::Offline),
    ] {
        let fake = Fake::start();
        let directory =
            std::env::temp_dir().join(format!("nabbit-notes-acceptance-{}", uuid::Uuid::new_v4()));
        let db = Database::open(&directory).unwrap();
        let vault = Arc::new(MemoryVault::default());
        let service = Service::test_connection(
            db.clone(),
            fake.endpoint.clone(),
            vault.clone(),
            Arc::new(|_| {}),
        )
        .unwrap();
        let _stop = Stop(service.clone());
        service.status(fake.endpoint.base().as_str()).unwrap();
        let login = service
            .login("Fixture", Password::new(PASSWORD.into()))
            .unwrap();
        let recovery = login.recovery_code.map(|code| code.value().to_owned());
        if let Some(code) = &recovery {
            service.confirm(code.clone()).unwrap();
        }
        let connection = service.snapshot().unwrap();
        service
            .start_scope(Setup {
                workspace_id: "personal".into(),
                expected_user_id: connection.user.unwrap().id,
                expected_base_url: connection.base_url.unwrap(),
                preferences: Preferences::default(),
                upload_local: false,
            })
            .unwrap();
        wait(|| service.sync_snapshot().unwrap().state == SyncStatus::UpToDate);
        let scope = db.notes_context().unwrap().unwrap();
        db.create_note_card_in(
            NoteDraft {
                title: format!("Keep queued on {status}"),
                ..Default::default()
            },
            Some(&scope),
        )
        .unwrap();
        fake.fault(
            status,
            if access {
                json!({"workspaceAccessChanged":true,"workspaceId":"elsewhere","error":PASSWORD})
            } else {
                json!({"error":PASSWORD})
            },
            if status == 429 {
                vec![("Retry-After".into(), "30".into())]
            } else {
                vec![]
            },
        );
        service.request_sync();
        wait(|| service.sync_snapshot().unwrap().state == expected);
        let public = serde_json::to_string(&service.sync_snapshot().unwrap()).unwrap();
        assert!(!public.contains(PASSWORD));
        let count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM tack_outbox WHERE scope=?1",
                [&scope.key],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        for secrets in vault.values.lock().unwrap().values() {
            let value: serde_json::Value =
                serde_json::from_slice(&secrets.encode().unwrap()).unwrap();
            assert_eq!(
                value
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                vec!["cookie", "csrf"]
            );
        }
        service.stop();
        for entry in std::fs::read_dir(&directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                let bytes = std::fs::read(path).unwrap();
                for value in std::iter::once(PASSWORD).chain(recovery.as_deref()) {
                    assert!(!bytes.windows(value.len()).any(|w| w == value.as_bytes()));
                }
            }
        }
    }
}
#[test]
fn crash_output_redacts_auth_material() {
    const CHILD: &str = "NABBIT_NOTES_CRASH_REDACTION_CHILD";
    let markers = [
        PASSWORD,
        "crash-cookie-marker",
        "crash-csrf-marker",
        "crash-recovery-marker",
    ];
    if std::env::var(CHILD).as_deref() == Ok("1") {
        let password = Password::new(PASSWORD.into());
        let secrets = Secrets {
            cookie: "tack_sid=crash-cookie-marker; Path=/; HttpOnly; Secure".into(),
            csrf: "crash-csrf-marker".into(),
        };
        let recovery = RecoveryCode::new("crash-recovery-marker".into());
        panic!("controlled fixture panic {password:?} {secrets:?} {recovery:?}");
    }
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "tack::tests::acceptance_tests::crash_output_redacts_auth_material",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD, "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().unwrap();
    assert!(!output.status.success());
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(text.contains("controlled fixture panic"));
    assert!(text.contains("Password([redacted])"));
    assert!(text.contains("TackSession([redacted])"));
    assert!(text.contains("RecoveryCode([redacted])"));
    for marker in markers {
        assert!(!text.contains(marker));
    }
}
