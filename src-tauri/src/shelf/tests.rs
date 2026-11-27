use super::*;
struct Fixture {
    root: PathBuf,
    db: Database,
    files: Vec<String>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("nabbit-shelf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let files = ["résumé বাংলা.txt", "movie.MP4", "picture.png"]
            .into_iter()
            .map(|name| {
                let p = root.join(name);
                std::fs::write(&p, b"Fixture original").unwrap();
                p.to_str().unwrap().to_owned()
            })
            .collect();
        let db = Database::open(&root.join("profile")).unwrap();
        Self { root, db, files }
    }
}
#[test]
fn add_dedupes_paths_and_survives_reopen_without_copying_inputs() {
    let f = Fixture::new();
    let rows = add(
        &f.db,
        vec![f.files[0].clone(), f.files[1].clone(), f.files[0].clone()],
    )
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].name, "résumé বাংলা.txt");
    assert_eq!(rows[1].kind, "video");
    assert!(rows.iter().all(|r| r.available && r.size == Some(16)));
    let reopened = Database::open(&f.root.join("profile")).unwrap();
    assert_eq!(list(&reopened).unwrap()[0].id, rows[0].id);
    assert_eq!(
        std::fs::read_dir(f.root.join("profile")).unwrap().count(),
        3
    ); // SQLite/WAL/SHM only.
    #[cfg(windows)]
    assert_eq!(
        add(&f.db, vec![f.files[0].to_uppercase()]).unwrap().len(),
        2
    );
}
#[test]
fn a_bad_batch_is_atomic_and_rejects_directories_relative_and_empty_input() {
    let f = Fixture::new();
    for paths in [
        vec![],
        vec![f.files[0].clone(), "relative.txt".into()],
        vec![f.root.to_str().unwrap().into()],
        vec![f.root.join("gone.txt").to_str().unwrap().into()],
        vec![f.files[0].clone(); 257],
    ] {
        assert!(add(&f.db, paths).is_err());
        assert!(list(&f.db).unwrap().is_empty());
    }
}
#[test]
fn missing_files_remain_removable_and_clear_never_touches_originals() {
    let f = Fixture::new();
    let rows = add(&f.db, f.files.clone()).unwrap();
    std::fs::remove_file(&f.files[1]).unwrap();
    let current = list(&f.db).unwrap();
    assert!(!current[1].available);
    assert_eq!(current[1].size, None);
    assert!(drag_plan(&f.db, vec![rows[1].id.clone()]).is_err());
    remove(&f.db, Some(vec![rows[1].id.clone()])).unwrap();
    assert_eq!(list(&f.db).unwrap().len(), 2);
    remove(&f.db, None).unwrap();
    assert!(list(&f.db).unwrap().is_empty());
    assert_eq!(std::fs::read(&f.files[0]).unwrap(), b"Fixture original");
    assert!(Path::new(&f.files[2]).is_file());
}
#[test]
fn paths_and_drag_plans_use_shelf_order_and_record_only_the_selected_originals() {
    let f = Fixture::new();
    let rows = add(&f.db, f.files.clone()).unwrap();
    let ids = vec![rows[2].id.clone(), rows[0].id.clone(), rows[2].id.clone()];
    let plan = drag_plan(&f.db, ids.clone()).unwrap();
    assert_eq!(plan.item, vec![rows[0].path.clone(), rows[2].path.clone()]);
    assert_eq!(plan.mode, "copy");
    assert!(plan.icon.starts_with("data:image/png;base64,"));
    let mut copied = String::new();
    copy_with(&f.db, Some(ids), |text| {
        copied = text.into();
        Ok(())
    })
    .unwrap();
    assert_eq!(
        copied,
        plan.item.join(if cfg!(windows) { "\r\n" } else { "\n" })
    );
    assert_eq!(paths(&f.db, None).unwrap().lines().count(), 3);
    assert!(drag_plan(&f.db, vec![]).is_err());
    assert!(drag_plan(&f.db, vec!["stale".into()]).is_err());
    assert!(copy_with(&f.db, Some(vec!["stale".into()]), |_| panic!(
        "no clipboard write"
    ))
    .is_err());
    assert!(copy_with(&f.db, None, |_| Err(msg("injected write denial"))).is_err());
}
#[test]
fn capacity_rollback_cannot_drop_existing_items() {
    let f = Fixture::new();
    for i in 0..256 {
        let p = f.root.join(format!("{i}.txt"));
        std::fs::write(&p, b"fixture").unwrap();
        add(&f.db, vec![p.to_str().unwrap().into()]).unwrap();
    }
    assert!(add(&f.db, vec![f.files[0].clone()]).is_err());
    assert_eq!(list(&f.db).unwrap().len(), 256);
}
#[test]
fn thumbnails_are_bounded_on_demand_and_never_written_beside_or_instead_of_inputs() {
    let f = Fixture::new();
    let image = image::DynamicImage::new_rgb8(640, 480);
    image.save(&f.files[2]).unwrap();
    let original = std::fs::read(&f.files[2]).unwrap();
    let rows = add(&f.db, f.files.clone()).unwrap();
    use base64::Engine;
    let url = preview(&f.db, &rows[2].id).unwrap().unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(url.strip_prefix("data:image/png;base64,").unwrap())
        .unwrap();
    let decoded = image::load_from_memory(&bytes).unwrap();
    assert!(decoded.width() <= 320 && decoded.height() <= 144);
    assert_eq!(std::fs::read(&f.files[2]).unwrap(), original);
    assert!(preview(&f.db, &rows[0].id).unwrap().is_none());
    std::fs::write(&f.files[2], b"corrupt fixture").unwrap();
    assert!(preview(&f.db, &rows[2].id).unwrap().is_none());
    assert!(preview(&f.db, "unknown").is_err());
}
