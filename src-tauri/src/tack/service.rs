//! One condition-variable worker owns HTTP, debounce, retries and heartbeats.
use super::{
    client::{Client, LoginReply},
    endpoint::Endpoint,
    model::*,
    schedule::Schedule,
    session::{KeyringVault, Password, RecoveryCode},
};
use crate::{
    db::Database,
    notes::preferences::{Profile, Setup},
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    sync::{Arc, Condvar, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

struct State {
    schedule: Schedule,
    status: SyncStatus,
    error: Option<Error>,
    needs_status: bool,
}
impl Default for State {
    fn default() -> Self {
        Self {
            schedule: Schedule::default(),
            status: SyncStatus::LocalOnly,
            error: None,
            needs_status: false,
        }
    }
}
type Observer = dyn Fn(SyncSnapshot) + Send + Sync;
struct Inner {
    #[cfg(test)]
    test_transport: OnceLock<(Endpoint, Arc<dyn super::session::Vault>)>,
    operation: Mutex<()>,
    client: Mutex<Option<Client>>,
    state: Mutex<State>,
    changed: Condvar,
    started: Instant,
    db: OnceLock<Database>,
    observer: OnceLock<Arc<Observer>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}
#[derive(Clone)]
pub struct Service(Arc<Inner>);
impl Default for Service {
    fn default() -> Self {
        Self(Arc::new(Inner {
            #[cfg(test)]
            test_transport: OnceLock::new(),
            operation: Mutex::new(()),
            client: Mutex::new(None),
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            started: Instant::now(),
            db: OnceLock::new(),
            observer: OnceLock::new(),
            worker: Mutex::new(None),
        }))
    }
}
impl Service {
    fn now(&self) -> u64 {
        self.0.started.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
    fn db(&self) -> Result<&Database> {
        self.0
            .db
            .get()
            .ok_or_else(|| Error::new(ErrorCode::LocalStorage))
    }
    pub(crate) fn start(&self, db: Database, app: AppHandle) -> Result<()> {
        let last_data = AtomicU64::new(db.tack_data_revision()?);
        let observed_db = db.clone();
        let observer: Arc<Observer> = Arc::new(move |snapshot| {
            let _ = app.emit("tack:sync", &snapshot);
            if let Ok(revision) = observed_db.tack_data_revision() {
                if revision > last_data.fetch_max(revision, Ordering::AcqRel) {
                    let _ = app.emit("notes:updated", ());
                }
            }
            if let Some(bus) = app.try_state::<Arc<crate::island::activity_bus::Bus>>() {
                bus.submit(
                    crate::island::activity::ActivityEvent::SyncState {
                        state: snapshot.state,
                    },
                    None,
                );
            }
        });
        self.start_worker(db, observer, true, true)
    }
    fn start_worker(
        &self,
        db: Database,
        observer: Arc<Observer>,
        restore: bool,
        watch_network: bool,
    ) -> Result<()> {
        if self.0.db.set(db).is_err() {
            return Ok(());
        }
        let _ = self.0.observer.set(observer);
        let worker = self.clone();
        let handle = thread::Builder::new()
            .name("nabbit-tack".into())
            .spawn(move || {
                #[cfg(windows)]
                let _network = if watch_network {
                    super::network::Watch::start(worker.clone()).ok()
                } else {
                    None
                };
                #[cfg(not(windows))]
                let _ = watch_network;
                if restore {
                    let _operation = worker.0.operation.lock().unwrap_or_else(|e| e.into_inner());
                    if let Err(error) = worker.restore() {
                        worker.failed(error);
                    }
                }
                worker.emit();
                let mut state = worker.0.state.lock().unwrap_or_else(|e| e.into_inner());
                loop {
                    if state.schedule.stopped {
                        break;
                    }
                    if state.schedule.due(worker.now()) {
                        state.status = SyncStatus::Syncing;
                        state.error = None;
                        drop(state);
                        let operation =
                            worker.0.operation.lock().unwrap_or_else(|e| e.into_inner());
                        let cancelled = {
                            let current = worker.0.state.lock().unwrap_or_else(|e| e.into_inner());
                            current.schedule.stopped || !current.schedule.active
                        };
                        if cancelled {
                            drop(operation);
                            state = worker.0.state.lock().unwrap_or_else(|e| e.into_inner());
                            state.schedule.running = false;
                            continue;
                        }
                        worker.emit();
                        let result = worker.run_pass();
                        match result {
                            Ok(pending) => {
                                let mut state =
                                    worker.0.state.lock().unwrap_or_else(|e| e.into_inner());
                                state.schedule.success(worker.now(), pending);
                                state.error = None;
                                state.status = SyncStatus::UpToDate;
                            }
                            Err(error) => worker.failed(error),
                        }
                        worker.emit();
                        drop(operation);
                        state = worker.0.state.lock().unwrap_or_else(|e| e.into_inner());
                        continue;
                    }
                    state = match state.schedule.wait(worker.now()) {
                        Some(ms) => {
                            worker
                                .0
                                .changed
                                .wait_timeout(state, Duration::from_millis(ms))
                                .unwrap_or_else(|e| e.into_inner())
                                .0
                        }
                        None => worker
                            .0
                            .changed
                            .wait(state)
                            .unwrap_or_else(|e| e.into_inner()),
                    };
                }
                // Cancellation happens outside the state lock: the native callback
                // may be finishing a notification that needs that same lock.
                drop(state);
            })
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        *self
            .0
            .worker
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))? = Some(handle);
        Ok(())
    }
    fn restore(&self) -> Result<()> {
        self.restore_using(|identity| {
            Client::new(Endpoint::new(&identity.base_url)?, Arc::new(KeyringVault))
        })
    }
    fn restore_using(&self, create: impl FnOnce(&Identity) -> Result<Client>) -> Result<()> {
        let db = self.db()?;
        if !db.tack_enabled()? {
            return Ok(());
        }
        let Some(context) = db.notes_context()? else {
            return Ok(());
        };
        let identity = db.tack_identity(&context)?;
        let mut slot = self
            .0
            .client
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        // An explicit command may have connected while the worker was starting.
        if slot.is_some() {
            return Ok(());
        }
        *slot = Some(create(&identity)?);
        {
            let mut state = self
                .0
                .state
                .lock()
                .map_err(|_| Error::new(ErrorCode::Offline))?;
            state.schedule.active = true;
            state.needs_status = true;
        }
        let connection = slot
            .as_mut()
            .ok_or_else(|| Error::new(ErrorCode::SignedOut))?
            .status()?;
        self.accept(&connection, false)?;
        Ok(())
    }
    fn identity(connection: &Connection) -> Result<Identity> {
        Ok(Identity {
            base_url: connection
                .base_url
                .clone()
                .ok_or_else(|| Error::new(ErrorCode::SignedOut))?,
            user_id: connection
                .user
                .as_ref()
                .ok_or_else(|| Error::new(ErrorCode::SignedOut))?
                .id
                .clone(),
            workspace_id: connection
                .workspace
                .as_ref()
                .ok_or_else(|| Error::new(ErrorCode::SignedOut))?
                .id
                .clone(),
        })
    }
    fn accept(&self, connection: &Connection, explicit: bool) -> Result<()> {
        if !connection.ready {
            return Err(Error::new(if connection.recovery_pending {
                ErrorCode::RecoveryPending
            } else {
                ErrorCode::SignedOut
            }));
        }
        if let Some(db) = self.0.db.get() {
            let identity = Self::identity(connection)?;
            let current = db.notes_context()?;
            let previous = current.as_ref().map(|c| db.tack_identity(c)).transpose()?;
            if !explicit && previous.as_ref().is_some_and(|i| i != &identity) {
                return Err(Error::new(ErrorCode::WorkspaceChanged));
            }
            if explicit || current.is_none() || !db.tack_enabled()? {
                db.tack_activate(&identity)?;
            }
            let mut state = self
                .0
                .state
                .lock()
                .map_err(|_| Error::new(ErrorCode::Offline))?;
            state.schedule.connect(self.now());
            state.status = SyncStatus::Syncing;
            state.error = None;
            state.needs_status = false;
            self.0.changed.notify_one();
        }
        Ok(())
    }
    fn pause(&self) -> Result<()> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        state.schedule.disconnect();
        state.status = SyncStatus::Offline;
        state.error = None;
        drop(state);
        if let Some(db) = self.0.db.get() {
            db.tack_pause_and_export()?;
        }
        Ok(())
    }
    fn endpoint(&self, base_url: &str) -> Result<Endpoint> {
        #[cfg(test)]
        if let Some((endpoint, _)) = self.0.test_transport.get() {
            if endpoint.base().as_str() == base_url {
                return Ok(endpoint.clone());
            }
        }
        Endpoint::new(base_url)
    }
    fn client(&self, endpoint: Endpoint) -> Result<Client> {
        #[cfg(test)]
        if let Some((allowed, vault)) = self.0.test_transport.get() {
            if allowed.base() == endpoint.base() {
                return Client::new(endpoint, vault.clone());
            }
        }
        Client::new(endpoint, Arc::new(KeyringVault))
    }
    fn staged(&self, pending: bool) -> Result<()> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        state.schedule.disconnect();
        state.error = None;
        state.status = if pending {
            SyncStatus::RecoveryPending
        } else {
            SyncStatus::LocalOnly
        };
        Ok(())
    }
    pub fn status(&self, base_url: &str) -> Result<Connection> {
        let _operation = self
            .0
            .operation
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        let endpoint = self.endpoint(base_url)?;
        self.db()?.tack_hint(endpoint.base().as_str(), None)?;
        let result: Result<Connection> = (|| {
            let mut slot = self
                .0
                .client
                .lock()
                .map_err(|_| Error::new(ErrorCode::Offline))?;
            if slot
                .as_ref()
                .is_none_or(|c| c.endpoint().base() != endpoint.base())
            {
                self.pause()?;
                *slot = Some(self.client(endpoint)?);
            }
            let connection = slot
                .as_mut()
                .ok_or_else(|| Error::new(ErrorCode::SignedOut))?
                .status()?;
            if connection.ready && self.db()?.tack_enabled()? {
                self.accept(&connection, false)?;
            } else if connection.ready {
                self.staged(false)?;
            } else {
                self.failed(Error::new(if connection.recovery_pending {
                    ErrorCode::RecoveryPending
                } else {
                    ErrorCode::SignedOut
                }));
            }
            Ok(connection)
        })();
        if let Err(error) = &result {
            self.failed(error.clone());
        }
        self.emit();
        result
    }
    pub fn snapshot(&self) -> Result<Connection> {
        Ok(self
            .0
            .client
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?
            .as_ref()
            .map(Client::snapshot)
            .unwrap_or_default())
    }
    pub fn login(&self, username: &str, password: Password) -> Result<LoginReply> {
        let _operation = self
            .0
            .operation
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        let result: Result<LoginReply> = (|| {
            let mut slot = self
                .0
                .client
                .lock()
                .map_err(|_| Error::new(ErrorCode::Offline))?;
            self.pause()?;
            let reply = slot
                .as_mut()
                .ok_or_else(|| Error::new(ErrorCode::SignedOut))?
                .login(username, password)?;
            if let (Some(base), Some(user)) = (&reply.connection.base_url, &reply.connection.user) {
                self.db()?.tack_hint(base, Some(&user.username))?;
            }
            self.staged(reply.connection.recovery_pending)?;
            Ok(reply)
        })();
        if let Err(error) = &result {
            self.failed(error.clone());
        }
        self.emit();
        result
    }
    pub fn confirm(&self, code: String) -> Result<Connection> {
        let _operation = self
            .0
            .operation
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        let code = RecoveryCode::new(code);
        let result: Result<Connection> = (|| {
            let mut slot = self
                .0
                .client
                .lock()
                .map_err(|_| Error::new(ErrorCode::Offline))?;
            let connection = slot
                .as_mut()
                .ok_or_else(|| Error::new(ErrorCode::SignedOut))?
                .confirm_recovery(code)?;
            self.staged(false)?;
            Ok(connection)
        })();
        if let Err(error) = &result {
            self.failed(error.clone());
        }
        self.emit();
        result
    }
    pub fn switch(&self, id: &str) -> Result<Connection> {
        let _operation = self
            .0
            .operation
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        let result: Result<Connection> = (|| {
            let mut slot = self
                .0
                .client
                .lock()
                .map_err(|_| Error::new(ErrorCode::Offline))?;
            self.pause()?;
            let connection = slot
                .as_mut()
                .ok_or_else(|| Error::new(ErrorCode::SignedOut))?
                .switch_workspace(id)?;
            self.staged(false)?;
            Ok(connection)
        })();
        if let Err(error) = &result {
            self.failed(error.clone());
        }
        self.emit();
        result
    }
    pub(crate) fn profile(&self) -> Result<Profile> {
        Ok(self.db()?.tack_profile()?)
    }
    pub(crate) fn workspace_profile(&self, id: &str) -> Result<Profile> {
        let connection = self.snapshot()?;
        let workspace = connection
            .workspaces
            .iter()
            .find(|w| w.id == id)
            .ok_or_else(|| Error::new(ErrorCode::InvalidInput))?;
        let mut identity = Self::identity(&connection)?;
        identity.workspace_id = workspace.id.clone();
        let mut profile = self.db()?.tack_profile_for(Some(&Context {
            key: identity.key(),
            epoch: 0,
        }))?;
        profile.read_only = workspace.role == "guest";
        Ok(profile)
    }
    pub(crate) fn start_scope(&self, request: Setup) -> Result<Connection> {
        let preferences = request
            .preferences
            .normalized()
            .map_err(|_| Error::new(ErrorCode::InvalidInput))?;
        let id = request.workspace_id.as_str();
        let upload = request.upload_local;
        let _operation = self
            .0
            .operation
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        let result = (|| {
            let mut slot = self
                .0
                .client
                .lock()
                .map_err(|_| Error::new(ErrorCode::Offline))?;
            self.pause()?;
            let client = slot
                .as_mut()
                .ok_or_else(|| Error::new(ErrorCode::SignedOut))?;
            let previous = client.snapshot();
            if previous.user.as_ref().map(|u| u.id.as_str())
                != Some(request.expected_user_id.as_str())
                || previous.base_url.as_deref() != Some(request.expected_base_url.as_str())
            {
                return Err(Error::new(ErrorCode::WorkspaceChanged));
            }
            let fresh = client.status()?;
            if fresh.user.as_ref().map(|u| u.id.as_str()) != Some(request.expected_user_id.as_str())
            {
                return Err(Error::new(ErrorCode::WorkspaceChanged));
            }
            if !fresh.ready {
                return Err(Error::new(if fresh.recovery_pending {
                    ErrorCode::RecoveryPending
                } else {
                    ErrorCode::SignedOut
                }));
            }
            let workspace = fresh
                .workspaces
                .iter()
                .find(|w| w.id == id)
                .ok_or_else(|| Error::new(ErrorCode::WorkspaceChanged))?;
            let read_only = workspace.role == "guest";
            if read_only && upload {
                return Err(Error::new(ErrorCode::InvalidInput));
            }
            let connection = if fresh.workspace.as_ref().is_some_and(|w| w.id == id) {
                fresh
            } else {
                client.switch_workspace(id)?
            };
            let context = self.db()?.tack_configure(
                &Self::identity(&connection)?,
                Some((preferences, read_only)),
            )?;
            if upload {
                self.db()?.tack_upload_local(&context)?;
            }
            self.db()?.tack_enable(&context)?;
            let mut state = self
                .0
                .state
                .lock()
                .map_err(|_| Error::new(ErrorCode::Offline))?;
            state.schedule.connect(self.now());
            state.status = SyncStatus::Syncing;
            state.error = None;
            state.needs_status = false;
            self.0.changed.notify_one();
            Ok(connection)
        })();
        if let Err(error) = &result {
            self.failed(error.clone());
        }
        self.emit();
        result
    }
    pub(crate) fn browser_target(&self) -> Result<String> {
        let connection = self.snapshot()?;
        if !connection.checked {
            return Err(Error::new(ErrorCode::InvalidServer));
        }
        let base = connection
            .base_url
            .ok_or_else(|| Error::new(ErrorCode::InvalidServer))?;
        Ok(Endpoint::new(&base)?.base().to_string())
    }
    #[cfg(test)]
    pub(super) fn test_connection(
        db: Database,
        endpoint: Endpoint,
        vault: Arc<dyn super::session::Vault>,
        observer: Arc<Observer>,
    ) -> Result<Self> {
        let service = Self::default();
        let _ = service.0.test_transport.set((endpoint, vault));
        service.start_worker(db, observer, false, false)?;
        Ok(service)
    }
    pub fn logout(&self) -> Result<Connection> {
        let _operation = self
            .0
            .operation
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        let result = (|| {
            let mut slot = self
                .0
                .client
                .lock()
                .map_err(|_| Error::new(ErrorCode::Offline))?;
            self.pause()?;
            slot.as_mut()
                .ok_or_else(|| Error::new(ErrorCode::SignedOut))?
                .logout()
        })();
        let still_authenticated = self.snapshot()?.user.is_some();
        {
            let mut state = self
                .0
                .state
                .lock()
                .map_err(|_| Error::new(ErrorCode::Offline))?;
            state.status = if still_authenticated {
                result
                    .as_ref()
                    .err()
                    .map_or(SyncStatus::Offline, |e| e.state)
            } else {
                SyncStatus::SignedOut
            };
            state.error = result.as_ref().err().cloned();
        }
        self.emit();
        result
    }
    fn run_pass(&self) -> Result<bool> {
        let db = self.db()?;
        let Some(context) = db.notes_context()? else {
            return Ok(false);
        };
        if !db.tack_enabled()? {
            return Err(Error::new(ErrorCode::SignedOut));
        }
        let mut slot = self
            .0
            .client
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        let client = slot
            .as_mut()
            .ok_or_else(|| Error::new(ErrorCode::SignedOut))?;
        if self
            .0
            .state
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?
            .needs_status
        {
            let connection = client.status()?;
            let actual = Self::identity(&connection)?;
            let expected = db.tack_identity(&context)?;
            if actual != expected {
                return Err(Error::new(ErrorCode::WorkspaceChanged));
            }
            if !connection.ready {
                return Err(Error::new(if connection.recovery_pending {
                    ErrorCode::RecoveryPending
                } else {
                    ErrorCode::SignedOut
                }));
            }
            self.0
                .state
                .lock()
                .map_err(|_| Error::new(ErrorCode::Offline))?
                .needs_status = false;
        }
        super::sync::cycle(db, &context, client)?;
        Ok(!db.tack_batch(&context, &Default::default())?.is_empty())
    }
    fn failed(&self, error: Error) {
        if [
            ErrorCode::SignedOut,
            ErrorCode::WorkspaceChanged,
            ErrorCode::SecureStorage,
        ]
        .contains(&error.code)
        {
            if let Some(db) = self.0.db.get() {
                let _ = db.tack_pause_and_export();
            }
        }
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.status = error.state;
        state.schedule.failed(self.now(), &error);
        state.error = Some(error);
        self.0.changed.notify_one();
    }
    pub fn sync_snapshot(&self) -> Result<SyncSnapshot> {
        let state = self
            .0
            .state
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        let mut snapshot = SyncSnapshot {
            state: state.status,
            scope: None,
            pending: 0,
            conflicts: 0,
            reference_issues: 0,
            last_synced: None,
            error: state.error.clone(),
            next_attempt_ms: state.schedule.wait(self.now()),
        };
        if let Some(db) = self.0.db.get() {
            let crate::notes::sync_store::Summary {
                scope: context,
                pending,
                conflicts,
                reference_issues: issues,
                last_synced: last,
            } = db.tack_summary()?;
            snapshot.scope = context;
            snapshot.pending = pending;
            snapshot.conflicts = conflicts;
            snapshot.reference_issues = issues;
            snapshot.last_synced = last;
            if snapshot.error.is_none() && snapshot.scope.is_some() && state.schedule.active {
                snapshot.state = if conflicts + issues > 0 {
                    SyncStatus::Conflict
                } else if pending > 0 || state.schedule.running {
                    SyncStatus::Syncing
                } else if snapshot.last_synced.is_some() {
                    SyncStatus::UpToDate
                } else {
                    snapshot.state
                };
            }
        }
        Ok(snapshot)
    }
    fn emit(&self) {
        if let (Some(observer), Ok(snapshot)) = (self.0.observer.get(), self.sync_snapshot()) {
            observer(snapshot);
        }
    }
    pub(crate) fn edited(&self) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.schedule.edit(self.now());
        drop(state);
        self.0.changed.notify_one();
        self.emit();
    }
    pub(crate) fn request_sync(&self) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.schedule.request(self.now());
        drop(state);
        self.0.changed.notify_one();
    }
    pub(crate) fn visibility(&self, open: bool, focused: bool) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.schedule.visibility(self.now(), open);
        if focused {
            state.schedule.request(self.now());
        }
        drop(state);
        self.0.changed.notify_one();
    }
    pub(crate) fn network_regained(&self) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.schedule.network_regained(self.now());
        drop(state);
        self.0.changed.notify_one();
    }
    pub(crate) fn conflicts(&self, context: &Context) -> Result<Vec<Conflict>> {
        Ok(self.db()?.tack_conflicts(context)?)
    }
    pub(crate) fn resolve(
        &self,
        context: &Context,
        table: &str,
        id: &str,
        token: &str,
        version: u64,
        choice: Resolution,
    ) -> Result<()> {
        let _operation = self
            .0
            .operation
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        let _client = self
            .0
            .client
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        self.db()?
            .tack_resolve(context, table, id, token, version, choice)?;
        self.edited();
        Ok(())
    }
    pub(crate) fn upload_local(&self, context: &Context) -> Result<usize> {
        let _operation = self
            .0
            .operation
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        let _client = self
            .0
            .client
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        let count = self.db()?.tack_upload_local(context)?;
        self.edited();
        Ok(count)
    }
    pub(crate) fn local_mode(&self) -> Result<()> {
        let _operation = self
            .0
            .operation
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        let _client = self
            .0
            .client
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        if let Err(error) = self.pause() {
            self.failed(error.clone());
            self.emit();
            return Err(error);
        }
        self.db()?.tack_local_mode()?;
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| Error::new(ErrorCode::Offline))?;
        state.schedule.disconnect();
        state.status = SyncStatus::LocalOnly;
        state.error = None;
        drop(state);
        self.emit();
        Ok(())
    }
    pub(crate) fn stop(&self) {
        {
            let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
            state.schedule.stopped = true;
            self.0.changed.notify_one();
        }
        let handle = self
            .0
            .worker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }

    #[cfg(test)]
    pub(crate) fn test_start(
        db: Database,
        client: Client,
        observer: Arc<Observer>,
    ) -> Result<Self> {
        let service = Self::default();
        *service.0.client.lock().unwrap() = Some(client);
        service.start_worker(db, observer, false, false)?;
        {
            let mut state = service.0.state.lock().unwrap();
            state.schedule.connect(service.now());
            state.status = SyncStatus::Syncing;
        }
        service.0.changed.notify_one();
        Ok(service)
    }
    #[cfg(test)]
    pub(crate) fn test_idle(db: Database) -> Result<Self> {
        let service = Self::default();
        service.start_worker(db, Arc::new(|_| {}), false, false)?;
        Ok(service)
    }
    #[cfg(test)]
    pub(crate) fn test_resume(
        db: Database,
        endpoint: Endpoint,
        vault: Arc<dyn super::session::Vault>,
    ) -> Result<Self> {
        let service = Self::test_idle(db)?;
        {
            let _op = service.0.operation.lock().unwrap();
            if let Err(error) = service.restore_using(|_| Client::new(endpoint, vault)) {
                service.failed(error);
            }
        }
        service.0.changed.notify_one();
        service.emit();
        Ok(service)
    }
}
