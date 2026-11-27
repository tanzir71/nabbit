//! Keep the specific Shelf/pin/download references that followed an operation.
use super::{Entry, Verb};
use crate::{
    db::Database,
    error::{msg, Result},
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct References {
    pub shelf: Vec<Shelf>,
    pub displaced: Vec<Shelf>,
    pub pins: Vec<String>,
    pub downloads: Vec<String>,
    #[serde(default)]
    pub tools: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Shelf {
    id: String,
    path: String,
    key: String,
    position: i64,
    added: String,
}
fn shelf(conn: &Connection, path: &str) -> Result<Vec<Shelf>> {
    let mut stmt =
        conn.prepare("SELECT id,path,path_key,position,added_at FROM shelf_items WHERE path=?1")?;
    let rows = stmt
        .query_map([path], |r| {
            Ok(Shelf {
                id: r.get(0)?,
                path: r.get(1)?,
                key: r.get(2)?,
                position: r.get(3)?,
                added: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
pub fn capture(db: &Database, path: &str) -> Result<References> {
    let tools = db
        .tool_jobs()?
        .into_iter()
        .filter(|job| job.output.as_deref() == Some(path) && job.status == "completed")
        .map(|job| job.id)
        .collect();
    let conn = db.conn.lock().map_err(|_| msg("Database unavailable"))?;
    let ids = |table: &str, column: &str| -> Result<Vec<String>> {
        let mut stmt = conn.prepare(&format!("SELECT id FROM {table} WHERE {column}=?1"))?;
        let rows = stmt
            .query_map([path], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    };
    Ok(References {
        shelf: shelf(&conn, path)?,
        displaced: Vec::new(),
        pins: ids("pins", "path")?,
        downloads: ids("downloads", "output_path")?,
        tools,
    })
}
pub fn displaced(db: &Database, entry: &mut Entry, output: &str) -> Result<()> {
    let conn = db.conn.lock().map_err(|_| msg("Database unavailable"))?;
    entry.references.displaced = shelf(&conn, output)?
        .into_iter()
        .filter(|row| {
            !entry
                .references
                .shelf
                .iter()
                .any(|source| source.id == row.id)
        })
        .collect();
    Ok(())
}
pub fn update(conn: &Connection, entry: &Entry) -> Result<()> {
    if entry.verb != Verb::Move {
        return Ok(());
    }
    let Some(output) = &entry.output else {
        return Ok(());
    };
    let reversed = entry.restored || entry.undone;
    let (from, to) = if reversed {
        (output, &entry.source.path)
    } else {
        (&entry.source.path, output)
    };
    let key = if cfg!(windows) {
        to.to_lowercase()
    } else {
        to.clone()
    };
    for row in &entry.references.shelf {
        let present: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM shelf_items WHERE id=?1 AND path=?2)",
            params![row.id, from],
            |r| r.get(0),
        )?;
        if !present {
            continue;
        }
        if !reversed {
            for other in &entry.references.displaced {
                conn.execute(
                    "DELETE FROM shelf_items WHERE id=?1 AND path=?2",
                    params![other.id, output],
                )?;
            }
        }
        conn.execute(
            "UPDATE OR IGNORE shelf_items SET path=?1,path_key=?2 WHERE id=?3 AND path=?4",
            params![to, key, row.id, from],
        )?;
    }
    if reversed {
        for row in &entry.references.displaced {
            conn.execute("INSERT OR IGNORE INTO shelf_items(id,path,path_key,position,added_at) VALUES(?1,?2,?3,?4,?5)",params![row.id,row.path,row.key,row.position,row.added])?;
        }
    }
    for id in &entry.references.pins {
        conn.execute(
            "UPDATE pins SET path=?1 WHERE id=?2 AND path=?3",
            params![to, id, from],
        )?;
    }
    for id in &entry.references.downloads {
        conn.execute(
            "UPDATE downloads SET output_path=?1 WHERE id=?2 AND output_path=?3",
            params![to, id, from],
        )?;
    }
    if let Some(fingerprint) = &entry.fingerprint {
        let (expected, replacement) = if reversed {
            (
                Some(&fingerprint.identity),
                entry.restored_identity.as_ref(),
            )
        } else {
            (entry.source_identity.as_ref(), Some(&fingerprint.identity))
        };
        if let (Some(expected), Some(replacement)) = (expected, replacement) {
            for id in &entry.references.tools {
                let raw: String =
                    conn.query_row("SELECT value FROM tool_jobs WHERE id=?1", [id], |r| {
                        r.get(0)
                    })?;
                let mut job: crate::tools::Job = serde_json::from_str(&raw)?;
                if job.status == "completed"
                    && job.output.as_ref() == Some(from)
                    && job.output_identity.as_ref() == Some(expected)
                    && job.output_hash.as_deref() == Some(&fingerprint.hash)
                {
                    job.output = Some(to.clone());
                    job.output_identity = Some(replacement.clone());
                    conn.execute(
                        "UPDATE tool_jobs SET value=?1 WHERE id=?2",
                        params![serde_json::to_string(&job)?, id],
                    )?;
                }
            }
        }
    }
    Ok(())
}
