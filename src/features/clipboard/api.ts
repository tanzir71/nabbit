import { invoke } from "@tauri-apps/api/core";
import type { ClipboardEntry, AppSettings, StorageStats } from "../../lib/types";
export interface ClipboardSnapshot {
  entries: ClipboardEntry[];
  retentionDays: number;
  total: number;
}
export interface ClipboardPick {
  kind: "copied" | "pasteSent";
  message: string;
}
export const clipboardApi = {
  snapshot: async (): Promise<ClipboardSnapshot> => {
    const [entries, settings, stats] = await Promise.all([
      invoke<ClipboardEntry[]>("list_clipboard_entries", { query: null }),
      invoke<AppSettings>("get_settings"),
      invoke<StorageStats>("get_storage_stats"),
    ]);
    return { entries, retentionDays: settings.retentionDays, total: stats.clipboardCount };
  },
  pick: (id: string, mode: "copy" | "paste") =>
    invoke<ClipboardPick>("island_clipboard_pick", { id, mode }),
  pin: (id: string) => invoke<ClipboardEntry>("toggle_pin_clipboard_entry", { id }),
  remove: (id: string) => invoke<void>("delete_clipboard_entry", { id }),
};
