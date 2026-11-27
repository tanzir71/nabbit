use crate::{
    error::{msg, Result},
    notes::{
        capture::CaptureRequest,
        links::{
            self,
            service::{Catalog, Preview, PreviewRequest, Service},
            store::{BulkAction, Guard, ImportResult},
        },
        store::StoredNote,
        sync_store::Context,
    },
    AppState,
};
use tauri::{Emitter, Manager};
fn owner(window: &tauri::WebviewWindow) -> Result<String> {
    let name = window.label();
    if name == "main" || name == "settings" || name.starts_with("island") {
        Ok(name.into())
    } else {
        Err(msg("Open Notes or Settings to import bookmarks"))
    }
}
#[tauri::command]
pub async fn bookmarks_discover(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Catalog> {
    let owner = owner(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Service>()
            .discover(&owner, &links::sources::Roots::system())
    })
    .await
    .map_err(|_| msg("Bookmark source scan stopped"))?
}
#[tauri::command]
pub async fn bookmarks_pick_html(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    session_id: String,
) -> Result<Option<Catalog>> {
    let owner = owner(&window)?;
    #[cfg(windows)]
    let hwnd = window.hwnd()?.0 as isize;
    #[cfg(not(windows))]
    let hwnd = 0;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = links::picker::html(hwnd)? else {
            return Ok(None);
        };
        app.state::<Service>()
            .add_html(&owner, &session_id, &path)
            .map(Some)
    })
    .await
    .map_err(|_| msg("Bookmark file selection stopped"))?
}
#[tauri::command]
pub async fn bookmarks_preview(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: PreviewRequest,
) -> Result<Preview> {
    let owner = owner(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Service>()
            .preview(&app.state::<AppState>().db, &owner, request)
    })
    .await
    .map_err(|_| msg("Bookmark preview stopped"))?
}
fn progress(
    app: &tauri::AppHandle,
    id: &str,
    done: usize,
    total: usize,
    state: crate::island::activity::JobState,
) {
    let _ = app.emit(
        "notes:import-progress",
        serde_json::json!({"id":id,"done":done,"total":total,"state":state}),
    );
    crate::island::activity_bus::publish(
        app,
        crate::island::activity::ActivityEvent::ToolJob {
            job_id: format!("bookmark-import-{id}"),
            tool_id: "bookmark-import".into(),
            label: format!("Import bookmarks · {done}/{total}"),
            percent: if total == 0 {
                0.
            } else {
                (done as f64 / total as f64 * 100.).min(99.)
            },
            state,
        },
    );
}
#[tauri::command]
pub async fn bookmarks_commit(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    plan_id: String,
    expected_scope: Option<Context>,
) -> Result<ImportResult> {
    let owner = owner(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        use crate::island::activity::JobState;
        progress(&app, &plan_id, 0, 0, JobState::Running);
        let result = app.state::<Service>().commit(
            &app.state::<AppState>().db,
            &owner,
            &plan_id,
            expected_scope.as_ref(),
            |done, total| progress(&app, &plan_id, done, total, JobState::Running),
        );
        progress(
            &app,
            &plan_id,
            0,
            0,
            if result.is_ok() {
                JobState::Done
            } else {
                JobState::Failed
            },
        );
        if let Ok(result) = &result {
            super::notes::publish(&app);
            if let Some(id) = &result.first_card_id {
                crate::island::activity_bus::publish(
                    &app,
                    crate::island::activity::ActivityEvent::NoteSaved {
                        card_id: id.clone(),
                        destination: if expected_scope.is_some() {
                            "Tack · Links · queued"
                        } else {
                            "this PC · Links"
                        }
                        .into(),
                    },
                );
            }
        }
        result
    })
    .await
    .map_err(|_| msg("Bookmark import stopped; reopen Notes to check recent imports"))?
}
#[tauri::command]
pub fn bookmarks_release(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    session_id: String,
) -> Result<()> {
    app.state::<Service>()
        .release(&owner(&window)?, &session_id)
}
#[tauri::command]
pub fn bookmarks_history(
    state: tauri::State<'_, AppState>,
    expected_scope: Option<Context>,
) -> Result<Vec<ImportResult>> {
    state.db.bookmark_imports(expected_scope.as_ref())
}
#[tauri::command]
pub async fn bookmarks_undo(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    expected_scope: Option<Context>,
) -> Result<usize> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let count = db.undo_bookmark_import(&id, expected_scope.as_ref())?;
        super::notes::publish(&app);
        Ok(count)
    })
    .await
    .map_err(|_| msg("Undo import stopped; reopen Notes to check recent imports"))?
}
#[tauri::command]
pub async fn links_bulk(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    expected_scope: Option<Context>,
    guards: Vec<Guard>,
    action: BulkAction,
) -> Result<usize> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let count = db.bulk_links(expected_scope.as_ref(), &guards, &action)?;
        super::notes::publish(&app);
        Ok(count)
    })
    .await
    .map_err(|_| msg("Updating selected links stopped"))?
}
#[tauri::command]
pub async fn links_open(
    state: tauri::State<'_, AppState>,
    expected_scope: Option<Context>,
    guards: Vec<Guard>,
) -> Result<usize> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let urls = db.selected_link_urls(expected_scope.as_ref(), &guards)?;
        let count = urls.len();
        for url in urls {
            open::that(url).map_err(|_| msg("A link could not be opened"))?;
        }
        Ok(count)
    })
    .await
    .map_err(|_| msg("Opening links stopped"))?
}
#[tauri::command]
pub fn link_clean(url: String) -> Result<String> {
    links::parse::clean_url(&url)
}
#[tauri::command]
pub async fn link_open_url(url: String) -> Result<()> {
    let url = links::parse::web_url(&url)?.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        open::that(url).map_err(|_| msg("The link could not be opened"))
    })
    .await
    .map_err(|_| msg("Opening the link stopped"))?
}
#[tauri::command]
pub async fn save_link(app: tauri::AppHandle, request: CaptureRequest) -> Result<StoredNote> {
    let db = app.state::<AppState>().db.clone();
    let cached = app.state::<AppState>().capture.current();
    tauri::async_runtime::spawn_blocking(move || {
        let request_id = request.request_id.clone();
        let note = links::capture::save(&db, request, cached.as_ref())?;
        super::notes::publish(&app);
        crate::island::activity_bus::publish(
            &app,
            crate::island::activity::ActivityEvent::NoteSaved {
                card_id: note.value["id"].as_str().unwrap_or_default().into(),
                destination: if note.value["id"].as_str() != Some(&request_id) {
                    "Already saved · Links"
                } else if note.scope.is_some() {
                    "Tack · Links · queued"
                } else {
                    "this PC · Links"
                }
                .into(),
            },
        );
        Ok(note)
    })
    .await
    .map_err(|_| msg("Saving the link stopped. Your capture is preserved."))?
}
