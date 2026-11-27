//! Shared pin shape and shortcut adapter; browsing and operations live in files/.
use crate::{
    error::{msg, Result},
    AppState,
};
use serde::Serialize;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    pub id: String,
    pub kind: String,
    pub path: String,
    pub label: Option<String>,
    pub slot: Option<u8>,
}
fn launch_with(pin: &Pin, launch: impl FnOnce(&Pin) -> Result<()>) -> Result<()> {
    let path = std::path::Path::new(&pin.path);
    let facts = crate::files::paths::facts(&pin.path)?;
    if !path.is_absolute()
        || !matches!(pin.kind.as_str(), "file" | "folder")
        || facts.directory != (pin.kind == "folder")
    {
        return Err(msg("This pinned path is unavailable"));
    }
    launch(pin)
}
#[cfg(windows)]
fn launch(pin: &Pin) -> Result<()> {
    crate::files::native::action(pin.path.clone(), "open".into())
}
#[cfg(not(windows))]
fn launch(pin: &Pin) -> Result<()> {
    open::that(&pin.path).map_err(Into::into)
}
fn caller(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<()> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let manager = app
            .try_state::<std::sync::Arc<crate::island::Manager>>()
            .ok_or_else(|| msg("Island is unavailable"))?;
        if !manager.is_expanded(window.label()) {
            return Err(msg("Open the island to use pins"));
        }
    }
    #[cfg(not(windows))]
    let _ = (app, window);
    Ok(())
}
#[tauri::command]
pub fn list_island_pins(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Pin>> {
    caller(&app, &window)?;
    state.db.list_pins()
}
#[tauri::command]
pub async fn island_open_pin(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: Option<String>,
    slot: Option<u8>,
) -> Result<()> {
    caller(&app, &window)?;
    let db = state.db.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("nabbit-pin-open".into())
        .spawn(move || {
            let result = (|| {
                let pin = db.pin_target(id.as_deref(), slot)?;
                launch_with(&pin, |pin| {
                    if crate::island::acceptance_session() {
                        Ok(())
                    } else {
                        launch(pin)
                    }
                })?;
                db.touch_pin(&pin.id)?;
                use tauri::Emitter;
                window.emit(
                    "nabbit://pin-opened",
                    serde_json::json!({"pin":pin,"injected":crate::island::acceptance_session()}),
                )?;
                Ok(())
            })();
            let _ = tx.send(result);
        })?;
    rx.await.map_err(|_| msg("Pin opener stopped"))?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_launch_validates_paths_before_using_the_injected_opener() {
        let path = std::env::temp_dir().join(format!("nabbit-pin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let mut pin = Pin {
            id: "one".into(),
            kind: "folder".into(),
            path: path.to_string_lossy().into(),
            label: None,
            slot: Some(1),
        };
        let mut opened = 0;
        launch_with(&pin, |_| {
            opened += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(opened, 1);
        pin.kind = "file".into();
        assert!(launch_with(&pin, |_| panic!("must not open a mismatched kind")).is_err());
        pin.path = "relative/path".into();
        assert!(launch_with(&pin, |_| panic!("must not open relative path")).is_err());
        std::fs::remove_dir(path).unwrap();
    }
}
