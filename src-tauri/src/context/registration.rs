//! The only registry namespace owned by the Explorer integration is per-user.
use crate::{
    error::{msg, Result},
    tools::registry,
};
use serde::{Deserialize, Serialize};
use std::path::Path;
pub const ROOT: &str = "Software\\Classes\\*\\shell\\Nabbit";
pub const OWNER: &str = "com.nabbit.app";
#[cfg(windows)]
#[path = "registration_win.rs"]
mod native;
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub send_to: bool,
    pub context_menu: bool,
    pub selection_copy_fallback: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Value {
    pub key: String,
    pub name: &'static str,
    pub value: String,
}
pub fn plan(executable: &Path) -> Result<Vec<Value>> {
    let executable = executable.to_string_lossy();
    if !Path::new(executable.as_ref()).is_absolute() || executable.contains(['\0', '\r', '\n', '"'])
    {
        return Err(msg("The app executable path cannot be registered"));
    }
    let mut values = vec![];
    let mut add = |key: String, name, value: String| values.push(Value { key, name, value });
    add(ROOT.into(), "NabbitOwner", OWNER.into());
    add(ROOT.into(), "NabbitExecutable", executable.to_string());
    for (name, value) in [
        ("MUIVerb", "Nabbit"),
        ("SubCommands", ""),
        ("MultiSelectModel", "Player"),
    ] {
        add(ROOT.into(), name, value.into());
    }
    let shelf = format!("{ROOT}\\shell\\00-shelf");
    add(shelf.clone(), "MUIVerb", "Add to Shelf".into());
    add(shelf.clone(), "MultiSelectModel", "Player".into());
    add(
        format!("{shelf}\\command"),
        "",
        format!("\"{executable}\" --send-to -- \"%1\""),
    );
    let presets = registry::presets();
    let mut index = 1;
    for tool in registry::catalog() {
        for preset in tool.presets {
            let preset = presets
                .iter()
                .find(|p| p.id == *preset)
                .ok_or_else(|| msg("Registered tool has an unknown preset"))?;
            let key = format!("{ROOT}\\shell\\{index:02}-{}-{}", tool.id, preset.id);
            index += 1;
            add(key.clone(), "MUIVerb", preset.name.clone());
            add(key.clone(), "MultiSelectModel", "Player".into());
            add(
                key.clone(),
                "AppliesTo",
                tool.accepts
                    .filetypes
                    .iter()
                    .map(|ext| format!("System.FileExtension:=\".{ext}\""))
                    .collect::<Vec<_>>()
                    .join(" OR "),
            );
            add(
                format!("{key}\\command"),
                "",
                format!(
                    "\"{executable}\" --send-to --tool {} --preset {} -- \"%1\"",
                    tool.id, preset.id
                ),
            );
        }
    }
    Ok(values)
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Link {
    pub owner: String,
    pub target: String,
    pub arguments: String,
}
pub trait Port {
    fn exists(&mut self) -> Result<bool>;
    fn get(&mut self, name: &str) -> Result<Option<String>>;
    fn set(&mut self, value: &Value) -> Result<()>;
    fn remove_menu(&mut self) -> Result<()>;
    fn link(&mut self) -> Result<Option<Link>>;
    fn save_link(&mut self, link: &Link) -> Result<()>;
    fn remove_link(&mut self) -> Result<()>;
}
pub fn apply(port: &mut dyn Port, preferences: &Preferences, executable: &Path) -> Result<()> {
    let values = plan(executable)?;
    let executable = executable.to_string_lossy().into_owned();
    let owner = port.get("NabbitOwner")?;
    let previous = port.get("NabbitExecutable")?;
    let previous_link = port.link()?;
    if preferences.send_to
        && previous_link
            .as_ref()
            .is_some_and(|link| link.owner != OWNER)
    {
        return Err(msg(
            "An existing Nabbit Send To shortcut belongs to another app",
        ));
    }
    if preferences.context_menu {
        if port.exists()? && owner.as_deref() != Some(OWNER) {
            return Err(msg(
                "An existing Nabbit context menu belongs to another app",
            ));
        }
        if owner.as_deref() == Some(OWNER) {
            port.remove_menu()?;
        }
        for value in &values {
            port.set(value)?;
        }
    } else if owner.as_deref() == Some(OWNER)
        && previous.is_some_and(|p| p.eq_ignore_ascii_case(&executable))
    {
        port.remove_menu()?;
    }
    let previous = previous_link;
    if preferences.send_to {
        port.save_link(&Link {
            owner: OWNER.into(),
            target: executable,
            arguments: "--send-to --".into(),
        })?;
    } else if previous
        .is_some_and(|link| link.owner == OWNER && link.target.eq_ignore_ascii_case(&executable))
    {
        port.remove_link()?;
    }
    Ok(())
}
pub fn preferences(db: &crate::db::Database) -> Result<Preferences> {
    db.setting_value("context/preferences")?
        .map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .transpose()
        .map(|p| p.unwrap_or_default())
}
pub fn sync(preferences: Preferences) -> Result<()> {
    #[cfg(windows)]
    {
        let executable = std::env::current_exe()?;
        crate::shell::run(move || {
            let mut port = native::Native::new()?;
            apply(&mut port, &preferences, &executable)
        })
    }
    #[cfg(not(windows))]
    {
        if preferences.send_to || preferences.context_menu {
            Err(msg("Explorer integration is available on Windows"))
        } else {
            Ok(())
        }
    }
}
pub fn uninstall() -> Result<()> {
    sync(Preferences::default())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registration_plan_contains_every_registry_preset_and_only_the_owned_hkcu_subtree() {
        let exe = std::env::temp_dir()
            .join("Nabbit Fixture (বাংলা)")
            .join("nabbit.exe");
        let values = plan(&exe).unwrap();
        assert!(values
            .iter()
            .all(|v| v.key == ROOT || v.key.starts_with(&format!("{ROOT}\\"))));
        assert!(values
            .iter()
            .any(|v| v.name == "NabbitOwner" && v.value == OWNER));
        for tool in registry::catalog() {
            for preset in tool.presets {
                let suffix = format!("--tool {} --preset {} -- \"%1\"", tool.id, preset);
                let command = values
                    .iter()
                    .find(|v| v.name.is_empty() && v.value.ends_with(&suffix))
                    .expect("Each registry preset has an Explorer command");
                let key = command.key.strip_suffix("\\command").unwrap();
                let applies = values
                    .iter()
                    .find(|v| v.key == key && v.name == "AppliesTo")
                    .unwrap();
                assert_eq!(
                    applies.value,
                    tool.accepts
                        .filetypes
                        .iter()
                        .map(|ext| format!("System.FileExtension:=\".{ext}\""))
                        .collect::<Vec<_>>()
                        .join(" OR ")
                );
            }
        }
        assert!(values
            .iter()
            .filter(|v| v.key.ends_with("\\command"))
            .all(|v| v
                .value
                .starts_with(&format!("\"{}\"", exe.to_string_lossy()))));
        assert!(
            Preferences::default()
                == Preferences {
                    send_to: false,
                    context_menu: false,
                    selection_copy_fallback: false
                }
        );
    }
    #[derive(Default)]
    struct Fake {
        values: std::collections::HashMap<(String, String), String>,
        link: Option<Link>,
        removed: usize,
    }
    impl Port for Fake {
        fn exists(&mut self) -> Result<bool> {
            Ok(!self.values.is_empty())
        }
        fn get(&mut self, name: &str) -> Result<Option<String>> {
            Ok(self.values.get(&(ROOT.into(), name.into())).cloned())
        }
        fn set(&mut self, value: &Value) -> Result<()> {
            assert!(value.key == ROOT || value.key.starts_with(&format!("{ROOT}\\")));
            self.values
                .insert((value.key.clone(), value.name.into()), value.value.clone());
            Ok(())
        }
        fn remove_menu(&mut self) -> Result<()> {
            self.values.clear();
            self.removed += 1;
            Ok(())
        }
        fn link(&mut self) -> Result<Option<Link>> {
            Ok(self.link.clone())
        }
        fn save_link(&mut self, link: &Link) -> Result<()> {
            self.link = Some(link.clone());
            Ok(())
        }
        fn remove_link(&mut self) -> Result<()> {
            self.link = None;
            Ok(())
        }
    }
    #[test]
    fn toggles_and_uninstall_remove_only_this_executable_owned_registration() {
        let exe = std::env::temp_dir().join("nabbit.exe");
        let mut port = Fake::default();
        apply(
            &mut port,
            &Preferences {
                send_to: true,
                context_menu: true,
                ..Default::default()
            },
            &exe,
        )
        .unwrap();
        assert!(port.link.is_some());
        assert!(!port.values.is_empty());
        apply(
            &mut port,
            &Preferences::default(),
            &exe.with_file_name("another.exe"),
        )
        .unwrap();
        assert!(port.link.is_some());
        assert!(!port.values.is_empty());
        apply(&mut port, &Preferences::default(), &exe).unwrap();
        assert!(port.link.is_none());
        assert!(port.values.is_empty());
        port.values
            .insert((ROOT.into(), "NabbitOwner".into()), "foreign".into());
        assert!(apply(
            &mut port,
            &Preferences {
                context_menu: true,
                ..Default::default()
            },
            &exe
        )
        .is_err());
        assert_eq!(port.values.len(), 1);
    }
}
