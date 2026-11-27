use super::{geometry::Profile, Binding};
use crate::{
    db::Database,
    error::{msg, Result},
    notes::{
        store::StoredNote,
        sync_store::{self, Context},
    },
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub fn scope_key(scope: Option<&Context>) -> &str {
    scope.map_or("", |s| s.key.as_str())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    pub base: StoredNote,
    pub value: Value,
    pub copy_id: Option<String>,
    pub copy_request: Option<crate::notes::capture::CaptureRequest>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkpoint {
    pub instance: String,
    pub sequence: u64,
    pub draft: Draft,
}
#[derive(Clone, Debug)]
pub struct Saved {
    pub card_id: String,
    pub monitor: String,
    pub last_note: StoredNote,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    pub status: &'static str,
    pub note: Option<StoredNote>,
    pub checkpoint: Option<Checkpoint>,
    pub current_scope: Option<Context>,
    pub read_only: bool,
}
pub fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS sticky_windows(scope TEXT NOT NULL,card_id TEXT NOT NULL,monitor TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,card_id,monitor));
 CREATE TABLE IF NOT EXISTS sticky_cards(scope TEXT NOT NULL,card_id TEXT NOT NULL,monitor TEXT NOT NULL,opened INTEGER NOT NULL,last_note TEXT NOT NULL,PRIMARY KEY(scope,card_id));
 CREATE TABLE IF NOT EXISTS sticky_drafts(scope TEXT NOT NULL,card_id TEXT NOT NULL,instance TEXT NOT NULL,sequence INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,card_id));")?;
    Ok(())
}
impl Database {
    pub fn sticky_save_bound(
        &self,
        binding: &Binding,
        base: StoredNote,
        patch: Value,
    ) -> Result<StoredNote> {
        if base.scope != binding.scope
            || base.value["id"].as_str() != Some(&binding.card_id)
            || patch.as_object().is_none_or(|p| {
                p.keys()
                    .any(|k| !["title", "body", "items"].contains(&k.as_str()))
            })
        {
            return Err(msg("This edit belongs to another sticky note"));
        }
        let current = self.note_editor(&binding.card_id, binding.scope.as_ref())?;
        if current
            .note
            .value
            .get("trashedAt")
            .is_some_and(|v| !v.is_null())
        {
            return Err(msg(
                "This card was removed. Your sticky draft is preserved.",
            ));
        }
        self.update_note_card_in(
            &binding.card_id,
            base.value["revision"].as_u64().unwrap_or(0),
            binding.scope.as_ref(),
            Some(&base.edit_token),
            patch,
        )
    }
    pub fn sticky_profile(
        &self,
        scope: Option<&Context>,
        card: &str,
        monitor: &str,
    ) -> Result<Option<Profile>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        conn.query_row(
            "SELECT value FROM sticky_windows WHERE scope=?1 AND card_id=?2 AND monitor=?3",
            params![scope_key(scope), card, monitor],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .map(|s| serde_json::from_str(&s).map_err(Into::into))
        .transpose()
    }
    pub fn sticky_remember(
        &self,
        binding: &Binding,
        profile: &Profile,
        opened: bool,
        note: Option<&StoredNote>,
    ) -> Result<()> {
        if !profile.valid() {
            return Err(msg("Invalid sticky placement"));
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        let key = scope_key(binding.scope.as_ref());
        tx.execute("INSERT INTO sticky_windows(scope,card_id,monitor,value) VALUES(?1,?2,?3,?4) ON CONFLICT(scope,card_id,monitor) DO UPDATE SET value=excluded.value",params![key,binding.card_id,profile.monitor,serde_json::to_string(profile)?])?;
        if let Some(note) = note {
            tx.execute("INSERT INTO sticky_cards(scope,card_id,monitor,opened,last_note) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(scope,card_id) DO UPDATE SET monitor=excluded.monitor,opened=excluded.opened,last_note=excluded.last_note",params![key,binding.card_id,profile.monitor,opened,serde_json::to_string(note)?])?;
        } else {
            tx.execute(
                "UPDATE sticky_cards SET monitor=?1,opened=?2 WHERE scope=?3 AND card_id=?4",
                params![profile.monitor, opened, key, binding.card_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn sticky_saved(&self, scope: Option<&Context>, only_open: bool) -> Result<Vec<Saved>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let mut statement=conn.prepare("SELECT card_id,monitor,last_note FROM sticky_cards WHERE scope=?1 AND (?2=0 OR opened=1) ORDER BY card_id")?;
        let rows = statement
            .query_map(params![scope_key(scope), only_open], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(card_id, monitor, note)| {
                Ok(Saved {
                    card_id,
                    monitor,
                    last_note: serde_json::from_str(&note)?,
                })
            })
            .collect()
    }
    pub fn sticky_content(&self, binding: &Binding) -> Result<Content> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let current = sync_store::current(&conn)?;
        let key = scope_key(binding.scope.as_ref());
        let same = current == binding.scope;
        let raw: Option<(String, bool, String)> = if same {
            conn.query_row(
                "SELECT value,local_only,edit_token FROM note_cards WHERE scope=?1 AND id=?2",
                params![key, binding.card_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
        } else {
            None
        };
        let mut status = if !same {
            "scopeChanged"
        } else if raw.is_none() {
            "gone"
        } else {
            "ready"
        };
        let note = if let Some((value, local_only, edit_token)) = raw {
            let note = StoredNote {
                value: serde_json::from_str(&value)?,
                local_only,
                scope: binding.scope.clone(),
                edit_token,
            };
            if note.value.get("trashedAt").is_some_and(|v| !v.is_null()) {
                status = "gone";
            }
            conn.execute(
                "UPDATE sticky_cards SET last_note=?1 WHERE scope=?2 AND card_id=?3",
                params![serde_json::to_string(&note)?, key, binding.card_id],
            )?;
            Some(note)
        } else {
            conn.query_row(
                "SELECT last_note FROM sticky_cards WHERE scope=?1 AND card_id=?2",
                params![key, binding.card_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .map(|s| serde_json::from_str(&s))
            .transpose()?
        };
        let checkpoint = conn
            .query_row(
                "SELECT instance,sequence,value FROM sticky_drafts WHERE scope=?1 AND card_id=?2",
                params![key, binding.card_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, u64>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
            .map(|(instance, sequence, value)| -> Result<Checkpoint> {
                Ok(Checkpoint {
                    instance,
                    sequence,
                    draft: serde_json::from_str(&value)?,
                })
            })
            .transpose()?;
        Ok(Content {
            status,
            note,
            checkpoint,
            current_scope: current.clone(),
            read_only: crate::notes::preferences::read_only(&conn, current.as_ref())?,
        })
    }
    pub fn sticky_checkpoint(&self, binding: &Binding, sequence: u64, draft: Draft) -> Result<()> {
        if draft.base.value["id"].as_str() != Some(&binding.card_id)
            || draft.value["id"].as_str() != Some(&binding.card_id)
            || scope_key(draft.base.scope.as_ref()) != scope_key(binding.scope.as_ref())
        {
            return Err(msg("This draft belongs to another note"));
        }
        let raw = serde_json::to_string(&draft)?;
        // Base + edited full card + frozen capture packet may each approach
        // Tack's 3 MB card limit, including preserved future item fields.
        if raw.len() > 9_200_000 || sequence > i64::MAX as u64 {
            return Err(msg("This draft is too large to checkpoint"));
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        conn.execute("INSERT INTO sticky_drafts(scope,card_id,instance,sequence,value) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(scope,card_id) DO UPDATE SET instance=excluded.instance,sequence=excluded.sequence,value=excluded.value WHERE sticky_drafts.instance!=excluded.instance OR sticky_drafts.sequence<=excluded.sequence",params![scope_key(binding.scope.as_ref()),binding.card_id,binding.instance,sequence,raw])?;
        Ok(())
    }
    pub fn sticky_clear_checkpoint(&self, binding: &Binding, sequence: u64) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        conn.execute("DELETE FROM sticky_drafts WHERE scope=?1 AND card_id=?2 AND instance=?3 AND sequence<=?4",params![scope_key(binding.scope.as_ref()),binding.card_id,binding.instance,sequence.min(i64::MAX as u64)])?;
        Ok(())
    }
    pub fn sticky_discard_checkpoint(&self, binding: &Binding) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        conn.execute(
            "DELETE FROM sticky_drafts WHERE scope=?1 AND card_id=?2",
            params![scope_key(binding.scope.as_ref()), binding.card_id],
        )?;
        Ok(())
    }
}
