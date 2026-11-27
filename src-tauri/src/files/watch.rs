use super::paths;
use crate::error::{msg, Result};
use notify::Watcher;
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
struct Watch {
    token: String,
    path: String,
    active: Arc<AtomicBool>,
    _watcher: Option<notify::RecommendedWatcher>,
}
impl Drop for Watch {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}
#[derive(Default)]
pub struct Watches(Mutex<HashMap<String, Watch>>);
pub fn should_watch(facts: &paths::Facts) -> bool {
    !facts.network
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub path: String,
    pub name: String,
    pub directory: bool,
    pub modified: u64,
    pub cloud: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peek {
    pub token: String,
    pub path: String,
    pub items: Vec<Recent>,
    pub watching: bool,
}
impl Watches {
    pub fn open(
        &self,
        owner: &str,
        path: String,
        changed: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Peek> {
        self.open_using(owner, path, changed, paths::facts)
    }
    pub(super) fn open_using(
        &self,
        owner: &str,
        path: String,
        changed: Arc<dyn Fn(String) + Send + Sync>,
        probe: impl FnOnce(&str) -> Result<paths::Facts>,
    ) -> Result<Peek> {
        let token = uuid::Uuid::new_v4().to_string();
        let active = Arc::new(AtomicBool::new(true));
        self.0
            .lock()
            .map_err(|_| msg("Pin preview unavailable"))?
            .insert(
                owner.into(),
                Watch {
                    token: token.clone(),
                    path: path.clone(),
                    active: active.clone(),
                    _watcher: None,
                },
            );
        let result = (|| {
            let facts = probe(&path)?;
            if !facts.directory {
                return Err(msg("Choose a folder pin"));
            }
            if !active.load(Ordering::Acquire) {
                return Err(msg("Pin preview closed"));
            }
            let watcher = if !should_watch(&facts) {
                None
            } else {
                let running = active.clone();
                let current = token.clone();
                let mut watcher =
                    notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                        if running.load(Ordering::Acquire)
                            && !event.as_ref().is_ok_and(|event| {
                                matches!(event.kind, notify::EventKind::Access(_))
                            })
                        {
                            changed(current.clone());
                        }
                    })
                    .map_err(|e| msg(e.to_string()))?;
                watcher
                    .watch(&paths::checked(&path)?, notify::RecursiveMode::NonRecursive)
                    .map_err(|e| msg(e.to_string()))?;
                Some(watcher)
            };
            let watching = watcher.is_some();
            {
                let mut watches = self.0.lock().map_err(|_| msg("Pin preview unavailable"))?;
                let current = watches
                    .get_mut(owner)
                    .filter(|watch| watch.token == token)
                    .ok_or_else(|| msg("Pin preview closed"))?;
                current._watcher = watcher;
            }
            let items = recent(&path, &active)?;
            Ok(Peek {
                token: token.clone(),
                path,
                items,
                watching,
            })
        })();
        if result.is_err() {
            self.close(owner, Some(&token));
        }
        result
    }

    pub fn read(&self, owner: &str, token: &str) -> Result<Vec<Recent>> {
        let (path, active) = {
            let watches = self.0.lock().map_err(|_| msg("Pin preview unavailable"))?;
            let watch = watches
                .get(owner)
                .filter(|w| w.token == token)
                .ok_or_else(|| msg("Pin preview closed"))?;
            (watch.path.clone(), watch.active.clone())
        };
        recent(&path, &active)
    }
    pub fn item(&self, owner: &str, token: &str, path: &str) -> Result<Recent> {
        self.read(owner, token)?
            .into_iter()
            .find(|i| i.path == path)
            .ok_or_else(|| msg("This recent item changed. Refresh the preview."))
    }
    pub fn close(&self, owner: &str, token: Option<&str>) {
        if let Ok(mut watches) = self.0.lock() {
            if watches
                .get(owner)
                .is_some_and(|w| token.is_none_or(|t| w.token == t))
            {
                watches.remove(owner);
            }
        }
    }
    pub fn stop(&self) {
        if let Ok(mut watches) = self.0.lock() {
            watches.clear();
        }
    }
}
pub fn recent(path: &str, active: &AtomicBool) -> Result<Vec<Recent>> {
    let mut newest = Vec::new();
    for entry in std::fs::read_dir(paths::checked(path)?)? {
        if !active.load(Ordering::Acquire) {
            return Err(msg("Pin preview closed"));
        }
        let Ok(entry) = entry else {
            continue;
        };
        let path = paths::display(&entry.path());
        let Ok(facts) = paths::facts(&path) else {
            continue;
        };
        newest.push(Recent {
            name: entry.file_name().to_string_lossy().into(),
            path,
            directory: facts.directory,
            modified: facts.modified,
            cloud: facts.cloud,
        });
        newest.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.name.cmp(&b.name)));
        newest.truncate(6);
    }
    Ok(newest)
}
