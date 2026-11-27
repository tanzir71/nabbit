//! Explicit, serialized Tack API v4 transport. No background sync starts here.
use super::{
    endpoint::Endpoint,
    model::*,
    session::{Password, RecoveryCode, Secrets, Vault},
};
use reqwest::{
    blocking::Client as Http,
    cookie::{CookieStore, Jar},
    header::{HeaderValue, RETRY_AFTER},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::Read,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use url::Url;
use zeroize::{Zeroize, Zeroizing};

const MAX_RESPONSE: u64 = 8 * 1024 * 1024;

struct SessionJar {
    endpoint: Endpoint,
    jar: Jar,
    saved: Mutex<String>,
}
impl SessionJar {
    fn new(endpoint: Endpoint) -> Self {
        Self {
            endpoint,
            jar: Jar::default(),
            saved: Mutex::new(String::new()),
        }
    }
    fn accept(&self, header: &HeaderValue, url: &Url) {
        if !self.endpoint.accepts(url) {
            return;
        }
        let Ok(raw) = header.to_str() else {
            return;
        };
        let Ok(mut cookie) = cookie::Cookie::parse(raw.to_owned()) else {
            return;
        };
        if cookie.name() != "tack_sid"
            || !(16..=128).contains(&cookie.value().len())
            || !cookie
                .value()
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b",-".contains(&c))
            || cookie.http_only() != Some(true)
            || (url.scheme() == "https" && cookie.secure() != Some(true))
            || cookie
                .domain()
                .is_some_and(|d| d.trim_start_matches('.') != url.host_str().unwrap_or_default())
            || cookie.path().unwrap_or("/")
                != self.endpoint.base().path().trim_end_matches('/').to_owned() + "/"
        {
            return;
        }
        // Persist absolute expiry, never restart Max-Age on each app launch.
        if let Some(age) = cookie.max_age() {
            cookie.set_expires(cookie::time::OffsetDateTime::now_utc().saturating_add(age));
            cookie.set_max_age(None);
        }
        let saved = cookie.to_string();
        self.jar.add_cookie_str(&saved, url);
        if let Ok(mut current) = self.saved.lock() {
            current.zeroize();
            *current = saved;
        }
    }
    fn persisted(&self) -> String {
        if self.jar.cookies(&self.endpoint.action("status")).is_none() {
            return String::new();
        }
        self.saved.lock().map(|s| s.clone()).unwrap_or_default()
    }
}
impl Drop for SessionJar {
    fn drop(&mut self) {
        if let Ok(value) = self.saved.get_mut() {
            value.zeroize();
        }
    }
}
impl CookieStore for SessionJar {
    fn set_cookies(&self, headers: &mut dyn Iterator<Item = &HeaderValue>, url: &Url) {
        for header in headers {
            self.accept(header, url);
        }
    }
    fn cookies(&self, url: &Url) -> Option<HeaderValue> {
        if !self.endpoint.accepts(url) {
            return None;
        }
        self.jar.cookies(url).map(|mut h| {
            h.set_sensitive(true);
            h
        })
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoginReply {
    pub connection: Connection,
    pub recovery_code: Option<RecoveryCode>,
}

pub struct Client {
    endpoint: Endpoint,
    http: Http,
    jar: Arc<SessionJar>,
    vault: Arc<dyn Vault>,
    secrets: Secrets,
    connection: Connection,
    retry_at: Option<(Instant, Duration)>,
}
impl Client {
    pub fn new(endpoint: Endpoint, vault: Arc<dyn Vault>) -> Result<Self> {
        let secrets = vault.load(endpoint.scope())?.unwrap_or_default();
        let jar = Arc::new(SessionJar::new(endpoint.clone()));
        if !secrets.cookie.is_empty() {
            let header = HeaderValue::from_str(&secrets.cookie)
                .map_err(|_| Error::new(ErrorCode::SecureStorage))?;
            jar.accept(&header, &endpoint.action("status"));
        }
        let http = Http::builder()
            .cookie_provider(jar.clone())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        let connection = Connection {
            base_url: Some(endpoint.base().to_string()),
            requires_login: true,
            ..Connection::default()
        };
        Ok(Self {
            endpoint,
            http,
            jar,
            vault,
            secrets,
            connection,
            retry_at: None,
        })
    }
    pub fn snapshot(&self) -> Connection {
        self.connection.clone()
    }
    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }
    fn fail<T>(&mut self, error: Error) -> Result<T> {
        self.connection.error = Some(error.clone());
        self.connection.ready = false;
        Err(error)
    }
    fn forget(&mut self) -> Result<()> {
        self.secrets = Secrets::default();
        // Replace the transport too: reqwest's Jar has no clear method.
        self.jar = Arc::new(SessionJar::new(self.endpoint.clone()));
        self.http = Http::builder()
            .cookie_provider(self.jar.clone())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        self.connection.user = None;
        self.connection.workspace = None;
        self.connection.workspaces.clear();
        self.connection.ready = false;
        self.connection.requires_login = true;
        self.connection.recovery_pending = false;
        self.vault.clear(self.endpoint.scope())
    }
    fn persist(&mut self) -> Result<()> {
        self.secrets.cookie.zeroize();
        self.secrets.cookie = self.jar.persisted();
        if self.secrets.cookie.is_empty() {
            self.secrets.csrf.zeroize();
            self.vault.clear(self.endpoint.scope())
        } else {
            self.vault.save(self.endpoint.scope(), &self.secrets)
        }
    }
    fn request(&mut self, action: &str, body: Option<Value>) -> Result<Value> {
        if let Some((started, wait)) = self.retry_at {
            if let Some(left) = wait.checked_sub(started.elapsed()).filter(|d| !d.is_zero()) {
                let mut e = Error::new(ErrorCode::RateLimited);
                e.retry_after_ms = Some(left.as_millis().clamp(1, u64::MAX as u128) as u64);
                return self.fail(e);
            }
            self.retry_at = None;
        }
        let url = self.endpoint.action(action);
        let mut request = if body.is_some() {
            self.http.post(url)
        } else {
            self.http.get(url)
        };
        if let Some(mut body) = body {
            let mut csrf = HeaderValue::from_str(&self.secrets.csrf)
                .map_err(|_| Error::new(ErrorCode::InvalidResponse))?;
            csrf.set_sensitive(true);
            let encoded =
                serde_json::to_vec(&body).map_err(|_| Error::new(ErrorCode::InvalidInput))?;
            if let Some(object) = body.as_object_mut() {
                for key in ["password", "code"] {
                    if let Some(Value::String(value)) = object.get_mut(key) {
                        value.zeroize();
                    }
                }
            }
            if encoded.len() as u64 > MAX_RESPONSE {
                return self.fail(Error::new(ErrorCode::StorageFull));
            }
            request = request
                .header("X-CSRF-Token", csrf)
                .header("Content-Type", "application/json")
                .body(encoded);
            if let Some(user) = &self.connection.user {
                request = request.header("X-Workspace-User", &user.id);
            }
            if let Some(workspace) = &self.connection.workspace {
                request = request.header("X-Tack-Workspace", &workspace.id);
            }
        }
        let response = match request.send() {
            Ok(r) => r,
            Err(_) => return self.fail(Error::new(ErrorCode::Offline)),
        };
        let status = response.status().as_u16();
        let retry = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let mut bytes = Zeroizing::new(Vec::new());
        if response
            .take(MAX_RESPONSE + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_RESPONSE
        {
            return self.fail(Error::new(ErrorCode::InvalidResponse));
        }
        let mut value = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            let code = match status {
                401 | 403 => ErrorCode::SignedOut,
                409 if value.get("workspace").is_some()
                    || value.get("workspaceAccessChanged").is_some()
                    || value.get("workspaceId").is_some() =>
                {
                    ErrorCode::WorkspaceChanged
                }
                409 => ErrorCode::Conflict,
                413 => ErrorCode::StorageFull,
                428 => ErrorCode::RecoveryPending,
                429 => ErrorCode::RateLimited,
                500..=599 => ErrorCode::Offline,
                _ => ErrorCode::InvalidResponse,
            };
            let mut error = Error::new(code);
            error.http_status = Some(status);
            if status == 429 {
                let wait = retry
                    .as_deref()
                    .and_then(retry_after)
                    .unwrap_or(Duration::from_secs(60));
                error.retry_after_ms = Some(wait.as_millis().min(u64::MAX as u128) as u64);
                self.retry_at = Some((Instant::now(), wait));
            }
            if status == 401 || status == 403 {
                if let Err(e) = self.forget() {
                    return self.fail(e);
                }
            }
            return self.fail(error);
        }
        if !value.is_object() {
            return self.fail(Error::new(ErrorCode::InvalidResponse));
        }
        if ["status", "login"].contains(&action)
            && value.get("csrf").and_then(Value::as_str).is_none()
        {
            return self.fail(Error::new(ErrorCode::InvalidResponse));
        }
        if let Some(token) = value.as_object_mut().and_then(|o| o.remove("csrf")) {
            let Some(token) = token
                .as_str()
                .filter(|v| !v.is_empty() && v.len() <= 256 && HeaderValue::from_str(v).is_ok())
            else {
                return self.fail(Error::new(ErrorCode::InvalidResponse));
            };
            self.secrets.csrf.zeroize();
            self.secrets.csrf = token.to_owned();
        }
        if let Err(e) = self.persist() {
            let _ = self.forget();
            return self.fail(e);
        }
        self.connection.error = None;
        self.connection.ready = self.connection.user.is_some()
            && !self.connection.recovery_pending
            && !self.connection.requires_login;
        Ok(value)
    }
    fn status_value(&mut self, value: Value, require_version: bool) -> Result<Connection> {
        let invalid = || Error::new(ErrorCode::InvalidResponse);
        let result = (|| {
            if require_version
                && (value.get("version").and_then(Value::as_u64) != Some(4)
                    || value.get("available").and_then(Value::as_bool) != Some(true))
            {
                return Err(invalid());
            }
            let user: Option<User> =
                serde_json::from_value(value.get("user").cloned().ok_or_else(invalid)?)
                    .map_err(|_| invalid())?;
            let workspace: Option<Workspace> =
                serde_json::from_value(value.get("workspace").cloned().ok_or_else(invalid)?)
                    .map_err(|_| invalid())?;
            let workspaces: Vec<Workspace> =
                serde_json::from_value(value.get("workspaces").cloned().ok_or_else(invalid)?)
                    .map_err(|_| invalid())?;
            if user.as_ref().is_some_and(|u| u.id.is_empty())
                || workspace.as_ref().is_some_and(|w| w.id.is_empty())
                || user.is_some() != workspace.is_some()
                || self.secrets.csrf.is_empty()
                || self.jar.persisted().is_empty()
            {
                return Err(invalid());
            }
            let pending = value
                .get("recoveryPending")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            self.connection.user = user;
            self.connection.workspace = workspace;
            self.connection.workspaces = workspaces;
            self.connection.requires_login = self.connection.user.is_none();
            self.connection.recovery_pending = pending;
            self.connection.ready = !self.connection.requires_login && !pending;
            self.connection.checked = true;
            Ok(self.snapshot())
        })();
        match result {
            Ok(v) => Ok(v),
            Err(e) => {
                let _ = self.forget();
                self.fail(e)
            }
        }
    }
    pub fn status(&mut self) -> Result<Connection> {
        let value = self.request("status", None)?;
        self.status_value(value, true)
    }
    pub fn login(&mut self, username: &str, password: Password) -> Result<LoginReply> {
        let username = username.trim().to_lowercase();
        if !(3..=32).contains(&username.len())
            || !username.bytes().enumerate().all(|(i, c)| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || (i > 0 && b"_.-".contains(&c))
            })
            || !(10..=72).contains(&password.value().len())
        {
            return self.fail(Error::new(ErrorCode::InvalidInput));
        }
        self.status()?;
        let mut value = self.request(
            "login",
            Some(json!({"username":username,"password":password.value(),"remember":true})),
        )?;
        let code = value
            .as_object_mut()
            .and_then(|o| o.remove("recoveryCode"))
            .and_then(|v| v.as_str().map(str::to_owned))
            .map(RecoveryCode::new);
        value["recoveryPending"] = json!(code.is_some());
        let connection = self.status_value(value, false)?;
        if connection.user.is_none() || (connection.recovery_pending && code.is_none()) {
            return self.fail(Error::new(ErrorCode::InvalidResponse));
        }
        Ok(LoginReply {
            connection,
            recovery_code: code,
        })
    }
    pub fn confirm_recovery(&mut self, code: RecoveryCode) -> Result<Connection> {
        self.require_user()?;
        self.request(
            "recovery-confirm",
            Some(json!({"saved":true,"code":code.value()})),
        )?;
        self.status()
    }
    pub fn switch_workspace(&mut self, id: &str) -> Result<Connection> {
        self.require_user()?;
        if !self.connection.workspaces.iter().any(|w| w.id == id) {
            return self.fail(Error::new(ErrorCode::InvalidInput));
        }
        let mut value = self.request("workspace-switch", Some(json!({"id":id})))?;
        value["user"] = serde_json::to_value(&self.connection.user)
            .map_err(|_| Error::new(ErrorCode::InvalidResponse))?;
        value["recoveryPending"] = json!(self.connection.recovery_pending);
        if value
            .get("workspace")
            .and_then(|w| w.get("id"))
            .and_then(Value::as_str)
            != Some(id)
        {
            return self.fail(Error::new(ErrorCode::InvalidResponse));
        }
        self.status_value(value, false)
    }
    pub fn logout(&mut self) -> Result<Connection> {
        let remote = if self.secrets.csrf.is_empty() {
            Ok(Value::Null)
        } else {
            self.request("logout", Some(json!({})))
        };
        if let Err(e) = self.forget() {
            return self.fail(e);
        }
        match remote {
            Ok(_) => {
                self.connection.error = None;
                Ok(self.snapshot())
            }
            Err(e) => self.fail(e),
        }
    }
    fn require_user(&mut self) -> Result<()> {
        if self.connection.user.is_none() {
            self.fail(Error::new(ErrorCode::SignedOut))
        } else {
            Ok(())
        }
    }
    /// Transport only. V4.3 owns batching, cursor transactions, outbox and retries.
    pub fn sync(&mut self, cursor: u64, mutations: &[Mutation]) -> Result<SyncReply> {
        self.require_user()?;
        let mut keys = HashSet::new();
        if mutations.len() > 50
            || mutations.iter().any(|m| {
                !["cards", "reminders", "settings"].contains(&m.table.as_str())
                    || m.id.is_empty()
                    || !keys.insert((&m.table, &m.id))
                    || (!m.value.is_null()
                        && m.value
                            .get(if m.table == "settings" { "key" } else { "id" })
                            .and_then(Value::as_str)
                            != Some(&m.id))
            })
        {
            return self.fail(Error::new(ErrorCode::InvalidInput));
        }
        let value = self.request("sync", Some(json!({"cursor":cursor,"mutations":mutations})))?;
        let reply: SyncReply = match serde_json::from_value(value) {
            Ok(v) => v,
            Err(_) => return self.fail(Error::new(ErrorCode::InvalidResponse)),
        };
        if Some(reply.user_id.as_str()) != self.connection.user.as_ref().map(|u| u.id.as_str())
            || Some(reply.workspace_id.as_str())
                != self.connection.workspace.as_ref().map(|w| w.id.as_str())
        {
            return self.fail(Error::new(ErrorCode::WorkspaceChanged));
        }
        if reply.cursor < cursor
            || (reply.more && reply.cursor == cursor)
            || reply.changes.iter().any(|r| r.version == 0)
            || reply.changes.iter().chain(&reply.conflicts).any(|r| {
                r.table.is_empty()
                    || r.id.is_empty()
                    || (r.version == 0 && !r.value.is_null())
                    || (!r.value.is_null()
                        && r.value
                            .get(if r.table == "settings" { "key" } else { "id" })
                            .and_then(Value::as_str)
                            != Some(r.id.as_str()))
            })
        {
            return self.fail(Error::new(ErrorCode::InvalidResponse));
        }
        Ok(reply)
    }
}
fn retry_after(raw: &str) -> Option<Duration> {
    if let Ok(seconds) = raw.parse::<u64>() {
        return Some(Duration::from_secs(seconds.max(1)));
    }
    let date = chrono::DateTime::parse_from_rfc2822(raw).ok()?;
    Some(Duration::from_secs(
        (date.timestamp() - chrono::Utc::now().timestamp()).max(1) as u64,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cookie_filter_is_installation_scoped_and_preserves_absolute_expiry() {
        let endpoint = Endpoint::new("https://example.test/tack/").unwrap();
        let url = endpoint.action("status");
        let jar = SessionJar::new(endpoint.clone());
        for raw in [
            "analytics=01234567890123456789; Path=/tack/; Secure; HttpOnly",
            "tack_sid=01234567890123456789; Path=/; Secure; HttpOnly",
            "tack_sid=01234567890123456789; Path=/tack/; HttpOnly",
            "tack_sid=01234567890123456789; Path=/tack/; Domain=other.test; Secure; HttpOnly",
            "tack_sid=01234567890123456789; Path=/tack/; Secure",
        ] {
            jar.accept(&HeaderValue::from_str(raw).unwrap(), &url);
            assert!(jar.persisted().is_empty());
        }
        let cookie="tack_sid=01234567890123456789; Path=/tack/; Secure; HttpOnly; Max-Age=2592000; Expires=Wed, 01 Jan 2098 00:00:00 GMT";
        jar.accept(&HeaderValue::from_str(cookie).unwrap(), &url);
        let saved = jar.persisted();
        assert!(!saved.is_empty());
        assert!(!saved.to_ascii_lowercase().contains("max-age"));
        assert!(jar
            .cookies(&Url::parse("https://example.test/other/api/index.php").unwrap())
            .is_none());
        assert!(jar
            .cookies(&Url::parse("https://other.test/tack/api/index.php").unwrap())
            .is_none());
        let restarted = SessionJar::new(endpoint);
        restarted.accept(&HeaderValue::from_str(&saved).unwrap(), &url);
        assert_eq!(restarted.persisted(), saved);
        jar.accept(&HeaderValue::from_static("tack_sid=01234567890123456789; Path=/tack/; Secure; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT"),&url);
        assert!(jar.persisted().is_empty());
    }
    #[test]
    fn retry_after_accepts_seconds_and_http_dates() {
        assert_eq!(retry_after("900"), Some(Duration::from_secs(900)));
        assert_eq!(retry_after("0"), Some(Duration::from_secs(1)));
        let future = (chrono::Utc::now() + chrono::Duration::seconds(120))
            .format("%a, %d %b %Y %H:%M:%S GMT")
            .to_string();
        assert!(retry_after(&future).is_some_and(|d| (119..=120).contains(&d.as_secs())));
        assert_eq!(retry_after("invalid"), None);
    }

    #[test]
    fn max_age_deletion_wins_over_a_future_expires_date() {
        let endpoint = Endpoint::new("https://example.test/tack/").unwrap();
        let url = endpoint.action("status");
        let jar = SessionJar::new(endpoint);
        jar.accept(&HeaderValue::from_static("tack_sid=01234567890123456789; Path=/tack/; Secure; HttpOnly; Expires=Wed, 01 Jan 2098 00:00:00 GMT"),&url);
        assert!(!jar.persisted().is_empty());
        jar.accept(&HeaderValue::from_static("tack_sid=01234567890123456789; Path=/tack/; Secure; HttpOnly; Max-Age=0; Expires=Wed, 01 Jan 2098 00:00:00 GMT"),&url);
        assert!(jar.persisted().is_empty());
    }
}
