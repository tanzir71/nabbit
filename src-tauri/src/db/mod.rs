mod download_presets;
pub mod models;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    db::models::{AppSettings, ClipboardEntry, DownloadJob, StorageStats},
    error::{msg, Result},
    util::{content_type_for_text, preview_text, sha256_hex},
};

#[derive(Clone)]
pub struct Database {
    pub(crate) conn: Arc<Mutex<Connection>>,
    db_path: PathBuf,
}

impl Database {
    pub fn open(app_data_dir: &Path) -> Result<Self> {
        fs::create_dir_all(app_data_dir)?;
        let db_path = app_data_dir.join("nabbit.sqlite3");
        let conn = match Connection::open(&db_path) {
            Ok(conn) => conn,
            Err(error) => {
                backup_corrupt_db(app_data_dir, &db_path);
                eprintln!("Recovered from corrupt DB open error: {error}");
                Connection::open(&db_path)?
            }
        };
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: db_path.clone(),
        };
        if let Err(error) = db.migrate() {
            drop(db);
            backup_corrupt_db(app_data_dir, &db_path);
            eprintln!("Recovered from corrupt DB migration error: {error}");
            let recovered = Self {
                conn: Arc::new(Mutex::new(Connection::open(&db_path)?)),
                db_path,
            };
            recovered.migrate()?;
            recovered.seed_exclusions()?;
            return Ok(recovered);
        }
        db.seed_exclusions()?;
        Ok(db)
    }

    pub fn path(&self) -> &Path {
        &self.db_path
    }

    pub fn migrate(&self) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS clipboard_entries (
                id TEXT PRIMARY KEY,
                content_type TEXT NOT NULL,
                content TEXT NOT NULL,
                preview TEXT NOT NULL,
                hash TEXT NOT NULL UNIQUE,
                source_app TEXT,
                pinned INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                last_used_at TEXT NOT NULL,
                blob_path TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_clipboard_last_used ON clipboard_entries(last_used_at DESC);
            CREATE TABLE IF NOT EXISTS downloads (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                title TEXT NOT NULL,
                thumbnail TEXT,
                status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                speed TEXT,
                eta TEXT,
                output_path TEXT,
                error TEXT,
                quality TEXT NOT NULL,
                playlist_mode TEXT NOT NULL DEFAULT 'video',
                playlist_range TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS download_presets (
                site TEXT PRIMARY KEY,
                options_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_downloads_updated ON downloads(updated_at DESC);
            CREATE TABLE IF NOT EXISTS app_exclusions (
                app_name TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pins (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL, label TEXT,
                slot INTEGER, sort TEXT NOT NULL DEFAULT 'name', verb TEXT,
                added_at TEXT, last_used TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_pin_slot ON pins(slot) WHERE slot IS NOT NULL;
            CREATE TABLE IF NOT EXISTS note_cards (
                id TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                local_only INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );
            ",
        )?;
        let columns = conn
            .prepare("PRAGMA table_info(downloads)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        crate::shelf::migrate(&conn)?;
        if !columns.iter().any(|c| c == "options_json") {
            conn.execute("ALTER TABLE downloads ADD COLUMN options_json TEXT", [])?;
        }
        // Upgrade the shipped v1 default once; retain customized/disabled shortcuts.
        let migrated: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE key = 'capture_shortcut_v2')",
            [],
            |row| row.get(0),
        )?;
        if !migrated {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT value FROM settings WHERE key = 'app_settings'",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(raw) = raw {
                if let Ok(mut settings) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if settings["quickDownloadShortcut"] == "CmdOrCtrl+Shift+D" {
                        settings["quickDownloadShortcut"] = "Ctrl+Alt+D".into();
                        conn.execute(
                            "UPDATE settings SET value = ?1 WHERE key = 'app_settings'",
                            [serde_json::to_string(&settings)?],
                        )?;
                    }
                }
            }
            conn.execute(
                "INSERT INTO settings(key,value,updated_at) VALUES('capture_shortcut_v2','1',?1)",
                [Utc::now().to_rfc3339()],
            )?;
        }
        crate::notes::sync_store::migrate(&mut conn)?;
        crate::sticky::store::migrate(&conn)?;
        Ok(())
    }

    fn seed_exclusions(&self) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        for name in ["1Password", "Bitwarden", "KeePass", "LastPass", "Dashlane"] {
            conn.execute(
                "INSERT OR IGNORE INTO app_exclusions(app_name, enabled, created_at) VALUES (?1, 1, ?2)",
                params![name, now],
            )?;
        }
        Ok(())
    }

    pub fn list_pins(&self) -> Result<Vec<crate::pins::Pin>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let mut stmt=conn.prepare("SELECT id, kind, path, label, slot FROM pins ORDER BY COALESCE(slot, 1000000), added_at, id")?;
        let rows = stmt
            .query_map([], |row| {
                Ok(crate::pins::Pin {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    path: row.get(2)?,
                    label: row.get(3)?,
                    slot: row.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn pin_target(&self, id: Option<&str>, slot: Option<u8>) -> Result<crate::pins::Pin> {
        if !matches!((id, slot), (Some(_), None) | (None, Some(1..=9))) {
            return Err(msg("Choose a pin or a slot from 1 to 9"));
        }
        self.list_pins()?
            .into_iter()
            .find(|pin| {
                id.is_some_and(|id| id == pin.id) || slot.is_some_and(|slot| Some(slot) == pin.slot)
            })
            .ok_or_else(|| msg("This pin slot is empty"))
    }
    pub fn touch_pin(&self, id: &str) -> Result<()> {
        self.conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?
            .execute(
                "UPDATE pins SET last_used=?1 WHERE id=?2",
                params![Utc::now().to_rfc3339(), id],
            )?;
        Ok(())
    }
    pub fn clear_finished_downloads(&self) -> Result<Vec<String>> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        let ids = {
            let mut stmt =
                tx.prepare("SELECT id FROM downloads WHERE status IN ('completed', 'cancelled')")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        tx.execute(
            "DELETE FROM downloads WHERE status IN ('completed', 'cancelled')",
            [],
        )?;
        tx.commit()?;
        Ok(ids)
    }
    pub fn get_settings(&self) -> Result<AppSettings> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'app_settings'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match raw {
            Some(value) => Ok(serde_json::from_str::<AppSettings>(&value).unwrap_or_default()),
            None => Ok(AppSettings::default()),
        }
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<AppSettings> {
        let normalized = normalize_settings(settings.clone());
        let value = serde_json::to_string(&normalized)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        conn.execute(
            "INSERT INTO settings(key, value, updated_at) VALUES ('app_settings', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![value, Utc::now().to_rfc3339()],
        )?;
        Ok(normalized)
    }

    pub fn setting_value(&self, key: &str) -> Result<Option<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        Ok(conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn set_setting_value(&self, key: &str, value: &str) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        conn.execute(
            "INSERT INTO settings(key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn add_clipboard_text(
        &self,
        content: &str,
        source_app: Option<String>,
    ) -> Result<Option<ClipboardEntry>> {
        let settings = self.get_settings()?;
        if content.trim().is_empty() {
            return Ok(None);
        }
        if content.len() > 2_000_000 {
            return Ok(None);
        }
        if settings.sensitive_heuristics && crate::clipboard::sensitive::looks_sensitive(content) {
            return Ok(None);
        }
        if let Some(source) = source_app.as_deref() {
            if self.is_excluded_app(source)? {
                return Ok(None);
            }
        }

        let now = Utc::now();
        let hash = sha256_hex(content.as_bytes());
        let content_type = content_type_for_text(content);
        let preview = preview_text(content);
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM clipboard_entries WHERE hash = ?1",
                params![hash],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(id) = existing {
            conn.execute(
                "UPDATE clipboard_entries SET last_used_at = ?1, source_app = COALESCE(?2, source_app) WHERE id = ?3",
                params![now.to_rfc3339(), source_app, id],
            )?;
            drop(conn);
            return self.get_clipboard_entry(&id).map(Some);
        }

        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO clipboard_entries(id, content_type, content, preview, hash, source_app, pinned, created_at, last_used_at, blob_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7, NULL)",
            params![
                id,
                content_type,
                content,
                preview,
                hash,
                source_app,
                now.to_rfc3339()
            ],
        )?;
        drop(conn);
        self.get_clipboard_entry(&id).map(Some)
    }

    pub fn list_clipboard_entries(&self, query: Option<&str>) -> Result<Vec<ClipboardEntry>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let like = query.map(|value| format!("%{}%", value.trim()));
        let mut stmt = if like.is_some() {
            conn.prepare(
                "SELECT id, content_type, content, preview, hash, source_app, pinned, created_at, last_used_at, blob_path
                 FROM clipboard_entries
                 WHERE content LIKE ?1 OR preview LIKE ?1 OR source_app LIKE ?1
                 ORDER BY pinned DESC, last_used_at DESC
                 LIMIT 500",
            )?
        } else {
            conn.prepare(
                "SELECT id, content_type, content, preview, hash, source_app, pinned, created_at, last_used_at, blob_path
                 FROM clipboard_entries
                 ORDER BY pinned DESC, last_used_at DESC
                 LIMIT 500",
            )?
        };

        let mapper = |row: &rusqlite::Row<'_>| row_to_clipboard_entry(row);
        let rows = if let Some(like) = like {
            stmt.query_map(params![like], mapper)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        } else {
            stmt.query_map([], mapper)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        Ok(rows)
    }

    pub fn get_clipboard_entry(&self, id: &str) -> Result<ClipboardEntry> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        Ok(conn.query_row(
            "SELECT id, content_type, content, preview, hash, source_app, pinned, created_at, last_used_at, blob_path
             FROM clipboard_entries WHERE id = ?1",
            params![id],
            row_to_clipboard_entry,
        )?)
    }

    pub fn touch_clipboard_entry(&self, id: &str) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        conn.execute(
            "UPDATE clipboard_entries SET last_used_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id],
        )?;
        Ok(())
    }

    pub fn toggle_pin_clipboard_entry(&self, id: &str) -> Result<ClipboardEntry> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        conn.execute(
            "UPDATE clipboard_entries SET pinned = CASE pinned WHEN 1 THEN 0 ELSE 1 END WHERE id = ?1",
            params![id],
        )?;
        drop(conn);
        self.get_clipboard_entry(id)
    }

    pub fn delete_clipboard_entry(&self, id: &str) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        conn.execute("DELETE FROM clipboard_entries WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn clear_clipboard_history(&self) -> Result<()> {
        let blob_paths = {
            let conn = self
                .conn
                .lock()
                .map_err(|_| msg("database lock poisoned"))?;
            let mut stmt = conn.prepare(
                "SELECT DISTINCT blob_path FROM clipboard_entries
                 WHERE blob_path IS NOT NULL AND TRIM(blob_path) <> ''",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            let mut blob_paths = Vec::new();
            for row in rows {
                blob_paths.push(row?);
            }
            blob_paths
        };

        for blob_path in blob_paths {
            self.remove_clipboard_blob(&blob_path)?;
        }

        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        conn.execute("DELETE FROM clipboard_entries", [])?;
        Ok(())
    }

    fn remove_clipboard_blob(&self, raw_path: &str) -> Result<()> {
        let path = PathBuf::from(raw_path);
        let path = if path.is_absolute() {
            path
        } else {
            self.db_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(path)
        };

        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn run_retention_gc(&self) -> Result<usize> {
        let settings = self.get_settings()?;
        self.run_retention_gc_for_days(settings.retention_days)
    }

    pub fn run_retention_gc_for_days(&self, days: i64) -> Result<usize> {
        let cutoff = Utc::now() - Duration::days(days);
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let count = conn.execute(
            "DELETE FROM clipboard_entries WHERE pinned = 0 AND created_at < ?1",
            params![cutoff.to_rfc3339()],
        )?;
        Ok(count)
    }

    pub fn is_excluded_app(&self, source_app: &str) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let lower = source_app.to_lowercase();
        let mut stmt = conn.prepare("SELECT app_name FROM app_exclusions WHERE enabled = 1")?;
        for name in stmt.query_map([], |row| row.get::<_, String>(0))? {
            if lower.contains(&name?.to_lowercase()) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn insert_download(&self, job: &DownloadJob) -> Result<()> {
        self.insert_download_and_preset(job, false)
    }

    pub fn update_download(&self, job: &DownloadJob) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        conn.execute(
            "UPDATE downloads
             SET title = ?2, thumbnail = ?3, status = ?4, progress = ?5, speed = ?6, eta = ?7,
                 output_path = ?8, error = ?9, quality = ?10, playlist_mode = ?11, playlist_range = ?12, updated_at = ?13, options_json = ?14
             WHERE id = ?1",
            params![
                job.id,
                job.title,
                job.thumbnail,
                job.status,
                job.progress,
                job.speed,
                job.eta,
                job.output_path,
                job.error,
                job.quality,
                job.playlist_mode,
                job.playlist_range,
                job.updated_at.to_rfc3339(),
                job.options.as_ref().map(serde_json::to_string).transpose()?
            ],
        )?;
        Ok(())
    }

    pub fn list_downloads(&self) -> Result<Vec<DownloadJob>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let mut stmt = conn.prepare(
            "SELECT id, url, title, thumbnail, status, progress, speed, eta, output_path, error, quality, playlist_mode, playlist_range, created_at, updated_at, options_json
             FROM downloads
             WHERE status NOT IN ('completed', 'cancelled')
                OR id IN (SELECT id FROM downloads WHERE status IN ('completed', 'cancelled') ORDER BY updated_at DESC LIMIT 200)
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt
            .query_map([], row_to_download_job)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_download(&self, id: &str) -> Result<DownloadJob> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        Ok(conn.query_row(
            "SELECT id, url, title, thumbnail, status, progress, speed, eta, output_path, error, quality, playlist_mode, playlist_range, created_at, updated_at, options_json
             FROM downloads WHERE id = ?1",
            params![id],
            row_to_download_job,
        )?)
    }

    pub fn mark_interrupted_downloads(&self) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        conn.execute(
            "UPDATE downloads SET status = 'interrupted', error = 'Interrupted by app restart', updated_at = ?1
             WHERE status IN ('queued', 'running', 'paused')",
            params![now],
        )?;
        Ok(())
    }

    pub fn stats(&self) -> Result<StorageStats> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let clipboard_count =
            conn.query_row("SELECT COUNT(*) FROM clipboard_entries", [], |row| {
                row.get(0)
            })?;
        let download_count =
            conn.query_row("SELECT COUNT(*) FROM downloads", [], |row| row.get(0))?;
        let db_size_bytes = fs::metadata(&self.db_path)
            .map(|meta| meta.len())
            .unwrap_or(0);
        Ok(StorageStats {
            clipboard_count,
            download_count,
            db_size_bytes,
        })
    }
}

fn backup_corrupt_db(app_data_dir: &Path, db_path: &Path) {
    if db_path.exists() {
        let backup =
            app_data_dir.join(format!("nabbit.corrupt.{}.sqlite3", Utc::now().timestamp()));
        let _ = fs::rename(db_path, backup);
    }
}

fn normalize_settings(mut settings: AppSettings) -> AppSettings {
    settings.island_shortcut = settings.island_shortcut.trim().to_owned();
    settings.island_activity = settings.island_activity.normalized();
    settings.island.monitor_id = settings
        .island
        .monitor_id
        .map(|id| id.trim().chars().take(128).collect::<String>())
        .filter(|id| !id.is_empty());
    if ![30, 60, 90].contains(&settings.retention_days) {
        settings.retention_days = 30;
    }
    settings.image_size_cap_mb = settings.image_size_cap_mb.clamp(1, 50);
    settings.max_concurrent_downloads = settings.max_concurrent_downloads.clamp(1, 6);
    if !["download", "notes", "clipboard"].contains(&settings.last_tab.as_str()) {
        settings.last_tab = "download".into();
    }
    settings
}

fn parse_dt(value: String) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
}

fn row_to_clipboard_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClipboardEntry> {
    Ok(ClipboardEntry {
        id: row.get(0)?,
        content_type: row.get(1)?,
        content: row.get(2)?,
        preview: row.get(3)?,
        hash: row.get(4)?,
        source_app: row.get(5)?,
        pinned: row.get::<_, i64>(6)? != 0,
        created_at: parse_dt(row.get(7)?)?,
        last_used_at: parse_dt(row.get(8)?)?,
        blob_path: row.get(9)?,
    })
}

fn row_to_download_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<DownloadJob> {
    let mut job = DownloadJob {
        id: row.get(0)?,
        url: row.get(1)?,
        title: row.get(2)?,
        thumbnail: row.get(3)?,
        status: row.get(4)?,
        progress: row.get(5)?,
        speed: row.get(6)?,
        eta: row.get(7)?,
        output_path: row.get(8)?,
        error: row.get(9)?,
        failure: None,
        options: row
            .get::<_, Option<String>>(15)?
            .map(|raw| {
                serde_json::from_str(&raw).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        15,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })
            })
            .transpose()?,
        quality: row.get(10)?,
        playlist_mode: row.get(11)?,
        playlist_range: row.get(12)?,
        created_at: parse_dt(row.get(13)?)?,
        updated_at: parse_dt(row.get(14)?)?,
    };
    job.failure = crate::download::errors::for_job(&job);
    Ok(job)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_create_expected_tables() {
        let dir = tempfile_dir();
        let db = Database::open(&dir).expect("db opens");
        let settings = db.get_settings().expect("settings exist");
        assert_eq!(settings.retention_days, 30);
        assert!(db.path().exists());
    }

    #[test]
    fn duplicate_clipboard_hash_updates_entry() {
        let dir = tempfile_dir();
        let db = Database::open(&dir).expect("db opens");
        let first = db.add_clipboard_text("hello", None).unwrap().unwrap();
        let second = db.add_clipboard_text("hello", None).unwrap().unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(db.list_clipboard_entries(None).unwrap().len(), 1);
    }

    #[test]
    fn retention_gc_keeps_pinned_entries() {
        let dir = tempfile_dir();
        let db = Database::open(&dir).expect("db opens");
        let old = db.add_clipboard_text("old", None).unwrap().unwrap();
        db.toggle_pin_clipboard_entry(&old.id).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE clipboard_entries SET created_at = ?1 WHERE id = ?2",
                params![(Utc::now() - Duration::days(100)).to_rfc3339(), old.id],
            )
            .unwrap();
        }
        assert_eq!(db.run_retention_gc_for_days(30).unwrap(), 0);
        assert_eq!(db.list_clipboard_entries(None).unwrap().len(), 1);
    }

    #[test]
    fn theme_defaults_preserve_legacy_settings_and_override_survives_reopen() {
        use super::models::ThemePreference;
        let dir = tempfile_dir();
        let db = Database::open(&dir).expect("db opens");
        let mut settings = AppSettings {
            retention_days: 90,
            output_dir: "preserved-output".into(),
            ..AppSettings::default()
        };
        let mut legacy = serde_json::to_value(&settings).unwrap();
        legacy.as_object_mut().unwrap().remove("theme");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('app_settings',?1,?2)",params![legacy.to_string(),Utc::now().to_rfc3339()]).unwrap();
        }
        let loaded = db.get_settings().unwrap();
        assert_eq!(loaded.theme, ThemePreference::System);
        assert_eq!(loaded.retention_days, 90);
        assert_eq!(loaded.output_dir, "preserved-output");
        settings.theme = ThemePreference::Dark;
        db.save_settings(&settings).unwrap();
        drop(db);
        let reopened = Database::open(&dir).unwrap().get_settings().unwrap();
        assert_eq!(reopened.theme, ThemePreference::Dark);
        assert_eq!(reopened.output_dir, "preserved-output");
        legacy["theme"] = serde_json::json!("future-theme");
        let unknown: AppSettings = serde_json::from_value(legacy).unwrap();
        assert_eq!(unknown.theme, ThemePreference::System);
        assert_eq!(unknown.retention_days, 90);
    }
    #[test]
    fn activity_policy_extends_legacy_settings_normalizes_and_survives_reopen() {
        use crate::island::activity::{Kind, ORDER};
        let dir = tempfile_dir();
        let db = Database::open(&dir).unwrap();
        let mut settings = AppSettings {
            retention_days: 90,
            output_dir: "preserved".into(),
            ..AppSettings::default()
        };
        let mut legacy = serde_json::to_value(&settings).unwrap();
        legacy.as_object_mut().unwrap().remove("islandActivity");
        let loaded: AppSettings = serde_json::from_value(legacy).unwrap();
        assert_eq!(loaded.island_activity.order, ORDER);
        assert_eq!(loaded.retention_days, 90);
        settings.island_activity.order = vec![Kind::Power, Kind::Privacy, Kind::Power];
        settings.island_activity.disabled = vec![Kind::Media, Kind::Media];
        settings.island_activity.show_alerts_over_fullscreen = true;
        settings.island_activity.hidden_until_ms = Some(1_900_000_000_000);
        let saved = db.save_settings(&settings).unwrap();
        assert_eq!(saved.island_activity.order.len(), ORDER.len());
        assert_eq!(saved.island_activity.disabled, vec![Kind::Media]);
        drop(db);
        let reopened = Database::open(&dir).unwrap().get_settings().unwrap();
        assert_eq!(reopened.island_activity, saved.island_activity);
        assert_eq!(reopened.output_dir, "preserved");
        assert_eq!(reopened.retention_days, 90);
    }

    #[test]
    fn island_preferences_extend_legacy_settings_and_survive_reopen() {
        use crate::island::model::{MonitorMode, Preferences, Shape, Size};
        let dir = tempfile_dir();
        let db = Database::open(&dir).unwrap();
        let original = AppSettings {
            output_dir: "preserved-island-output".into(),
            retention_days: 90,
            ..AppSettings::default()
        };
        let mut legacy = serde_json::to_value(&original).unwrap();
        legacy.as_object_mut().unwrap().remove("island");
        db.set_setting_value("app_settings", &legacy.to_string())
            .unwrap();
        let mut settings = db.get_settings().unwrap();
        assert_eq!(settings.island, Preferences::default());
        assert_eq!(settings.output_dir, original.output_dir);
        settings.island = Preferences {
            enabled: false,
            shape: Shape::Notch,
            size: Size::Large,
            monitor_mode: MonitorMode::Specific,
            monitor_id: Some("  unplugged-display  ".into()),
        };
        let saved = db.save_settings(&settings).unwrap();
        drop(db);
        let reopened = Database::open(&dir).unwrap().get_settings().unwrap();
        assert_eq!(reopened.island, saved.island);
        assert_eq!(
            reopened.island.monitor_id.as_deref(),
            Some("unplugged-display")
        );
        assert_eq!(reopened.retention_days, 90);
        assert_eq!(reopened.output_dir, original.output_dir);
        legacy["island"] =
            serde_json::json!({"shape":"future","size":"future","monitorMode":"future"});
        let unknown: AppSettings = serde_json::from_value(legacy).unwrap();
        assert_eq!(unknown.island, Preferences::default());
        assert_eq!(unknown.retention_days, 90);
    }

    #[test]
    fn source_app_exclusions_skip_entries() {
        let dir = tempfile_dir();
        let db = Database::open(&dir).expect("db opens");
        let entry = db
            .add_clipboard_text("very secret", Some("Bitwarden.exe".into()))
            .unwrap();
        assert!(entry.is_none());
        assert_eq!(db.list_clipboard_entries(None).unwrap().len(), 0);
    }

    #[test]
    fn sensitive_heuristics_skip_when_enabled() {
        let dir = tempfile_dir();
        let db = Database::open(&dir).expect("db opens");
        let mut settings = db.get_settings().unwrap();
        settings.sensitive_heuristics = true;
        db.save_settings(&settings).unwrap();
        let entry = db.add_clipboard_text("4242 4242 4242 4242", None).unwrap();
        assert!(entry.is_none());
    }

    #[test]
    fn very_large_clipboard_payloads_are_skipped() {
        let dir = tempfile_dir();
        let db = Database::open(&dir).expect("db opens");
        let content = "x".repeat(2_000_001);

        let entry = db.add_clipboard_text(&content, None).unwrap();

        assert!(entry.is_none());
        assert_eq!(db.list_clipboard_entries(None).unwrap().len(), 0);
    }

    #[test]
    fn clear_clipboard_history_removes_blob_files() {
        let dir = tempfile_dir();
        let db = Database::open(&dir).expect("db opens");
        let blob_path = dir.join("clipboard-blob.bin");
        fs::write(&blob_path, b"blob").unwrap();
        let now = Utc::now().to_rfc3339();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO clipboard_entries(id, content_type, content, preview, hash, source_app, pinned, created_at, last_used_at, blob_path)
                 VALUES (?1, 'image', 'blob', 'blob', ?2, 'test', 0, ?3, ?3, ?4)",
                params![
                    Uuid::new_v4().to_string(),
                    format!("hash-{}", Uuid::new_v4()),
                    now,
                    blob_path.to_string_lossy().to_string()
                ],
            )
            .unwrap();
        }

        db.clear_clipboard_history().unwrap();

        assert_eq!(db.list_clipboard_entries(None).unwrap().len(), 0);
        assert!(!blob_path.exists());
    }

    #[test]
    fn open_recovers_from_corrupt_database_file() {
        let dir = tempfile_dir();
        fs::write(dir.join("nabbit.sqlite3"), b"not sqlite").unwrap();
        let db = Database::open(&dir).expect("db recovers");
        db.migrate().unwrap();
        assert!(db.path().exists());
        assert!(fs::read_dir(&dir).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("nabbit.corrupt.")));
    }

    #[test]
    fn keyboard_defaults_extend_old_settings_without_replacing_custom_keys() {
        let dir = tempfile_dir();
        let db = Database::open(&dir).unwrap();
        let mut legacy = serde_json::to_value(AppSettings::default()).unwrap();
        for field in ["islandShortcut", "island", "islandActivity", "theme"] {
            legacy.as_object_mut().unwrap().remove(field);
        }
        legacy["togglePopoverShortcut"] = "Ctrl+Alt+F8".into();
        legacy["quickDownloadShortcut"] = "Ctrl+Alt+F7".into();
        db.set_setting_value("app_settings", &legacy.to_string())
            .unwrap();
        let mut settings = db.get_settings().unwrap();
        assert_eq!(settings.toggle_popover_shortcut, "Ctrl+Alt+F8");
        assert_eq!(
            settings.island_shortcut,
            if cfg!(windows) { "Alt+Space" } else { "" }
        );
        settings.island_shortcut = " Ctrl+Alt+F9 ".into();
        db.save_settings(&settings).unwrap();
        drop(db);
        let settings = Database::open(&dir).unwrap().get_settings().unwrap();
        assert_eq!(settings.island_shortcut, "Ctrl+Alt+F9");
        assert_eq!(settings.quick_download_shortcut, "Ctrl+Alt+F7");
    }
    #[test]
    fn capture_shortcut_migrates_the_old_default_once_and_retains_custom_or_disabled_keys() {
        for shortcut in ["CmdOrCtrl+Shift+D", "Ctrl+Alt+F7", ""] {
            let dir = tempfile_dir();
            let db = Database::open(&dir).unwrap();
            let settings = AppSettings {
                quick_download_shortcut: shortcut.into(),
                ..Default::default()
            };
            db.save_settings(&settings).unwrap();
            db.conn
                .lock()
                .unwrap()
                .execute("DELETE FROM settings WHERE key = 'capture_shortcut_v2'", [])
                .unwrap();
            drop(db);
            let db = Database::open(&dir).unwrap();
            let mut settings = db.get_settings().unwrap();
            assert_eq!(
                settings.quick_download_shortcut,
                if shortcut == "CmdOrCtrl+Shift+D" {
                    "Ctrl+Alt+D"
                } else {
                    shortcut
                }
            );
            settings.quick_download_shortcut = "CmdOrCtrl+Shift+D".into();
            db.save_settings(&settings).unwrap();
            drop(db);
            assert_eq!(
                Database::open(&dir)
                    .unwrap()
                    .get_settings()
                    .unwrap()
                    .quick_download_shortcut,
                "CmdOrCtrl+Shift+D"
            );
        }
    }
    #[test]
    fn keyboard_pin_slots_are_stable_unique_and_survive_reopen() {
        let dir = tempfile_dir();
        let db = Database::open(&dir).unwrap();
        for slot in 1..=9 {
            db.conn
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO pins(id,kind,path,slot) VALUES(?1,'file',?2,?3)",
                    params![
                        format!("pin-{slot}"),
                        format!("C:\\Fixture\\{slot}.txt"),
                        slot
                    ],
                )
                .unwrap();
        }
        for slot in 1..=9 {
            assert_eq!(
                db.pin_target(None, Some(slot)).unwrap().id,
                format!("pin-{slot}")
            );
        }
        assert!(db.pin_target(None, Some(0)).is_err());
        assert!(db.pin_target(None, Some(10)).is_err());
        assert!(db.pin_target(None, None).is_err());
        assert!(db.pin_target(Some("pin-1"), Some(1)).is_err());
        assert!(db
            .conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO pins(id,kind,path,slot) VALUES('duplicate','file','x',1)",
                []
            )
            .is_err());
        db.touch_pin("pin-9").unwrap();
        drop(db);
        let db = Database::open(&dir).unwrap();
        assert_eq!(db.list_pins().unwrap().len(), 9);
        assert_eq!(db.pin_target(Some("pin-9"), None).unwrap().slot, Some(9));
    }
    fn tempfile_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nabbit-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
