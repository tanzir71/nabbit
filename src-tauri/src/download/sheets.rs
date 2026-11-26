use crate::{
    db::models::{DownloadJob, DownloadMetadata, DownloadRequest},
    error::{msg, Result},
    AppState,
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Options,
    Trim,
    Playlist,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    pub kind: Kind,
    pub url: String,
    pub options: super::options::DownloadOptions,
    #[serde(default)]
    pub remember: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Intent {
    pub id: String,
    pub draft: Draft,
    pub metadata: Option<DownloadMetadata>,
}
#[derive(Default)]
pub struct Service(pub Mutex<Option<Intent>>);
impl Service {
    fn close_if_current(&self, id: Option<&str>) -> Result<bool> {
        let mut current = self.0.lock().map_err(|_| msg("sheet lock poisoned"))?;
        if id.is_some_and(|id| current.as_ref().is_none_or(|intent| intent.id != id)) {
            return Ok(false);
        }
        *current = None;
        Ok(true)
    }
}

#[tauri::command]
pub fn open_download_sheet(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mut draft: Draft,
) -> Result<()> {
    draft.url = crate::capture::web_url(&draft.url)?;
    draft.options = draft.options.normalized()?;
    let intent = Intent {
        id: uuid::Uuid::new_v4().to_string(),
        metadata: state
            .capture
            .current()
            .filter(|m| m.normalized_url == draft.url && m.extractor.as_deref() != Some("capture")),
        draft,
    };
    *app.state::<Service>()
        .0
        .lock()
        .map_err(|_| msg("sheet lock poisoned"))? = Some(intent.clone());
    if let Some(window) = app.get_webview_window("download-sheet") {
        window.emit("download:sheet", intent)?;
        window.show()?;
        window.set_focus()?;
    } else {
        tauri::WebviewWindowBuilder::new(
            &app,
            "download-sheet",
            tauri::WebviewUrl::App("index.html?download-sheet".into()),
        )
        .title("Nabbit — Download")
        .inner_size(460.0, 680.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .center()
        .build()?;
    }
    Ok(())
}
#[tauri::command]
pub fn get_download_sheet(state: tauri::State<'_, Service>) -> Result<Option<Intent>> {
    Ok(state
        .0
        .lock()
        .map_err(|_| msg("sheet lock poisoned"))?
        .clone())
}
#[tauri::command]
pub fn download_sheet_ready(app: tauri::AppHandle) -> Result<()> {
    if let Some(window) = app.get_webview_window("download-sheet") {
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}
#[tauri::command]
pub fn close_download_sheet(app: tauri::AppHandle, id: Option<String>) -> Result<()> {
    if !app.state::<Service>().close_if_current(id.as_deref())? {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window("download-sheet") {
        window.destroy()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn an_older_enqueue_cannot_close_the_newer_review() {
        let service = Service::default();
        *service.0.lock().unwrap() = Some(Intent {
            id: "newer".into(),
            draft: Draft {
                kind: Kind::Options,
                url: "https://example.invalid/new".into(),
                options: Default::default(),
                remember: false,
            },
            metadata: None,
        });
        assert!(!service.close_if_current(Some("older")).unwrap());
        assert_eq!(service.0.lock().unwrap().as_ref().unwrap().id, "newer");
        assert!(service.close_if_current(Some("newer")).unwrap());
        assert!(service.0.lock().unwrap().is_none());
    }
}
#[tauri::command]
pub async fn start_playlist_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: DownloadRequest,
    indices: Vec<u32>,
) -> Result<Vec<DownloadJob>> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let url = request.url.clone();
        let jobs = state.downloads.enqueue_playlist(request, indices)?;
        crate::capture::download_started(&app, &url);
        Ok(jobs)
    })
    .await
    .map_err(|e| msg(e.to_string()))?
}
#[tauri::command]
pub async fn preview_download_source(url: String, start_ms: u64) -> Result<()> {
    let normalized = crate::capture::web_url(&url)?;
    let mut url = url::Url::parse(&normalized).map_err(|e| msg(e.to_string()))?;
    if super::presets::site_key(&normalized)? == "youtube.com" {
        let pairs: Vec<_> = url
            .query_pairs()
            .filter(|(k, _)| k != "t" && k != "start")
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        url.query_pairs_mut()
            .clear()
            .extend_pairs(pairs)
            .append_pair("t", &(start_ms / 1000).to_string());
    }
    tauri::async_runtime::spawn_blocking(move || open::that(url.as_str()).map_err(Into::into))
        .await
        .map_err(|e| msg(e.to_string()))?
}
