import { invoke } from "@tauri-apps/api/core";
import type { NoteDraft, NotePatch, StoredNote, NotesState, NotesContext } from "./types";

export const notesApi = {
  capture: (request: NoteCaptureRequest) => invoke<StoredNote>("capture_note", { request }),
  open: (intent: NotesIntent) => invoke<void>("notes_open", { intent }),
  takeIntent: () =>
    invoke<{ navigation: NotesNavigation | null; shortcutError: string | null }>(
      "take_notes_intent",
    ),
  editor: (id: string, expectedScope?: NotesContext | null) =>
    invoke<NoteEditorData>("get_note_editor", { id, expectedScope: expectedScope ?? null }),
  saveEditor: (card: StoredNote, patch: NotePatch, reminders: ReminderEdit[]) =>
    invoke<StoredNote>("save_note_editor", {
      request: {
        id: card.value.id,
        expectedRevision: card.value.revision,
        expectedEditToken: card.editToken,
        expectedScope: card.scope ?? null,
        patch,
        reminders,
      },
    }),
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

export interface ReminderValue {
  id: string;
  revision: number;
  entityId: string;
  entityType: "card";
  at: string;
  timeZone: string;
  repeat: "none" | "daily" | "weekdays" | "weekly" | "monthly";
  anchorDay: number;
  snoozedUntil: string | null;
  lastCompletedAt: string | null;
  enabled: boolean;
  [key: string]: unknown;
}
export interface StoredReminder {
  value: ReminderValue;
  editToken: string;
}
export interface ReminderEdit {
  id: string;
  expectedToken: string | null;
  value: ReminderValue | null;
}
export interface NoteEditorData {
  note: StoredNote;
  reminders: StoredReminder[];
  attachments: Array<{ id: string; name: string; mime: string; data: string }>;
  revisions: Array<{ value: Record<string, unknown> | null; reason: string; savedAt: string }>;
}
export interface NoteCaptureRequest {
  requestId: string;
  expectedScope: NotesContext | null;
  draft: NoteDraft;
  patch: NotePatch;
  reminders: ReminderEdit[];
}
export type NotesIntent =
  | { kind: "capture" | "all" }
  | { kind: "new"; request: NoteCaptureRequest }
  | { kind: "card"; id: string; expectedScope: NotesContext | null };
export interface NotesNavigation {
  id: string;
  intent: NotesIntent;
}
