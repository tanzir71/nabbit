import { create } from "zustand";
import { notesApi } from "../features/notes/api";
import type { NoteDraft, NotePatch, StoredNote, NotesContext } from "../features/notes/types";

interface NotesStore {
  cards: StoredNote[];
  scope: NotesContext | null;
  loading: boolean;
  error: string | null;
  busy: string[];
  refresh: () => Promise<void>;
  createNote: (draft: NoteDraft) => Promise<StoredNote | null>;
  updateNote: (card: StoredNote, patch: NotePatch) => Promise<StoredNote | null>;
}
let loadGeneration = 0;
const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
export const useNotesStore = create<NotesStore>((set, get) => ({
  cards: [],
  scope: null,
  loading: true,
  error: null,
  busy: [],
  refresh: async () => {
    const generation = ++loadGeneration;
    try {
      const state = await notesApi.state();
      if (generation === loadGeneration)
        set({ cards: state.cards, scope: state.scope, loading: false });
    } catch (reason) {
      if (generation === loadGeneration) set({ error: message(reason), loading: false });
    }
  },
  createNote: async (draft) => {
    if (get().busy.includes("new")) return null;
    set((s) => ({ busy: [...s.busy, "new"], error: null }));
    try {
      const scope = get().scope;
      const card = scope ? await notesApi.create(draft, scope) : await notesApi.create(draft);
      await get().refresh();
      return card;
    } catch (reason) {
      set({ error: message(reason) });
      return null;
    } finally {
      set((s) => ({ busy: s.busy.filter((id) => id !== "new") }));
    }
  },
  updateNote: async (card, patch) => {
    const id = card.value.id;
    if (get().busy.includes(id)) return null;
    set((s) => ({ busy: [...s.busy, id], error: null }));
    try {
      const saved =
        card.scope || card.editToken
          ? await notesApi.update(id, card.value.revision, patch, card.scope, card.editToken)
          : await notesApi.update(id, card.value.revision, patch);
      await get().refresh();
      return saved;
    } catch (reason) {
      set({ error: message(reason) });
      await get().refresh();
      return null;
    } finally {
      set((s) => ({ busy: s.busy.filter((item) => item !== id) }));
    }
  },
}));
