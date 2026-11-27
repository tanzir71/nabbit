import { invoke } from "@tauri-apps/api/core";
import type { NotesContext, StoredNote } from "./types";
export interface BookmarkSource {
  id: string;
  name: string;
  browser: string;
  files: string[];
  links: number;
  folders: number;
  skipped: number;
  error: string | null;
}
export interface BookmarkCatalog {
  sessionId: string;
  sources: BookmarkSource[];
  readFiles: string[];
}
export interface BookmarkOptions {
  foldersAsLabels: boolean;
  skipDuplicates: boolean;
  priority: "inbox" | "later";
}
export interface BookmarkPreview {
  planId: string;
  eligible: number;
  duplicates: number;
  skipped: number;
  total: number;
  files: string[];
  scope: NotesContext | null;
}
export interface BookmarkImport {
  id: string;
  imported: number;
  duplicates: number;
  skipped: number;
  undoAvailable: boolean;
  firstCardId: string | null;
}
export interface ImportProgress {
  id: string;
  done: number;
  total: number;
  state: "running" | "done" | "failed";
}
export type LinkAction = { kind: "label"; labels: string[] } | { kind: "later" | "archive" };
const guards = (cards: StoredNote[]) =>
  cards.map((card) => ({ id: card.value.id, editToken: card.editToken ?? "" }));
export const linksApi = {
  openUrl: (url: string) => invoke<void>("link_open_url", { url }),
  discover: () => invoke<BookmarkCatalog>("bookmarks_discover"),
  pickHtml: (sessionId: string) =>
    invoke<BookmarkCatalog | null>("bookmarks_pick_html", { sessionId }),
  preview: (
    sessionId: string,
    sourceIds: string[],
    expectedScope: NotesContext | null,
    options: BookmarkOptions,
  ) =>
    invoke<BookmarkPreview>("bookmarks_preview", {
      request: { sessionId, sourceIds, expectedScope, options },
    }),
  commit: (planId: string, expectedScope: NotesContext | null) =>
    invoke<BookmarkImport>("bookmarks_commit", { planId, expectedScope }),
  release: (sessionId: string) => invoke<void>("bookmarks_release", { sessionId }),
  history: (expectedScope: NotesContext | null) =>
    invoke<BookmarkImport[]>("bookmarks_history", { expectedScope }),
  undo: (id: string, expectedScope: NotesContext | null) =>
    invoke<number>("bookmarks_undo", { id, expectedScope }),
  bulk: (cards: StoredNote[], expectedScope: NotesContext | null, action: LinkAction) =>
    invoke<number>("links_bulk", { guards: guards(cards), expectedScope, action }),
  open: (cards: StoredNote[], expectedScope: NotesContext | null) =>
    invoke<number>("links_open", { guards: guards(cards), expectedScope }),
  clean: (url: string) => invoke<string>("link_clean", { url }),
};
