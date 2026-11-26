//! Opt-in fixture providers and file RPC for an isolated, owned acceptance process.
use crate::{
    db::models::{DownloadJob, DownloadMetadata, DownloadRequest},
    error::{msg, Result},
    AppState,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path, time::Instant};
use tauri::{Emitter, Manager};

pub fn fake() -> bool {
    std::env::var_os("NABBIT_ACCEPTANCE_FAKE_DOWNLOAD").is_some()
}
pub fn enabled() -> bool {
    fake()
        && std::env::var("NABBIT_DOWNLOAD_ACCEPTANCE").as_deref() == Ok("1")
        && std::env::var_os("NABBIT_APP_DATA_DIR").is_some()
        && std::env::var_os("NABBIT_ACCEPTANCE_COMMAND_DIR").is_some()
}
pub fn injected_clipboard() -> bool {
    enabled() && std::env::var("NABBIT_ACCEPTANCE_CLIPBOARD_PROVIDER").as_deref() == Ok("1")
}
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    metadata: HashMap<String, DownloadMetadata>,
    failures: HashMap<String, Vec<String>>,
    hold_at62: Vec<String>,
    online_urls: Vec<String>,
}
fn fixture() -> Result<Fixture> {
    if !enabled() {
        return Ok(Fixture::default());
    }
    let Some(path) = std::env::var_os("NABBIT_ACCEPTANCE_DOWNLOAD_FIXTURE") else {
        return Ok(Fixture::default());
    };
    let path = Path::new(&path);
    if std::fs::metadata(path)?.len() > 2 * 1024 * 1024 {
        return Err(msg("Acceptance fixture is too large."));
    }
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
pub fn metadata(url: &str) -> Result<DownloadMetadata> {
    let normalized = crate::capture::web_url(url)?;
    if let Some(mut metadata) = fixture()?.metadata.remove(&normalized) {
        metadata.url.clone_from(&normalized);
        metadata.normalized_url = normalized;
        return Ok(metadata);
    }
    Ok(DownloadMetadata {
        url: normalized.clone(),
        normalized_url: normalized.clone(),
        title: format!("Acceptance download {normalized}"),
        channel: None,
        duration: None,
        thumbnail: None,
        is_playlist: normalized.contains("list="),
        playlist_count: None,
        extractor: Some("acceptance".into()),
        qualities: vec![],
        details: None,
        live_pending: None,
    })
}
pub fn failure(url: &str, attempt: u32) -> Result<Option<String>> {
    Ok(fixture()?
        .failures
        .get(url)
        .and_then(|errors| {
            attempt
                .checked_sub(1)
                .and_then(|index| errors.get(index as usize))
        })
        .cloned())
}
pub fn held(url: &str) -> Result<bool> {
    if !fixture()?.hold_at62.iter().any(|entry| entry == url) {
        return Ok(false);
    }
    Ok(!std::env::var_os("NABBIT_ACCEPTANCE_COMMAND_DIR")
        .map(|dir| Path::new(&dir).join("release-downloads").exists())
        .unwrap_or(false))
}
pub fn online(url: &str) -> bool {
    fixture().is_ok_and(|fixture| fixture.online_urls.iter().any(|entry| entry == url))
}

#[derive(Deserialize)]
struct Request {
    id: String,
    operation: Operation,
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Operation {
    Snapshot,
    Capture {
        url: String,
    },
    Clipboard {
        text: String,
        source_app: Option<String>,
        #[serde(default)]
        protected: bool,
    },
    DeepLink {
        uri: String,
    },
    Hotkey {
        text: String,
    },
    Start {
        request: DownloadRequest,
    },
    Playlist {
        request: DownloadRequest,
        indices: Vec<u32>,
    },
    Control {
        id: String,
        action: String,
    },
    Recover {
        id: String,
        recovery: super::errors::Recovery,
    },
    Preset {
        url: String,
        options: super::options::DownloadOptions,
    },
    Settings {
        patch: serde_json::Value,
    },
    Show,
}
#[derive(Serialize)]
struct Response {
    id: String,
    result: Option<serde_json::Value>,
    error: Option<String>,
}
pub fn process(
    app: &tauri::AppHandle,
    state: &AppState,
    dir: &Path,
    last_clipboard_url: &mut Option<(String, Instant)>,
) {
    if !enabled() {
        return;
    }
    let path = dir.join("downloads-request.json");
    if !path.exists() {
        return;
    }
    let request: Result<Request> = std::fs::read(&path)
        .map_err(Into::into)
        .and_then(|bytes| serde_json::from_slice::<Request>(&bytes).map_err(Into::into));
    let response = match request {
        Ok(request) => match dispatch(app, state, request.operation, last_clipboard_url) {
            Ok(value) => Response {
                id: request.id,
                result: Some(value),
                error: None,
            },
            Err(error) => Response {
                id: request.id,
                result: None,
                error: Some(error.to_string()),
            },
        },
        Err(error) => Response {
            id: String::new(),
            result: None,
            error: Some(format!("Invalid acceptance request: {error}")),
        },
    };
    let _ = std::fs::remove_file(&path);
    let target = dir.join("downloads-response.json");
    let temporary = dir.join("downloads-response.tmp");
    if let Ok(bytes) = serde_json::to_vec(&response) {
        if std::fs::write(&temporary, bytes).is_ok() {
            let _ = std::fs::rename(temporary, target);
        }
    }
}
fn dispatch(
    app: &tauri::AppHandle,
    state: &AppState,
    operation: Operation,
    last_clipboard_url: &mut Option<(String, Instant)>,
) -> Result<serde_json::Value> {
    let value = match operation {
        Operation::Snapshot => {
            serde_json::json!({"jobs":state.db.list_downloads()?,"captured":state.capture.current(),"queue":state.downloads.acceptance_snapshot(),"engine":state.engine.snapshot(),"windows":app.webview_windows().keys().collect::<Vec<_>>() })
        }
        Operation::Capture { url } => serde_json::to_value(crate::capture::review(app, &url)?)?,
        Operation::Clipboard {
            text,
            source_app,
            protected,
        } => {
            crate::clipboard::watcher::injected_event(
                app,
                &state.db,
                &text,
                source_app,
                protected,
                last_clipboard_url,
            );
            serde_json::json!({"captured":state.capture.current(),"jobs":state.db.list_downloads()?})
        }
        Operation::DeepLink { uri } => {
            crate::capture::open_deep_link(app, &uri)?;
            serde_json::Value::Null
        }
        Operation::Hotkey { text } => {
            let job = crate::capture::explicit_hotkey(
                || Ok(text),
                |url| state.downloads.enqueue_remembered(url),
            )?;
            crate::capture::download_started(app, &job.url);
            serde_json::to_value(job)?
        }
        Operation::Start { request } => {
            let job = state.downloads.enqueue(request)?;
            crate::capture::download_started(app, &job.url);
            serde_json::to_value(job)?
        }
        Operation::Playlist { request, indices } => {
            serde_json::to_value(state.downloads.enqueue_playlist(request, indices)?)?
        }
        Operation::Control { id, action } => {
            let job: Option<DownloadJob> = match action.as_str() {
                "pause" => {
                    state.downloads.pause(&id)?;
                    None
                }
                "cancel" => {
                    state.downloads.cancel(&id)?;
                    None
                }
                "resume" => Some(state.downloads.resume(&id)?),
                "retry" => Some(state.downloads.retry(&id)?),
                _ => return Err(msg("Unknown acceptance queue action.")),
            };
            serde_json::to_value(job)?
        }
        Operation::Recover { id, recovery } => {
            serde_json::to_value(state.downloads.recover(&id, recovery)?)?
        }
        Operation::Preset { url, options } => {
            serde_json::to_value(state.db.remember_download_preset(&url, &options)?)?
        }
        Operation::Settings { patch } => {
            let mut value = serde_json::to_value(state.db.get_settings()?)?;
            for (key, entry) in patch
                .as_object()
                .ok_or_else(|| msg("Settings patch must be an object."))?
            {
                value[key] = entry.clone();
            }
            let settings = serde_json::from_value(value)?;
            state.db.save_settings(&settings)?;
            app.emit("settings:updated", &settings)?;
            serde_json::to_value(settings)?
        }
        Operation::Show => {
            crate::show_popover(app)?;
            serde_json::Value::Null
        }
    };
    Ok(value)
}
