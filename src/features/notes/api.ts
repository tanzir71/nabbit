import { invoke } from "@tauri-apps/api/core";
import type { NoteDraft, NotePatch, StoredNote } from "./types";

export const notesApi = {
  list: () => invoke<StoredNote[]>("list_note_cards"),
  create: (draft: NoteDraft) => invoke<StoredNote>("create_note_card", { draft }),
  update: (id: string, expectedRevision: number, patch: NotePatch) =>
    invoke<StoredNote>("update_note_card", { id, expectedRevision, patch }),
};
