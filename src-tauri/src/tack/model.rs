//! Public DTOs contain no session cookie, CSRF token or retained password.
pub use crate::island::activity::SyncStatus;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct User {
    pub id: String,
    pub username: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub role: String,
    #[serde(default)]
    pub display_name: String,
    pub user_id: String,
    #[serde(default)]
    pub session_epoch: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub checked: bool,
    pub base_url: Option<String>,
    pub user: Option<User>,
    pub workspace: Option<Workspace>,
    pub workspaces: Vec<Workspace>,
    pub recovery_pending: bool,
    pub requires_login: bool,
    pub ready: bool,
    pub error: Option<Error>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    InvalidServer,
    InvalidResponse,
    InvalidInput,
    SecureStorage,
    LocalStorage,
    SignedOut,
    WorkspaceChanged,
    StorageFull,
    RecoveryPending,
    RateLimited,
    Conflict,
    Offline,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Error {
    pub code: ErrorCode,
    pub state: SyncStatus,
    pub http_status: Option<u16>,
    pub retry_after_ms: Option<u64>,
}
impl Error {
    pub fn new(code: ErrorCode) -> Self {
        let state = match code {
            ErrorCode::InvalidServer | ErrorCode::InvalidInput => SyncStatus::LocalOnly,
            ErrorCode::SecureStorage | ErrorCode::SignedOut => SyncStatus::SignedOut,
            ErrorCode::WorkspaceChanged => SyncStatus::WorkspaceChanged,
            ErrorCode::StorageFull => SyncStatus::StorageFull,
            ErrorCode::RecoveryPending => SyncStatus::RecoveryPending,
            ErrorCode::RateLimited => SyncStatus::RateLimited,
            ErrorCode::Conflict => SyncStatus::Conflict,
            ErrorCode::Offline | ErrorCode::InvalidResponse | ErrorCode::LocalStorage => {
                SyncStatus::Offline
            }
        };
        Self {
            code,
            state,
            http_status: None,
            retry_after_ms: None,
        }
    }
    pub fn message(&self) -> &'static str {
        match self.code {
            ErrorCode::InvalidServer => "Enter an HTTPS Tack installation URL without a username, password, query or fragment.",
            ErrorCode::InvalidResponse => "This server did not return a supported Tack response.",
            ErrorCode::InvalidInput => "Check the requested Tack action and try again.",
            ErrorCode::SecureStorage => "The Tack session could not be read or saved in secure storage.",
            ErrorCode::LocalStorage => "Notes could not be saved on this device. Queued changes are preserved; try again.",
            ErrorCode::SignedOut => "Sign in to Tack to continue. Your local notes are preserved.",
            ErrorCode::WorkspaceChanged => "The Tack workspace changed. Check the selected workspace before continuing.",
            ErrorCode::StorageFull => "This Tack workspace is full. Export or remove unused attachments in Tack.",
            ErrorCode::RecoveryPending => "Save and confirm the current Tack recovery code before syncing.",
            ErrorCode::RateLimited => "Tack has limited sign-in or sync attempts. Wait before trying again.",
            ErrorCode::Conflict => "This Tack action conflicts with a newer change.",
            ErrorCode::Offline => "Tack is unavailable. Local changes stay on this device.",
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

impl From<crate::error::NabbitError> for Error {
    fn from(error: crate::error::NabbitError) -> Self {
        let code = match &error {
            crate::error::NabbitError::Message(s) if s.starts_with("WorkspaceChanged:") => {
                ErrorCode::WorkspaceChanged
            }
            crate::error::NabbitError::Message(s) if s.starts_with("InvalidResponse:") => {
                ErrorCode::InvalidResponse
            }
            crate::error::NabbitError::Message(s) if s.starts_with("Conflict:") => {
                ErrorCode::Conflict
            }
            crate::error::NabbitError::Message(s) if s.starts_with("StorageFull:") => {
                ErrorCode::StorageFull
            }
            _ => ErrorCode::LocalStorage,
        };
        Self::new(code)
    }
}
pub use crate::notes::sync_store::{Conflict, Context, Identity, Resolution};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnapshot {
    pub state: SyncStatus,
    pub scope: Option<Context>,
    pub pending: u64,
    pub conflicts: u64,
    pub reference_issues: u64,
    pub last_synced: Option<String>,
    pub error: Option<Error>,
    pub next_attempt_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mutation {
    pub table: String,
    pub id: String,
    pub base_version: u64,
    pub base_value: Value,
    pub value: Value,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Record {
    pub table: String,
    pub id: String,
    pub version: u64,
    pub value: Value,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReply {
    pub changes: Vec<Record>,
    pub cursor: u64,
    pub more: bool,
    #[serde(default)]
    pub conflicts: Vec<Record>,
    pub user_id: String,
    pub workspace_id: String,
    #[serde(default)]
    pub reference_issues: Vec<Value>,
    #[serde(default)]
    pub access: Option<Value>,
    #[serde(default)]
    pub access_reset: bool,
}
