import { invoke } from "@tauri-apps/api/core";
import type { SyncStatus } from "../../lib/activity";

export type TackErrorCode =
  | "invalidServer" | "invalidResponse" | "invalidInput" | "secureStorage"
  | "signedOut" | "workspaceChanged" | "storageFull" | "recoveryPending"
  | "rateLimited" | "conflict" | "offline";
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
// Request secrets are never placed in a store, console, localStorage or events.
export const tackApi = {
  snapshot: () => invoke<TackConnection>("tack_snapshot"),
  status: (baseUrl: string) => invoke<TackConnection>("tack_status", { baseUrl }),
  login: (username: string, password: string) =>
    invoke<{ connection: TackConnection; recoveryCode: string | null }>("tack_login", { username, password }),
  confirmRecovery: (code: string) => invoke<TackConnection>("tack_confirm_recovery", { code }),
  switchWorkspace: (id: string) => invoke<TackConnection>("tack_switch_workspace", { id }),
  logout: () => invoke<TackConnection>("tack_logout"),
};
