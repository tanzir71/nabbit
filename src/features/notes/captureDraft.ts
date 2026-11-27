import type { NoteCaptureRequest, ReminderValue } from "./api";
import type { NotesContext, StoredNote, NoteKind } from "./types";
import { parseCapture, parts } from "./parseCapture";
export interface CaptureDraft {
  text: string;
  scope: NotesContext | null;
  id: string;
  clock: string;
  zone: string;
}
export const sameScope = (a: NotesContext | null | undefined, b: NotesContext | null | undefined) =>
  (a?.key ?? null) === (b?.key ?? null) && (a?.epoch ?? null) === (b?.epoch ?? null);
export const blankCapture = (scope: NotesContext | null): CaptureDraft => ({
  text: "",
  scope,
  id: crypto.randomUUID(),
  clock: new Date().toISOString(),
  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});
export function restoreCapture(raw: string | undefined, scope: NotesContext | null): CaptureDraft {
  try {
    const d = JSON.parse(raw ?? "null") as CaptureDraft | null;
    if (
      d &&
      typeof d.text === "string" &&
      typeof d.id === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(d.id) &&
      typeof d.clock === "string" &&
      Number.isFinite(Date.parse(d.clock)) &&
      typeof d.zone === "string" &&
      (d.scope === null ||
        (typeof d.scope?.key === "string" && Number.isSafeInteger(d.scope.epoch)))
    )
      return d;
  } catch {
    /* A missing/old draft must not prevent opening Notes. */
  }
  return blankCapture(scope);
}
export function prepareCapture(draft: CaptureDraft, forceKind?: NoteKind): NoteCaptureRequest {
  const parsed = parseCapture(draft.text, new Date(draft.clock), draft.zone);
  // Nabbit's v2 data model has cards, not repository imports or a project/roster browser.
  // Keep unresolved references visible in the note instead of silently dropping them.
  let title = parsed.title;
  for (const literal of [
    parsed.assignee ? `@${parsed.assignee}` : "",
    parsed.project ? `+${parsed.project}` : "",
  ]) {
    if (literal && !title.split(/\s+/).includes(literal)) title = (title + " " + literal).trim();
  }
  const kind = forceKind ?? (parsed.kind === "repo" ? "bookmark" : parsed.kind);
  const reminder: ReminderValue | undefined = parsed.reminder
    ? {
        id: `reminder:card:${draft.id}`,
        revision: 0,
        entityId: draft.id,
        entityType: "card",
        ...parsed.reminder,
        anchorDay: parts(new Date(parsed.reminder.at), parsed.reminder.timeZone).day,
        snoozedUntil: null,
        lastCompletedAt: null,
        enabled: true,
      }
    : undefined;
  return {
    requestId: draft.id,
    expectedScope: draft.scope,
    draft: { title, kind, priority: parsed.priority, labels: parsed.labels, url: parsed.url },
    patch:
      forceKind === "checklist"
        ? { items: [{ id: `${draft.id}:item0`, text: "", checked: false }] }
        : {},
    reminders: reminder ? [{ id: reminder.id, expectedToken: null, value: reminder }] : [],
  };
}
export function captureCard(request: NoteCaptureRequest): StoredNote {
  const now = new Date().toISOString(),
    d = request.draft;
  return {
    localOnly: request.expectedScope === null,
    scope: request.expectedScope,
    editToken: "unsaved",
    value: {
      id: request.requestId,
      revision: 0,
      assigneeId: null,
      ref: "",
      doneWhen: "",
      frontmatter: "",
      title: d.title,
      body: d.body ?? "",
      kind: d.kind ?? "note",
      url: d.url ?? "",
      items: (d.items ?? []).map((text, index) => ({
        id: `${request.requestId}:item${index}`,
        text,
        checked: false,
      })),
      labels: d.labels ?? [],
      priority: d.priority ?? "inbox",
      color: d.color ?? "default",
      pinned: false,
      archived: false,
      trashedAt: null,
      completed: false,
      attachmentIds: [],
      rank: "a0",
      projectId: null,
      sourceId: null,
      createdAt: now,
      updatedAt: now,
      ...request.patch,
    },
  };
}
