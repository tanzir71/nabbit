//! Owned files + production Shelf store. Clipboard and drag effects are records.
use crate::{db::Database, error::Result, shelf};
use serde_json::{json, Map, Value};
use std::{
    path::{Path, PathBuf},
    sync::{mpsc, Mutex},
};
pub(super) struct Fixture {
    root: PathBuf,
    copied: Mutex<Vec<String>>,
}
impl Fixture {
    pub fn new(directory: &Path) -> Self {
        let root = directory.join("shelf-fixtures");
        std::fs::create_dir_all(&root).unwrap();
        let image = image::ImageBuffer::from_fn(320, 144, |x, y| {
            image::Rgb([
                (210 - x / 4) as u8,
                (202 - y / 3) as u8,
                (174 + x / 5) as u8,
            ])
        });
        image.save(root.join("photo.png")).unwrap();
        std::fs::File::create(root.join("movie.mp4"))
            .unwrap()
            .set_len(18_100_000)
            .unwrap();
        std::fs::write(root.join("handoff.md"), b"Owned original Shelf fixture").unwrap();
        std::fs::write(root.join("gone.txt"), b"Owned missing-file fixture").unwrap();
        Self {
            root,
            copied: Mutex::new(vec![]),
        }
    }
}
pub(super) fn handles(command: &str) -> bool {
    command.starts_with("shelf_") || command == "test.shelf" || command == "island_stage_drop"
}
pub(super) fn route(
    db: &Database,
    f: &Fixture,
    command: &str,
    mut args: Map<String, Value>,
    events: &Mutex<Vec<mpsc::Sender<String>>>,
) -> crate::tack::model::Result<Value> {
    let result: Result<Value> = (|| {
        let ids = || {
            serde_json::from_value::<Option<Vec<String>>>(
                args.get("ids").cloned().unwrap_or(Value::Null),
            )
            .map_err(crate::error::NabbitError::from)
        };
        let value = match command {
            "test.shelf" => {
                if args.get("missing").and_then(Value::as_bool) == Some(true) {
                    std::fs::remove_file(f.root.join("gone.txt"))?;
                }
                return Ok(
                    json!({"paths":(["photo.png","movie.mp4","handoff.md","gone.txt"].map(|name|f.root.join(name).to_str().unwrap().to_owned())),"copied":*f.copied.lock().unwrap(),"items":shelf::list(db)?,"originalsRemain":(["photo.png","movie.mp4","handoff.md"].iter().all(|name|f.root.join(name).is_file()))}),
                );
            }
            "shelf_list" => return Ok(serde_json::to_value(shelf::list(db)?)?),
            "shelf_preview" => {
                return Ok(serde_json::to_value(shelf::preview(
                    db,
                    args.get("id").and_then(Value::as_str).unwrap_or(""),
                )?)?)
            }
            "shelf_paths" => return Ok(json!(shelf::paths(db, ids()?)?)),
            "shelf_copy_paths" => {
                shelf::copy_with(db, ids()?, |text| {
                    f.copied.lock().unwrap().push(text.into());
                    Ok(())
                })?;
                return Ok(Value::Null);
            }
            "shelf_drag_plan" => {
                return Ok(serde_json::to_value(shelf::drag_plan(
                    db,
                    ids()?.unwrap_or_default(),
                )?)?)
            }
            "shelf_add" => serde_json::to_value(shelf::add(
                db,
                serde_json::from_value(args.remove("paths").unwrap_or(Value::Null))?,
            )?)?,
            "island_stage_drop" => {
                assert_eq!(args["zone"], "shelf");
                shelf::add(
                    db,
                    serde_json::from_value(args["payload"]["files"].clone())?,
                )?;
                Value::Null
            }
            "shelf_remove" => {
                shelf::remove(db, ids()?)?;
                Value::Null
            }
            _ => return Err(crate::error::msg("Unknown Shelf fixture command")),
        };
        let packet = format!(
            "data: {}\n\n",
            json!({"event":"shelf:changed","payload":null})
        );
        events
            .lock()
            .unwrap()
            .retain(|sender| sender.send(packet.clone()).is_ok());
        Ok(value)
    })();
    result.map_err(|_| crate::tack::model::Error::new(crate::tack::model::ErrorCode::InvalidInput))
}
