use super::*;
#[tauri::command]
pub async fn tool_pick_input(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    tool_id: String,
) -> Result<Option<String>> {
    caller(&app, &window)?;
    let tool = registry::get(&tool_id)?;
    tauri::async_runtime::spawn_blocking(move || files::pick(&tool))
        .await
        .map_err(|_| msg("File chooser stopped"))?
}
#[tauri::command]
pub fn third_party_licenses(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<serde_json::Value> {
    caller(&app, &window)?;
    Ok(serde_json::from_str(include_str!(
        "../../../third-party/notices.json"
    ))?)
}
pub(crate) fn caller(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<()> {
    if matches!(window.label(), "main" | "settings" | "media-sheet") {
        return Ok(());
    }
    #[cfg(windows)]
    {
        app.try_state::<Arc<crate::island::Manager>>()
            .ok_or_else(|| msg("Island is unavailable"))?
            .surface_instruction(window.label())
            .map_err(msg)?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err(msg("Tools are unavailable on this surface"))
    }
}
#[tauri::command]
pub fn tool_catalog(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    paths: Option<Vec<String>>,
) -> Result<Vec<registry::Tool>> {
    caller(&app, &window)?;
    if let Some(paths) = paths {
        if paths.len() > 256 {
            return Err(msg("Choose at most 256 files"));
        }
        if paths.is_empty() || crate::context::silent(&app) {
            return Ok(vec![]);
        }
        return Ok(registry::catalog()
            .into_iter()
            .filter(|tool| paths.iter().all(|path| tool.accepts_path(Path::new(path))))
            .collect());
    }
    Ok(registry::catalog())
}
#[tauri::command]
pub fn tool_suggest(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    paths: Vec<String>,
) -> Result<Option<String>> {
    caller(&app, &window)?;
    if crate::context::silent(&app) {
        return Ok(None);
    }
    if paths.len() > 1 && paths.len() <= 64 {
        let tool = registry::get("images-pdf")?;
        for path in &paths {
            let facts = crate::files::paths::facts(path)?;
            if facts.directory || !tool.accepts_path(Path::new(&facts.path)) {
                return Ok(None);
            }
        }
        return Ok(Some("images-pdf".into()));
    }
    if paths.len() != 1 {
        return Ok(None);
    }
    let facts = crate::files::paths::facts(&paths[0])?;
    if facts.directory {
        return Ok(None);
    }
    let limit = state
        .db
        .tool_presets()?
        .into_iter()
        .find(|p| p.id == "discord")
        .and_then(|p| p.max_mb)
        .unwrap_or(20);
    Ok(registry::suggestion(Path::new(&facts.path), facts.bytes, limit).map(str::to_owned))
}
#[tauri::command]
pub fn tool_presets(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<registry::Preset>> {
    caller(&app, &window)?;
    state.db.tool_presets()
}
#[tauri::command]
pub fn tool_save_preset(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    preset: registry::Preset,
) -> Result<()> {
    caller(&app, &window)?;
    state.db.save_tool_preset(&preset)?;
    app.emit("tools:presets", ())?;
    Ok(())
}
#[tauri::command]
pub fn tool_jobs(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Vec<Job>> {
    caller(&app, &window)?;
    service.jobs()
}
#[tauri::command]
pub async fn tool_start(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    request: Request,
) -> Result<Job> {
    caller(&app, &window)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        registry::get(&request.tool_id)?.run(&service, request)
    })
    .await
    .map_err(|_| msg("Tool submission stopped"))?
}
#[tauri::command]
pub fn tool_cancel(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    id: String,
) -> Result<()> {
    caller(&app, &window)?;
    service.cancel(&id)
}
#[tauri::command]
pub async fn tool_retry(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    id: String,
) -> Result<Job> {
    caller(&app, &window)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.retry(&id))
        .await
        .map_err(|_| msg("Tool retry stopped"))?
}
#[tauri::command]
pub async fn tool_undo(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    id: String,
) -> Result<()> {
    caller(&app, &window)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.undo_with(&id, |path| {
            if crate::island::acceptance_session() {
                let root = app.state::<crate::AppState>().app_data_dir.canonicalize()?;
                if !path.canonicalize()?.starts_with(&root) {
                    return Err(msg("Acceptance Undo requires an owned fixture"));
                }
                let folder = root.join("tool-recycle-fixture");
                std::fs::create_dir_all(&folder)?;
                let target = folder.join(format!(
                    "{}-{}",
                    uuid::Uuid::new_v4(),
                    path.file_name().unwrap_or_default().to_string_lossy()
                ));
                // The injected provider only quarantines an owned output; no Shell or Recycle Bin.
                std::fs::hard_link(path, &target)?;
                std::fs::remove_file(path)?;
                app.emit(
                    "tools:undone",
                    serde_json::json!({"id":id,"injected":true,"path":target}),
                )?;
                Ok(())
            } else {
                files::recycle(path)
            }
        })
    })
    .await
    .map_err(|_| msg("Tool Undo stopped"))?
}
#[tauri::command]
pub async fn tool_reveal(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    id: String,
) -> Result<()> {
    caller(&app, &window)?;
    let jobs = service.jobs()?;
    tauri::async_runtime::spawn_blocking(move || {
        let job = jobs
            .into_iter()
            .find(|j| j.id == id && j.status == "completed")
            .ok_or_else(|| msg("Tool result not found"))?;
        let path = job.output.ok_or_else(|| msg("Tool result not found"))?;
        let path = Path::new(&path);
        let _file = files::input(path)?;
        if crate::island::acceptance_session() {
            let root = app.state::<crate::AppState>().app_data_dir.canonicalize()?;
            if !path.canonicalize()?.starts_with(root) {
                return Err(msg("Acceptance Reveal requires an owned fixture"));
            }
            app.emit(
                "tools:revealed",
                serde_json::json!({"id":id,"path":path,"injected":true}),
            )?;
            return Ok(());
        }
        files::reveal(path)
    })
    .await
    .map_err(|_| msg("Tool Reveal stopped"))?
}
#[tauri::command]
pub fn tool_quit(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    confirmed: bool,
) -> Result<()> {
    caller(&app, &window)?;
    if confirmed {
        service.quit_confirmed.store(true, Ordering::Release);
    }
    request_quit(&app);
    Ok(())
}
