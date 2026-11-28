use super::*;
#[tauri::command]
pub async fn tool_pdf_pages(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<u32> {
    crate::tools::commands::caller(&app, &window)?;
    tauri::async_runtime::spawn_blocking(move || {
        page_count(Path::new(&path), &AtomicBool::new(false))
    })
    .await
    .map_err(|_| msg("PDF inspection stopped"))?
}
