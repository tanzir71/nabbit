use super::*;
use tauri::Emitter;
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub info: Option<Info>,
    pub error: Option<String>,
    pub codec_required: bool,
}
#[tauri::command]
pub async fn tool_image_inspect(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    path: String,
) -> Result<Inspection> {
    crate::tools::commands::caller(&app, &window)?;
    let dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let engine = crate::download::ffmpeg::verified(&dir).unwrap_or_default();
        Ok(
            match inspect(&engine, Path::new(&path), &AtomicBool::new(false)) {
                Ok(info) => Inspection {
                    info: Some(info),
                    error: None,
                    codec_required: false,
                },
                Err(error) => Inspection {
                    info: None,
                    error: Some(error.to_string()),
                    codec_required: matches!(format(Path::new(&path)).as_str(), "heic" | "heif"),
                },
            },
        )
    })
    .await
    .map_err(|_| msg("Image inspection stopped"))?
}
pub fn store_url(codec: &str) -> Result<&'static str> {
    match codec {
        "heif" => Ok("https://apps.microsoft.com/detail/9PMMSR1CGPWG"),
        "hevc" => Ok("https://apps.microsoft.com/detail/9NMZLZ57R3T7"),
        _ => Err(msg("Unknown image codec")),
    }
}
#[tauri::command]
pub async fn tool_image_codec(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    codec: String,
) -> Result<()> {
    crate::tools::commands::caller(&app, &window)?;
    let url = store_url(&codec)?;
    if crate::island::acceptance_session() {
        app.emit(
            "tools:codec",
            serde_json::json!({"url":url,"injected":true}),
        )?;
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::shell::run(move || open::that(url).map_err(Into::into))
    })
    .await
    .map_err(|_| msg("The Store page could not open"))?
}
