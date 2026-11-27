import { invoke } from "@tauri-apps/api/core";
import type { SyncStatus } from "../../lib/activity";
import type { NotesContext } from "./types";

export type TackErrorCode =
  | "invalidServer"
  | "invalidResponse"
  | "invalidInput"
  | "secureStorage"
  | "localStorage"
  | "signedOut"
  | "workspaceChanged"
  | "storageFull"
  | "recoveryPending"
  | "rateLimited"
  | "conflict"
  | "offline";
export interface TackError {
  code: TackErrorCode;
  state: SyncStatus;
  httpStatus: number | null;
  retryAfterMs: number | null;
}
export interface TackWorkspace {
  id: string;
  name: string;
  role: string;
  displayName: string;
  userId: string;
  sessionEpoch: number;
}
export interface TackConnection {
  baseUrl: string | null;
  user: { id: string; username: string } | null;
  workspace: TackWorkspace | null;
  workspaces: TackWorkspace[];
  recoveryPending: boolean;
  requiresLogin: boolean;
  /** Authentication is ready; this does not claim notes have synced. */
  ready: boolean;
  error: TackError | null;
}
export interface TackSyncSnapshot {
  state: SyncStatus;
  scope: NotesContext | null;
  pending: number;
  conflicts: number;
  referenceIssues: number;
  lastSynced: string | null;
  error: TackError | null;
  nextAttemptMs: number | null;
}
export interface TackConflict {
  scope: NotesContext;
  table: string;
  id: string;
  token: string;
  local: Record<string, unknown> | null;
  remote: { table: string; id: string; version: number; value: Record<string, unknown> | null };
}
// Request secrets are never placed in a store, console, localStorage or events.
export const tackApi = {
  snapshot: () => invoke<TackConnection>("tack_snapshot"),
  status: (baseUrl: string) => invoke<TackConnection>("tack_status", { baseUrl }),
  login: (username: string, password: string) =>
    invoke<{ connection: TackConnection; recoveryCode: string | null }>("tack_login", {
      username,
      password,
    }),
  confirmRecovery: (code: string) => invoke<TackConnection>("tack_confirm_recovery", { code }),
  switchWorkspace: (id: string) => invoke<TackConnection>("tack_switch_workspace", { id }),
  logout: () => invoke<TackConnection>("tack_logout"),
  syncSnapshot: () => invoke<TackSyncSnapshot>("tack_sync_snapshot"),
  syncNow: () => invoke<TackSyncSnapshot>("tack_sync_now"),
  conflicts: (scope: NotesContext) => invoke<TackConflict[]>("tack_conflicts", { scope }),
  resolve: (conflict: TackConflict, choice: "keepLocal" | "useRemote") =>
    invoke<void>("tack_resolve_conflict", {
      scope: conflict.scope,
      table: conflict.table,
      id: conflict.id,
      token: conflict.token,
      remoteVersion: conflict.remote.version,
      choice,
    }),
  uploadLocal: (scope: NotesContext) => invoke<number>("tack_upload_local_notes", { scope }),
  localMode: () => invoke<void>("tack_local_mode"),
};
