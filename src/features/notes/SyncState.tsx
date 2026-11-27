import type { TackSyncSnapshot } from "./tackApi";
import { EditorIcon } from "./EditorIcon";
import { syncCopy } from "./syncCopy";
import "./editor.css";

export function SyncState({
  snapshot,
  workspace,
  compact = false,
  busy = false,
  act,
  actionLabel,
}: {
  snapshot: TackSyncSnapshot;
  workspace?: string;
  compact?: boolean;
  busy?: boolean;
  act?: () => void;
  actionLabel?: string;
}) {
  const copy = syncCopy(snapshot, workspace);
  const icon =
    snapshot.state === "localOnly" || snapshot.state === "rateLimited" ? "offline" : snapshot.state;
  return (
    <div
      className={`note-sync ${compact ? "note-sync--compact" : ""}`}
      data-sync-state={snapshot.state}
    >
      <div className="note-sync-copy" role="status" aria-live="polite">
        <span className="note-sync-title">
          <EditorIcon name={compact && snapshot.state === "upToDate" ? "cloud" : icon} />
          <strong>{copy.title}</strong>
        </span>
        <span className="note-sync-detail" title={copy.detail}>
          {copy.detail}
        </span>
      </div>
      {copy.action && act ? (
        <button type="button" disabled={busy || snapshot.state === "syncing"} onClick={act}>
          {actionLabel ?? copy.action}
        </button>
      ) : null}
    </div>
  );
}
