use crate::tack::{
    client::LoginReply,
    model::{Conflict, Connection, Context, Error, ErrorCode, Resolution, Result, SyncSnapshot},
    service::Service,
    session::Password,
};

async fn blocking<T: Send + 'static>(
    action: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(action)
        .await
        .map_err(|_| Error::new(ErrorCode::Offline))?
}
#[tauri::command]
pub async fn tack_status(
    service: tauri::State<'_, Service>,
    base_url: String,
) -> Result<Connection> {
    let service = service.inner().clone();
    blocking(move || service.status(&base_url)).await
}
#[tauri::command]
pub async fn tack_snapshot(service: tauri::State<'_, Service>) -> Result<Connection> {
    let service = service.inner().clone();
    blocking(move || service.snapshot()).await
}
#[tauri::command]
pub async fn tack_login(
    service: tauri::State<'_, Service>,
    username: String,
    password: String,
) -> Result<LoginReply> {
    let service = service.inner().clone();
    let password = Password::new(password);
    blocking(move || service.login(&username, password)).await
}
#[tauri::command]
pub async fn tack_confirm_recovery(
    service: tauri::State<'_, Service>,
    code: String,
) -> Result<Connection> {
    let service = service.inner().clone();
    blocking(move || service.confirm(code)).await
}
#[tauri::command]
pub async fn tack_switch_workspace(
    service: tauri::State<'_, Service>,
    id: String,
) -> Result<Connection> {
    let service = service.inner().clone();
    blocking(move || service.switch(&id)).await
}
#[tauri::command]
pub async fn tack_logout(service: tauri::State<'_, Service>) -> Result<Connection> {
    let service = service.inner().clone();
    blocking(move || service.logout()).await
}

#[tauri::command]
pub fn tack_sync_snapshot(service: tauri::State<'_, Service>) -> Result<SyncSnapshot> {
    service.sync_snapshot()
}
#[tauri::command]
pub fn tack_sync_now(service: tauri::State<'_, Service>) -> Result<SyncSnapshot> {
    service.request_sync();
    service.sync_snapshot()
}
#[tauri::command]
pub async fn tack_conflicts(
    service: tauri::State<'_, Service>,
    scope: Context,
) -> Result<Vec<Conflict>> {
    let service = service.inner().clone();
    blocking(move || service.conflicts(&scope)).await
}
#[tauri::command]
pub async fn tack_resolve_conflict(
    service: tauri::State<'_, Service>,
    scope: Context,
    table: String,
    id: String,
    token: String,
    remote_version: u64,
    choice: Resolution,
) -> Result<()> {
    let service = service.inner().clone();
    blocking(move || service.resolve(&scope, &table, &id, &token, remote_version, choice)).await
}
#[tauri::command]
pub async fn tack_upload_local_notes(
    service: tauri::State<'_, Service>,
    scope: Context,
) -> Result<usize> {
    let service = service.inner().clone();
    blocking(move || service.upload_local(&scope)).await
}
#[tauri::command]
pub async fn tack_local_mode(service: tauri::State<'_, Service>) -> Result<()> {
    let service = service.inner().clone();
    blocking(move || service.local_mode()).await
}
