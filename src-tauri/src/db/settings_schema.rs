//! Extend the existing v0.1 settings row in place. Never replace the history DB.
use super::models::AppSettings;
use crate::error::Result;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
const MARKER: &str = "settings_layout_v2";

pub(super) fn migrate(conn: &mut Connection) -> Result<()> {
    let transaction = conn.transaction()?;
    let done: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE key = ?1)",
        [MARKER],
        |r| r.get(0),
    )?;
    if done {
        return Ok(());
    }
    let original: Option<String> = transaction
        .query_row(
            "SELECT value FROM settings WHERE key = 'app_settings'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(original) = original {
        // Invalid JSON is a preferences problem, not evidence of a corrupt SQLite file.
        // Leave it untouched rather than triggering Database::open's DB recovery path.
        let Ok(Value::Object(mut values)) = serde_json::from_str::<Value>(&original) else {
            return Ok(());
        };
        let Value::Object(defaults) = serde_json::to_value(AppSettings::default())? else {
            unreachable!()
        };
        if !values.contains_key("displayMode")
            && values.get("island").and_then(|v| v.get("enabled")) == Some(&Value::Bool(false))
        {
            values.insert("displayMode".into(), Value::String("trayOnly".into()));
        }
        for (key, value) in defaults {
            values.entry(key).or_insert(value);
        }
        if values
            .get("clipboardSearchShortcut")
            .and_then(Value::as_str)
            .is_some_and(|key| matches!(key, "CmdOrCtrl+Shift+C" | "Ctrl+Shift+C"))
        {
            values.insert(
                "clipboardSearchShortcut".into(),
                Value::String("Ctrl+Alt+V".into()),
            );
        }
        let merged = Value::Object(values);
        if serde_json::from_value::<AppSettings>(merged.clone()).is_err() {
            return Ok(());
        }
        transaction.execute(
            "UPDATE settings SET value = ?1 WHERE key = 'app_settings'",
            [serde_json::to_string(&merged)?],
        )?;
    }
    transaction.execute(
        "INSERT INTO settings(key,value,updated_at) VALUES(?1,'1',?2)",
        params![MARKER, Utc::now().to_rfc3339()],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(super) fn preserve_unknown(original: Option<&str>, settings: &AppSettings) -> Result<String> {
    let mut previous = original
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let Value::Object(known) = serde_json::to_value(settings)? else {
        unreachable!()
    };
    fn preserve_nested(
        previous: &mut serde_json::Map<String, Value>,
        known: serde_json::Map<String, Value>,
    ) {
        for (key, value) in known {
            if let (Some(Value::Object(old)), Value::Object(new)) = (previous.get_mut(&key), &value)
            {
                preserve_nested(old, new.clone());
            } else {
                previous.insert(key, value);
            }
        }
    }
    preserve_nested(&mut previous, known);
    Ok(serde_json::to_string(&previous)?)
}

/// Merge only supplied, known fields. Nested preferences are patches too, so two
/// windows changing different island/activity options cannot revert one another.
pub(crate) fn patch(settings: &AppSettings, change: Value) -> Result<AppSettings> {
    fn merge(target: &mut Value, change: Value) -> Result<()> {
        let (Some(target), Value::Object(change)) = (target.as_object_mut(), change) else {
            return Err(crate::error::msg("Settings changes must be an object"));
        };
        for (key, value) in change {
            let old = target
                .get_mut(&key)
                .ok_or_else(|| crate::error::msg(format!("Unknown settings field: {key}")))?;
            if old.is_object() && value.is_object() {
                merge(old, value)?;
            } else {
                *old = value;
            }
        }
        Ok(())
    }
    if serde_json::to_vec(&change)?.len() > 65_536 {
        return Err(crate::error::msg("Settings change is too large"));
    }
    let mut value = serde_json::to_value(settings)?;
    merge(&mut value, change)?;
    Ok(serde_json::from_value(value)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn patches_preserve_concurrent_fields_and_reject_unknown_or_invalid_values() {
        let first = patch(
            &AppSettings::default(),
            serde_json::json!({"retentionDays":90,"island":{"shape":"notch"}}),
        )
        .unwrap();
        let second = patch(&first, serde_json::json!({"theme":"dark","island":{"peekOnHoverMs":null},"islandActivity":{"disabled":["media"]}})).unwrap();
        assert_eq!(second.retention_days, 90);
        assert_eq!(second.island.shape, crate::island::model::Shape::Notch);
        assert_eq!(second.island.peek_on_hover_ms, None);
        assert_eq!(
            second.island_activity.order,
            crate::island::activity::ORDER.to_vec()
        );
        for invalid in [
            serde_json::json!([]),
            serde_json::json!({"retentionDays":"bad"}),
            serde_json::json!({"unknown":true}),
            serde_json::json!({"island":{"unknown":true}}),
            serde_json::json!({"theme":null}),
            serde_json::json!({"outputDir":"x".repeat(65_537)}),
        ] {
            assert!(patch(&second, invalid).is_err());
        }
    }
    use crate::db::Database;
    use std::path::PathBuf;
    struct Owned(PathBuf);
    impl Owned {
        fn new() -> Self {
            let p =
                std::env::temp_dir().join(format!("nabbit-v61-settings-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Owned {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn v01_partial_preferences_history_custom_and_disabled_keys_survive_reopen_and_save() {
        let owned = Owned::new();
        let db = Database::open(&owned.0).unwrap();
        let entry = db
            .add_clipboard_text("Owned migration history", None)
            .unwrap()
            .unwrap();
        let raw = serde_json::json!({"retentionDays":90,"outputDir":"D:\\Owned\\Exports","togglePopoverShortcut":"Ctrl+Alt+F8","quickDownloadShortcut":"","clipboardSearchShortcut":"Ctrl+Alt+F7","futureExtension":{"keep":true}});
        db.set_setting_value("app_settings", &raw.to_string())
            .unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM settings WHERE key = ?1", [MARKER])
            .unwrap();
        drop(db);
        let db = Database::open(&owned.0).unwrap();
        let settings = db.get_settings().unwrap();
        assert_eq!(settings.retention_days, 90);
        assert_eq!(settings.output_dir, "D:\\Owned\\Exports");
        assert_eq!(settings.toggle_popover_shortcut, "Ctrl+Alt+F8");
        assert!(settings.quick_download_shortcut.is_empty());
        assert_eq!(settings.clipboard_search_shortcut, "Ctrl+Alt+F7");
        assert_eq!(db.path(), owned.0.join("nabbit.sqlite3"));
        assert_eq!(
            db.get_clipboard_entry(&entry.id).unwrap().content,
            "Owned migration history"
        );
        let migrated = db.setting_value("app_settings").unwrap().unwrap();
        db.migrate().unwrap();
        assert_eq!(db.setting_value("app_settings").unwrap().unwrap(), migrated);
        let mut settings = settings;
        settings.start_hidden = false;
        db.save_settings(&settings).unwrap();
        let saved: Value =
            serde_json::from_str(&db.setting_value("app_settings").unwrap().unwrap()).unwrap();
        assert_eq!(saved["futureExtension"], raw["futureExtension"]);
        assert_eq!(saved["startHidden"], false);
        assert_eq!(db.setting_value(MARKER).unwrap().as_deref(), Some("1"));
    }
    #[test]
    fn invalid_preferences_never_replace_or_backup_the_history_database() {
        for raw in ["broken JSON", r#"{"retentionDays":"invalid"}"#, "[]"] {
            let owned = Owned::new();
            let db = Database::open(&owned.0).unwrap();
            let entry = db
                .add_clipboard_text("Retain this history", None)
                .unwrap()
                .unwrap();
            db.set_setting_value("app_settings", raw).unwrap();
            db.conn
                .lock()
                .unwrap()
                .execute("DELETE FROM settings WHERE key = ?1", [MARKER])
                .unwrap();
            drop(db);
            let db = Database::open(&owned.0).unwrap();
            assert_eq!(
                db.setting_value("app_settings").unwrap().as_deref(),
                Some(raw)
            );
            assert!(db.setting_value(MARKER).unwrap().is_none());
            assert_eq!(
                db.get_clipboard_entry(&entry.id).unwrap().content,
                "Retain this history"
            );
        }
    }
}
