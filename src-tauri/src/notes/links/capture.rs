//! One production boundary for scoped, idempotent link capture and metadata.
use crate::{
    db::{models::DownloadMetadata, Database},
    error::{msg, Result},
    notes::{capture::CaptureRequest, store::StoredNote},
};
pub(crate) fn save(
    db: &Database,
    request: CaptureRequest,
    cached: Option<&DownloadMetadata>,
) -> Result<StoredNote> {
    save_with(db, request, |url| super::title::fetch(url, cached))
}
fn save_with(
    db: &Database,
    request: CaptureRequest,
    fetch: impl FnOnce(&str) -> String,
) -> Result<StoredNote> {
    if request
        .patch
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .or(request.draft.kind.as_deref())
        != Some("bookmark")
    {
        return Err(msg("Link capture requires a bookmark"));
    }
    if uuid::Uuid::parse_str(&request.request_id)
        .ok()
        .is_none_or(|id| {
            id.get_version() != Some(uuid::Version::Random) || id.to_string() != request.request_id
        })
    {
        return Err(msg("Invalid link capture ID"));
    }
    let url = request
        .patch
        .get("url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&request.draft.url);
    let parsed = super::parse::web_url(url)?;
    let (replay, read_only) = {
        let conn = db.conn.lock().map_err(|_| msg("database lock poisoned"))?;
        crate::notes::sync_store::ensure(&conn, request.expected_scope.as_ref())?;
        let replay = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM note_capture_receipts WHERE request_id=?1)",
            [&request.request_id],
            |r| r.get::<_, bool>(0),
        )?;
        (
            replay,
            crate::notes::preferences::read_only(&conn, request.expected_scope.as_ref())?,
        )
    };
    if read_only && !replay {
        return Err(msg(
            "This Tack workspace is read only. Your link is preserved.",
        ));
    }
    let title = request
        .patch
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&request.draft.title);
    let automatic = title.trim().is_empty()
        || title.trim() == url.trim()
        || Some(title.trim()) == parsed.host_str();
    let title = (!replay && automatic).then(|| fetch(url));
    db.capture_note_enriched(request, title, true)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::{store::NoteDraft, sync_store::Identity};
    use serde_json::json;
    fn request() -> CaptureRequest {
        CaptureRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            expected_scope: None,
            draft: NoteDraft {
                title: "https://example.invalid/doc".into(),
                url: "https://example.invalid/doc".into(),
                kind: Some("bookmark".into()),
                ..Default::default()
            },
            patch: json!({}),
            reminders: vec![],
        }
    }
    fn db() -> Database {
        Database::open(
            &std::env::temp_dir().join(format!("nabbit-link-save-{}", uuid::Uuid::new_v4())),
        )
        .unwrap()
    }
    #[test]
    fn captured_title_is_frozen_for_retries_and_invalid_input_never_fetches() {
        let db = db();
        let mut r = request();
        r.patch = json!({"title": r.draft.title});
        let note = save_with(&db, r.clone(), |_| "Fixture title".into()).unwrap();
        assert_eq!(note.value["title"], "Fixture title");
        assert_eq!(
            save_with(&db, r.clone(), |_| panic!("retry fetched again"))
                .unwrap()
                .value,
            note.value
        );
        let mut bad = r;
        bad.request_id = "not-a-uuid".into();
        assert!(save_with(&db, bad, |_| panic!("invalid input fetched")).is_err());
    }
    #[test]
    fn a_workspace_change_during_title_fetch_preserves_both_scopes() {
        let db = db();
        let identity = Identity {
            base_url: "https://fixture.invalid/".into(),
            user_id: "u".into(),
            workspace_id: "personal".into(),
        };
        assert!(save_with(&db, request(), |_| {
            db.tack_activate(&identity).unwrap();
            "Title arrived after workspace changed".into()
        })
        .is_err());
        assert!(db.list_note_cards().unwrap().is_empty());
        let scope = db.notes_context().unwrap().unwrap();
        let mut r = request();
        r.expected_scope = Some(scope.clone());
        crate::notes::sync_store::set_meta(
            &db.conn.lock().unwrap(),
            &format!("read_only/{}", scope.key),
            "true",
        )
        .unwrap();
        assert!(save_with(&db, r, |_| panic!("read-only destination fetched")).is_err());
    }
}
