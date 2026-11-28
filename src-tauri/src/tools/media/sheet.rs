use super::*;
use crate::tools::Service;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    pub id: String,
    pub tool_id: String,
    pub input: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    #[serde(default)]
    pub inputs: Vec<String>,
}
fn validate(intent: &Intent) -> Result<()> {
    if uuid::Uuid::parse_str(&intent.id).is_err() {
        return Err(msg("Invalid review id"));
    }
    let tool = crate::tools::registry::get(&intent.tool_id)?;
    if intent
        .preset_id
        .as_ref()
        .is_some_and(|id| !tool.presets.contains(&id.as_str()))
    {
        return Err(msg("This preset does not belong to the tool"));
    }
    if intent.inputs.len() > 64 {
        return Err(msg("Choose at most 64 files"));
    }
    for input in &intent.inputs {
        crate::files::paths::checked(input)?;
        if !tool.accepts_path(Path::new(input)) {
            return Err(msg("This tool does not accept every file in the batch"));
        }
    }
    if intent.input.len() > 32760
        || intent.input.contains(['\0', '\n', '\r'])
        || !intent.input.is_empty() && !Path::new(&intent.input).is_absolute()
    {
        return Err(msg("Choose an absolute file path"));
    }
    Ok(())
}
#[tauri::command]
pub async fn tool_open_media_sheet(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, std::sync::Arc<Service>>,
    intent: Intent,
) -> Result<()> {
    crate::tools::commands::caller(&app, &window)?;
    validate(&intent)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _opening = service
            .sheet_open
            .lock()
            .map_err(|_| msg("Media review unavailable"))?;
        {
            let mut current = service
                .sheet
                .lock()
                .map_err(|_| msg("Media review unavailable"))?;
            if current.as_ref().is_some_and(|old| old.id == intent.id) {
                if current.as_ref() != Some(&intent) {
                    return Err(msg("This review id belongs to another input"));
                }
                if app.get_webview_window("media-sheet").is_some() {
                    return Ok(());
                }
            }
            *current = Some(intent.clone());
        }
        if let Some(window) = app.get_webview_window("media-sheet") {
            window.emit("tools:sheet", &intent)?;
        } else {
            tauri::WebviewWindowBuilder::new(
                &app,
                "media-sheet",
                tauri::WebviewUrl::App("index.html?media-sheet".into()),
            )
            .title("Nabbit — File tools")
            .inner_size(440., 640.)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .focused(!crate::island::acceptance_session())
            .focusable(!crate::island::acceptance_session())
            .center()
            .build()?;
        }
        Ok(())
    })
    .await
    .map_err(|_| msg("Media review could not open"))?
}
#[tauri::command]
pub fn tool_media_sheet(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, std::sync::Arc<Service>>,
) -> Result<Option<Intent>> {
    if window.label() != "media-sheet" {
        return Err(msg("Not a media review window"));
    }
    Ok(service
        .sheet
        .lock()
        .map_err(|_| msg("Media review unavailable"))?
        .clone())
}
#[tauri::command]
pub fn tool_media_sheet_ready(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, std::sync::Arc<Service>>,
    id: String,
    height: u32,
) -> Result<()> {
    if window.label() != "media-sheet"
        || service
            .sheet
            .lock()
            .map_err(|_| msg("Media review unavailable"))?
            .as_ref()
            .is_none_or(|i| i.id != id)
    {
        return Err(msg("This media review is no longer current"));
    }
    let maximum = window
        .current_monitor()?
        .map(|m| (m.work_area().size.height as f64 / m.scale_factor() - 40.).max(240.) as u32)
        .unwrap_or(720)
        .min(840);
    window.set_size(tauri::LogicalSize::new(
        if service.sheet.lock().ok().is_some_and(|s| {
            s.as_ref().is_some_and(|i| {
                registry_image(&i.tool_id)
                    || matches!(
                        crate::tools::registry::get(&i.tool_id)
                            .map(|t| t.executor_for(Path::new(&i.input))),
                        Ok(crate::tools::registry::Executor::Image(_))
                    )
            })
        }) {
            460.
        } else {
            440.
        },
        f64::from(height.clamp(200, maximum)),
    ))?;
    window.show()?;
    if !crate::island::acceptance_session() {
        window.set_focus()?;
    }
    let _ = app;
    Ok(())
}
#[tauri::command]
pub fn tool_close_media_sheet(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, std::sync::Arc<Service>>,
    id: String,
) -> Result<()> {
    if window.label() != "media-sheet" {
        return Err(msg("Not a media review window"));
    }
    let mut current = service
        .sheet
        .lock()
        .map_err(|_| msg("Media review unavailable"))?;
    if current.as_ref().is_some_and(|i| i.id == id) {
        *current = None;
        window.hide()?;
    }
    Ok(())
}
#[tauri::command]
pub async fn tool_media_inspect(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    path: String,
) -> Result<Info> {
    crate::tools::commands::caller(&app, &window)?;
    let dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        inspect(
            &crate::download::ffmpeg::verified(&dir)?,
            Path::new(&path),
            &AtomicBool::new(false),
        )
    })
    .await
    .map_err(|_| msg("Media inspection stopped"))?
}
#[tauri::command]
pub async fn tool_media_capabilities(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    probe_gpu: bool,
) -> Result<gpu::Capabilities> {
    crate::tools::commands::caller(&app, &window)?;
    let dir = state.app_data_dir.clone();
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        gpu::capabilities(
            &crate::download::ffmpeg::verified(&dir)?,
            &db,
            probe_gpu,
            &AtomicBool::new(false),
        )
    })
    .await
    .map_err(|_| msg("Encoder probe stopped"))?
}
#[tauri::command]
pub fn tool_media_estimate(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    info: Info,
    options: Options,
    max_mb: u32,
) -> Result<Plan> {
    crate::tools::commands::caller(&app, &window)?;
    plan(&info, &options, max_mb, None)
}

fn registry_image(id: &str) -> bool {
    crate::tools::registry::get(id).is_ok_and(|t| t.category == "images")
}
