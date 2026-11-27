import type { TackSyncSnapshot } from "./tackApi";
import type { SyncStatus } from "../../lib/activity";
export function syncCopy(sync: TackSyncSnapshot, workspace?: string) {
  const queued = `${sync.pending} ${sync.pending === 1 ? "change" : "changes"} queued on this PC`;
  const states: Record<SyncStatus, { title: string; detail: string; action?: string }> = {
    localOnly: { title: "Local only", detail: "Saved on this device" },
    upToDate: {
      title: sync.pending ? "Changes queued" : sync.lastSynced ? "Synced" : "Ready to sync",
      detail: sync.pending
        ? queued
        : sync.lastSynced
          ? `Tack${workspace ? ` · ${workspace}` : ""} · Last synced ${new Date(sync.lastSynced).toLocaleString()}`
          : "Waiting for the first sync",
    },
    syncing: {
      title: "Syncing",
      detail: sync.pending
        ? `Sending ${sync.pending} ${sync.pending === 1 ? "change" : "changes"}…`
        : "Checking Tack for changes…",
    },
    offline: { title: "Offline", detail: queued, action: "Retry sync" },
    signedOut: {
      title: "Signed out",
      detail: "Your notes and queued changes are kept. Sign in again.",
      action: "Sign in",
    },
    recoveryPending: {
      title: "Recovery pending",
      detail: "Save and confirm your recovery code before syncing.",
      action: "Confirm recovery",
    },
    workspaceChanged: {
      title: "Workspace changed",
      detail: "Your access changed. Choose a workspace again.",
      action: "Choose workspace",
    },
    storageFull: {
      title: "Storage full",
      detail:
        "Workspace hit Tack’s 100 MB limit. Manage attachments in Tack; queued changes are kept.",
      action: "Open Tack",
    },
    rateLimited: {
      title: "Waiting to retry",
      detail: "Tack has limited attempts. Queued changes are kept; sync will retry automatically.",
    },
    conflict: {
      title: "Conflict",
      detail: `${sync.conflicts} ${sync.conflicts === 1 ? "record changed" : "records changed"} in two places.`,
      action: "Review conflicts",
    },
  };
  return states[sync.state];
}
