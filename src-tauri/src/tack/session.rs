//! Only the filtered session cookie and CSRF token enter secure storage.
use super::model::{Error, ErrorCode, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub service: String,
    pub account: String,
}
impl Scope {
    pub fn for_url(base: &Url) -> Self {
        // Separate installations/ports on one host must never share a session.
        Self {
            service: format!("Nabbit/Tack/{}", base.host_str().unwrap_or_default()),
            account: format!("session:{:x}", Sha256::digest(base.as_str().as_bytes())),
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Secrets {
    pub(crate) cookie: String,
    pub(crate) csrf: String,
}
impl std::fmt::Debug for Secrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TackSession([redacted])")
    }
}
impl Drop for Secrets {
    fn drop(&mut self) {
        self.cookie.zeroize();
        self.csrf.zeroize();
    }
}
impl Secrets {
    pub(crate) fn encode(&self) -> Result<Zeroizing<Vec<u8>>> {
        let raw = serde_json::to_vec(self).map_err(|_| Error::new(ErrorCode::SecureStorage))?;
        if raw.len() > 2400 {
            return Err(Error::new(ErrorCode::SecureStorage));
        }
        Ok(Zeroizing::new(raw))
    }
    pub(crate) fn decode(raw: &[u8]) -> Result<Self> {
        if raw.len() > 2400 {
            return Err(Error::new(ErrorCode::SecureStorage));
        }
        serde_json::from_slice(raw).map_err(|_| Error::new(ErrorCode::SecureStorage))
    }
}

/// Inject a memory/failing vault in tests; production always uses KeyringVault.
pub trait Vault: Send + Sync {
    fn load(&self, scope: &Scope) -> Result<Option<Secrets>>;
    fn save(&self, scope: &Scope, secrets: &Secrets) -> Result<()>;
    fn clear(&self, scope: &Scope) -> Result<()>;
}

#[derive(Default)]
pub struct KeyringVault;
#[cfg(windows)]
impl KeyringVault {
    fn entry(scope: &Scope) -> Result<keyring::Entry> {
        keyring::Entry::new(&scope.service, &scope.account)
            .map_err(|_| Error::new(ErrorCode::SecureStorage))
    }
}
#[cfg(windows)]
impl Vault for KeyringVault {
    fn load(&self, scope: &Scope) -> Result<Option<Secrets>> {
        match Self::entry(scope)?.get_secret() {
            Ok(raw) => Secrets::decode(&Zeroizing::new(raw)).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(Error::new(ErrorCode::SecureStorage)),
        }
    }
    fn save(&self, scope: &Scope, secrets: &Secrets) -> Result<()> {
        Self::entry(scope)?
            .set_secret(&secrets.encode()?)
            .map_err(|_| Error::new(ErrorCode::SecureStorage))
    }
    fn clear(&self, scope: &Scope) -> Result<()> {
        match Self::entry(scope)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(Error::new(ErrorCode::SecureStorage)),
        }
    }
}
#[cfg(not(windows))]
impl Vault for KeyringVault {
    fn load(&self, _: &Scope) -> Result<Option<Secrets>> {
        Err(Error::new(ErrorCode::SecureStorage))
    }
    fn save(&self, _: &Scope, _: &Secrets) -> Result<()> {
        Err(Error::new(ErrorCode::SecureStorage))
    }
    fn clear(&self, _: &Scope) -> Result<()> {
        Err(Error::new(ErrorCode::SecureStorage))
    }
}

/// Credentials are request-scoped, zeroized on drop and redacted by Debug.
pub struct Password(Zeroizing<String>);
impl Password {
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
    pub(crate) fn value(&self) -> &str {
        &self.0
    }
}
impl std::fmt::Debug for Password {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Password([redacted])")
    }
}

/// The code may be serialized once for the explicit recovery dialog; not saved.
pub struct RecoveryCode(Zeroizing<String>);
impl RecoveryCode {
    pub(crate) fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
    pub fn value(&self) -> &str {
        &self.0
    }
}
impl Serialize for RecoveryCode {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(self.value())
    }
}
impl std::fmt::Debug for RecoveryCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RecoveryCode([redacted])")
    }
}
