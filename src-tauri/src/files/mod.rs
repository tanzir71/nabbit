//! Metadata-only pin browsing and journalled file operations.
pub mod commands;
#[cfg(windows)]
pub mod drop;
pub mod native;
pub mod paths;
mod pins;
mod references;
#[cfg(test)]
mod tests;
mod watch;
use crate::{
    db::Database,
    error::{msg, Result},
};
use paths::Facts;
pub use pins::*;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
pub use watch::Watches;
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Verb {
    Move,
    Copy,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Modifiers {
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub ctrl: bool,
}
pub fn verb(source: &Facts, destination: &Facts, modifiers: &Modifiers, always_move: bool) -> Verb {
    if modifiers.ctrl {
        Verb::Copy
    } else if modifiers.shift || always_move || source.volume == destination.volume {
        Verb::Move
    } else {
        Verb::Copy
    }
}
fn moving_out(source: &Facts, destination: &Facts, verb: Verb, roots: &[String]) -> bool {
    verb == Verb::Move
        && ((source.cloud && !destination.cloud)
            || roots.iter().any(|root| {
                paths::inside(&source.path, root) && !paths::inside(&destination.path, root)
            }))
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub source: Facts,
    #[serde(default)]
    pub source_identity: Option<String>,
    #[serde(default)]
    pub restored_identity: Option<String>,
    pub verb: Verb,
    pub output: Option<String>,
    pub fingerprint: Option<Fingerprint>,
    pub backup: Option<String>,
    #[serde(default)]
    pub backup_fingerprint: Option<Fingerprint>,
    #[serde(default)]
    pub restored: bool,
    #[serde(default)]
    pub backup_restored: bool,
    pub replaced: bool,
    pub undone: bool,
    #[serde(default)]
    pub references: references::References,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub identity: String,
    pub hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    pub destination: Facts,
    pub entries: Vec<Entry>,
    pub reasons: Vec<String>,
    pub bytes: u64,
    pub status: String,
    pub created_at: String,
    pub error: Option<String>,
    pub site: Option<String>,
}
pub struct Service {
    pub db: Database,
    pub watches: Watches,
    pub directory: std::path::PathBuf,
    lock: Mutex<()>,
    active: Arc<std::sync::atomic::AtomicUsize>,
}
pub struct Lease(Arc<std::sync::atomic::AtomicUsize>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}
impl Service {
    pub fn lease(&self) -> Lease {
        self.active
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        Lease(self.active.clone())
    }
    pub fn active(&self) -> bool {
        self.active.load(std::sync::atomic::Ordering::Acquire) > 0
    }
    pub fn new(db: Database, directory: std::path::PathBuf) -> Result<Arc<Self>> {
        let service = Arc::new(Self {
            db,
            watches: Watches::default(),
            directory,
            lock: Mutex::new(()),
            active: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        });
        for mut operation in service.history()? {
            if operation.status == "working" || operation.status == "undoing" {
                operation.status = "partial".into();
                operation.error = Some(
                    "Interrupted when Nabbit stopped. Only recorded results can be undone.".into(),
                );
                service.save(&operation)?;
            }
        }
        Ok(service)
    }
    pub fn prepare(
        &self,
        paths: Vec<String>,
        destination: String,
        modifiers: Modifiers,
        always_move: bool,
        site: Option<String>,
    ) -> Result<Operation> {
        if paths.is_empty() || paths.len() > 256 {
            return Err(msg("Choose between 1 and 256 files"));
        }
        let site = site.or(self.site_for(&paths)?);
        let destination = paths::facts(&paths::canonical(&destination)?)?;
        if !destination.directory {
            return Err(msg("Choose a destination folder"));
        }
        let mut entries = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut bytes = 0u64;
        let roots = paths::cloud_roots();
        let mut cloud = false;
        for path in paths {
            let source = paths::facts(&paths::canonical(&path)?)?;
            if source.directory {
                return Err(msg(
                    "Choose files to move. Folder pins can be opened or dragged into another app.",
                ));
            }
            let key = if cfg!(windows) {
                source.path.to_lowercase()
            } else {
                source.path.clone()
            };
            if !seen.insert(key) {
                continue;
            }
            if Path::new(&source.path).parent().is_some_and(|p| {
                paths::inside(&destination.path, &paths::display(p))
                    && paths::inside(&paths::display(p), &destination.path)
            }) {
                return Err(msg("The file is already in this folder"));
            }
            let action = verb(&source, &destination, &modifiers, always_move);
            cloud |= moving_out(&source, &destination, action, &roots);
            bytes = bytes.saturating_add(source.bytes);
            entries.push(Entry {
                source_identity: None,
                restored_identity: None,
                references: references::capture(&self.db, &source.path)?,
                source,
                verb: action,
                output: None,
                fingerprint: None,
                backup: None,
                backup_fingerprint: None,
                restored: false,
                backup_restored: false,
                replaced: false,
                undone: false,
            });
        }
        let mut reasons = Vec::new();
        if cloud {
            reasons
                .push("Moving out of a cloud sync folder may download the original files.".into());
        }
        if destination.network {
            reasons.push("The destination is on a network.".into());
        }
        if entries.len() > 50 {
            reasons.push("This operation contains more than 50 files.".into());
        }
        let operation = Operation {
            id: uuid::Uuid::new_v4().to_string(),
            destination,
            entries,
            reasons,
            bytes,
            status: "prepared".into(),
            created_at: chrono::Utc::now().to_rfc3339(),
            error: None,
            site: site.filter(|v| v.len() <= 200),
        };
        self.save(&operation)?;
        Ok(operation)
    }
    pub fn execute(&self, id: &str, confirmed: bool, backend: &impl Backend) -> Result<Operation> {
        self.execute_using(id, confirmed, backend, paths::facts)
    }
    fn execute_using(
        &self,
        id: &str,
        confirmed: bool,
        backend: &impl Backend,
        probe: impl Fn(&str) -> Result<Facts>,
    ) -> Result<Operation> {
        let _lease = self.lease();
        let _guard = self
            .lock
            .lock()
            .map_err(|_| msg("File operation unavailable"))?;
        let mut operation = self.get(id)?;
        if operation.status != "prepared" {
            return Ok(operation);
        }
        if !operation.reasons.is_empty() && !confirmed {
            return Err(msg("Confirm this file operation first"));
        }
        if probe(&operation.destination.path)? != operation.destination {
            return Err(msg("The destination changed. Choose it again."));
        }
        for entry in &operation.entries {
            if probe(&entry.source.path)? != entry.source {
                return Err(msg("A source file changed. Choose the files again."));
            }
        }
        operation.status = "working".into();
        self.save(&operation)?;
        for index in 0..operation.entries.len() {
            let result = (|| -> Result<()> {
                operation.entries[index].source_identity =
                    Some(paths::identity(&operation.entries[index].source.path)?);
                self.save(&operation)?;
                let entry = &operation.entries[index];
                let expected = Path::new(&operation.destination.path).join(
                    Path::new(&entry.source.path)
                        .file_name()
                        .ok_or_else(|| msg("File has no name"))?,
                );
                if expected.try_exists()? {
                    let facts = paths::facts(&paths::display(&expected))?;
                    if facts.directory || facts.attributes & (paths::RECALL | 0x1000) != 0 {
                        return Err(msg("An existing destination cannot be backed up safely. Choose another folder or rename the file first."));
                    }
                    let backup_dir = self.directory.join("file-operations").join(&operation.id);
                    std::fs::create_dir_all(&backup_dir)?;
                    let backup = backup_dir.join(format!("{index}.backup"));
                    native::backup(&facts.path, &backup)?;
                    operation.entries[index].backup = Some(backup.to_string_lossy().into());
                    operation.entries[index].backup_fingerprint = Some(
                        backend.fingerprint(
                            backup
                                .to_str()
                                .ok_or_else(|| msg("Backup path unavailable"))?,
                        )?,
                    );
                    self.save(&operation)?;
                }
                let entry = &operation.entries[index];
                let output = backend.transfer(
                    &entry.source.path,
                    &operation.destination.path,
                    None,
                    entry.verb,
                )?;
                let Some(output) = output else {
                    return Ok(());
                };
                if !paths::inside(&output, &operation.destination.path) {
                    return Err(msg("Windows returned an unexpected destination"));
                }
                let entry = &mut operation.entries[index];
                entry.replaced = entry.backup.is_some()
                    && paths::inside(&output, &paths::display(&expected))
                    && paths::inside(&paths::display(&expected), &output);
                entry.output = Some(output.clone());
                references::displaced(&self.db, entry, &output)?;
                self.save(&operation)?;
                operation.entries[index].fingerprint = Some(backend.fingerprint(&output)?);
                self.save(&operation)?;
                Ok(())
            })();
            if let Err(error) = result {
                operation.error = Some(error.to_string());
                break;
            }
        }
        operation.status = if operation.error.is_some() {
            "partial"
        } else {
            "completed"
        }
        .into();
        self.save(&operation)?;
        Ok(operation)
    }
    pub fn undo(&self, id: &str, backend: &impl Backend) -> Result<Operation> {
        let _lease = self.lease();
        let _guard = self
            .lock
            .lock()
            .map_err(|_| msg("File operation unavailable"))?;
        let mut operation = self.get(id)?;
        if operation.status == "undone" {
            return Ok(operation);
        }
        if !matches!(operation.status.as_str(), "completed" | "partial") {
            return Err(msg("This operation cannot be undone"));
        }
        // Preflight every result before moving or recycling any result.
        for entry in operation
            .entries
            .iter()
            .filter(|e| !e.undone && e.output.is_some())
        {
            if entry.restored
                && entry.replaced
                && !entry.backup_restored
                && Path::new(entry.output.as_deref().unwrap()).try_exists()?
            {
                return Err(msg(
                    "The replacement path is occupied. Undo will not overwrite it.",
                ));
            }
            if !entry.restored
                && Some(backend.fingerprint(entry.output.as_deref().unwrap())?) != entry.fingerprint
            {
                return Err(msg(
                    "A result changed. Undo will not touch an edited or replaced file.",
                ));
            }
            if !entry.restored
                && entry.verb == Verb::Move
                && Path::new(&entry.source.path).try_exists()?
            {
                return Err(msg(
                    "The original path is occupied. Move that file before using Undo.",
                ));
            }
            if let Some(backup) = &entry.backup {
                if entry.replaced
                    && !entry.backup_restored
                    && Some(backend.fingerprint(backup)?) != entry.backup_fingerprint
                {
                    return Err(msg("The replacement backup is unavailable"));
                }
            }
        }
        operation.status = "undoing".into();
        operation.error = None;
        self.save(&operation)?;
        for index in (0..operation.entries.len()).rev() {
            let entry = operation.entries[index].clone();
            if entry.undone || entry.output.is_none() {
                continue;
            }
            let result = (|| -> Result<()> {
                let output = entry.output.as_deref().unwrap();
                if !entry.restored && entry.verb == Verb::Move {
                    let source = Path::new(&entry.source.path);
                    let parent = source.parent().ok_or_else(|| msg("No original folder"))?;
                    let restored = backend.transfer(
                        output,
                        &paths::display(parent),
                        source.file_name().and_then(|v| v.to_str()),
                        Verb::Move,
                    )?;
                    if restored.as_deref() != Some(&entry.source.path) {
                        return Err(msg(
                            "The original file could not be restored to its exact path",
                        ));
                    }
                } else if !entry.restored {
                    backend.recycle(output)?;
                }
                operation.entries[index].restored = true;
                if entry.verb == Verb::Move {
                    operation.entries[index].restored_identity =
                        Some(paths::identity(&entry.source.path)?);
                }
                self.save(&operation)?;
                if entry.replaced && !entry.backup_restored {
                    let original = Path::new(output);
                    let restored = backend.transfer(
                        entry.backup.as_deref().unwrap(),
                        &paths::display(original.parent().unwrap()),
                        original.file_name().and_then(|v| v.to_str()),
                        Verb::Move,
                    )?;
                    if restored.as_deref() != Some(output) {
                        return Err(msg("The replaced file backup could not be restored"));
                    }
                    operation.entries[index].backup_restored = true;
                    self.save(&operation)?;
                }
                Ok(())
            })();
            match result {
                Ok(()) => {
                    operation.entries[index].undone = true;
                    self.save(&operation)?;
                }
                Err(error) => {
                    operation.status = "partial".into();
                    operation.error = Some(error.to_string());
                    self.save(&operation)?;
                    return Err(error);
                }
            }
        }
        operation.status = "undone".into();
        self.save(&operation)?;
        Ok(operation)
    }
    pub fn save(&self, op: &Operation) -> Result<()> {
        let mut conn = self
            .db
            .conn
            .lock()
            .map_err(|_| msg("Database unavailable"))?;
        let tx = conn.transaction()?;
        tx.execute("INSERT INTO file_ops(id,value,created_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET value=excluded.value",params![op.id,serde_json::to_string(op)?,op.created_at])?;
        for entry in &op.entries {
            references::update(&tx, entry)?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn get(&self, id: &str) -> Result<Operation> {
        let raw: String = self
            .db
            .conn
            .lock()
            .map_err(|_| msg("Database unavailable"))?
            .query_row("SELECT value FROM file_ops WHERE id=?1", [id], |r| r.get(0))?;
        Ok(serde_json::from_str(&raw)?)
    }
    pub fn history(&self) -> Result<Vec<Operation>> {
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|_| msg("Database unavailable"))?;
        let mut stmt =
            conn.prepare("SELECT value FROM file_ops ORDER BY created_at DESC,id DESC LIMIT 500")?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|v| serde_json::from_str(&v).map_err(Into::into))
            .collect()
    }
    pub fn suggestions(&self, paths: &[String], site: Option<&str>) -> Result<Vec<String>> {
        let stored_site = self.site_for(paths)?;
        let site = site.or(stored_site.as_deref());
        let extensions: Vec<_> = paths
            .iter()
            .filter_map(|p| Path::new(p).extension())
            .map(|v| v.to_string_lossy().to_lowercase())
            .collect();
        let mut seen = std::collections::HashSet::new();
        Ok(self
            .history()?
            .into_iter()
            .filter(|op| {
                op.entries.iter().any(|e| {
                    !e.undone
                        && e.output.is_some()
                        && (site.is_some_and(|s| op.site.as_deref() == Some(s))
                            || Path::new(&e.source.path).extension().is_some_and(|v| {
                                extensions.contains(&v.to_string_lossy().to_lowercase())
                            }))
                })
            })
            .map(|op| op.destination.path)
            .filter(|path| seen.insert(path.clone()) && Path::new(path).is_dir())
            .take(3)
            .collect())
    }
    fn site_for(&self, paths: &[String]) -> Result<Option<String>> {
        let conn = self
            .db
            .conn
            .lock()
            .map_err(|_| msg("Database unavailable"))?;
        for path in paths {
            let url:Option<String>=conn.query_row("SELECT url FROM downloads WHERE output_path=?1 ORDER BY updated_at DESC LIMIT 1",[path],|r|r.get(0)).optional()?;
            if let Some(site) = url
                .and_then(|url| url::Url::parse(&url).ok())
                .and_then(|url| url.host_str().map(str::to_owned))
            {
                return Ok(Some(site.trim_start_matches("www.").into()));
            }
        }
        Ok(None)
    }
}
pub trait Backend {
    fn transfer(
        &self,
        source: &str,
        destination: &str,
        name: Option<&str>,
        verb: Verb,
    ) -> Result<Option<String>>;
    fn fingerprint(&self, path: &str) -> Result<Fingerprint>;
    fn recycle(&self, path: &str) -> Result<()>;
}
pub fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS file_ops(id TEXT PRIMARY KEY,value TEXT NOT NULL,created_at TEXT NOT NULL);")?;
    Ok(())
}
