import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AppSettings } from "../../lib/types";
import { api } from "../../lib/ipc";

export const shortcutActions = [
  {
    id: "island",
    field: "islandShortcut",
    title: "Open or close the island",
    fallback: "Alt+Space",
  },
  { id: "quickNote", field: "quickNoteShortcut", title: "Quick note", fallback: "Ctrl+Alt+N" },
  {
    id: "download",
    field: "quickDownloadShortcut",
    title: "Download link on clipboard",
    fallback: "Ctrl+Alt+D",
  },
  {
    id: "clipboard",
    field: "clipboardSearchShortcut",
    title: "Clipboard history",
    fallback: "Ctrl+Alt+V",
  },
  {
    id: "timer",
    field: "focusTimerShortcut",
    title: "Start or stop focus timer",
    fallback: "Ctrl+Alt+T",
  },
  {
    id: "hideIsland",
    field: "hideIslandShortcut",
    title: "Hide island for an hour",
    fallback: "Ctrl+Alt+H",
  },
  {
    id: "selection",
    field: "selectedTextShortcut",
    title: "Act on selected text",
    fallback: "Ctrl+Alt+S",
  },
  {
    id: "toggleTray",
    field: "togglePopoverShortcut",
    title: "Toggle tray (legacy)",
    fallback: "CmdOrCtrl+Shift+V",
  },
] as const;
export type ShortcutAction = (typeof shortcutActions)[number];
export interface ShortcutStatus {
  id: ShortcutAction["id"];
  shortcut: string;
  activeShortcut: string | null;
  problem: { shortcut: string; message: string; conflict: boolean } | null;
}
export interface ShortcutsSnapshot {
  rows: ShortcutStatus[];
  recording: boolean;
  cleanupError: string | null;
  injected: boolean;
}
export const shortcutValue = (settings: AppSettings, action: ShortcutAction) =>
  settings[action.field] ?? action.fallback;
export function keycaps(value: string) {
  return value
    .split("+")
    .map((key) => {
      const lower = key.trim().toLowerCase();
      if (["control", "ctrl", "cmdorctrl", "commandorcontrol"].includes(lower)) return "Ctrl";
      if (["super", "meta", "win", "command"].includes(lower)) return "Win";
      if (
        ["alt", "shift", "space", "enter", "tab", "delete", "backspace", "escape"].includes(lower)
      )
        return lower[0].toUpperCase() + lower.slice(1);
      return key
        .trim()
        .replace(/^(Key|Digit)([A-Z0-9])$/i, "$2")
        .replace(/^f(\d+)$/i, "F$1");
    })
    .filter(Boolean);
}
export function recordedShortcut(
  event: Pick<
    KeyboardEvent,
    | "key"
    | "code"
    | "ctrlKey"
    | "altKey"
    | "shiftKey"
    | "metaKey"
    | "isComposing"
    | "keyCode"
    | "repeat"
  >,
): string | null {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    event.repeat ||
    ["Control", "Alt", "AltGraph", "Shift", "Meta", "Dead", "Unidentified"].includes(event.key)
  )
    return null;
  const modifiers = [
    event.ctrlKey && "Ctrl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.metaKey && "Super",
  ].filter(Boolean);
  if (!modifiers.length && !/^F(?:[1-9]|1\d|2[0-4])$/.test(event.key)) return null;
  const key = event.code.startsWith("Numpad")
    ? event.code
    : /^[a-z0-9]$/i.test(event.key)
      ? event.key.toUpperCase()
      : event.code || (event.key === " " ? "Space" : event.key);
  return [...modifiers, key].join("+");
}
export function serializeRecordings(send: (token: string, active: boolean) => Promise<void>) {
  let pending = Promise.resolve();
  return (token: string, active: boolean) => {
    const result = pending.then(() => send(token, active));
    pending = result.catch(() => {});
    return result;
  };
}
// Preserve start/stop order when the user changes rows during an IPC request.
const sendRecording = serializeRecordings((token, active) =>
  invoke<void>("shortcuts_recording", { token, active }),
);
export const shortcutsApi = {
  snapshot: async (): Promise<ShortcutsSnapshot> => {
    if (isTauri()) return invoke("shortcuts_snapshot");
    const settings = await api.getSettings();
    return {
      rows: shortcutActions.map((a) => ({
        id: a.id,
        shortcut: shortcutValue(settings, a),
        activeShortcut: shortcutValue(settings, a) || null,
        problem: null,
      })),
      recording: false,
      cleanupError: null,
      injected: true,
    };
  },
  recording: (token: string, active: boolean) =>
    isTauri() ? sendRecording(token, active) : Promise.resolve(),
};
