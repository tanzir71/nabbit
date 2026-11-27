import type { ActivityItem } from "./activity";
import { downloadErrorTitle } from "./downloadErrors";

export type CompactKind =
  | "volume"
  | "idle"
  | "link"
  | "download"
  | "media"
  | "timer"
  | "privacy"
  | "power"
  | "done"
  | "error"
  | "note"
  | "moved"
  | "result"
  | "tool";
export const compactWidths: Record<CompactKind, number> = {
  volume: 272,
  idle: 112,
  link: 336,
  download: 320,
  media: 272,
  timer: 240,
  privacy: 232,
  power: 232,
  done: 348,
  error: 348,
  note: 272,
  moved: 312,
  result: 340,
  tool: 300,
};
export function compactKind(item: ActivityItem | null): CompactKind {
  switch (item?.event.kind) {
    case "volumeChanged":
      return "volume";
    case "linkDetected":
      return "link";
    case "downloadProgress":
      return "download";
    case "mediaChanged":
      return "media";
    case "timerTick":
    case "timerEnded":
      return "timer";
    case "privacyChanged":
      return "privacy";
    case "powerChanged":
      return "power";
    case "downloadDone":
      return "done";
    case "downloadFailed":
      return "error";
    case "noteSaved":
    case "linkSaved":
      return "note";
    case "filesMoved":
      return "moved";
    case "toolResult":
      return "result";
    case "toolJob":
      return "tool";
    default:
      return "idle";
  }
}
export const percent = (value: number) =>
  Math.round(Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0);
export function duration(value: number) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export const basename = (path: string) => path.split(/[\\/]/).pop() || path;
export function bytes(value: number) {
  return value >= 1e9
    ? `${Number((value / 1e9).toFixed(1))} GB`
    : value >= 1e6
      ? `${Number((value / 1e6).toFixed(1))} MB`
      : `${Number((value / 1e3).toFixed(1))} KB`;
}
export function activityTitle(item: ActivityItem) {
  const e = item.event;
  switch (e.kind) {
    case "volumeChanged":
      return `Volume ${e.percent}%`;
    case "linkDetected":
      return e.title || e.site || "Link copied";
    case "downloadProgress":
      return e.title;
    case "downloadDone":
      return basename(e.path);
    case "downloadFailed":
      return e.jobId === "engine-health"
        ? "Download engine needs an update"
        : downloadErrorTitle[e.error];
    case "mediaChanged":
      return e.title;
    case "timerTick":
      return e.label || "Focus";
    case "timerEnded":
      return "Time is up";
    case "privacyChanged":
      return [...new Set([...e.mic, ...e.camera])].join(", ");
    case "powerChanged":
      return e.charging ? "Charging" : "Battery low";
    case "noteSaved":
      return `Saved ${e.destination.startsWith("this PC") ? "on" : "to"} ${e.destination}`;
    case "linkSaved":
      return e.title;
    case "filesMoved":
      return `${e.verb === "copied" ? "Copied" : "Moved"} to ${basename(e.destination)}`;
    case "toolJob":
      return e.label;
    case "toolResult":
      return basename(e.path);
    default:
      return "Nabbit";
  }
}
export function activityTab(item: ActivityItem | null) {
  if (item?.event.kind === "volumeChanged") return "media" as const;
  switch (item?.category) {
    case "media":
      return "media" as const;
    case "timer":
    case "timerEnding":
      return "timer" as const;
    case "tool":
    case "result":
      return "files" as const;
    default:
      return "nab" as const;
  }
}
