use super::{
    registry::{self, Preset},
    Job,
};
use crate::{
    db::Database,
    error::{msg, Result},
};
use rusqlite::{params, Connection};
pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS tool_presets(id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tool_jobs(id TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL);")?;
    Ok(())
}
impl Database {
    pub fn tool_presets(&self) -> Result<Vec<Preset>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let mut rows = registry::presets();
        let mut stmt = conn.prepare("SELECT value FROM tool_presets ORDER BY id")?;
        for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
            let value: Preset = serde_json::from_str(&row?)?;
            registry::validate_preset(&value)?;
            if let Some(old) = rows.iter_mut().find(|p| p.id == value.id) {
                *old = value;
            }
        }
        Ok(rows)
    }
    pub fn save_tool_preset(&self, preset: &Preset) -> Result<()> {
        registry::validate_preset(preset)?;
        self.conn.lock().map_err(|_|msg("database lock poisoned"))?.execute(
            "INSERT INTO tool_presets(id,value) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
            params![preset.id,serde_json::to_string(preset)?])?;
        Ok(())
    }
    pub fn tool_jobs(&self) -> Result<Vec<Job>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let mut stmt =
            conn.prepare("SELECT value FROM tool_jobs ORDER BY created_at DESC, id DESC")?;
        let mut jobs = Vec::new();
        for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
            jobs.push(serde_json::from_str(&row?)?);
        }
        Ok(jobs)
    }
    pub fn save_tool_job(&self, job: &Job) -> Result<()> {
        self.conn.lock().map_err(|_|msg("database lock poisoned"))?.execute(
            "INSERT INTO tool_jobs(id,value,created_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
            params![job.id,serde_json::to_string(job)?,job.created_at])?;
        Ok(())
    }
}
