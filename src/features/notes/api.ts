import { invoke } from "@tauri-apps/api/core";
import type { NoteDraft, NotePatch, StoredNote, NotesState, NotesContext } from "./types";

export const notesApi = {
  list: () => invoke<StoredNote[]>("list_note_cards"),
  state: () => invoke<NotesState>("get_notes_state"),
  create: (draft: NoteDraft, expectedScope?: NotesContext | null) =>
    invoke<StoredNote>("create_note_card", { draft, expectedScope: expectedScope ?? null }),
  update: (
    id: string,
    expectedRevision: number,
    patch: NotePatch,
    expectedScope?: NotesContext | null,
    expectedEditToken?: string,
  ) =>
    invoke<StoredNote>("update_note_card", {
      id,
      expectedRevision,
      patch,
      expectedScope: expectedScope ?? null,
      expectedEditToken: expectedEditToken ?? null,
    }),
};
