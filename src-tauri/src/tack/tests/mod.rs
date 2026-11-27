mod fake;
mod merge;
mod sync_tests;

#[test]
fn field_merge_matches_100_pinned_php_reference_cases() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/tack/merge.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let actual = merge::merge_protocol_write(
            &case["base"],
            &case["current"],
            &case["incoming"],
            fake::STAMP,
        )
        .or_else(|| {
            merge::merge_fields(
                &case["base"],
                &case["current"],
                &case["incoming"],
                fake::STAMP,
            )
        })
        .unwrap_or(serde_json::Value::Null);
        assert!(
            actual == case["expected"],
            "PHP merge mismatch: {}",
            case["name"]
        );
    }
}

use super::{
    client::Client,
    endpoint::Endpoint,
    model::{ErrorCode, Mutation, SyncStatus},
    session::{KeyringVault, Password, RecoveryCode, Scope, Secrets, Vault},
};
use fake::{Fake, PASSWORD};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct MemoryVault {
    values: Mutex<HashMap<String, Secrets>>,
    fail_save: bool,
}
impl Vault for MemoryVault {
    fn load(&self, s: &Scope) -> super::model::Result<Option<Secrets>> {
        Ok(self.values.lock().unwrap().get(&s.account).cloned())
    }
    fn save(&self, s: &Scope, value: &Secrets) -> super::model::Result<()> {
        if self.fail_save {
            return Err(super::model::Error::new(ErrorCode::SecureStorage));
        }
        self.values
            .lock()
            .unwrap()
            .insert(s.account.clone(), value.clone());
        Ok(())
    }
    fn clear(&self, s: &Scope) -> super::model::Result<()> {
        self.values.lock().unwrap().remove(&s.account);
        Ok(())
    }
}
fn client(fake: &Fake, vault: Arc<MemoryVault>) -> Client {
    Client::new(fake.endpoint.clone(), vault).unwrap()
}
fn login(client: &mut Client) {
    let reply = client
        .login("Fixture", Password::new(PASSWORD.into()))
        .unwrap();
    if let Some(code) = reply.recovery_code {
        client.confirm_recovery(code).unwrap();
    }
    assert!(client.snapshot().ready);
}
fn card(id: &str, body: &str) -> Value {
    json!({"id":id,"title":"Fixture","body":body,"labels":[],"ref":"","revision":0,"updatedAt":fake::STAMP,"future":{"preserve":true}})
}
fn mutation(id: &str, value: Value) -> Mutation {
    Mutation {
        table: "cards".into(),
        id: id.into(),
        base_version: 0,
        base_value: Value::Null,
        value,
    }
}
fn record(reply: &super::model::SyncReply, id: &str) -> super::model::Record {
    reply
        .changes
        .iter()
        .find(|r| r.table == "cards" && r.id == id)
        .unwrap()
        .clone()
}

#[test]
fn endpoint_is_https_only_and_separates_installations() {
    for value in [
        "http://example.test",
        "http://127.0.0.1:8787",
        "file:///tack",
        "https://u:p@example.test",
        "https://example.test/?token=x",
        "https://example.test/#x",
        "https://",
    ] {
        assert!(Endpoint::new(value).is_err(), "{value}");
    }
    let first = Endpoint::new("https://EXAMPLE.test/tack").unwrap();
    let normalized = Endpoint::new("https://example.test/tack/").unwrap();
    assert_eq!(first.scope(), normalized.scope());
    assert_eq!(
        first.action("status").as_str(),
        "https://example.test/tack/api/index.php?action=status"
    );
    for url in [
        "https://example.test/other/",
        "https://example.test:444/tack/",
        "https://another.test/tack/",
    ] {
        assert_ne!(first.scope(), Endpoint::new(url).unwrap().scope());
    }
}
#[test]
fn session_rotation_recovery_workspace_restart_and_logout() {
    let fake = Fake::start();
    let vault = Arc::new(MemoryVault::default());
    let mut first = client(&fake, vault.clone());
    assert_eq!(fake.state.lock().unwrap().requests, 0);
    assert!(first.snapshot().user.is_none());
    first.status().unwrap();
    let before = vault.load(fake.endpoint.scope()).unwrap().unwrap();
    let reply = first
        .login("fixture", Password::new(PASSWORD.into()))
        .unwrap();
    assert!(reply.connection.recovery_pending);
    assert!(!reply.connection.ready);
    let code = reply.recovery_code.unwrap();
    let after = vault.load(fake.endpoint.scope()).unwrap().unwrap();
    assert!(before.cookie != after.cookie && before.csrf != after.csrf);
    assert_eq!(
        first.sync(0, &[]).unwrap_err().state,
        SyncStatus::RecoveryPending
    );
    let public = serde_json::to_string(&first.snapshot()).unwrap();
    assert!(
        !public.contains(&after.csrf)
            && !public.contains(code.value())
            && !public.contains(PASSWORD)
    );
    let mut second = client(&fake, Arc::new(MemoryVault::default()));
    let rotated = second
        .login("fixture", Password::new(PASSWORD.into()))
        .unwrap()
        .recovery_code
        .unwrap();
    assert!(rotated.value() != code.value());
    assert_eq!(
        first.confirm_recovery(code).unwrap_err().code,
        ErrorCode::Conflict
    );
    second.confirm_recovery(rotated).unwrap();
    first.status().unwrap();
    assert!(first.snapshot().ready);
    first.switch_workspace("team").unwrap();
    assert_eq!(first.snapshot().workspace.unwrap().id, "team");
    assert!(first.sync(0, &[]).unwrap().changes.is_empty());
    drop(first);
    let mut restored = client(&fake, vault.clone());
    assert_eq!(restored.status().unwrap().workspace.unwrap().id, "team");
    restored.logout().unwrap();
    assert!(vault.load(fake.endpoint.scope()).unwrap().is_none());
    assert!(client(&fake, vault).status().unwrap().user.is_none());
}
#[test]
fn server_merge_versions_conflicts_references_and_unknown_fields() {
    let fake = Fake::start();
    let mut a = client(&fake, Arc::new(MemoryVault::default()));
    login(&mut a);
    let created = a
        .sync(0, &[mutation("one", card("one", "alpha beta gamma"))])
        .unwrap();
    let base = record(&created, "one");
    assert_eq!(base.value["ref"], "tck-1");
    assert_eq!(base.version, 1);
    let mut left = base.value.clone();
    left["body"] = json!("ALPHA beta gamma");
    left["labels"] = json!(["left"]);
    left["revision"] = json!(1);
    a.sync(
        created.cursor,
        &[Mutation {
            base_version: base.version,
            base_value: base.value.clone(),
            ..mutation("one", left)
        }],
    )
    .unwrap();
    let mut right = base.value.clone();
    right["body"] = json!("alpha beta GAMMA");
    right["labels"] = json!(["right"]);
    right["pinned"] = json!(true);
    right["revision"] = json!(1);
    let merged = a
        .sync(
            0,
            &[Mutation {
                base_version: 1,
                base_value: base.value.clone(),
                ..mutation("one", right)
            }],
        )
        .unwrap();
    assert!(merged.conflicts.is_empty());
    let current = record(&merged, "one");
    assert_eq!(current.value["body"], "ALPHA beta GAMMA");
    assert_eq!(current.value["labels"], json!(["left", "right"]));
    assert_eq!(current.value["future"], json!({"preserve":true}));
    assert_eq!(current.value["ref"], "tck-1");
    assert_eq!(current.value["revision"], 2);
    let mut overlap = base.value.clone();
    overlap["body"] = json!("other beta gamma");
    let conflict = a
        .sync(
            0,
            &[Mutation {
                base_version: 1,
                base_value: base.value,
                ..mutation("one", overlap)
            }],
        )
        .unwrap();
    assert_eq!(conflict.conflicts.len(), 1);
    assert_eq!(conflict.conflicts[0], current);
    let mut labeled = card("two", "body");
    labeled["labels"] = json!(["Build"]);
    let reply = a.sync(0, &[mutation("two", labeled)]).unwrap();
    assert_eq!(record(&reply, "two").value["ref"], "bui-2");
    a.sync(
        0,
        &[Mutation {
            base_version: current.version,
            base_value: current.value,
            ..mutation("one", Value::Null)
        }],
    )
    .unwrap();
    let restored = mutation("one", card("one", "restored"));
    let reply = a
        .sync(
            0,
            &[Mutation {
                base_version: 4,
                ..restored
            }],
        )
        .unwrap();
    assert_eq!(record(&reply, "one").value["ref"], "tck-1");
}
#[test]
fn mutation_limits_paging_hidden_records_and_storage_rollback() {
    let fake = Fake::start();
    let mut client = client(&fake, Arc::new(MemoryVault::default()));
    login(&mut client);
    let many = (0..51)
        .map(|i| mutation(&format!("card-{i}"), card(&format!("card-{i}"), "body")))
        .collect::<Vec<_>>();
    let before = fake.state.lock().unwrap().requests;
    assert_eq!(
        client.sync(0, &many).unwrap_err().code,
        ErrorCode::InvalidInput
    );
    assert_eq!(fake.state.lock().unwrap().requests, before);
    let mut cursor = 0;
    for batch in many.chunks(50) {
        cursor = client.sync(cursor, batch).unwrap().cursor;
    }
    assert!(cursor > 51);
    assert_eq!(client.sync(cursor, &[]).unwrap().changes.len(), 0);
    {
        let mut state = fake.state.lock().unwrap();
        for i in 0..205 {
            state.seed(
                "projects",
                &format!("project-{i}"),
                json!({"id":format!("project-{i}")}),
                i >= 200,
            );
        }
    }
    let hidden = client.sync(cursor, &[]).unwrap();
    assert!(hidden.more);
    assert!(hidden.changes.is_empty());
    assert!(hidden.cursor > cursor);
    let page = client.sync(hidden.cursor, &[]).unwrap();
    assert!(!page.more);
    assert_eq!(page.changes.len(), 5);
    fake.state.lock().unwrap().limits = (1, 100 * 1024 * 1024);
    assert_eq!(
        client
            .sync(
                page.cursor,
                &[mutation("rolled-back", card("rolled-back", "body"))]
            )
            .unwrap_err()
            .state,
        SyncStatus::StorageFull
    );
    fake.state.lock().unwrap().limits = (15_000, 100 * 1024 * 1024);
    assert!(client.sync(page.cursor, &[]).unwrap().changes.is_empty());
}
#[test]
fn every_http_error_maps_to_safe_state_and_retry_after_blocks_network() {
    let cases = [
        (401, SyncStatus::SignedOut),
        (403, SyncStatus::SignedOut),
        (409, SyncStatus::Conflict),
        (413, SyncStatus::StorageFull),
        (428, SyncStatus::RecoveryPending),
        (429, SyncStatus::RateLimited),
        (503, SyncStatus::Offline),
    ];
    for (status, expected) in cases {
        let fake = Fake::start();
        let vault = Arc::new(MemoryVault::default());
        let mut client = client(&fake, vault.clone());
        login(&mut client);
        fake.fault(
            status,
            json!({"error":PASSWORD}),
            if status == 429 {
                vec![("Retry-After".into(), "900".into())]
            } else {
                vec![]
            },
        );
        let error = client.sync(0, &[]).unwrap_err();
        assert_eq!(error.state, expected);
        assert_eq!(error.http_status, Some(status));
        assert!(!format!("{error:?} {error}").contains(PASSWORD));
        if status == 401 || status == 403 {
            assert!(vault.load(fake.endpoint.scope()).unwrap().is_none());
            assert!(client.snapshot().user.is_none());
        }
        if status == 429 {
            assert_eq!(error.retry_after_ms, Some(900_000));
            let requests = fake.state.lock().unwrap().requests;
            assert_eq!(client.status().unwrap_err().code, ErrorCode::RateLimited);
            assert_eq!(fake.state.lock().unwrap().requests, requests);
        }
    }
    let fake = Fake::start();
    let mut client = client(&fake, Arc::new(MemoryVault::default()));
    login(&mut client);
    fake.fault(
        409,
        json!({"workspaceAccessChanged":true,"workspaceId":"elsewhere"}),
        vec![],
    );
    assert_eq!(
        client.sync(0, &[]).unwrap_err().state,
        SyncStatus::WorkspaceChanged
    );
}
#[test]
fn logout_offline_clears_session_and_vault_failure_never_falls_back() {
    let fake = Fake::start();
    let vault = Arc::new(MemoryVault::default());
    let mut client = client(&fake, vault.clone());
    login(&mut client);
    fake.fault(503, json!({"error":"offline"}), vec![]);
    assert_eq!(client.logout().unwrap_err().code, ErrorCode::Offline);
    assert!(vault.load(fake.endpoint.scope()).unwrap().is_none());
    assert!(client.snapshot().user.is_none());
    let bad = Arc::new(MemoryVault {
        fail_save: true,
        ..MemoryVault::default()
    });
    let mut client = Client::new(fake.endpoint.clone(), bad.clone()).unwrap();
    assert_eq!(client.status().unwrap_err().code, ErrorCode::SecureStorage);
    assert!(bad.load(fake.endpoint.scope()).unwrap().is_none());
}
#[test]
fn fake_rate_limit_and_recovery_guards_are_server_side() {
    let fake = Fake::start();
    let vault = Arc::new(MemoryVault::default());
    for _ in 0..10 {
        let mut client = client(&fake, vault.clone());
        assert_eq!(
            client
                .login("fixture", Password::new("incorrect-password".into()))
                .unwrap_err()
                .code,
            ErrorCode::SignedOut
        );
    }
    let mut next = client(&fake, vault.clone());
    assert_eq!(
        next.login("fixture", Password::new(PASSWORD.into()))
            .unwrap_err()
            .code,
        ErrorCode::RateLimited
    );
    fake.state.lock().unwrap().advance(901);
    let mut fresh = client(&fake, vault);
    login(&mut fresh);
}
#[test]
fn corrupted_and_foreign_responses_are_rejected_without_data_application() {
    let fake = Fake::start();
    let mut client = client(&fake, Arc::new(MemoryVault::default()));
    login(&mut client);
    for value in [
        json!({"changes":[{"table":"cards","id":"x","version":1}],"cursor":1,"more":false,"userId":"user-1","workspaceId":"personal"}),
        json!({"changes":[],"cursor":0,"more":false,"userId":"wrong","workspaceId":"personal"}),
    ] {
        fake.fault(200, value, vec![]);
        let error = client.sync(0, &[]).unwrap_err();
        assert!([ErrorCode::InvalidResponse, ErrorCode::WorkspaceChanged].contains(&error.code));
    }
}
#[cfg(windows)]
#[test]
fn windows_credential_manager_roundtrip_contains_only_cookie_and_csrf() {
    let base = Endpoint::new(&format!("https://{}.invalid/tack/", uuid::Uuid::new_v4())).unwrap();
    let scope = base.scope().clone();
    let vault = KeyringVault;
    struct Cleanup(Scope);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = KeyringVault.clear(&self.0);
        }
    }
    let _cleanup = Cleanup(scope.clone());
    assert!(vault.load(&scope).unwrap().is_none());
    let secrets = Secrets {
        cookie: "tack_sid=synthetic; Path=/tack/; HttpOnly; Secure".into(),
        csrf: "synthetic-csrf".into(),
    };
    vault.save(&scope, &secrets).unwrap();
    let loaded = vault.load(&scope).unwrap().unwrap();
    assert!(loaded.cookie == secrets.cookie && loaded.csrf == secrets.csrf);
    let raw = loaded.encode().unwrap();
    let json: Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(
        json.as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["cookie", "csrf"]
    );
    assert!(!format!(
        "{loaded:?} {:?} {:?}",
        Password::new(PASSWORD.into()),
        RecoveryCode::new("test-code".into())
    )
    .contains(PASSWORD));
    vault.clear(&scope).unwrap();
    assert!(vault.load(&scope).unwrap().is_none());
}

#[test]
fn auth_wire_fixtures_match_server_actions_and_header_guards() {
    let fake = Fake::start();
    let http = reqwest::blocking::Client::builder()
        .cookie_store(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let cases: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/tack/auth.json")).unwrap();
    fn replace(value: &mut Value, csrf: &str, recovery: &str) {
        match value {
            Value::String(s) => {
                *value = match s.as_str() {
                    "<password>" => json!(PASSWORD),
                    "<recovery>" => json!(recovery),
                    "<csrf>" => json!(csrf),
                    "<personal>" => fake::workspace("personal"),
                    "<team>" => fake::workspace("team"),
                    _ => return,
                };
            }
            Value::Array(a) => {
                for v in a {
                    replace(v, csrf, recovery);
                }
            }
            Value::Object(o) => {
                for v in o.values_mut() {
                    replace(v, csrf, recovery);
                }
            }
            _ => {}
        }
    }
    let mut csrf = String::new();
    let mut recovery = String::new();
    let mut selected = "personal".to_owned();
    for case in cases.as_array().unwrap() {
        let action = case["action"].as_str().unwrap();
        let mut input = case["request"].clone();
        replace(&mut input, &csrf, &recovery);
        let request = if case["method"] == "GET" {
            http.get(fake.endpoint.action(action))
        } else {
            http.post(fake.endpoint.action(action))
                .header("X-CSRF-Token", &csrf)
                .header("X-Workspace-User", "user-1")
                .header(
                    "X-Tack-Workspace",
                    case["workspaceHeader"].as_str().unwrap_or(&selected),
                )
                .json(&input)
        };
        let response = request.send().unwrap();
        assert_eq!(
            response.status().as_u16(),
            case["status"].as_u64().unwrap() as u16,
            "{}",
            case["name"]
        );
        let mut value: Value = response.json().unwrap();
        if let Some(token) = value.get("csrf").and_then(Value::as_str) {
            csrf = token.into();
        }
        if let Some(code) = value.get("recoveryCode").and_then(Value::as_str) {
            recovery = code.into();
        }
        if let Some(id) = value
            .get("workspace")
            .and_then(|w| w.get("id"))
            .and_then(Value::as_str)
        {
            selected = id.into();
        }
        if value.get("error").is_some() {
            value["error"] = json!("<error>");
        }
        let mut expected = case["response"].clone();
        replace(&mut expected, &csrf, &recovery);
        // Boolean comparison keeps session/recovery tokens out of assertion diagnostics.
        assert!(value == expected, "Wire fixture mismatch: {}", case["name"]);
    }
}

#[test]
fn fake_enforces_mutation_limits_not_just_the_client() {
    let fake = Fake::start();
    let vault = Arc::new(MemoryVault::default());
    let mut client = client(&fake, vault.clone());
    login(&mut client);
    let saved = vault.load(fake.endpoint.scope()).unwrap().unwrap();
    let cookie = cookie::Cookie::parse(saved.cookie.clone()).unwrap();
    let http = reqwest::blocking::Client::new();
    for mutations in [
        vec![mutation("duplicate", card("duplicate", "x")); 2],
        (0..51)
            .map(|i| mutation(&format!("m{i}"), card(&format!("m{i}"), "x")))
            .collect(),
    ] {
        let response = http
            .post(fake.endpoint.action("sync"))
            .header("Cookie", format!("tack_sid={}", cookie.value()))
            .header("X-CSRF-Token", &saved.csrf)
            .header("X-Workspace-User", "user-1")
            .header("X-Tack-Workspace", "personal")
            .json(&json!({"cursor":0,"mutations":mutations}))
            .send()
            .unwrap();
        assert_eq!(response.status().as_u16(), 400);
    }
    assert!(client.sync(0, &[]).unwrap().changes.is_empty());
}

#[test]
fn transport_does_not_follow_redirects_or_apply_unexpected_cookies() {
    let fake = Fake::start();
    let other = Fake::start();
    let mut client = client(&fake, Arc::new(MemoryVault::default()));
    login(&mut client);
    fake.fault(
        302,
        json!({"error":"redirect"}),
        vec![(
            "Location".into(),
            other.endpoint.action("status").to_string(),
        )],
    );
    assert_eq!(
        client.status().unwrap_err().code,
        ErrorCode::InvalidResponse
    );
    assert_eq!(other.state.lock().unwrap().requests, 0);
}

#[test]
fn oversized_request_and_extreme_retry_header_cannot_bypass_bounds() {
    let fake = Fake::start();
    let mut client = client(&fake, Arc::new(MemoryVault::default()));
    login(&mut client);
    let requests = fake.state.lock().unwrap().requests;
    assert_eq!(
        client
            .sync(
                0,
                &[mutation(
                    "large",
                    card("large", &"x".repeat(8 * 1024 * 1024))
                )]
            )
            .unwrap_err()
            .code,
        ErrorCode::StorageFull
    );
    assert_eq!(fake.state.lock().unwrap().requests, requests);
    fake.fault(
        429,
        json!({"error":"wait"}),
        vec![("Retry-After".into(), u64::MAX.to_string())],
    );
    assert_eq!(
        client.sync(0, &[]).unwrap_err().retry_after_ms,
        Some(u64::MAX)
    );
    let requests = fake.state.lock().unwrap().requests;
    assert_eq!(client.status().unwrap_err().code, ErrorCode::RateLimited);
    assert_eq!(fake.state.lock().unwrap().requests, requests);
}

#[test]
fn tombstone_versions_and_paging_must_make_progress() {
    let fake = Fake::start();
    let mut client = client(&fake, Arc::new(MemoryVault::default()));
    login(&mut client);
    for value in [
        json!({"changes":[{"table":"cards","id":"missing","version":0,"value":null}],"cursor":1,"more":false,"userId":"user-1","workspaceId":"personal"}),
        json!({"changes":[],"cursor":0,"more":true,"userId":"user-1","workspaceId":"personal"}),
    ] {
        fake.fault(200, value, vec![]);
        assert_eq!(
            client.sync(0, &[]).unwrap_err().code,
            ErrorCode::InvalidResponse
        );
    }
    // A missing server row is a legitimate version-zero conflict, not a change.
    fake.fault(200,json!({"changes":[],"conflicts":[{"table":"cards","id":"missing","version":0,"value":null}],"cursor":0,"more":false,"userId":"user-1","workspaceId":"personal"}),vec![]);
    assert_eq!(client.sync(0, &[]).unwrap().conflicts[0].version, 0);
}
