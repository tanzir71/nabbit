export type ActivityKind =
  "privacy" | "timerEnding" | "download" | "tool" | "link" | "result" | "media" | "timer" | "power";
export interface ActivityPreferences {
  order: ActivityKind[];
  disabled: ActivityKind[];
  showAlertsOverFullscreen: boolean;
  focusMode: boolean;
  hiddenUntilMs: number | null;
}
export const activityOrder: ActivityKind[] = [
  "privacy",
  "timerEnding",
  "download",
  "tool",
  "link",
  "result",
  "media",
  "timer",
  "power",
];
export type ErrorKind =
  | "SignInRequired"
  | "SiteChanged"
  | "MissingJsRuntime"
  | "FormatUnavailable"
  | "Drm"
  | "Disk"
  | "Offline"
  | "Live"
  | "Unknown";
export type SyncStatus =
  | "localOnly"
  | "upToDate"
  | "syncing"
  | "offline"
  | "signedOut"
  | "workspaceChanged"
  | "storageFull"
  | "recoveryPending"
  | "rateLimited"
  | "conflict";
export type DragKind = "url" | "file" | "text";
export type ActivityEvent =
  | {
      kind: "linkDetected";
      url: string;
      title: string | null;
      duration: number | null;
      site: string;
    }
  | {
      kind: "downloadProgress";
      jobId: string;
      title: string;
      percent: number;
      speed: string | null;
      eta: string | null;
    }
  | { kind: "downloadDone"; jobId: string; path: string }
  | { kind: "downloadFailed"; jobId: string; error: ErrorKind }
  | {
      kind: "mediaChanged";
      sessionId: string;
      title: string;
      artist: string;
      playing: boolean;
      timeline: { positionS: number; durationS: number } | null;
      art: string | null;
    }
  | { kind: "timerTick"; id: string; remainingS: number; label: string }
  | { kind: "timerEnded"; id: string }
  | { kind: "privacyChanged"; mic: string[]; camera: string[] }
  | { kind: "powerChanged"; percent: number; charging: boolean }
  | { kind: "noteSaved"; cardId: string; destination: string }
  | { kind: "syncState"; state: SyncStatus }
  | { kind: "fullscreen" | "maximized"; monitor: string; active: boolean }
  | { kind: "dragEnter"; kinds: DragKind[] }
  | { kind: "dragLeave" | "clipboardChanged" | "refresh" }
  | {
      kind: "toolJob";
      jobId: string;
      toolId: string;
      label: string;
      percent: number;
      state: "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
    }
  | {
      kind: "toolResult";
      jobId: string;
      path: string;
      beforeBytes: number;
      afterBytes: number;
      note: string | null;
    }
  | {
      kind: "filesMoved";
      opId: string;
      count: number;
      destination: string;
      verb: "moved" | "copied";
      undoable: boolean;
    }
  | { kind: "linkSaved"; cardId: string; title: string }
  | { kind: "downloadRemoved"; jobId: string }
  | { kind: "dismissed"; id: string }
  | { kind: "preferencesChanged"; preferences: ActivityPreferences };
export interface ActivityItem {
  id: string;
  category: ActivityKind;
  event: ActivityEvent;
  alert: boolean;
  bubbleOnly: boolean;
}
export type Gate = "visible" | "faded" | "hidden";
export interface ActivityView {
  label: string;
  gate: Gate;
  primary: ActivityItem | null;
  bubble: ActivityItem | null;
  queue: ActivityItem[];
  fullscreen: boolean;
  userHidden: boolean;
  focusMode: boolean;
}
export interface ActivitySnapshot {
  revision: number;
  views: ActivityView[];
  preferences: ActivityPreferences;
  syncState: SyncStatus;
}
export type ActivityMessage = ActivityEvent & { target: string | null; snapshot: ActivitySnapshot };
