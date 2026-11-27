use super::{
    parse::Bookmark,
    sources::{self, Roots},
    store::{BulkAction, Guard, Options, Plan},
};
use crate::{
    db::Database,
    notes::{store::NoteDraft, sync_store::Identity},
};
use serde_json::json;
use std::{fs, path::PathBuf};
use uuid::Uuid;
fn directory() -> PathBuf {
    let p = std::env::temp_dir().join(format!("nabbit-bookmark-test-{}", Uuid::new_v4()));
    fs::create_dir(&p).unwrap();
    p
}
fn db() -> Database {
    Database::open(&directory()).unwrap()
}
fn item(i: usize) -> Bookmark {
    Bookmark {
        title: format!("Imported {i}"),
        url: format!("https://example.invalid/item/{i}"),
        labels: vec!["Design".into(), "Fonts".into()],
        created_at: Some("2024-01-01T00:00:00.000Z".into()),
    }
}
fn plan(scope: Option<crate::notes::sync_store::Context>, n: usize) -> Plan {
    Plan {
        id: Uuid::new_v4().to_string(),
        scope,
        bookmarks: (0..n).map(item).collect(),
        skipped: 0,
        files: vec!["fixture/Bookmarks".into()],
        options: Options::default(),
    }
}
fn guard(note: &crate::notes::store::StoredNote) -> Guard {
    Guard {
        id: note.value["id"].as_str().unwrap().into(),
        edit_token: note.edit_token.clone(),
    }
}
#[test]
fn import_is_atomic_once_only_and_one_durable_undo_group() {
    let db = db();
    let mut p = plan(None, 56);
    p.bookmarks.push(item(0));
    p.skipped = 1;
    assert_eq!(db.preview_bookmarks(&p).unwrap(), (56, 1));
    let mut progress = vec![];
    let result = db
        .import_bookmarks(&p, |done, total| progress.push((done, total)))
        .unwrap();
    assert_eq!(
        (result.imported, result.duplicates, result.skipped),
        (56, 1, 1)
    );
    assert_eq!(progress, vec![(50, 57), (57, 57)]);
    assert_eq!(
        db.import_bookmarks(&p, |_, _| panic!("retry must not recreate rows"))
            .unwrap()
            .imported,
        56
    );
    let rows = db.list_note_cards().unwrap();
    assert_eq!(rows.len(), 56);
    assert!(rows
        .iter()
        .all(|n| n.value["priority"] == "later"
            && n.value["createdAt"] == "2024-01-01T00:00:00.000Z"));
    let edited = db
        .update_note_card_in(
            rows[0].value["id"].as_str().unwrap(),
            0,
            None,
            Some(&rows[0].edit_token),
            json!({"body":"Edited after import"}),
        )
        .unwrap();
    let path = db.path().parent().unwrap().to_path_buf();
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(db.undo_bookmark_import(&p.id, None).unwrap(), 56);
    assert_eq!(db.undo_bookmark_import(&p.id, None).unwrap(), 0);
    assert!(db
        .list_note_cards()
        .unwrap()
        .iter()
        .all(|n| !n.value["trashedAt"].is_null()));
    assert_eq!(
        db.note_editor(edited.value["id"].as_str().unwrap(), None)
            .unwrap()
            .note
            .value["body"],
        "Edited after import"
    );
    assert!(!db.import_bookmarks(&p, |_, _| {}).unwrap().undo_available);
    assert_eq!(db.list_note_cards().unwrap().len(), 56);
}
#[test]
fn dedupe_includes_workspace_existing_links_and_can_be_disabled() {
    let db = db();
    db.create_note_card(NoteDraft {
        title: "Already here".into(),
        kind: Some("bookmark".into()),
        url: "HTTPS://EXAMPLE.INVALID/item/0/?utm_source=old#anchor".into(),
        ..Default::default()
    })
    .unwrap();
    let mut p = plan(None, 2);
    assert_eq!(db.preview_bookmarks(&p).unwrap(), (1, 1));
    assert_eq!(db.import_bookmarks(&p, |_, _| {}).unwrap().imported, 1);
    p.id = Uuid::new_v4().to_string();
    p.options.skip_duplicates = false;
    p.options.folders_as_labels = false;
    p.options.priority = "inbox".into();
    assert_eq!(db.import_bookmarks(&p, |_, _| {}).unwrap().imported, 2);
    let rows = db.list_note_cards().unwrap();
    assert_eq!(rows.len(), 4);
    assert_eq!(
        rows.iter()
            .filter(|n| n.value["labels"] == json!([]) && n.value["priority"] == "inbox")
            .count(),
        3
    );
}
#[test]
fn bulk_actions_are_atomic_stale_guarded_and_preserve_full_values() {
    let db = db();
    db.import_bookmarks(&plan(None, 2), |_, _| {}).unwrap();
    let rows = db.list_note_cards().unwrap();
    db.update_note_card_in(
        rows[1].value["id"].as_str().unwrap(),
        0,
        None,
        Some(&rows[1].edit_token),
        json!({"body":"Newer edit"}),
    )
    .unwrap();
    assert!(db
        .bulk_links(
            None,
            &rows.iter().map(guard).collect::<Vec<_>>(),
            &BulkAction::Archive
        )
        .is_err());
    assert!(db
        .list_note_cards()
        .unwrap()
        .iter()
        .all(|n| n.value["archived"] == false));
    let current = db.list_note_cards().unwrap();
    let guards = current.iter().map(guard).collect::<Vec<_>>();
    assert_eq!(
        db.bulk_links(
            None,
            &guards,
            &BulkAction::Label {
                labels: vec![" Fonts ".into(), "Reading".into()]
            }
        )
        .unwrap(),
        2
    );
    assert!(db
        .list_note_cards()
        .unwrap()
        .iter()
        .all(|n| n.value["labels"] == json!(["Design", "Fonts", "Reading"])));
    let current = db.list_note_cards().unwrap();
    assert_eq!(
        db.selected_link_urls(None, &current.iter().map(guard).collect::<Vec<_>>())
            .unwrap()
            .len(),
        2
    );
    assert!(db.selected_link_urls(None, &guards).is_err());
    let scope = db
        .tack_activate(&Identity {
            base_url: "https://fixture.invalid/".into(),
            user_id: "u".into(),
            workspace_id: "personal".into(),
        })
        .unwrap();
    assert!(db.bulk_links(None, &guards, &BulkAction::Later).is_err());
    let p = plan(Some(scope.clone()), 1);
    db.import_bookmarks(&p, |_, _| {}).unwrap();
    crate::notes::sync_store::set_meta(
        &db.conn.lock().unwrap(),
        &format!("read_only/{}", scope.key),
        "true",
    )
    .unwrap();
    assert!(db
        .import_bookmarks(&plan(Some(scope.clone()), 1), |_, _| {})
        .is_err());
    assert!(db.undo_bookmark_import(&p.id, Some(&scope)).is_err());
}
#[test]
fn invalid_item_rolls_back_the_entire_import_and_receipt() {
    let db = db();
    let mut p = plan(None, 3);
    p.bookmarks[2].created_at = Some("not a date".into());
    assert!(db.import_bookmarks(&p, |_, _| {}).is_err());
    assert!(db.list_note_cards().unwrap().is_empty());
    assert!(db.bookmark_imports(None).unwrap().is_empty());
}
#[test]
fn firefox_live_wal_chromium_and_html_import_the_same_cards_without_other_file_reads() {
    let root = directory();
    let local = root.join("local");
    let roaming = root.join("roaming");
    let profile = local.join("Google/Chrome/User Data/Profile 1");
    fs::create_dir_all(&profile).unwrap();
    let state = profile.parent().unwrap().join("Local State");
    fs::write(&state,r#"{"profile":{"info_cache":{"Profile 1":{"name":"Personal"},"../../History":{"name":"Forbidden"}}}}"#).unwrap();
    let chrome = profile.join("Bookmarks");
    fs::write(&chrome,r#"{"roots":{"bookmark_bar":{"name":"Bookmarks bar","type":"folder","children":[{"type":"folder","name":"Design","children":[{"type":"url","name":"Fonts & type","url":"https://example.invalid/fonts","date_added":"13348540800000000"},{"type":"url","name":"Duplicate","url":"https://example.invalid/fonts","date_added":"13348540800000000"},{"type":"url","name":"No","url":"javascript:alert(1)"}]}]}}}"#).unwrap();
    fs::write(profile.join("History"), b"must not open").unwrap();
    fs::write(profile.join("Cookies"), b"must not open").unwrap();
    fs::write(profile.join("Login Data"), b"must not open").unwrap();
    let firefox = roaming.join("Mozilla/Firefox/Profiles/fixture.default");
    fs::create_dir_all(&firefox).unwrap();
    let places = firefox.join("places.sqlite");
    let live = rusqlite::Connection::open(&places).unwrap();
    live.execute_batch("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE moz_places(id INTEGER PRIMARY KEY,url TEXT,title TEXT);CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY,fk INTEGER,type INTEGER,parent INTEGER,title TEXT,dateAdded INTEGER);INSERT INTO moz_places VALUES(1,'https://example.invalid/fonts','Fonts & type'),(2,'javascript:alert(1)','No'),(3,'https://history.invalid/never-import','Private history');INSERT INTO moz_bookmarks VALUES(1,NULL,2,0,'Bookmarks Toolbar',0),(2,NULL,2,1,'Design',0),(3,1,1,2,'Fonts & type',1704067200000000),(4,1,1,2,'Duplicate',1704067200000000),(5,2,1,2,'No',0);").unwrap();
    let wal = firefox.join("places.sqlite-wal");
    assert!(wal.is_file());
    let original = fs::read(&places).unwrap();
    let original_wal = fs::read(&wal).unwrap();
    let discovery = sources::discover(&Roots {
        local: Some(local),
        roaming: Some(roaming),
    })
    .unwrap();
    assert_eq!(discovery.sources.len(), 2);
    let allow = [state, chrome, places.clone(), wal.clone()]
        .into_iter()
        .map(|p| std::fs::canonicalize(p).unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        discovery
            .read_files
            .iter()
            .map(|p| std::fs::canonicalize(p).unwrap())
            .collect::<std::collections::HashSet<_>>(),
        allow
    );
    assert_eq!(fs::read(&places).unwrap(), original);
    assert_eq!(fs::read(&wal).unwrap(), original_wal);
    let html = root.join("export.html");
    fs::write(&html,r#"<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Bookmarks Menu</H3><DL><p><DT><H3>Design</H3><DL><p><DT><A HREF="https://example.invalid/fonts" ADD_DATE="1704067200">Fonts &amp; type</A><DT><A HREF="https://example.invalid/fonts" ADD_DATE="1704067200">Duplicate</A><DT><A HREF="javascript:alert(1)">No</A></DL></DL></DL>"#).unwrap();
    let html = sources::selected_html(&html).unwrap();
    let mut all = discovery.sources;
    all.extend(html.sources);
    for source in all {
        assert!(
            source.error.is_none(),
            "{}: {:?}",
            source.name,
            source.error
        );
        assert_eq!(source.links, 2);
        assert_eq!(source.skipped, 1);
        let db = db();
        let mut p = plan(None, 0);
        p.bookmarks = source.parsed.bookmarks;
        assert_eq!(db.import_bookmarks(&p, |_, _| {}).unwrap().imported, 1);
        let note = db.list_note_cards().unwrap().remove(0);
        assert_eq!(note.value["title"], "Fonts & type");
        assert_eq!(note.value["labels"], json!(["Design"]));
        assert_eq!(note.value["createdAt"], "2024-01-01T00:00:00.000Z");
        assert_eq!(note.value["priority"], "later");
    }
    drop(live);
}
#[test]
fn bookmark_capture_receipt_freezes_enriched_title_and_deduped_id() {
    let db = db();
    let request = crate::notes::capture::CaptureRequest {
        request_id: Uuid::new_v4().to_string(),
        expected_scope: None,
        draft: NoteDraft {
            title: "https://example.invalid/page".into(),
            url: "https://example.invalid/page".into(),
            kind: Some("bookmark".into()),
            ..Default::default()
        },
        patch: json!({}),
        reminders: vec![],
    };
    let saved = db
        .capture_note_enriched(request.clone(), Some("Server title".into()), true)
        .unwrap();
    let again = db
        .capture_note_enriched(request.clone(), Some("Changed server title".into()), true)
        .unwrap();
    assert_eq!(saved.value, again.value);
    let mut duplicate = request;
    duplicate.request_id = Uuid::new_v4().to_string();
    duplicate.draft.url = "HTTPS://EXAMPLE.INVALID/page/?utm_source=x#part".into();
    let deduped = db
        .capture_note_enriched(duplicate.clone(), Some("Other title".into()), true)
        .unwrap();
    assert_eq!(deduped.value["id"], saved.value["id"]);
    assert_eq!(
        db.capture_note(duplicate).unwrap().value["id"],
        saved.value["id"]
    );
    assert_eq!(db.list_note_cards().unwrap().len(), 1);
}
#[test]
fn preview_session_is_window_bound_rechecks_duplicates_and_replays_after_release() {
    use super::service::{PreviewRequest, Service};
    let root = directory();
    let profile = root.join("Google/Chrome/User Data/Default");
    fs::create_dir_all(&profile).unwrap();
    fs::write(profile.join("Bookmarks"),r#"{"roots":{"bookmark_bar":{"children":[{"type":"url","name":"A","url":"https://example.invalid/a"},{"type":"url","name":"B","url":"https://example.invalid/b"}]}}}"#).unwrap();
    let db = db();
    let service = Service::default();
    let catalog = service
        .discover(
            "main",
            &Roots {
                local: Some(root.clone()),
                roaming: None,
            },
        )
        .unwrap();
    let ids = catalog
        .sources
        .iter()
        .map(|s| s.id.clone())
        .collect::<Vec<_>>();
    let request = || PreviewRequest {
        session_id: catalog.session_id.clone(),
        source_ids: ids.clone(),
        expected_scope: None,
        options: Options::default(),
    };
    assert!(service.preview(&db, "settings", request()).is_err());
    let error = service
        .add_html(
            "settings",
            &catalog.session_id,
            &root.join("not-selected.html"),
        )
        .err()
        .expect("Other windows must not read selected files");
    assert!(error.to_string().contains("Rescan"));
    let preview = service.preview(&db, "main", request()).unwrap();
    assert_eq!(preview.eligible, 2);
    db.create_note_card(NoteDraft {
        title: "Another window saved it".into(),
        kind: Some("bookmark".into()),
        url: "HTTPS://EXAMPLE.INVALID/a/?utm_source=x#part".into(),
        ..Default::default()
    })
    .unwrap();
    let saved = service
        .commit(&db, "main", &preview.plan_id, None, |_, _| {})
        .unwrap();
    assert_eq!((saved.imported, saved.duplicates), (1, 1));
    service.release("settings", &catalog.session_id).unwrap();
    assert!(service.preview(&db, "main", request()).is_ok());
    service.release("main", &catalog.session_id).unwrap();
    assert!(service.preview(&db, "main", request()).is_err());
    assert_eq!(
        service
            .commit(&db, "main", &preview.plan_id, None, |_, _| panic!(
                "receipt retry must not write"
            ))
            .unwrap()
            .imported,
        1
    );
    assert_eq!(db.list_note_cards().unwrap().len(), 2);
}
#[test]
fn html_keeps_export_values_and_tack_numeric_add_dates() {
    let html = r#"<DL><DT><H3>Bookmarks bar</H3><DL><DT><H3> Long folder label </H3><DL><DT><A HREF="HTTPS://EXAMPLE.INVALID/docs?utm_source=old#keep" ADD_DATE="1.704067200e9"></A></DL></DL></DL>"#;
    let parsed = super::parse::html(html).unwrap();
    assert_eq!(parsed.bookmarks[0].title, "");
    assert_eq!(
        parsed.bookmarks[0].url,
        "HTTPS://EXAMPLE.INVALID/docs?utm_source=old#keep"
    );
    assert_eq!(parsed.bookmarks[0].labels, vec![" Long folder label "]);
    assert_eq!(
        parsed.bookmarks[0].created_at.as_deref(),
        Some("2024-01-01T00:00:00.000Z")
    );
    assert!(super::parse::html(
        r#"<A HREF="https://example.invalid" ADD_DATE="Infinity">Invalid date</A>"#
    )
    .is_err());
}
