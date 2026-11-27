//! The Shelf stores references only. Removal/clear never mutate source files.
pub mod commands;
#[cfg(test)]
mod tests;
use crate::{
    db::Database,
    error::{msg, Result},
};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::{
    collections::HashSet,
    io::{Cursor, Read},
    path::{Path, PathBuf},
};
const MAX_ITEMS: usize = 256;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: Option<u64>,
    pub available: bool,
}
#[derive(Serialize)]
pub struct DragPlan {
    pub item: Vec<String>,
    pub icon: String,
    pub mode: &'static str,
}
fn kind(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "heic" | "heif" | "avif" => "image",
        "mp4" | "mkv" | "mov" | "webm" | "avi" | "m4v" => "video",
        _ => "file",
    }
}
fn key(path: &str) -> String {
    #[cfg(windows)]
    return path.to_lowercase();
    #[cfg(not(windows))]
    path.into()
}
fn file_path(raw: &str) -> Result<String> {
    let path = Path::new(raw);
    if raw.len() > 32768 || raw.contains(['\0', '\n', '\r']) || !path.is_absolute() {
        return Err(msg("Use an absolute file path"));
    }
    if !path.is_file() {
        return Err(msg("This file is unavailable"));
    }
    let canonical = std::fs::canonicalize(path)?;
    let canonical = canonical
        .to_str()
        .ok_or_else(|| msg("This file path cannot be displayed"))?;
    // Keep ordinary Explorer paths in the database and on the clipboard.
    Ok(if let Some(unc) = canonical.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        canonical.strip_prefix(r"\\?\").unwrap_or(canonical).into()
    })
}
pub fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS shelf_items(id TEXT PRIMARY KEY,path TEXT NOT NULL,path_key TEXT NOT NULL UNIQUE,position INTEGER NOT NULL,added_at TEXT NOT NULL);")?;
    Ok(())
}
pub fn add(db: &Database, paths: Vec<String>) -> Result<Vec<Item>> {
    if paths.is_empty() || paths.len() > MAX_ITEMS {
        return Err(msg("Add between 1 and 256 files"));
    }
    // Validate the complete batch before inserting anything; aliases dedupe.
    let paths = paths
        .iter()
        .map(|p| file_path(p))
        .collect::<Result<Vec<_>>>()?;
    let mut conn = db.conn.lock().map_err(|_| msg("database lock poisoned"))?;
    let tx = conn.transaction()?;
    let position: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position),-1)+1 FROM shelf_items",
        [],
        |r| r.get(0),
    )?;
    for (offset, path) in paths.into_iter().enumerate() {
        tx.execute("INSERT OR IGNORE INTO shelf_items(id,path,path_key,position,added_at) VALUES(?1,?2,?3,?4,?5)", params![uuid::Uuid::new_v4().to_string(),path,key(&path),position + offset as i64,chrono::Utc::now().to_rfc3339()])?;
    }
    let count: usize = tx.query_row("SELECT COUNT(*) FROM shelf_items", [], |r| r.get(0))?;
    if count > MAX_ITEMS {
        return Err(msg(
            "The Shelf holds up to 256 files. Remove some before adding more.",
        ));
    }
    tx.commit()?;
    drop(conn);
    list(db)
}
fn records(db: &Database) -> Result<Vec<(String, String)>> {
    let conn = db.conn.lock().map_err(|_| msg("database lock poisoned"))?;
    let mut query = conn.prepare("SELECT id,path FROM shelf_items ORDER BY position,id")?;
    let rows = query
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
pub fn list(db: &Database) -> Result<Vec<Item>> {
    // Filesystem probes happen after the SQLite lock has been released.
    Ok(records(db)?
        .into_iter()
        .map(|(id, path)| {
            let file = Path::new(&path);
            let meta = std::fs::metadata(file).ok().filter(|m| m.is_file());
            Item {
                id,
                name: file
                    .file_name()
                    .map(|s| s.to_string_lossy().into())
                    .unwrap_or_else(|| path.clone()),
                kind: kind(file).into(),
                size: meta.as_ref().map(|m| m.len()),
                available: meta.is_some(),
                path,
            }
        })
        .collect())
}
fn selected(db: &Database, ids: Option<Vec<String>>) -> Result<Vec<(String, String)>> {
    let rows = records(db)?;
    let Some(ids) = ids else {
        return Ok(rows);
    };
    if ids.is_empty() || ids.len() > MAX_ITEMS {
        return Err(msg("Select files from the Shelf"));
    }
    let wanted: HashSet<_> = ids.into_iter().collect();
    let selected: Vec<_> = rows.into_iter().filter(|r| wanted.contains(&r.0)).collect();
    if selected.len() != wanted.len() {
        return Err(msg(
            "The Shelf changed. Refresh and select the files again.",
        ));
    }
    Ok(selected)
}
pub fn paths(db: &Database, ids: Option<Vec<String>>) -> Result<String> {
    let paths: Vec<_> = selected(db, ids)?.into_iter().map(|r| r.1).collect();
    if paths.is_empty() {
        return Err(msg("The Shelf is empty"));
    }
    Ok(paths.join(if cfg!(windows) { "\r\n" } else { "\n" }))
}
pub fn copy_with(
    db: &Database,
    ids: Option<Vec<String>>,
    write: impl FnOnce(&str) -> Result<()>,
) -> Result<()> {
    write(&paths(db, ids)?)
}
pub fn drag_plan(db: &Database, ids: Vec<String>) -> Result<DragPlan> {
    use base64::Engine;
    let selected = selected(db, Some(ids))?;
    let item = selected.into_iter().map(|(_, p)| {
        if !Path::new(&p).is_file() { return Err(msg("A selected file is unavailable. Remove it from the Shelf or restore it before dragging.")); }
        Ok(p)
    }).collect::<Result<Vec<_>>>()?;
    Ok(DragPlan {
        item,
        icon: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD
                .encode(include_bytes!("../../icons/32x32.png"))
        ),
        mode: "copy",
    })
}
pub fn remove(db: &Database, ids: Option<Vec<String>>) -> Result<()> {
    let rows = selected(db, ids)?;
    let mut conn = db.conn.lock().map_err(|_| msg("database lock poisoned"))?;
    let tx = conn.transaction()?;
    for (id, _) in rows {
        tx.execute("DELETE FROM shelf_items WHERE id=?1", [id])?;
    }
    tx.commit()?;
    Ok(())
}
pub fn preview(db: &Database, id: &str) -> Result<Option<String>> {
    use base64::Engine;
    let path: Option<String> = db
        .conn
        .lock()
        .map_err(|_| msg("database lock poisoned"))?
        .query_row("SELECT path FROM shelf_items WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()?;
    let path = PathBuf::from(path.ok_or_else(|| msg("The Shelf changed"))?);
    // Decode a bounded on-demand thumbnail in memory; never persist a copy.
    if !matches!(
        path.extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg" | "webp"
    ) {
        return Ok(None);
    }
    let thumb = (|| -> Result<String> {
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(8_000_001)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 8_000_000 {
            return Err(msg("Preview too large"));
        }
        let mut reader = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(16384);
        limits.max_image_height = Some(16384);
        limits.max_alloc = Some(64_000_000);
        reader.limits(limits);
        let image = reader
            .decode()
            .map_err(|_| msg("Preview unavailable"))?
            .thumbnail(320, 144);
        let mut out = Cursor::new(Vec::new());
        image
            .write_to(&mut out, image::ImageFormat::Png)
            .map_err(|_| msg("Preview unavailable"))?;
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(out.into_inner())
        ))
    })();
    Ok(thumb.ok())
}
