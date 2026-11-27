import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { api } from "../../lib/ipc";
import { tackApi, type TackConnection, type TackProfile, type TackSyncSnapshot } from "./tackApi";
import { tackError } from "./tackErrors";
import { TackConnectionSheet } from "./TackConnectionSheet";
import "./tack.css";
import { SyncState } from "./SyncState";
import { ConflictSheet } from "./ConflictSheet";

type Data = { connection: TackConnection; profile: TackProfile; sync: TackSyncSnapshot };
export function TackSettings({
  compact = false,
  editor = false,
}: {
  compact?: boolean;
  editor?: boolean;
}) {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState("");
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  const generation = useRef(0),
    alive = useRef(true),
    working = useRef(false);
  const reload = useRef(async () => {});
  reload.current = async () => {
    const request = ++generation.current;
    try {
      const [connection, profile, sync] = await Promise.all([
        tackApi.snapshot(),
        tackApi.profile(),
        tackApi.syncSnapshot(),
      ]);
      if (alive.current && request === generation.current) setData({ connection, profile, sync });
    } catch (reason) {
      if (alive.current && request === generation.current) setError(tackError(reason).message);
    }
  };
  useEffect(() => {
    alive.current = true;
    let active = true;
    const cleanups: Array<() => void> = [];
    let signature = "";
    const keep = (stop: () => void) => {
      if (active) cleanups.push(stop);
      else stop();
    };
    void Promise.all([
      api
        .onEvent<TackSyncSnapshot>("tack:sync", (sync) => {
          if (!active) return;
          setData((current) => (current ? { ...current, sync } : current));
          const key = JSON.stringify([
            sync.scope,
            sync.error?.code,
            ["signedOut", "recoveryPending", "workspaceChanged", "localOnly"].includes(sync.state)
              ? sync.state
              : null,
          ]);
          if (key !== signature) {
            signature = key;
            void reload.current();
          }
        })
        .then(keep),
      api
        .onEvent<void>("notes:updated", () => {
          if (active) void reload.current();
        })
        .then(keep),
    ])
      .then(() => {
        if (active) void reload.current();
      })
      .catch((reason) => {
        if (active) setError(tackError(reason).message);
      });
    return () => {
      alive.current = false;
      active = false;
      cleanups.forEach((stop) => stop());
    };
  }, []);
  const act = async (action: () => Promise<unknown>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      await reload.current();
    } catch (reason) {
      if (alive.current) setError(tackError(reason).message);
      await reload.current();
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const authenticated = !!data?.connection.user && !data.connection.requiresLogin;
  const problem = data?.sync.error ?? data?.connection.error;
  const problemCopy =
    data?.connection.recoveryPending && problem?.code === "conflict"
      ? "Sign in again to receive and confirm a new recovery code."
      : tackError(problem).message;
  const openSheet = () => {
    setError("");
    setOpen(true);
  };
  const syncAction = () => {
    if (data?.sync.state === "conflict") setReview(true);
    else if (data?.sync.state === "offline") void act(tackApi.syncNow);
    else if (data?.sync.state === "storageFull") void act(tackApi.open);
    else openSheet();
  };
  return (
    <>
      {compact ? (
        <div className="tack-compact">
          {data ? (
            <SyncState
              snapshot={data.sync}
              workspace={data.connection.workspace?.name}
              compact
              busy={busy}
              act={syncAction}
            />
          ) : (
            <span>Loading sync status…</span>
          )}
          {!editor ? (
            <button type="button" disabled={!data || busy} onClick={openSheet}>
              {authenticated ? "Tack settings" : "Connect Tack"}
            </button>
          ) : null}
          {!editor && data?.connection.checked ? (
            <button type="button" disabled={busy} onClick={() => void act(tackApi.open)}>
              Open Tack
            </button>
          ) : null}
        </div>
      ) : (
        <div className="tack-settings">
          {data ? (
            <SyncState
              snapshot={data.sync}
              workspace={data.connection.workspace?.name}
              busy={busy}
              act={syncAction}
            />
          ) : null}
          <div>
            <strong>
              {authenticated
                ? `Signed in as ${data.connection.user?.username}`
                : "Keep notes on this PC or connect your Tack"}
            </strong>
            <p className="tack-help">
              {authenticated
                ? data.connection.workspace?.name
                : "Use your own server. Notes stay local until you choose to sync."}
            </p>
            {data?.profile.readOnly ? <p className="tack-help">Read-only workspace</p> : null}
          </div>
          {data?.connection.baseUrl ? <code>{data.connection.baseUrl}</code> : null}
          <div className="tack-settings-actions">
            <Button variant="primary" disabled={!data || busy} onClick={openSheet}>
              {authenticated && data.connection.ready ? "Workspace & scope" : "Connect Tack"}
            </Button>
            {authenticated ? (
              <>
                <Button disabled={busy} onClick={() => void act(tackApi.logout)}>
                  Sign out
                </Button>
                <Button disabled={busy} onClick={() => void act(tackApi.localMode)}>
                  Use local notes only
                </Button>
              </>
            ) : null}
            {data?.connection.checked ? (
              <Button variant="ghost" disabled={busy} onClick={() => void act(tackApi.open)}>
                Open Tack
              </Button>
            ) : null}
          </div>
          {data?.sync.pending ? (
            <p className="tack-help">
              {data.sync.pending} queued {data.sync.pending === 1 ? "change" : "changes"} saved on
              this PC.
            </p>
          ) : null}
          <p className="tack-help">
            Signing out exports queued changes before removing the secure session. Local notes are
            kept.
          </p>
          {problem ? (
            <p className="tack-error" role="status">
              {problemCopy}
            </p>
          ) : null}
        </div>
      )}
      {error ? (
        <p className="tack-error" role="alert">
          {error}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setError("");
              void reload.current();
            }}
          >
            Try again
          </Button>
        </p>
      ) : null}
      {open && data ? (
        <TackConnectionSheet
          initial={data.connection}
          profile={data.profile}
          close={() => setOpen(false)}
          complete={() => {
            setOpen(false);
            void reload.current();
          }}
        />
      ) : null}
      {review && data?.sync.scope ? (
        <ConflictSheet
          scope={data.sync.scope}
          close={() => {
            setReview(false);
            void reload.current();
          }}
        />
      ) : null}
    </>
  );
}
