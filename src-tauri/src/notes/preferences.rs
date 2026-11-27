//! Device-only view preferences and non-secret connection hints.
use super::sync_store::{self, Context};
use crate::{
    db::Database,
    error::{msg, Result},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub show_tasks: bool,
    pub filter_labels: bool,
    pub labels: Vec<String>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            show_tasks: true,
            filter_labels: false,
            labels: vec![],
        }
    }
}
impl Preferences {
    pub(crate) fn normalized(mut self) -> Result<Self> {
        if self.labels.len() > 200
            || self
                .labels
                .iter()
                .any(|s| s.trim().is_empty() || s.chars().count() > 100)
        {
            return Err(msg("Choose valid Tack labels"));
        }
        self.labels = self
            .labels
            .into_iter()
            .map(|s| s.trim().to_owned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        if self.filter_labels && self.labels.is_empty() {
            return Err(msg("Choose at least one label to filter by"));
        }
        Ok(self)
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub base_url: Option<String>,
    pub username: String,
    pub local_count: u64,
    pub preferences: Preferences,
    pub labels: Vec<String>,
    pub read_only: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Setup {
    pub workspace_id: String,
    pub expected_user_id: String,
    pub expected_base_url: String,
    pub preferences: Preferences,
    pub upload_local: bool,
}
pub(crate) fn read(conn: &Connection, scope: Option<&Context>) -> Result<Preferences> {
    let Some(scope) = scope else {
        return Ok(Preferences::default());
    };
    sync_store::meta(conn, &format!("preferences/{}", scope.key))?
        .map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .unwrap_or_else(|| Ok(Preferences::default()))
}
pub(crate) fn read_only(conn: &Connection, scope: Option<&Context>) -> Result<bool> {
    match scope {
        Some(s) => {
            Ok(sync_store::meta(conn, &format!("read_only/{}", s.key))?.as_deref() == Some("true"))
        }
        None => Ok(false),
    }
}
pub(crate) fn writable(conn: &Connection, scope: Option<&Context>) -> Result<()> {
    sync_store::ensure(conn, scope)?;
    if read_only(conn, scope)? {
        return Err(msg(
            "This Tack workspace is read only. Your draft is preserved.",
        ));
    }
    Ok(())
}
impl Database {
    pub(crate) fn tack_hint(&self, base: &str, username: Option<&str>) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        sync_store::set_meta(&tx, "last_base", base)?;
        if let Some(name) = username {
            sync_store::set_meta(&tx, "last_username", name)?;
        }
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn tack_profile(&self) -> Result<Profile> {
        self.tack_profile_for(None)
    }
    pub(crate) fn tack_profile_for(&self, selected: Option<&Context>) -> Result<Profile> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let scope = selected.cloned().or(sync_store::current(&conn)?);
        let preferences = read(&conn, scope.as_ref())?;
        let mut labels = BTreeSet::new();
        if let Some(s) = &scope {
            let mut statement=conn.prepare("SELECT value FROM note_cards WHERE scope=?1 UNION ALL SELECT value FROM tack_mirror WHERE scope=?1 AND tbl='settings' AND id='tack.labels'")?;
            let values = statement.query_map([&s.key], |r| r.get::<_, String>(0))?;
            for raw in values {
                let value: serde_json::Value = serde_json::from_str(&raw?)?;
                if let Some(names) = value.get("labels").and_then(serde_json::Value::as_array) {
                    for name in names.iter().filter_map(serde_json::Value::as_str) {
                        labels.insert(name.to_owned());
                    }
                }
                if value.get("key").and_then(serde_json::Value::as_str) == Some("tack.labels") {
                    let catalogue = value
                        .get("value")
                        .and_then(serde_json::Value::as_str)
                        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                        .unwrap_or(serde_json::Value::Null);
                    if let Some(names) = catalogue.as_array() {
                        for name in names.iter().filter_map(serde_json::Value::as_str) {
                            labels.insert(name.to_owned());
                        }
                    }
                }
            }
        }
        labels.extend(preferences.labels.iter().cloned());
        Ok(Profile {
            base_url: sync_store::meta(&conn, "last_base")?,
            username: sync_store::meta(&conn, "last_username")?.unwrap_or_default(),
            local_count: conn.query_row(
                "SELECT count(*) FROM note_cards WHERE scope='' AND local_only=1",
                [],
                |r| r.get(0),
            )?,
            preferences,
            labels: labels.into_iter().collect(),
            read_only: read_only(&conn, scope.as_ref())?,
        })
    }
}
