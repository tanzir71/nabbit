import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { PresetChip } from "../../components/PresetChip";
import { Badge } from "../../components/Badge";
import { useNotesStore } from "../../store/notesStore";
import type { CardValue, NotePatch, StoredNote } from "./types";
import {
  notesApi,
  type NoteEditorData,
  type ReminderEdit,
  type ReminderValue,
  type NoteCaptureRequest,
} from "./api";
import { stickyApi } from "./stickyApi";
import { EditorIcon } from "./EditorIcon";
import { editorAssets } from "./editorAssets";
import { TackSettings } from "./TackSettings";
import { tackApi } from "./tackApi";
import "./editor.css";

const colors = ["default", "blue", "purple", "green", "pink", "gray"] as const;
const editable = [
  "title",
  "body",
  "url",
  "items",
  "priority",
  "labels",
  "color",
  "pinned",
  "archived",
  "trashedAt",
  "completed",
  "status",
] as const;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function patch(before: CardValue, after: CardValue): NotePatch {
  return Object.fromEntries(
    editable.filter((key) => !equal(before[key], after[key])).map((key) => [key, after[key]]),
  );
}
const dateInput = (at: string) => {
  const date = new Date(at);
  return Number.isFinite(date.getTime())
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
    : "";
};
export function NoteEditor({
  card,
  close,
  creation,
  onSaved,
}: {
  card: StoredNote;
  close: () => void;
  creation?: NoteCaptureRequest;
  onSaved?: (note: StoredNote) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    title = useId(),
    alive = useRef(true),
    working = useRef(false);
  const [snapshot, setSnapshot] = useState<NoteEditorData | null>(null),
    [draft, setDraft] = useState(card.value),
    [reminders, setReminders] = useState<ReminderValue[]>([]);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmClose, setConfirmClose] = useState(false),
    [reminderOpen, setReminderOpen] = useState(false),
    [labelsOpen, setLabelsOpen] = useState(false),
    [label, setLabel] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [taskOptions, setTaskOptions] = useState(false);
  const [created, setCreated] = useState(false);
  const creating = !!creation && !created;
  const openingSticky = useRef(false);
  const readOnly = useNotesStore((s) => s.readOnly),
    currentScope = useNotesStore((s) => s.scope);
  const moved = !equal(currentScope, card.scope ?? null);
  const reminderEdits: ReminderEdit[] = snapshot
    ? [
        ...reminders
          .filter((r) => !equal(r, snapshot.reminders.find((old) => old.value.id === r.id)?.value))
          .map((r) => ({
            id: r.id,
            expectedToken:
              snapshot.reminders.find((old) => old.value.id === r.id)?.editToken ?? null,
            value: r,
          })),
        ...snapshot.reminders
          .filter((r) => !reminders.some((next) => next.id === r.value.id))
          .map((r) => ({ id: r.value.id, expectedToken: r.editToken, value: null })),
      ]
    : [];
  const edits = snapshot ? patch(snapshot.note.value, draft) : {};
  const hasContent = !!(
    draft.title.trim() ||
    draft.body.trim() ||
    draft.items.some((i) => i.text.trim()) ||
    (draft.kind === "bookmark" && draft.url.trim())
  );
  const dirty =
    (creating && hasContent) || Object.keys(edits).length > 0 || reminderEdits.length > 0;
  const disabled = busy || readOnly || moved || !snapshot;
  const opening = useRef(card);
  const creationFocused = useRef(false);
  useEffect(() => {
    if (!creation || !snapshot || creationFocused.current) return;
    creationFocused.current = true;
    dialog.current
      ?.querySelector<HTMLInputElement>(
        creation.draft.kind === "checklist" ? ".note-editor-item > input" : ".note-editor-title",
      )
      ?.focus();
  }, [creation, snapshot]);
  useEffect(() => {
    alive.current = true;
    let active = true;
    const origin = document.activeElement;
    dialog.current?.showModal();
    const initial = opening.current;
    if (creation) {
      setSnapshot({
        note: initial,
        reminders: creation.reminders
          .filter((r) => r.value)
          .map((r) => ({ value: r.value!, editToken: "" })),
        attachments: [],
        revisions: [],
      });
      setReminders(creation.reminders.flatMap((r) => (r.value ? [r.value] : [])));
      return () => {
        active = false;
        alive.current = false;
        if (origin instanceof HTMLElement && origin.isConnected) origin.focus();
      };
    }
    void notesApi
      .editor(initial.value.id, initial.scope)
      .then((data) => {
        if (active) {
          setSnapshot(data);
          setDraft(data.note.value);
          setReminders(data.reminders.map((r) => r.value));
        }
      })
      .catch(() => {
        if (active)
          setError(
            "This note could not be opened. Its workspace may have changed. Close and reopen it.",
          );
      });
    return () => {
      active = false;
      alive.current = false;
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus();
    };
  }, [creation]);
  const requestClose = () => {
    if (working.current) return;
    if (dirty) setConfirmClose(true);
    else close();
  };
  const save = async (extra: NotePatch = {}, closeAfter = true) => {
    if (working.current || disabled || !snapshot || (creating && !hasContent)) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      const changes = { ...edits, ...extra };
      // A reminder-only change still participates in the card's optimistic transaction.
      if (!Object.keys(changes).length) changes.title = draft.title;
      const saved =
        creating && creation
          ? await notesApi.capture({
              ...creation,
              draft: {
                ...creation.draft,
                title: draft.title,
                body: draft.body,
                url: draft.url,
                kind: draft.kind,
                labels: draft.labels,
                priority: draft.priority,
                color: draft.color,
              },
              patch: {
                ...creation.patch,
                ...changes,
                items: draft.items,
                pinned: draft.pinned,
                completed: draft.completed,
                ...(draft.status ? { status: draft.status } : {}),
              },
              reminders: reminders.map((value) => ({ id: value.id, expectedToken: null, value })),
            })
          : await notesApi.saveEditor(snapshot.note, changes, reminderEdits);
      await useNotesStore.getState().refresh();
      if (alive.current) {
        if (creation) setCreated(true);
        onSaved?.(saved);
        if (closeAfter) close();
        else {
          const data = await notesApi.editor(saved.value.id, saved.scope);
          if (alive.current) {
            setSnapshot(data);
            setDraft(data.note.value);
            setReminders(data.reminders.map((r) => r.value));
          }
        }
      }
      return saved;
    } catch {
      if (alive.current)
        setError(
          "Your draft is still here. This note or a reminder may have changed elsewhere, or saving failed. Close without saving and reopen to review the latest version.",
        );
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const popOut = async () => {
    if (
      openingSticky.current ||
      busy ||
      moved ||
      !snapshot ||
      (creating && !hasContent) ||
      (readOnly && (dirty || creating))
    )
      return;
    openingSticky.current = true;
    try {
      const saved = dirty ? await save({}, false) : snapshot.note;
      if (!saved || !alive.current) return;
      setBusy(true);
      await stickyApi.open(saved);
      if (alive.current) close();
    } catch {
      if (alive.current)
        setError("Your note is saved, but its sticky window could not be opened. Retry Pop out.");
    } finally {
      openingSticky.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const update = <K extends keyof CardValue>(key: K, value: CardValue[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const addReminder = () => {
    const at = new Date();
    at.setDate(at.getDate() + 1);
    at.setHours(9, 0, 0, 0);
    setReminders((rows) => [
      ...rows,
      {
        id: crypto.randomUUID(),
        revision: 0,
        entityId: draft.id,
        entityType: "card",
        at: at.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        repeat: "none",
        anchorDay: at.getDate(),
        snoozedUntil: null,
        lastCompletedAt: null,
        enabled: true,
      },
    ]);
    setReminderOpen(true);
  };
  const changeReminder = (id: string, change: Partial<ReminderValue>) =>
    setReminders((rows) =>
      rows.map((r) =>
        r.id === id
          ? {
              ...r,
              ...change,
              revision:
                (snapshot?.reminders.find((s) => s.value.id === id)?.value.revision ?? -1) + 1,
            }
          : r,
      ),
    );
  return (
    <dialog
      ref={dialog}
      className="note-dialog note-editor"
      data-color={draft.color}
      aria-labelledby={title}
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          void save();
        }
      }}
    >
      <div className="note-sheet">
        <header className="note-editor-toolbar">
          <span className="note-editor-ref">{draft.ref || "Local note"}</span>
          <button
            type="button"
            aria-label="Task properties"
            disabled={draft.kind !== "task"}
            onClick={() => setTaskOptions((v) => !v)}
          >
            <Badge>{draft.kind[0].toUpperCase() + draft.kind.slice(1)}</Badge>
          </button>
          <span className="note-toolbar-spacer" />
          <IconButton
            label="Pop out note"
            disabled={
              busy ||
              moved ||
              !snapshot ||
              (creating && !hasContent) ||
              (readOnly && (dirty || creating))
            }
            onClick={() => void popOut()}
          >
            <EditorIcon name="popOut" />
          </IconButton>
          <IconButton
            label={draft.pinned ? "Unpin note" : "Pin note"}
            active={draft.pinned}
            disabled={disabled}
            onClick={() => update("pinned", !draft.pinned)}
          >
            <EditorIcon name="pin" />
          </IconButton>
          <IconButton
            label="Edit reminders"
            disabled={disabled}
            onClick={() => setReminderOpen((v) => !v)}
          >
            <EditorIcon name="reminder" />
          </IconButton>
          <IconButton
            label={draft.archived ? "Unarchive note" : "Archive note"}
            disabled={disabled}
            onClick={() => void save({ archived: !draft.archived })}
          >
            <EditorIcon name="archive" />
          </IconButton>
          <IconButton
            label={draft.trashedAt ? "Restore note" : "Move note to Trash"}
            disabled={disabled}
            onClick={() =>
              void save({ trashedAt: draft.trashedAt ? null : new Date().toISOString() })
            }
          >
            <EditorIcon name="trash" />
          </IconButton>
          <IconButton label="Close editor" disabled={busy} onClick={requestClose}>
            <EditorIcon name="close" />
          </IconButton>
        </header>
        <div className="note-editor-body">
          <h2 id={title} className="sr-only">
            Note editor
          </h2>
          {moved || readOnly ? (
            <p role="status">
              {moved
                ? "The workspace changed. Your draft is preserved; close and reopen to edit the current workspace."
                : "Read-only workspace"}
            </p>
          ) : null}
          {error ? (
            <p className="notes-error" role="alert">
              {error}
            </p>
          ) : null}
          <input
            className="note-editor-title"
            aria-label="Note title"
            value={draft.title}
            placeholder="Untitled note"
            maxLength={300}
            disabled={disabled}
            onChange={(e) => update("title", e.target.value)}
          />
          <textarea
            className="note-editor-body-input"
            aria-label="Note body"
            value={draft.body}
            placeholder="Take a note…"
            maxLength={200000}
            disabled={disabled}
            rows={draft.body.includes("\n") ? Math.min(12, draft.body.split("\n").length) : 2}
            onChange={(e) => update("body", e.target.value)}
          />
          {draft.kind === "bookmark" ? (
            <label className="note-edit-field">
              Link
              <input
                aria-label="Link URL"
                type="url"
                value={draft.url}
                disabled={disabled}
                onChange={(e) => update("url", e.target.value)}
              />
            </label>
          ) : null}
          {draft.kind === "task" || draft.kind === "checklist" ? (
            <div className="note-editor-items">
              {draft.items.map((item, index) => (
                <div key={item.id} className="note-editor-item" data-checked={item.checked}>
                  <label className="note-editor-check">
                    <input
                      type="checkbox"
                      aria-label={`Complete checklist item ${index + 1}`}
                      checked={item.checked}
                      disabled={disabled}
                      onChange={(e) =>
                        update(
                          "items",
                          draft.items.map((i) =>
                            i.id === item.id ? { ...i, checked: e.target.checked } : i,
                          ),
                        )
                      }
                    />
                    <span>{item.checked ? <EditorIcon name="check" /> : null}</span>
                  </label>
                  <input
                    aria-label={`Checklist item ${index + 1}`}
                    value={item.text}
                    disabled={disabled}
                    maxLength={200000}
                    onChange={(e) =>
                      update(
                        "items",
                        draft.items.map((i) =>
                          i.id === item.id ? { ...i, text: e.target.value } : i,
                        ),
                      )
                    }
                  />
                  <IconButton
                    label={`Remove item ${index + 1}`}
                    size={28}
                    disabled={disabled}
                    onClick={() =>
                      update(
                        "items",
                        draft.items.filter((i) => i.id !== item.id),
                      )
                    }
                  >
                    <EditorIcon name="close" />
                  </IconButton>
                </div>
              ))}
              <button
                className="note-editor-add"
                type="button"
                disabled={disabled}
                onClick={() =>
                  update("items", [
                    ...draft.items,
                    { id: crypto.randomUUID(), text: "", checked: false },
                  ])
                }
              >
                <EditorIcon name="plus" />
                List item
              </button>
            </div>
          ) : null}
          {draft.attachmentIds.length ? (
            <section className="note-attachments" aria-label="Read-only attachments">
              {snapshot?.attachments.map((a) => (
                <figure key={a.id}>
                  <img
                    src={
                      a.data.startsWith(`data:${a.mime};base64,`)
                        ? a.data
                        : `data:${a.mime};base64,${a.data}`
                    }
                    alt={a.name || "Note attachment"}
                  />
                  <figcaption>{a.name}</figcaption>
                </figure>
              ))}
              <p>
                {draft.attachmentIds.length} read-only{" "}
                {draft.attachmentIds.length === 1 ? "attachment" : "attachments"}
              </p>
              {snapshot && snapshot.attachments.length < draft.attachmentIds.length ? (
                <p>Some previews aren’t available on this PC. Open Tack to view all attachments.</p>
              ) : null}
              <Button
                size="sm"
                onClick={() =>
                  void tackApi.open().catch(() => setError("Tack could not be opened."))
                }
              >
                Open in Tack to edit
              </Button>
            </section>
          ) : null}
          {historyOpen ? (
            <section className="note-history" aria-label="Note history">
              {snapshot?.revisions.length ? (
                snapshot.revisions.map((r, i) => (
                  <article key={i}>
                    <h3>
                      {new Date(r.savedAt).toLocaleString()} ·{" "}
                      {r.reason === "kept-this-pc"
                        ? "Tack version kept in history"
                        : "This PC version kept in history"}
                    </h3>
                    <pre>
                      {typeof r.value?.body === "string"
                        ? r.value.body
                        : JSON.stringify(r.value, null, 2)}
                    </pre>
                  </article>
                ))
              ) : (
                <p>No conflict revisions for this note.</p>
              )}
            </section>
          ) : null}
        </div>
        <div className="note-editor-properties">
          <div className="note-property">
            <span>Priority</span>
            <div role="group" aria-label="Note priority">
              {(["inbox", "now", "next", "later"] as const).map((p) => (
                <PresetChip
                  key={p}
                  selected={draft.priority === p}
                  disabled={disabled}
                  onClick={() => update("priority", p)}
                >
                  {p[0].toUpperCase() + p.slice(1)}
                </PresetChip>
              ))}
            </div>
          </div>
          <div className="note-property">
            <span>Colour</span>
            <div
              className="note-colours"
              role="group"
              aria-label="Note colour"
              data-original={draft.color === "green"}
            >
              {draft.color === "green" ? (
                <img
                  src={editorAssets.palette.src}
                  width={172}
                  height={22}
                  alt=""
                  data-asset={editorAssets.palette.file}
                />
              ) : null}
              {colors.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="note-colour"
                  data-color={color}
                  aria-label={`${color[0].toUpperCase() + color.slice(1)} colour`}
                  aria-pressed={draft.color === color}
                  disabled={disabled}
                  onClick={() => update("color", color)}
                />
              ))}
            </div>
          </div>
          <div className="note-property">
            <span>Labels</span>
            <div className="note-labels">
              {draft.labels.map((l) => (
                <PresetChip
                  key={l}
                  disabled={disabled}
                  aria-label={`Remove label ${l}`}
                  onClick={() =>
                    update(
                      "labels",
                      draft.labels.filter((s) => s !== l),
                    )
                  }
                >
                  #{l}
                </PresetChip>
              ))}
              <PresetChip disabled={disabled} onClick={() => setLabelsOpen((v) => !v)}>
                Add
              </PresetChip>
            </div>
          </div>
          {labelsOpen ? (
            <form
              className="note-label-form"
              onSubmit={(e) => {
                e.preventDefault();
                const next = label.trim().replace(/^#/, "");
                if (next && !draft.labels.includes(next)) {
                  update("labels", [...draft.labels, next]);
                  setLabel("");
                }
              }}
            >
              <label>
                Add label
                <input
                  aria-label="Add label"
                  value={label}
                  maxLength={100}
                  disabled={disabled}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              <Button type="submit" size="sm" disabled={disabled || !label.trim()}>
                Add label
              </Button>
            </form>
          ) : null}
          <div className="note-property">
            <span>Reminder</span>
            <button
              type="button"
              className="note-reminder-summary"
              disabled={disabled}
              onClick={() => {
                if (reminders.length) setReminderOpen((v) => !v);
                else addReminder();
              }}
            >
              <EditorIcon name="bell" />
              {reminders.length
                ? `${new Date(reminders[0].at).toLocaleString()}${reminders[0].repeat !== "none" ? ` · ${reminders[0].repeat}` : ""}${reminders.length > 1 ? ` +${reminders.length - 1}` : ""}`
                : "Add reminder"}
            </button>
          </div>
          {reminderOpen ? (
            <fieldset className="note-reminder-fields">
              <legend>Reminders · times shown in this PC’s time zone</legend>
              {reminders.map((r, index) => (
                <div className="note-reminder-row" key={r.id}>
                  <label>
                    Date and time
                    <input
                      type="datetime-local"
                      aria-label={`Reminder ${index + 1} date and time`}
                      value={dateInput(r.at)}
                      disabled={disabled}
                      onChange={(e) => {
                        const date = new Date(e.target.value);
                        if (Number.isFinite(date.getTime()))
                          changeReminder(r.id, {
                            at: date.toISOString(),
                            anchorDay: date.getDate(),
                            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                            snoozedUntil: null,
                          });
                      }}
                    />
                  </label>
                  <label>
                    Repeat
                    <select
                      aria-label={`Reminder ${index + 1} repeat`}
                      value={r.repeat}
                      disabled={disabled}
                      onChange={(e) =>
                        changeReminder(r.id, { repeat: e.target.value as ReminderValue["repeat"] })
                      }
                    >
                      {["none", "daily", "weekdays", "weekly", "monthly"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      disabled={disabled}
                      onChange={(e) => changeReminder(r.id, { enabled: e.target.checked })}
                    />
                    Enabled
                  </label>
                  <Button
                    size="sm"
                    disabled={disabled}
                    onClick={() => setReminders((rows) => rows.filter((s) => s.id !== r.id))}
                  >
                    Remove reminder {index + 1}
                  </Button>
                </div>
              ))}
              <Button size="sm" disabled={disabled} onClick={addReminder}>
                Add reminder
              </Button>
              <p>Due reminders are saved and synced. Notifications are coming later.</p>
            </fieldset>
          ) : null}
          {draft.kind === "task" && taskOptions ? (
            <label className="note-task-status">
              Status
              <select
                aria-label="Task status"
                value={draft.status ?? (draft.completed ? "done" : "open")}
                disabled={disabled}
                onChange={(e) => {
                  const status = e.target.value as CardValue["status"];
                  setDraft((d) => ({ ...d, status, completed: status === "done" }));
                }}
              >
                {["open", "active", "blocked", "done"].map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            </label>
          ) : null}
          {dirty || creating ? (
            <div className="note-save-actions">
              <span role="status">Unsaved changes</span>
              <Button
                variant="primary"
                size="sm"
                disabled={disabled || (creating && !hasContent)}
                onClick={() => void save()}
              >
                Save note
              </Button>
            </div>
          ) : null}
          {confirmClose ? (
            <div className="notes-error" role="alert">
              Save your changes before closing?
              <div className="note-save-actions">
                <Button size="sm" disabled={disabled} onClick={() => void save()}>
                  Save and close
                </Button>
                <Button size="sm" onClick={close} disabled={busy}>
                  Close without saving
                </Button>
                <Button size="sm" onClick={() => setConfirmClose(false)}>
                  Keep editing
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        <footer className="note-editor-footer">
          <TackSettings compact editor />
          <button
            className="note-history-toggle"
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
          >
            History
          </button>
        </footer>
      </div>
    </dialog>
  );
}
