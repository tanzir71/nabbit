use super::parse::{self, Bookmark, MAX_BOOKMARKS};
use crate::{
    db::Database,
    error::{msg, Result},
    notes::{
        store::{self, EditGuard, NoteDraft, StoredNote},
        sync_store::{self, Context},
    },
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub folders_as_labels: bool,
    pub skip_duplicates: bool,
    pub priority: String,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            folders_as_labels: true,
            skip_duplicates: true,
            priority: "later".into(),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub scope: Option<Context>,
    pub options: Options,
    pub bookmarks: Vec<Bookmark>,
    pub skipped: usize,
    pub files: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub id: String,
    pub imported: usize,
    pub duplicates: usize,
    pub skipped: usize,
    pub undo_available: bool,
    pub first_card_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Guard {
    pub id: String,
    pub edit_token: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum BulkAction {
    Label { labels: Vec<String> },
    Later,
    Archive,
}
fn read_card(conn: &Connection, scope: Option<&Context>, id: &str) -> Result<Option<StoredNote>> {
    let raw: Option<(String, bool, String)> = conn
        .query_row(
            "SELECT value,local_only,edit_token FROM note_cards WHERE scope=?1 AND id=?2",
            params![scope.map_or("", |s| s.key.as_str()), id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    raw.map(|(value, local_only, edit_token)| {
        Ok(StoredNote {
            value: serde_json::from_str(&value)?,
            local_only,
            edit_token,
            scope: scope.cloned(),
        })
    })
    .transpose()
}
pub(crate) fn find_duplicate(
    conn: &Connection,
    scope: Option<&Context>,
    normalized: &str,
) -> Result<Option<StoredNote>> {
    let ids = conn
        .prepare(
            "SELECT id FROM note_cards WHERE scope=?1 AND json_extract(value,'$.kind')='bookmark'",
        )?
        .query_map([scope.map_or("", |s| s.key.as_str())], |r| {
            r.get::<_, String>(0)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for id in ids {
        if let Some(card) = read_card(conn, scope, &id)? {
            if parse::normalized_url(card.value["url"].as_str().unwrap_or_default())
                .ok()
                .as_deref()
                == Some(normalized)
            {
                return Ok(Some(card));
            }
        }
    }
    Ok(None)
}
fn known_urls(conn: &Connection, scope: Option<&Context>) -> Result<HashSet<String>> {
    let urls=conn.prepare("SELECT json_extract(value,'$.url') FROM note_cards WHERE scope=?1 AND json_extract(value,'$.kind')='bookmark'")?.query_map([scope.map_or("",|s|s.key.as_str())],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(urls
        .iter()
        .filter_map(|url| parse::normalized_url(url).ok())
        .collect())
}
/// Explicit local-note upload changes card IDs. Keep each import's undo group
/// with those same cards instead of losing it when the destination changes.
pub(crate) fn remap_local_imports(tx: &rusqlite::Transaction<'_>, scope: &Context) -> Result<()> {
    let imports = tx
        .prepare("SELECT id,ids,result,undone FROM note_imports WHERE scope=''")?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, bool>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (id, raw, result, undone) in imports {
        let ids: Vec<String> = serde_json::from_str(&raw)?;
        if ids.is_empty() {
            continue;
        }
        let mut mapped = Vec::new();
        let mut complete = true;
        for id in ids {
            let uploaded: Option<String> = tx
                .query_row(
                    "SELECT remote_id FROM tack_uploads WHERE local_id=?1 AND scope=?2",
                    params![id, scope.key],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(id) = uploaded {
                mapped.push(id);
            } else {
                complete = false;
                break;
            }
        }
        if complete {
            let mut result: ImportResult = serde_json::from_str(&result)?;
            result.first_card_id = mapped.first().cloned();
            result.undo_available = !undone && !mapped.is_empty();
            tx.execute(
                "UPDATE note_imports SET scope=?1,ids=?2,result=?3 WHERE id=?4 AND scope=''",
                params![
                    scope.key,
                    serde_json::to_string(&mapped)?,
                    serde_json::to_string(&result)?,
                    id
                ],
            )?;
        }
    }
    Ok(())
}
fn valid(plan: &Plan) -> Result<()> {
    if Uuid::parse_str(&plan.id).is_err()
        || plan.bookmarks.len() > MAX_BOOKMARKS
        || !matches!(plan.options.priority.as_str(), "inbox" | "later")
    {
        return Err(msg("Invalid bookmark import options"));
    }
    for b in &plan.bookmarks {
        parse::web_url(&b.url)?;
        if b.title.encode_utf16().count() > 300 {
            return Err(msg("An imported title exceeds 300 characters"));
        }
    }
    Ok(())
}
impl Database {
    pub(crate) fn preview_bookmarks(&self, plan: &Plan) -> Result<(usize, usize)> {
        valid(plan)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        crate::notes::preferences::writable(&conn, plan.scope.as_ref())?;
        let mut known = known_urls(&conn, plan.scope.as_ref())?;
        let mut duplicates = 0;
        for item in &plan.bookmarks {
            if !known.insert(parse::normalized_url(&item.url)?) {
                duplicates += 1;
            }
        }
        Ok((
            if plan.options.skip_duplicates {
                plan.bookmarks.len() - duplicates
            } else {
                plan.bookmarks.len()
            },
            duplicates,
        ))
    }
    pub(crate) fn import_bookmarks(
        &self,
        plan: &Plan,
        mut progress: impl FnMut(usize, usize),
    ) -> Result<ImportResult> {
        valid(plan)?;
        let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(plan)?));
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        crate::notes::preferences::writable(&tx, plan.scope.as_ref())?;
        let key = plan.scope.as_ref().map_or("", |s| s.key.as_str());
        let previous: Option<(String, String, String, bool)> = tx
            .query_row(
                "SELECT scope,digest,result,undone FROM note_imports WHERE id=?1",
                [&plan.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        if let Some((scope, previous, raw, undone)) = previous {
            if scope != key || previous != digest {
                return Err(msg(
                    "This import ID belongs to different files or a different workspace",
                ));
            }
            let mut result: ImportResult = serde_json::from_str(&raw)?;
            result.undo_available = !undone;
            return Ok(result);
        }
        let mut known = known_urls(&tx, plan.scope.as_ref())?;
        let mut ids = Vec::new();
        let mut duplicates = 0;
        for (i, item) in plan.bookmarks.iter().enumerate() {
            let duplicate = !known.insert(parse::normalized_url(&item.url)?);
            if duplicate {
                duplicates += 1;
            }
            if !duplicate || !plan.options.skip_duplicates {
                let id = Uuid::new_v4().to_string();
                store::insert_note_card_dated(
                    &tx,
                    NoteDraft {
                        title: item.title.clone(),
                        kind: Some("bookmark".into()),
                        url: item.url.clone(),
                        labels: if plan.options.folders_as_labels {
                            item.labels.clone()
                        } else {
                            vec![]
                        },
                        priority: Some(plan.options.priority.clone()),
                        ..Default::default()
                    },
                    plan.scope.as_ref(),
                    &id,
                    &json!({}),
                    item.created_at.as_deref(),
                )?;
                ids.push(id);
            }
            if (i + 1) % 50 == 0 || i + 1 == plan.bookmarks.len() {
                progress(i + 1, plan.bookmarks.len());
            }
        }
        let result = ImportResult {
            id: plan.id.clone(),
            imported: ids.len(),
            duplicates,
            skipped: plan.skipped,
            undo_available: !ids.is_empty(),
            first_card_id: ids.first().cloned(),
        };
        tx.execute(
            "INSERT INTO note_imports(id,scope,digest,ids,result) VALUES(?1,?2,?3,?4,?5)",
            params![
                plan.id,
                key,
                digest,
                serde_json::to_string(&ids)?,
                serde_json::to_string(&result)?
            ],
        )?;
        tx.commit()?;
        Ok(result)
    }
    pub(crate) fn bookmark_imports(&self, scope: Option<&Context>) -> Result<Vec<ImportResult>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        sync_store::ensure(&conn, scope)?;
        let raw=conn.prepare("SELECT result,undone FROM note_imports WHERE scope=?1 ORDER BY rowid DESC LIMIT 20")?.query_map([scope.map_or("",|s|s.key.as_str())],|r|Ok((r.get::<_,String>(0)?,r.get::<_,bool>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        raw.into_iter()
            .map(|(raw, undone)| {
                let mut r: ImportResult = serde_json::from_str(&raw)?;
                r.undo_available = r.imported > 0 && !undone;
                Ok(r)
            })
            .collect()
    }
    pub(crate) fn undo_bookmark_import(&self, id: &str, scope: Option<&Context>) -> Result<usize> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        crate::notes::preferences::writable(&tx, scope)?;
        let row: Option<(String, String, bool)> = tx
            .query_row(
                "SELECT scope,ids,undone FROM note_imports WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let (key, raw, undone) = row.ok_or_else(|| msg("This import is no longer available"))?;
        if key != scope.map_or("", |s| s.key.as_str()) {
            return Err(msg(
                "Switch back to the import's workspace before undoing it",
            ));
        }
        if undone {
            return Ok(0);
        }
        let ids: Vec<String> = serde_json::from_str(&raw)?;
        let mut count = 0;
        for id in ids {
            if let Some(note) = read_card(&tx, scope, &id)? {
                if note.value["trashedAt"].is_null() {
                    store::write_note_patch(
                        &tx,
                        EditGuard {
                            id: &id,
                            scope,
                            token: Some(&note.edit_token),
                            revision: 0,
                        },
                        &json!({"trashedAt":sync_store::stamp()}),
                        &[],
                    )?;
                    count += 1;
                }
            }
        }
        tx.execute("UPDATE note_imports SET undone=1 WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(count)
    }
    pub(crate) fn bulk_links(
        &self,
        scope: Option<&Context>,
        guards: &[Guard],
        action: &BulkAction,
    ) -> Result<usize> {
        if guards.is_empty() || guards.len() > MAX_BOOKMARKS {
            return Err(msg("Select links to organise"));
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        crate::notes::preferences::writable(&tx, scope)?;
        let mut seen = HashSet::new();
        for guard in guards {
            if !seen.insert(&guard.id) {
                return Err(msg("A selected link appears twice"));
            }
            let note = read_card(&tx, scope, &guard.id)?
                .ok_or_else(|| msg("A selected link no longer exists"))?;
            if note.value["kind"] != "bookmark" || !note.value["trashedAt"].is_null() {
                return Err(msg("A selected link changed; refresh and select again"));
            }
            let patch = match action {
                BulkAction::Later => json!({"priority":"later"}),
                BulkAction::Archive => json!({"archived":true}),
                BulkAction::Label { labels } => {
                    let mut combined: Vec<String> =
                        serde_json::from_value(note.value["labels"].clone())?;
                    for label in labels {
                        let value = label.trim();
                        if !value.is_empty() && !combined.iter().any(|s| s == value) {
                            combined.push(value.into());
                        }
                    }
                    json!({"labels":combined})
                }
            };
            store::write_note_patch(
                &tx,
                EditGuard {
                    id: &guard.id,
                    scope,
                    token: Some(&guard.edit_token),
                    revision: 0,
                },
                &patch,
                &[],
            )?;
        }
        tx.commit()?;
        Ok(guards.len())
    }
    pub(crate) fn selected_link_urls(
        &self,
        scope: Option<&Context>,
        guards: &[Guard],
    ) -> Result<Vec<String>> {
        if guards.is_empty() || guards.len() > MAX_BOOKMARKS {
            return Err(msg("Select links to open"));
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        sync_store::ensure(&conn, scope)?;
        guards
            .iter()
            .map(|g| {
                let note = read_card(&conn, scope, &g.id)?
                    .ok_or_else(|| msg("A selected link no longer exists"))?;
                if note.edit_token != g.edit_token
                    || note.value["kind"] != "bookmark"
                    || !note.value["trashedAt"].is_null()
                {
                    return Err(msg("A selected link changed; refresh and select again"));
                }
                Ok(parse::web_url(note.value["url"].as_str().unwrap_or_default())?.into())
            })
            .collect()
    }
}
