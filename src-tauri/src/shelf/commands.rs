use super::*;
use tauri::Emitter;
fn caller(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<()> {
    if window.label() == "main" {
        return Ok(());
    }
    #[cfg(windows)]
    {
        use tauri::Manager;
        app.try_state::<std::sync::Arc<crate::island::Manager>>()
            .ok_or_else(|| msg("Island is unavailable"))?
            .surface_instruction(window.label())
            .map_err(msg)?;
    }
    #[cfg(not(windows))]
    let _ = (app, window);
    Ok(())
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| msg("Shelf task stopped"))?
}
#[tauri::command]
pub async fn shelf_list(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<Item>> {
    // File reviews may choose existing Shelf entries. All mutating Shelf
    // commands retain authorization to the tray or an active island below.
    if window.label() != "media-sheet" {
        caller(&app, &window)?;
    }
    let db = state.db.clone();
    blocking(move || list(&db)).await
}
#[tauri::command]
pub async fn shelf_add(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    paths: Vec<String>,
) -> Result<Vec<Item>> {
    caller(&app, &window)?;
    let db = state.db.clone();
    let rows = blocking(move || add(&db, paths)).await?;
    let _ = app.emit("shelf:changed", ());
    Ok(rows)
}
#[tauri::command]
pub async fn shelf_remove(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    ids: Option<Vec<String>>,
) -> Result<()> {
    caller(&app, &window)?;
    let db = state.db.clone();
    blocking(move || remove(&db, ids)).await?;
    let _ = app.emit("shelf:changed", ());
    Ok(())
}
#[tauri::command]
pub async fn shelf_paths(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    ids: Option<Vec<String>>,
) -> Result<String> {
    caller(&app, &window)?;
    let db = state.db.clone();
    blocking(move || paths(&db, ids)).await
}
#[tauri::command]
pub async fn shelf_copy_paths(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    ids: Option<Vec<String>>,
) -> Result<()> {
    caller(&app, &window)?;
    if crate::island::acceptance_session()
        || crate::sticky::acceptance_enabled()
        || crate::download::acceptance::enabled()
    {
        return Err(msg("OS clipboard is disabled in acceptance"));
    }
    let db = state.db.clone();
    blocking(move || {
        copy_with(&db, ids, |text| {
            arboard::Clipboard::new()
                .map_err(|_| msg("Clipboard is unavailable"))?
                .set_text(text)
                .map_err(|_| msg("Clipboard could not be written"))
        })
    })
    .await
}
#[tauri::command]
pub async fn shelf_drag_plan(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    ids: Vec<String>,
) -> Result<DragPlan> {
    caller(&app, &window)?;
    let db = state.db.clone();
    blocking(move || drag_plan(&db, ids)).await
}
#[tauri::command]
pub async fn shelf_preview(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    id: String,
) -> Result<Option<String>> {
    caller(&app, &window)?;
    let db = state.db.clone();
    blocking(move || preview(&db, &id)).await
}
