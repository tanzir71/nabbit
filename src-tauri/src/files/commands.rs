use super::*;
use tauri::{Emitter, Manager};
fn caller(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<()> {
    if window.label() == "main" {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let manager = app
            .try_state::<Arc<crate::island::Manager>>()
            .ok_or_else(|| msg("Island unavailable"))?;
        if !manager.file_surface_active(window.label()) {
            return Err(msg("Open the island to use files"));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err(msg("Files are unavailable on this surface"))
    }
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| msg("File task stopped"))?
}
#[tauri::command]
pub fn files_drop_status(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<usize> {
    caller(&app, &window)?;
    #[cfg(windows)]
    {
        Ok(super::drop::count(window.label()))
    }
    #[cfg(not(windows))]
    {
        Ok(0)
    }
}
#[tauri::command]
pub async fn files_fixture_drop(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    request: DropFixture,
) -> Result<()> {
    let DropFixture {
        path,
        kind,
        x,
        y,
        modifiers,
    } = request;
    caller(&app, &window)?;
    if !crate::island::acceptance_session() || !crate::sticky::acceptance_enabled() {
        return Err(msg("Drag fixture is disabled"));
    }
    if !(0..=5760).contains(&x) || !(0..=3680).contains(&y) {
        return Err(msg("Fixture position is outside the owned viewport"));
    }
    let root = service.directory.clone();
    #[cfg(windows)]
    let owner = window.hwnd()?.0 as isize;
    #[cfg(not(windows))]
    let owner = 0;
    let event = blocking(move || {
        Owned { root }.guard(&path)?;
        #[cfg(windows)]
        {
            super::drop::fixture_event(path, kind, x, y, modifiers, owner)
        }
        #[cfg(not(windows))]
        {
            let _ = (path, kind, x, y, modifiers, owner);
            Err::<serde_json::Value, _>(msg("Native drag fixture is available on Windows"))
        }
    })
    .await?;
    app.emit_to(window.label(), "nabbit://native-drop", event)?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DropFixture {
    path: String,
    kind: String,
    x: i32,
    y: i32,
    modifiers: Modifiers,
}
#[tauri::command]
pub async fn files_pins(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Vec<PinView>> {
    caller(&app, &window)?;
    let db = service.db.clone();
    blocking(move || list(&db)).await
}
#[tauri::command]
pub async fn files_save_pin(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    draft: PinDraft,
) -> Result<String> {
    caller(&app, &window)?;
    let db = service.db.clone();
    let id = blocking(move || save(&db, draft)).await?;
    app.emit("pins:changed", ())?;
    Ok(id)
}
#[tauri::command]
pub fn files_remove_pin(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    id: String,
) -> Result<()> {
    caller(&app, &window)?;
    remove(&service.db, &id)?;
    service.watches.close(window.label(), None);
    app.emit("pins:changed", ())?;
    Ok(())
}
#[tauri::command]
pub async fn files_choose(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    folder: bool,
) -> Result<Option<String>> {
    caller(&app, &window)?;
    if crate::island::acceptance_session() {
        return Err(msg("Native picker is disabled in acceptance"));
    }
    blocking(move || native::choose(folder)).await
}
#[tauri::command]
pub async fn files_capabilities(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<serde_json::Value> {
    caller(&app, &window)?;
    blocking(move||{
    if crate::island::acceptance_session(){return Ok(serde_json::json!({"folders":[],"terminal":false,"code":false}));}
    let (terminal,code)=native::applications();Ok(serde_json::json!({"folders":native::known_folders()?,"terminal":terminal.is_some(),"code":code.is_some()}))
}).await
}
#[tauri::command]
pub async fn files_download_info(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    id: String,
) -> Result<serde_json::Value> {
    caller(&app, &window)?;
    let db = service.db.clone();
    blocking(move||{let job=db.get_download(&id)?;if job.status!="completed" {return Err(msg("This download is not finished"));}let path=job.output_path.ok_or_else(||msg("The download has no file path"))?;let facts=paths::facts(&path)?;
        Ok(serde_json::json!({"path":facts.path,"bytes":facts.bytes,"site":url::Url::parse(&job.url).ok().and_then(|url|url.host_str().map(str::to_owned)).map(|host|host.trim_start_matches("www.").to_owned())}))
    }).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRequest {
    pub paths: Vec<String>,
    pub destination: Option<String>,
    pub pin_id: Option<String>,
    #[serde(default)]
    pub modifiers: Modifiers,
    pub site: Option<String>,
}
#[tauri::command]
pub async fn files_plan(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    request: PlanRequest,
) -> Result<Operation> {
    caller(&app, &window)?;
    let service = service.inner().clone();
    blocking(move || {
        let (destination, always) = if let Some(id) = request.pin_id {
            let pin = service.db.pin_target(Some(&id), None)?;
            if pin.kind != "folder" {
                return Err(msg("Drop on a folder pin"));
            }
            (pin.path, always_move(&service.db, &id)?)
        } else {
            (
                request
                    .destination
                    .ok_or_else(|| msg("Choose a destination folder"))?,
                false,
            )
        };
        service.prepare(
            request.paths,
            destination,
            request.modifiers,
            always,
            request.site,
        )
    })
    .await
}
#[tauri::command]
pub async fn files_hints(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    paths: Vec<String>,
    modifiers: Modifiers,
) -> Result<serde_json::Value> {
    caller(&app, &window)?;
    let db = service.db.clone();
    blocking(move || {
        if paths.len() > 256 {
            return Err(msg("Too many files"));
        }
        let sources = paths
            .iter()
            .map(|p| paths::facts(p))
            .collect::<Result<Vec<_>>>()?;
        let mut hints = std::collections::HashMap::new();
        for pin in list(&db)?
            .into_iter()
            .filter(|p| p.pin.kind == "folder" && p.available)
        {
            let destination = paths::facts(&pin.pin.path)?;
            let verbs: Vec<_> = sources
                .iter()
                .map(|s| verb(s, &destination, &modifiers, pin.always_move))
                .collect();
            hints.insert(
                pin.pin.id,
                if verbs.is_empty() {
                    "Drop here"
                } else if verbs.iter().all(|v| *v == Verb::Move) {
                    "Move here"
                } else if verbs.iter().all(|v| *v == Verb::Copy) {
                    if modifiers.ctrl {
                        "Copy here"
                    } else {
                        "Copy · other drive"
                    }
                } else {
                    "Move / copy"
                },
            );
        }
        Ok(serde_json::json!(hints))
    })
    .await
}
fn changed(app: &tauri::AppHandle, operation: &Operation) {
    if let Some(tools) = app.try_state::<Arc<crate::tools::Service>>() {
        match tools.reload_locations() {
            Ok(ids) => {
                if !ids.is_empty() {
                    let _ = app.emit("tools:changed", ());
                    for id in ids {
                        crate::island::activity_bus::publish(
                            app,
                            crate::island::activity::ActivityEvent::Dismissed {
                                id: format!("toolResult:{id}"),
                            },
                        );
                    }
                }
            }
            Err(error) => {
                let _ = app.emit("capture:error", error.to_string());
            }
        }
    }
    let _ = app.emit("files:changed", ());
    let _ = app.emit("shelf:changed", ());
    let _ = app.emit("pins:changed", ());
    let done: Vec<_> = operation
        .entries
        .iter()
        .filter(|e| e.output.is_some() && !e.undone)
        .collect();
    if !done.is_empty() {
        crate::island::activity_bus::publish(
            app,
            crate::island::activity::ActivityEvent::FilesMoved {
                op_id: operation.id.clone(),
                count: done.len() as u32,
                destination: operation.destination.path.clone(),
                verb: if done.iter().all(|e| e.verb == Verb::Copy) {
                    crate::island::activity::MoveVerb::Copied
                } else {
                    crate::island::activity::MoveVerb::Moved
                },
                undoable: done.iter().all(|e| e.fingerprint.is_some()),
            },
        );
    } else {
        crate::island::activity_bus::publish(
            app,
            crate::island::activity::ActivityEvent::Dismissed {
                id: format!("files:{}", operation.id),
            },
        );
    }
}
pub fn undo_from_native(app: tauri::AppHandle, id: String, owner: isize) -> Result<()> {
    let service = app.state::<Arc<Service>>().inner().clone();
    let root = service.directory.clone();
    let _lease = service.lease();
    let operation = crate::shell::run(move || {
        if crate::island::acceptance_session() {
            service.undo(&id, &Owned { root })
        } else {
            service.undo(&id, &native::Native { owner })
        }
    })?;
    changed(&app, &operation);
    Ok(())
}
#[tauri::command]
pub async fn files_execute(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    id: String,
    confirmed: bool,
) -> Result<Operation> {
    caller(&app, &window)?;
    let service = service.inner().clone();
    let root = service.directory.clone();
    let lease = service.lease();
    #[cfg(windows)]
    let owner = window.hwnd()?.0 as isize;
    #[cfg(not(windows))]
    let owner = 0;
    let operation = blocking(move || {
        let _lease = lease;
        crate::shell::run(move || {
            if crate::island::acceptance_session() {
                service.execute(&id, confirmed, &Owned { root })
            } else {
                service.execute(&id, confirmed, &native::Native { owner })
            }
        })
    })
    .await?;
    changed(&app, &operation);
    Ok(operation)
}
#[tauri::command]
pub async fn files_undo(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    id: String,
) -> Result<Operation> {
    caller(&app, &window)?;
    let service = service.inner().clone();
    let root = service.directory.clone();
    let lease = service.lease();
    #[cfg(windows)]
    let owner = window.hwnd()?.0 as isize;
    #[cfg(not(windows))]
    let owner = 0;
    let operation = blocking(move || {
        let _lease = lease;
        crate::shell::run(move || {
            if crate::island::acceptance_session() {
                service.undo(&id, &Owned { root })
            } else {
                service.undo(&id, &native::Native { owner })
            }
        })
    })
    .await?;
    changed(&app, &operation);
    Ok(operation)
}
#[tauri::command]
pub async fn files_history(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Vec<Operation>> {
    caller(&app, &window)?;
    let service = service.inner().clone();
    blocking(move || service.history()).await
}
#[tauri::command]
pub async fn files_suggestions(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    paths: Vec<String>,
    site: Option<String>,
) -> Result<Vec<String>> {
    caller(&app, &window)?;
    let service = service.inner().clone();
    blocking(move || service.suggestions(&paths, site.as_deref())).await
}
#[tauri::command]
pub async fn files_peek_open(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    id: String,
) -> Result<watch::Peek> {
    caller(&app, &window)?;
    let service = service.inner().clone();
    let owner = window.label().to_owned();
    let events = app.clone();
    let target = owner.clone();
    blocking(move || {
        let pin = service.db.pin_target(Some(&id), None)?;
        service.watches.open(
            &owner,
            pin.path,
            Arc::new(move |token| {
                let _ = events.emit_to(target.as_str(), "pins:peek-changed", token);
            }),
        )
    })
    .await
}
#[tauri::command]
pub async fn files_peek_items(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    token: String,
) -> Result<Vec<watch::Recent>> {
    caller(&app, &window)?;
    let service = service.inner().clone();
    let owner = window.label().to_owned();
    blocking(move || service.watches.read(&owner, &token)).await
}
#[tauri::command]
pub fn files_peek_close(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    token: String,
) {
    service.watches.close(window.label(), Some(&token));
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinTarget {
    pub id: Option<String>,
    pub token: Option<String>,
    pub path: Option<String>,
}
fn target(service: &Service, owner: &str, target: PinTarget) -> Result<String> {
    match (target.id, target.token, target.path) {
        (Some(id), None, None) => {
            let pin = service.db.pin_target(Some(&id), None)?;
            let facts = paths::facts(&pin.path)?;
            if facts.directory != (pin.kind == "folder") {
                return Err(msg("The pin changed"));
            }
            Ok(pin.path)
        }
        (None, Some(token), Some(path)) => Ok(service.watches.item(owner, &token, &path)?.path),
        _ => Err(msg("Choose a pin or a visible recent item")),
    }
}
#[tauri::command]
pub async fn files_pin_action(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    target: PinTarget,
    action: String,
) -> Result<()> {
    caller(&app, &window)?;
    let service = service.inner().clone();
    let owner = window.label().to_owned();
    blocking(move || {
        let path = target_path(&service, &owner, target)?;
        if !matches!(
            action.as_str(),
            "open" | "reveal" | "copy" | "openWith" | "terminal" | "code"
        ) {
            return Err(msg("Unknown pin action"));
        }
        if crate::island::acceptance_session() {
            Owned {
                root: service.directory.clone(),
            }
            .guard(&path)?;
            app.emit(
                "pins:action",
                serde_json::json!({"path":path,"action":action,"injected":true}),
            )?;
            return Ok(());
        }
        if action == "copy" {
            arboard::Clipboard::new()
                .map_err(|_| msg("Clipboard unavailable"))?
                .set_text(path)
                .map_err(|_| msg("Could not copy the path"))
        } else {
            native::action(path, action)
        }
    })
    .await
}
fn target_path(service: &Service, owner: &str, value: PinTarget) -> Result<String> {
    target(service, owner, value)
}
#[tauri::command]
pub async fn files_drag_plan(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    target: PinTarget,
) -> Result<crate::shelf::DragPlan> {
    caller(&app, &window)?;
    let service = service.inner().clone();
    let owner = window.label().to_owned();
    blocking(move || {
        use base64::Engine;
        let path = target_path(&service, &owner, target)?;
        Ok(crate::shelf::DragPlan {
            item: vec![path],
            icon: format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD
                    .encode(include_bytes!("../../icons/32x32.png"))
            ),
            mode: "copy",
        })
    })
    .await
}
#[tauri::command]
pub async fn files_thumbnail(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<Service>>,
    target: PinTarget,
) -> Result<Option<String>> {
    caller(&app, &window)?;
    let service = service.inner().clone();
    let owner = window.label().to_owned();
    blocking(move || native::thumbnail(target_path(&service, &owner, target)?)).await
}

/// Acceptance adapters only touch canonical paths inside this unique app-data root.
pub struct Owned {
    pub root: std::path::PathBuf,
}
impl Owned {
    pub fn guard(&self, path: &str) -> Result<()> {
        let path = std::fs::canonicalize(paths::checked(path)?)?;
        if path.starts_with(self.root.canonicalize()?) {
            Ok(())
        } else {
            Err(msg("Acceptance requires an owned file fixture"))
        }
    }
}
impl Backend for Owned {
    fn transfer(
        &self,
        source: &str,
        destination: &str,
        name: Option<&str>,
        verb: Verb,
    ) -> Result<Option<String>> {
        self.guard(source)?;
        self.guard(destination)?;
        let source = paths::checked(source)?;
        let name = name
            .map(str::to_owned)
            .unwrap_or_else(|| source.file_name().unwrap().to_string_lossy().into());
        let mut output = paths::checked(destination)?.join(&name);
        let file = Path::new(&name);
        for index in 2..10000 {
            if !output.exists() {
                break;
            }
            output = paths::checked(destination)?.join(format!(
                "{} {index}{}",
                file.file_stem().unwrap().to_string_lossy(),
                file.extension()
                    .map(|s| format!(".{}", s.to_string_lossy()))
                    .unwrap_or_default()
            ));
        }
        let mut input = std::fs::File::open(&source)?;
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)?;
        std::io::copy(&mut input, &mut out)?;
        out.sync_all()?;
        crate::tools::files::dates(&input, &output)?;
        drop(out);
        drop(input);
        if verb == Verb::Move {
            std::fs::remove_file(source)?;
        }
        Ok(Some(paths::display(&output)))
    }
    fn fingerprint(&self, path: &str) -> Result<Fingerprint> {
        self.guard(path)?;
        native::Native { owner: 0 }.fingerprint(path)
    }
    fn recycle(&self, path: &str) -> Result<()> {
        self.guard(path)?;
        let folder = self.root.join("file-recycle-fixture");
        std::fs::create_dir_all(&folder)?;
        let from = paths::checked(path)?;
        let to = folder.join(uuid::Uuid::new_v4().to_string());
        std::fs::hard_link(&from, to)?;
        std::fs::remove_file(from)?;
        Ok(())
    }
}
