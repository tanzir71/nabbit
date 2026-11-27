//! No network or credential access until an explicit command connects.
use super::{
    client::{Client, LoginReply},
    endpoint::Endpoint,
    model::{Connection, Error, ErrorCode, Result},
    session::{KeyringVault, Password, RecoveryCode},
};
use std::sync::{Arc, Mutex};

#[derive(Default, Clone)]
pub struct Service(Arc<Mutex<Option<Client>>>);
impl Service {
    pub fn status(&self, base_url: &str) -> Result<Connection> {
        let endpoint = Endpoint::new(base_url)?;
        let mut slot = self.0.lock().map_err(|_| Error::new(ErrorCode::Offline))?;
        if slot
            .as_ref()
            .is_none_or(|c| c.endpoint().base() != endpoint.base())
        {
            *slot = Some(Client::new(endpoint, Arc::new(KeyringVault))?);
        }
        slot.as_mut()
            .ok_or_else(|| Error::new(ErrorCode::SignedOut))?
            .status()
    }
    pub fn snapshot(&self) -> Result<Connection> {
        Ok(self
            .0
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?
            .as_ref()
            .map(Client::snapshot)
            .unwrap_or_default())
    }
    fn with<T>(&self, action: impl FnOnce(&mut Client) -> Result<T>) -> Result<T> {
        action(
            self.0
                .lock()
                .map_err(|_| Error::new(ErrorCode::Offline))?
                .as_mut()
                .ok_or_else(|| Error::new(ErrorCode::SignedOut))?,
        )
    }
    pub fn login(&self, username: &str, password: Password) -> Result<LoginReply> {
        self.with(|c| c.login(username, password))
    }
    pub fn confirm(&self, code: String) -> Result<Connection> {
        self.with(|c| c.confirm_recovery(RecoveryCode::new(code)))
    }
    pub fn switch(&self, id: &str) -> Result<Connection> {
        self.with(|c| c.switch_workspace(id))
    }
    pub fn logout(&self) -> Result<Connection> {
        self.with(Client::logout)
    }
}
