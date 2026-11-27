use super::{
    parse::MAX_BOOKMARKS,
    sources::{self, Discovery, Roots, Source},
    store::{ImportResult, Options, Plan},
};
use crate::{
    db::Database,
    error::{msg, Result},
    notes::sync_store::Context,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;
#[derive(Default)]
pub struct Service(Mutex<State>);
#[derive(Default)]
struct State {
    sessions: HashMap<String, Session>,
    plans: HashMap<String, (String, Plan)>,
}
struct Session {
    owner: String,
    at: Instant,
    sources: HashMap<String, Source>,
    files: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub session_id: String,
    pub sources: Vec<Source>,
    pub read_files: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewRequest {
    pub session_id: String,
    pub source_ids: Vec<String>,
    pub expected_scope: Option<Context>,
    pub options: Options,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub plan_id: String,
    pub eligible: usize,
    pub duplicates: usize,
    pub skipped: usize,
    pub total: usize,
    pub files: Vec<String>,
    pub scope: Option<Context>,
}
impl Service {
    pub fn discover(&self, owner: &str, roots: &Roots) -> Result<Catalog> {
        self.catalog(owner, sources::discover(roots)?)
    }
    fn catalog(&self, owner: &str, discovery: Discovery) -> Result<Catalog> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| msg("Bookmark import state is unavailable"))?;
        state
            .sessions
            .retain(|_, s| s.at.elapsed() < Duration::from_secs(30 * 60));
        let active = state.sessions.keys().cloned().collect::<HashSet<_>>();
        state
            .plans
            .retain(|_, (session, _)| active.contains(session));
        if state.sessions.len() >= 8 {
            return Err(msg(
                "Close another bookmark import before opening a new one",
            ));
        }
        let session_id = Uuid::new_v4().to_string();
        state.sessions.insert(
            session_id.clone(),
            Session {
                owner: owner.into(),
                at: Instant::now(),
                sources: discovery
                    .sources
                    .iter()
                    .map(|s| (s.id.clone(), s.clone()))
                    .collect(),
                files: discovery.read_files.clone(),
            },
        );
        Ok(Catalog {
            session_id,
            sources: discovery.sources,
            read_files: discovery.read_files,
        })
    }
    /// Only the native picker (or an injected fixture picker) supplies this path.
    pub fn add_html(&self, owner: &str, session: &str, path: &Path) -> Result<Catalog> {
        {
            let state = self
                .0
                .lock()
                .map_err(|_| msg("Bookmark import state is unavailable"))?;
            if !state
                .sessions
                .get(session)
                .is_some_and(|s| s.owner == owner)
            {
                return Err(msg("Rescan bookmark sources before selecting a file"));
            }
        }
        let incoming = sources::selected_html(path)?;
        let mut state = self
            .0
            .lock()
            .map_err(|_| msg("Bookmark import state is unavailable"))?;
        let current = state
            .sessions
            .get_mut(session)
            .filter(|s| s.owner == owner)
            .ok_or_else(|| msg("Rescan bookmark sources before selecting a file"))?;
        for source in incoming.sources {
            current.sources.insert(source.id.clone(), source);
        }
        current.files.extend(incoming.read_files);
        current.files.sort();
        current.files.dedup();
        let mut sources = current.sources.values().cloned().collect::<Vec<_>>();
        sources.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(Catalog {
            session_id: session.into(),
            sources,
            read_files: current.files.clone(),
        })
    }
    pub fn preview(&self, db: &Database, owner: &str, request: PreviewRequest) -> Result<Preview> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| msg("Bookmark import state is unavailable"))?;
        let session = state
            .sessions
            .get(&request.session_id)
            .filter(|s| s.owner == owner)
            .ok_or_else(|| msg("Rescan bookmark sources before importing"))?;
        let mut seen = HashSet::new();
        let mut bookmarks = Vec::new();
        let mut skipped = 0;
        let mut files = Vec::new();
        for id in request.source_ids {
            if !seen.insert(id.clone()) {
                return Err(msg("A bookmark source is selected twice"));
            }
            let source = session
                .sources
                .get(&id)
                .filter(|s| s.error.is_none())
                .ok_or_else(|| msg("A selected bookmark source is unavailable"))?;
            bookmarks.extend_from_slice(&source.parsed.bookmarks);
            skipped += source.skipped;
            files.extend_from_slice(&source.files);
            if bookmarks.len() > MAX_BOOKMARKS {
                return Err(msg(
                    "Select fewer sources: one import supports up to 25,000 links",
                ));
            }
        }
        files.sort();
        files.dedup();
        let plan = Plan {
            id: Uuid::new_v4().to_string(),
            scope: request.expected_scope,
            options: request.options,
            bookmarks,
            skipped,
            files,
        };
        let (eligible, duplicates) = db.preview_bookmarks(&plan)?;
        let result = Preview {
            plan_id: plan.id.clone(),
            eligible,
            duplicates,
            skipped,
            total: plan.bookmarks.len(),
            files: plan.files.clone(),
            scope: plan.scope.clone(),
        };
        // Only keep the latest preview in this session; another window owns its
        // own session. A committed receipt remains durable after release.
        state.plans.retain(|_, (id, _)| id != &request.session_id);
        state
            .plans
            .insert(plan.id.clone(), (request.session_id, plan));
        Ok(result)
    }
    pub fn commit(
        &self,
        db: &Database,
        owner: &str,
        id: &str,
        scope: Option<&Context>,
        progress: impl FnMut(usize, usize),
    ) -> Result<ImportResult> {
        let plan = {
            let state = self
                .0
                .lock()
                .map_err(|_| msg("Bookmark import state is unavailable"))?;
            state.plans.get(id).and_then(|(session, plan)| {
                state
                    .sessions
                    .get(session)
                    .filter(|s| s.owner == owner)
                    .map(|_| plan.clone())
            })
        };
        if let Some(plan) = plan {
            if plan.scope.as_ref() != scope {
                return Err(msg(
                    "The workspace changed. Review the destination and preview again.",
                ));
            }
            db.import_bookmarks(&plan, progress)
        } else {
            db.bookmark_imports(scope)?
                .into_iter()
                .find(|r| r.id == id)
                .ok_or_else(|| msg("Preview these bookmark files again before importing"))
        }
    }
    pub fn release(&self, owner: &str, session: &str) -> Result<()> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| msg("Bookmark import state is unavailable"))?;
        if state
            .sessions
            .get(session)
            .is_some_and(|s| s.owner == owner)
        {
            state.sessions.remove(session);
            state.plans.retain(|_, (id, _)| id != session);
        }
        Ok(())
    }
}
