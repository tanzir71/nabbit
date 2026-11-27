use super::*;
use std::path::PathBuf;
struct Fixture {
    root: PathBuf,
    source: PathBuf,
    dest: PathBuf,
    service: Arc<Service>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("nabbit-files-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let dest = root.join("dest");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        let db = Database::open(&root.join("profile")).unwrap();
        let service = Service::new(db, root.clone()).unwrap();
        Self {
            root,
            source,
            dest,
            service,
        }
    }
    fn file(&self, name: &str) -> String {
        let path = self.source.join(name);
        std::fs::write(&path, b"Owned original file").unwrap();
        paths::display(&path)
    }
    fn plan(&self, paths: Vec<String>) -> Operation {
        self.service
            .prepare(
                paths,
                paths::display(&self.dest),
                Modifiers::default(),
                false,
                None,
            )
            .unwrap()
    }
    fn backend(&self) -> commands::Owned {
        commands::Owned {
            root: self.root.clone(),
        }
    }
    fn reopen(&self) -> Arc<Service> {
        Service::new(
            Database::open(&self.root.join("profile")).unwrap(),
            self.root.clone(),
        )
        .unwrap()
    }
}
#[test]
fn pins_edit_swap_slots_dedupe_remove_and_persist_without_touching_files() {
    let f = Fixture::new();
    let path = f.file("résumé বাংলা.txt");
    let draft = |path: String, slot, id| PinDraft {
        id,
        path,
        label: Some("Invoices".into()),
        slot,
        always_move: true,
    };
    let first = save(&f.service.db, draft(path.clone(), Some(1), None)).unwrap();
    assert!(save(&f.service.db, draft(path.clone(), None, None)).is_err());
    let second = save(&f.service.db, draft(paths::display(&f.dest), Some(2), None)).unwrap();
    save(
        &f.service.db,
        draft(path.clone(), Some(2), Some(first.clone())),
    )
    .unwrap();
    assert_eq!(f.service.db.pin_target(None, Some(1)).unwrap().id, second);
    assert_eq!(f.service.db.pin_target(None, Some(2)).unwrap().id, first);
    assert!(always_move(&f.reopen().db, &first).unwrap());
    remove(&f.service.db, &first).unwrap();
    assert!(Path::new(&path).is_file());
    assert!(save(&f.service.db, draft("relative".into(), None, None)).is_err());
    assert!(save(&f.service.db, draft(path, Some(10), None)).is_err());
}
#[test]
fn explorer_volume_rules_and_explicit_modifier_overrides() {
    let f = Fixture::new();
    let mut source = paths::facts(&f.file("file.txt")).unwrap();
    let destination = paths::facts(&paths::display(&f.dest)).unwrap();
    assert_eq!(
        verb(&source, &destination, &Modifiers::default(), false),
        Verb::Move
    );
    source.volume = "mock-second-volume".into();
    assert_eq!(
        verb(&source, &destination, &Modifiers::default(), false),
        Verb::Copy
    );
    assert_eq!(
        verb(
            &source,
            &destination,
            &Modifiers {
                shift: true,
                ctrl: false
            },
            false
        ),
        Verb::Move
    );
    assert_eq!(
        verb(&source, &destination, &Modifiers::default(), true),
        Verb::Move
    );
    assert_eq!(
        verb(
            &source,
            &destination,
            &Modifiers {
                shift: true,
                ctrl: true
            },
            true
        ),
        Verb::Copy
    );
}
#[test]
fn owned_moves_clashes_dates_restart_undo_and_duplicate_execute() {
    let f = Fixture::new();
    let path = f.file("invoice.txt");
    std::fs::write(f.dest.join("invoice.txt"), b"Existing destination").unwrap();
    let stamp = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1700000000);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(stamp)
        .unwrap();
    let plan = f.plan(vec![path.clone()]);
    let result = f.service.execute(&plan.id, false, &f.backend()).unwrap();
    assert_eq!(result.status, "completed");
    let output = result.entries[0].output.as_ref().unwrap();
    assert!(output.ends_with("invoice 2.txt"));
    assert!(!Path::new(&path).exists());
    assert_eq!(
        std::fs::read(f.dest.join("invoice.txt")).unwrap(),
        b"Existing destination"
    );
    assert_eq!(
        std::fs::metadata(output).unwrap().modified().unwrap(),
        stamp
    );
    assert_eq!(
        f.service
            .execute(&plan.id, false, &f.backend())
            .unwrap()
            .entries[0]
            .output
            .as_ref(),
        Some(output)
    );
    let reopened = f.reopen();
    let undone = reopened.undo(&plan.id, &f.backend()).unwrap();
    assert_eq!(undone.status, "undone");
    assert_eq!(std::fs::read(&path).unwrap(), b"Owned original file");
    assert!(!Path::new(output).exists());
    assert_eq!(
        std::fs::read(f.dest.join("invoice.txt")).unwrap(),
        b"Existing destination"
    );
}
#[test]
fn copy_undo_preserves_original_and_changed_results_are_rejected() {
    let f = Fixture::new();
    let path = f.file("photo.txt");
    let plan = f
        .service
        .prepare(
            vec![path.clone()],
            paths::display(&f.dest),
            Modifiers {
                ctrl: true,
                shift: false,
            },
            false,
            None,
        )
        .unwrap();
    let result = f.service.execute(&plan.id, false, &f.backend()).unwrap();
    let output = result.entries[0].output.as_ref().unwrap();
    std::fs::write(output, b"Changed output").unwrap();
    assert!(f.reopen().undo(&plan.id, &f.backend()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"Owned original file");
    let next = f.plan(vec![path.clone()]);
    let result = f.service.execute(&next.id, false, &f.backend()).unwrap();
    std::fs::write(&path, b"Occupied original path").unwrap();
    assert!(f.service.undo(&next.id, &f.backend()).is_err());
    assert!(Path::new(result.entries[0].output.as_ref().unwrap()).exists());
}
#[test]
fn confirmation_and_changed_source_are_checked_before_any_file_mutation() {
    let f = Fixture::new();
    let path = f.file("file.txt");
    let mut plan = f.plan(vec![path.clone()]);
    plan.reasons.push("Network fixture".into());
    f.service.save(&plan).unwrap();
    assert!(f.service.execute(&plan.id, false, &f.backend()).is_err());
    assert!(Path::new(&path).exists());
    std::fs::write(&path, b"Changed before confirm").unwrap();
    assert!(f.service.execute(&plan.id, true, &f.backend()).is_err());
    assert!(f.dest.read_dir().unwrap().next().is_none());
    assert!(f
        .service
        .prepare(
            vec![paths::display(&f.source)],
            paths::display(&f.dest),
            Modifiers::default(),
            false,
            None
        )
        .is_err());
}
#[test]
fn interrupted_operations_never_rerun_and_recorded_results_remain_undoable() {
    let f = Fixture::new();
    let path = f.file("file.txt");
    let plan = f.plan(vec![path.clone()]);
    let mut result = f.service.execute(&plan.id, false, &f.backend()).unwrap();
    result.status = "working".into();
    f.service.save(&result).unwrap();
    let restarted = f.reopen();
    assert_eq!(restarted.get(&plan.id).unwrap().status, "partial");
    assert!(!Path::new(&path).exists());
    assert_eq!(
        restarted.undo(&plan.id, &f.backend()).unwrap().status,
        "undone"
    );
}
#[test]
fn local_peek_lists_only_six_newest_and_watch_is_revoked() {
    let f = Fixture::new();
    for i in 0..9 {
        let path = f.file(&format!("item-{i}.txt"));
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1700000000 + i))
            .unwrap();
    }
    let (send, recv) = std::sync::mpsc::channel();
    let watch = f
        .service
        .watches
        .open(
            "owner",
            paths::display(&f.source),
            Arc::new(move |token| {
                let _ = send.send(token);
            }),
        )
        .unwrap();
    assert!(watch.watching);
    assert_eq!(watch.items.len(), 6);
    assert_eq!(watch.items[0].name, "item-8.txt");
    assert_eq!(watch.items[5].name, "item-3.txt");
    let new = f.file("new.txt");
    assert_eq!(
        recv.recv_timeout(std::time::Duration::from_secs(5))
            .unwrap(),
        watch.token
    );
    assert_eq!(
        f.service.watches.read("owner", &watch.token).unwrap()[0].path,
        new
    );
    f.service.watches.close("other", Some(&watch.token));
    assert!(f.service.watches.read("owner", &watch.token).is_ok());
    f.service.watches.close("owner", Some(&watch.token));
    assert!(f.service.watches.read("owner", &watch.token).is_err());
}
#[test]
fn owned_backend_rejects_paths_outside_its_canonical_root() {
    let f = Fixture::new();
    let other = Fixture::new();
    let foreign = other.file("foreign.txt");
    assert!(f
        .backend()
        .transfer(&foreign, &paths::display(&f.dest), None, Verb::Move)
        .is_err());
    assert!(Path::new(&foreign).exists());
}

#[test]
fn successful_copy_undo_and_extension_suggestions_use_the_journal() {
    let f = Fixture::new();
    let path = f.file("copied.txt");
    let plan = f
        .service
        .prepare(
            vec![path.clone()],
            paths::display(&f.dest),
            Modifiers {
                ctrl: true,
                shift: false,
            },
            false,
            Some("example.invalid".into()),
        )
        .unwrap();
    let done = f.service.execute(&plan.id, false, &f.backend()).unwrap();
    assert!(Path::new(&path).is_file());
    assert_eq!(
        f.service.suggestions(&["next.txt".into()], None).unwrap(),
        vec![paths::display(&f.dest)]
    );
    assert_eq!(
        f.service
            .suggestions(&["other.pdf".into()], Some("example.invalid"))
            .unwrap()
            .len(),
        1
    );
    assert!(f
        .service
        .suggestions(&["other.pdf".into()], None)
        .unwrap()
        .is_empty());
    f.reopen().undo(&done.id, &f.backend()).unwrap();
    assert!(Path::new(&path).is_file());
    assert!(!Path::new(done.entries[0].output.as_ref().unwrap()).exists());
}
struct Replace {
    owned: commands::Owned,
    fail_restore: std::sync::atomic::AtomicBool,
}
impl Backend for Replace {
    fn transfer(
        &self,
        source: &str,
        destination: &str,
        name: Option<&str>,
        verb: Verb,
    ) -> Result<Option<String>> {
        if source.ends_with(".backup")
            && self.fail_restore.load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(msg("Injected backup restore failure"));
        }
        self.owned.guard(source)?;
        self.owned.guard(destination)?;
        let name = name.map(str::to_owned).unwrap_or_else(|| {
            Path::new(source)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into()
        });
        let path = Path::new(destination).join(&name);
        if path.exists() {
            self.owned.guard(path.to_str().unwrap())?;
            std::fs::remove_file(path)?;
        }
        self.owned
            .transfer(source, destination, Some(name.as_str()), verb)
    }
    fn fingerprint(&self, path: &str) -> Result<Fingerprint> {
        self.owned.fingerprint(path)
    }
    fn recycle(&self, path: &str) -> Result<()> {
        self.owned.recycle(path)
    }
}
#[test]
fn replacement_backups_and_partial_undo_resume_after_restart() {
    let f = Fixture::new();
    let path = f.file("same.txt");
    let target = f.dest.join("same.txt");
    std::fs::write(&target, b"Previous target bytes").unwrap();
    let plan = f.plan(vec![path.clone()]);
    let backend = Replace {
        owned: f.backend(),
        fail_restore: std::sync::atomic::AtomicBool::new(false),
    };
    let done = f.service.execute(&plan.id, false, &backend).unwrap();
    assert!(done.entries[0].replaced);
    assert_eq!(std::fs::read(&target).unwrap(), b"Owned original file");
    backend
        .fail_restore
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(f.service.undo(&plan.id, &backend).is_err());
    assert!(f.service.get(&plan.id).unwrap().entries[0].restored);
    assert_eq!(std::fs::read(&path).unwrap(), b"Owned original file");
    backend
        .fail_restore
        .store(false, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        f.reopen().undo(&plan.id, &backend).unwrap().status,
        "undone"
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"Previous target bytes");
    assert_eq!(std::fs::read(&path).unwrap(), b"Owned original file");
}
#[test]
fn placeholder_cloud_move_policy_and_long_paths_do_not_read_file_contents() {
    let f = Fixture::new();
    let mut source = paths::facts(&f.file("cloud.txt")).unwrap();
    let mut destination = paths::facts(&paths::display(&f.dest)).unwrap();
    source.attributes = paths::RECALL;
    source.cloud = true;
    assert!(paths::local_only(&source, || -> Result<()> {
        panic!("A placeholder must not be opened or read")
    })
    .is_err());
    assert!(moving_out(&source, &destination, Verb::Move, &[]));
    assert!(!moving_out(&source, &destination, Verb::Copy, &[]));
    destination.cloud = true;
    assert!(!moving_out(
        &source,
        &destination,
        Verb::Move,
        &[paths::display(&f.root)]
    ));
    assert!(paths::long_path_policy(260, false)
        .unwrap_err()
        .to_string()
        .contains("Enable Windows long paths"));
    assert!(paths::long_path_policy(260, true).is_ok());
    assert!(paths::inside(
        &format!("{}\\file", paths::display(&f.source)),
        &paths::display(&f.source)
    ));
    assert!(!paths::inside(
        &format!("{}-other\\file", paths::display(&f.source)),
        &paths::display(&f.source)
    ));
}
#[test]
fn over_fifty_files_requires_confirmation_and_preserves_all_inputs() {
    let f = Fixture::new();
    let paths = (0..51)
        .map(|index| f.file(&format!("many-{index}.txt")))
        .collect::<Vec<_>>();
    let plan = f.plan(paths.clone());
    assert_eq!(plan.reasons.len(), 1);
    assert!(f.service.execute(&plan.id, false, &f.backend()).is_err());
    assert!(paths.iter().all(|p| Path::new(p).is_file()));
}
#[test]
fn move_updates_shelf_and_pin_references_and_undo_restores_them() {
    let f = Fixture::new();
    let path = f.file("linked.txt");
    let item = crate::shelf::add(&f.service.db, vec![path.clone()])
        .unwrap()
        .remove(0);
    let id = save(
        &f.service.db,
        PinDraft {
            id: None,
            path: path.clone(),
            label: None,
            slot: Some(1),
            always_move: false,
        },
    )
    .unwrap();
    let plan = f.plan(vec![path.clone()]);
    let done = f.service.execute(&plan.id, false, &f.backend()).unwrap();
    let output = done.entries[0].output.as_ref().unwrap();
    assert_eq!(&crate::shelf::list(&f.service.db).unwrap()[0].path, output);
    assert_eq!(
        f.service.db.pin_target(Some(&id), None).unwrap().path,
        *output
    );
    f.reopen().undo(&plan.id, &f.backend()).unwrap();
    assert_eq!(crate::shelf::list(&f.service.db).unwrap()[0].id, item.id);
    assert_eq!(crate::shelf::list(&f.service.db).unwrap()[0].path, path);
}
#[test]
fn mocked_second_volume_executes_a_copy_by_default_and_network_peek_never_watches() {
    let f = Fixture::new();
    let path = f.file("cross-volume.txt");
    let mut plan = f.plan(vec![path.clone()]);
    plan.entries[0].source.volume = "mock-volume-two".into();
    plan.entries[0].verb = verb(
        &plan.entries[0].source,
        &plan.destination,
        &Modifiers::default(),
        false,
    );
    assert_eq!(plan.entries[0].verb, Verb::Copy);
    f.service.save(&plan).unwrap();
    let probe = |raw: &str| {
        let mut facts = paths::facts(raw)?;
        if raw == path {
            facts.volume = "mock-volume-two".into();
        }
        Ok(facts)
    };
    let done = f
        .service
        .execute_using(&plan.id, false, &f.backend(), probe)
        .unwrap();
    assert_eq!(done.status, "completed");
    assert_eq!(std::fs::read(&path).unwrap(), b"Owned original file");
    assert_eq!(
        std::fs::read(done.entries[0].output.as_ref().unwrap()).unwrap(),
        b"Owned original file"
    );
    let mut network = plan.destination;
    network.network = true;
    assert!(!watch::should_watch(&network));
    network.network = false;
    assert!(watch::should_watch(&network));
}
#[test]
fn collision_reference_journal_preserves_both_original_shelf_and_pin_identities() {
    let f = Fixture::new();
    let source = f.file("both.txt");
    let target = f.dest.join("both.txt");
    std::fs::write(&target, b"Destination original").unwrap();
    let target = paths::display(&target);
    let before = crate::shelf::add(&f.service.db, vec![source.clone(), target.clone()]).unwrap();
    let source_pin = save(
        &f.service.db,
        PinDraft {
            id: None,
            path: source.clone(),
            label: None,
            slot: Some(1),
            always_move: false,
        },
    )
    .unwrap();
    let target_pin = save(
        &f.service.db,
        PinDraft {
            id: None,
            path: target.clone(),
            label: None,
            slot: Some(2),
            always_move: false,
        },
    )
    .unwrap();
    let backend = Replace {
        owned: f.backend(),
        fail_restore: std::sync::atomic::AtomicBool::new(false),
    };
    let plan = f.plan(vec![source.clone()]);
    f.service.execute(&plan.id, false, &backend).unwrap();
    assert_eq!(crate::shelf::list(&f.service.db).unwrap().len(), 1);
    f.reopen().undo(&plan.id, &backend).unwrap();
    let after = crate::shelf::list(&f.service.db).unwrap();
    assert_eq!(after.len(), 2);
    assert!(before.iter().all(|before| after
        .iter()
        .any(|after| after.id == before.id && after.path == before.path)));
    assert_eq!(
        f.service
            .db
            .pin_target(Some(&source_pin), None)
            .unwrap()
            .path,
        source
    );
    assert_eq!(
        f.service
            .db
            .pin_target(Some(&target_pin), None)
            .unwrap()
            .path,
        target
    );
}
#[cfg(windows)]
#[test]
fn owned_ole_data_object_preserves_paths_modifiers_and_never_mutates_the_source() {
    let f = Fixture::new();
    let path = f.file("drag বাংলা.txt");
    for kind in ["enter", "over", "drop"] {
        let event = drop::fixture_event(
            path.clone(),
            kind.into(),
            20,
            30,
            Modifiers {
                shift: true,
                ctrl: true,
            },
            0,
        )
        .unwrap();
        assert_eq!(event.kind, kind);
        assert_eq!(event.payload.files, vec![path.clone()]);
        assert!(event.shift && event.ctrl);
        assert_eq!(std::fs::read(&path).unwrap(), b"Owned original file");
    }
}
#[test]
fn completed_tool_output_locations_and_identities_follow_move_and_undo() {
    let f = Fixture::new();
    let path = f.file("generated (To JPG).jpg");
    let before = f.backend().fingerprint(&path).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let job = crate::tools::Job {
        id: id.clone(),
        request: crate::tools::Request {
            request_id: id.clone(),
            tool_id: "to-jpg".into(),
            input: f.file("input.png"),
            preset_id: "jpg".into(),
        },
        preset: crate::tools::registry::presets()
            .into_iter()
            .find(|preset| preset.id == "jpg")
            .unwrap(),
        status: "completed".into(),
        percent: 100.,
        created_at: chrono::Utc::now().to_rfc3339(),
        output: Some(path.clone()),
        before_bytes: 100,
        after_bytes: 20,
        note: None,
        error: None,
        output_hash: Some(before.hash),
        output_identity: Some(before.identity),
        staging_path: None,
        attempt: 1,
        retry_of: None,
    };
    f.service.db.save_tool_job(&job).unwrap();
    let plan = f.plan(vec![path.clone()]);
    let done = f.service.execute(&plan.id, false, &f.backend()).unwrap();
    let moved = f.service.db.tool_jobs().unwrap().remove(0);
    assert_eq!(moved.output, done.entries[0].output);
    assert_eq!(
        moved.output_identity,
        done.entries[0]
            .fingerprint
            .as_ref()
            .map(|fp| fp.identity.clone())
    );
    f.reopen().undo(&plan.id, &f.backend()).unwrap();
    let restored = f.service.db.tool_jobs().unwrap().remove(0);
    assert_eq!(restored.output, Some(path.clone()));
    assert_eq!(
        restored.output_identity,
        Some(paths::identity(&path).unwrap())
    );
}
#[test]
fn late_preview_open_cannot_replace_a_newer_watch_for_the_same_surface() {
    let f = Fixture::new();
    let path = paths::display(&f.source);
    let service = f.service.clone();
    let (ready, started) = std::sync::mpsc::sync_channel(1);
    let (release, hold) = std::sync::mpsc::sync_channel(1);
    let old = std::thread::spawn(move || {
        service
            .watches
            .open_using("owner", path, Arc::new(|_| {}), move |path| {
                ready.send(()).unwrap();
                hold.recv().unwrap();
                paths::facts(path)
            })
    });
    started
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    let current = f
        .service
        .watches
        .open("owner", paths::display(&f.dest), Arc::new(|_| {}))
        .unwrap();
    release.send(()).unwrap();
    assert!(old.join().unwrap().is_err());
    assert!(f.service.watches.read("owner", &current.token).is_ok());
    f.service.watches.stop();
}
#[cfg(windows)]
#[test]
fn replacement_backup_keeps_dates_attributes_and_alternate_streams_without_overwrite() {
    use std::os::windows::fs::MetadataExt;
    let f = Fixture::new();
    let path = f.file("metadata.txt");
    std::fs::write(format!("{path}:owned-proof"), b"Owned alternate stream").unwrap();
    let file = std::fs::File::options().write(true).open(&path).unwrap();
    file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1700000000))
        .unwrap();
    drop(file);
    let mut permissions = std::fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&path, permissions).unwrap();
    let backup = f.dest.join("backup.txt");
    native::backup(&path, &backup).unwrap();
    let original = std::fs::metadata(&path).unwrap();
    let copied = std::fs::metadata(&backup).unwrap();
    assert_eq!(copied.creation_time(), original.creation_time());
    assert_eq!(copied.last_write_time(), original.last_write_time());
    assert!(copied.permissions().readonly());
    assert_eq!(
        std::fs::read(format!("{}:owned-proof", backup.to_str().unwrap())).unwrap(),
        b"Owned alternate stream"
    );
    assert!(native::backup(&path, &backup).is_err());
}
#[test]
fn file_work_lease_covers_queued_and_running_work_and_releases_on_error() {
    let f = Fixture::new();
    assert!(!f.service.active());
    let queued = f.service.lease();
    assert!(f.service.active());
    drop(queued);
    assert!(!f.service.active());
    let path = f.file("confirm.txt");
    let mut plan = f.plan(vec![path]);
    plan.reasons.push("Owned confirmation fixture".into());
    f.service.save(&plan).unwrap();
    assert!(f.service.execute(&plan.id, false, &f.backend()).is_err());
    assert!(!f.service.active());
}
#[cfg(windows)]
#[test]
#[ignore = "Runs real IFileOperation only on owned temporary files; no conflict dialog or Recycle Bin"]
fn owned_shell_move_and_journal_undo_after_restart() {
    let f = Fixture::new();
    let path = f.file("native-owned.txt");
    let plan = f.plan(vec![path.clone()]);
    let backend = native::Native { owner: 0 };
    let done = f.service.execute(&plan.id, false, &backend).unwrap();
    assert_eq!(done.status, "completed", "{:?}", done.error);
    let output = done.entries[0].output.as_ref().unwrap();
    assert_eq!(std::fs::read(output).unwrap(), b"Owned original file");
    assert!(!Path::new(&path).exists());
    let undone = f.reopen().undo(&plan.id, &backend).unwrap();
    assert_eq!(undone.status, "undone");
    assert_eq!(std::fs::read(&path).unwrap(), b"Owned original file");
    assert!(!Path::new(output).exists());
}
