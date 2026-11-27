import { invoke } from "@tauri-apps/api/core";
import type { CardValue, NotePatch, NotesContext, StoredNote } from "./types";
import type { NoteCaptureRequest } from "./api";
export interface StickyProfile {
  monitor: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pinned: boolean;
  opacity: number;
}
export interface StickyBinding {
  instance: string;
  cardId: string;
  scope: NotesContext | null;
}
export interface StickyDraft {
  base: StoredNote;
  value: CardValue;
  copyId?: string;
  copyRequest?: NoteCaptureRequest;
}
export interface StickySnapshot {
  binding: StickyBinding;
  profile: StickyProfile;
  nativeOpacity: boolean;
  theme: import("../../lib/theme").ThemePreference;
  monitors: Array<{ id: string; name: string; primary: boolean; scaleFactor: number }>;
  content: {
    status: "ready" | "gone" | "scopeChanged";
    note: StoredNote | null;
    checkpoint: { instance: string; sequence: number; draft: StickyDraft } | null;
    currentScope: NotesContext | null;
    readOnly: boolean;
  };
}
export const stickyApi = {
  open: (note: StoredNote) =>
    invoke<string>("open_sticky", { id: note.value.id, expectedScope: note.scope ?? null }),
  snapshot: () => invoke<StickySnapshot>("sticky_snapshot"),
  ready: (instance: string, height: number) => invoke<void>("sticky_ready", { instance, height }),
  configure: (
    instance: string,
    change: Partial<Pick<StickyProfile, "pinned" | "opacity" | "monitor">>,
  ) => invoke<StickyProfile>("sticky_configure", { request: { instance, ...change } }),
  drag: () => invoke<void>("sticky_drag"),
  leave: () => invoke<void>("sticky_leave"),
  checkpoint: (binding: StickyBinding, sequence: number, draft: StickyDraft) =>
    invoke<void>("sticky_checkpoint", { instance: binding.instance, sequence, draft }),
  clear: (binding: StickyBinding, sequence: number) =>
    invoke<void>("sticky_clear_checkpoint", { instance: binding.instance, sequence }),
  save: (binding: StickyBinding, sequence: number, base: StoredNote, patch: NotePatch) =>
    invoke<StoredNote>("sticky_save", { instance: binding.instance, sequence, base, patch }),
  reload: (binding: StickyBinding) =>
    invoke<StickySnapshot>("sticky_reload", { instance: binding.instance }),
  close: (binding: StickyBinding, discard = false) =>
    invoke<void>("sticky_close", { instance: binding.instance, discard }),
  copy: (binding: StickyBinding, request: NoteCaptureRequest) =>
    invoke<string>("sticky_save_as_new", { instance: binding.instance, request }),
};
