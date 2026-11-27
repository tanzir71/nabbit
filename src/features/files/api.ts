import { invoke } from "@tauri-apps/api/core";
import { startDrag, type Options } from "@crabnebula/tauri-plugin-drag";
export interface Pin {
  id: string;
  kind: "file" | "folder";
  path: string;
  label: string | null;
  slot: number | null;
  alwaysMove: boolean;
  available: boolean;
  cloud: boolean;
  network: boolean;
}
export interface Recent {
  path: string;
  name: string;
  directory: boolean;
  modified: number;
  cloud: boolean;
}
export interface PinPeek {
  token: string;
  path: string;
  items: Recent[];
  watching: boolean;
}
export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
}
export interface Operation {
  id: string;
  destination: { path: string };
  entries: {
    source: { path: string };
    verb: "move" | "copy";
    output: string | null;
    fingerprint: unknown;
    undone: boolean;
  }[];
  reasons: string[];
  bytes: number;
  status: string;
  error: string | null;
}
export interface Target {
  id: string | null;
  token: string | null;
  path: string | null;
}
export const pinTarget = (id: string): Target => ({ id, token: null, path: null });
export const recentTarget = (token: string, path: string): Target => ({ id: null, token, path });
export const filesApi = {
  downloadInfo: (id: string) =>
    invoke<{ path: string; bytes: number; site: string | null }>("files_download_info", { id }),
  pins: () => invoke<Pin[]>("files_pins"),
  save: (draft: {
    id: string | null;
    path: string;
    label: string | null;
    slot: number | null;
    alwaysMove: boolean;
  }) => invoke<string>("files_save_pin", { draft }),
  remove: (id: string) => invoke<void>("files_remove_pin", { id }),
  choose: (folder: boolean) => invoke<string | null>("files_choose", { folder }),
  capabilities: () =>
    invoke<{ folders: [string, string][]; terminal: boolean; code: boolean }>("files_capabilities"),
  action: (target: Target, action: string) => invoke<void>("files_pin_action", { target, action }),
  thumbnail: (target: Target) => invoke<string | null>("files_thumbnail", { target }),
  peek: (id: string) => invoke<PinPeek>("files_peek_open", { id }),
  recent: (token: string) => invoke<Recent[]>("files_peek_items", { token }),
  closePeek: (token: string) => invoke<void>("files_peek_close", { token }),
  plan: (
    paths: string[],
    destination: string | null,
    pinId: string | null = null,
    modifiers: Modifiers = { shift: false, ctrl: false },
    site: string | null = null,
  ) => invoke<Operation>("files_plan", { request: { paths, destination, pinId, modifiers, site } }),
  execute: (id: string, confirmed: boolean) =>
    invoke<Operation>("files_execute", { id, confirmed }),
  undo: (id: string) => invoke<Operation>("files_undo", { id }),
  history: () => invoke<Operation[]>("files_history"),
  suggestions: (paths: string[], site: string | null = null) =>
    invoke<string[]>("files_suggestions", { paths, site }),
  hints: (paths: string[], modifiers: Modifiers) =>
    invoke<Record<string, string>>("files_hints", { paths, modifiers }),
  drag: async (target: Target) => {
    const plan = await invoke<Options>("files_drag_plan", { target });
    await invoke("shelf_drag_active", { active: true });
    try {
      await startDrag(plan);
    } finally {
      await invoke("shelf_drag_active", { active: false });
    }
  },
};
export const pinName = (pin: Pick<Pin, "path" | "label">) =>
  pin.label ||
  pin.path
    .replace(/[\\/]$/u, "")
    .split(/[\\/]/u)
    .pop() ||
  pin.path;
