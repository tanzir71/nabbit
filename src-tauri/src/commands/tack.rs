use crate::tack::{
    client::LoginReply,
    model::{Connection, Error, ErrorCode, Result},
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
