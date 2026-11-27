//! One serial sync pass. SQLite transactions never span a network request.
use super::{
    client::Client,
    model::{Error, ErrorCode, Result},
};
use crate::{
    db::Database,
    notes::sync_store::{Context, Identity, Queued},
};
use std::collections::HashSet;

fn checked_request(
    client: &mut Client,
    identity: &Identity,
    cursor: u64,
    batch: &[Queued],
) -> Result<super::model::SyncReply> {
    let mutations = batch.iter().map(|q| q.mutation.clone()).collect::<Vec<_>>();
    match client.sync(cursor, &mutations) {
        Err(error) if error.code == ErrorCode::Conflict && error.http_status == Some(409) => {
            if let Ok(connection) = client.status() {
                if connection.user.as_ref().map(|u| u.id.as_str()) != Some(&identity.user_id)
                    || connection.workspace.as_ref().map(|w| w.id.as_str())
                        != Some(&identity.workspace_id)
                {
                    return Err(Error::new(ErrorCode::WorkspaceChanged));
                }
            }
            Err(error)
        }
        result => result,
    }
}
fn drain(
    db: &Database,
    context: &Context,
    identity: &Identity,
    client: &mut Client,
    batch: &[Queued],
) -> Result<()> {
    let mut reply = checked_request(client, identity, db.tack_cursor(context)?, batch)?;
    let blocked = reply
        .conflicts
        .iter()
        .map(|r| (r.table.clone(), r.id.clone()))
        .chain(reply.reference_issues.iter().filter_map(|v| {
            Some((
                v.get("table")?.as_str()?.to_owned(),
                v.get("id")?.as_str()?.to_owned(),
            ))
        }))
        .collect::<HashSet<_>>();
    let accepted = batch
        .iter()
        .filter(|q| !blocked.contains(&(q.mutation.table.clone(), q.mutation.id.clone())))
        .cloned()
        .collect::<Vec<_>>();
    for _ in 0..1000 {
        let more = reply.more;
        db.tack_apply(context, &reply, &accepted)?;
        if !more {
            return Ok(());
        }
        reply = checked_request(client, identity, db.tack_cursor(context)?, &[])?;
    }
    Err(Error::new(ErrorCode::InvalidResponse))
}
pub(crate) fn cycle(db: &Database, context: &Context, client: &mut Client) -> Result<()> {
    let identity = db.tack_identity(context)?;
    let connection = client.snapshot();
    if connection.user.is_none() || connection.requires_login {
        return Err(Error::new(ErrorCode::SignedOut));
    }
    if connection.recovery_pending {
        return Err(Error::new(ErrorCode::RecoveryPending));
    }
    if client.endpoint().base().as_str() != identity.base_url
        || connection.user.as_ref().map(|u| u.id.as_str()) != Some(&identity.user_id)
        || connection.workspace.as_ref().map(|w| w.id.as_str()) != Some(&identity.workspace_id)
    {
        return Err(Error::new(ErrorCode::WorkspaceChanged));
    }
    // Pull first also recognizes a previous successful write whose reply was
    // lost before its local acknowledgement, without generating duplicate IDs.
    drain(db, context, &identity, client, &[])?;
    let mut visited = HashSet::new();
    loop {
        let batch = db.tack_batch(context, &visited)?;
        if batch.is_empty() {
            break;
        }
        for entry in &batch {
            visited.insert((entry.mutation.table.clone(), entry.mutation.id.clone()));
        }
        db.tack_attempt(context, &batch)?;
        drain(db, context, &identity, client, &batch)?;
    }
    db.tack_finish(context)?;
    Ok(())
}
