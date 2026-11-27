import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "../../components/IconButton";
import { IslandAsset } from "../../surfaces/island/IslandAsset";
import { NotesIcon } from "./NotesIcon";
import { notesApi, type NoteCaptureRequest } from "./api";
import {
  blankCapture,
  prepareCapture,
  restoreCapture,
  sameScope,
  type CaptureDraft,
} from "./captureDraft";
import type { NoteKind, NotesContext, StoredNote } from "./types";
import "./capture.css";

export function QuickCapture({
  scope,
  readOnly,
  ready = true,
  cards,
  initial,
  persist,
  open,
  saved,
  island = false,
}: {
  scope: NotesContext | null;
  readOnly: boolean;
  ready?: boolean;
  cards: StoredNote[];
  initial?: string;
  persist: (raw: string) => void;
  open: (request: NoteCaptureRequest) => void | Promise<void>;
  saved?: (note: StoredNote) => void;
  island?: boolean;
}) {
  const [draft, setDraft] = useState(() => restoreCapture(initial, scope));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const current = useRef(draft),
    active = useRef(true),
    working = useRef(false);
  const callbacks = useRef({ persist, saved });
  callbacks.current = { persist, saved };
  const persistDraft = (next: CaptureDraft) => {
    try {
      callbacks.current.persist(JSON.stringify(next));
    } catch {
      if (active.current)
        setError(
          "Your draft is visible here, but device storage is unavailable. Keep this view open until it is saved.",
        );
    }
  };
  const replace = (next: CaptureDraft) => {
    current.current = next;
    setDraft(next);
    persistDraft(next);
  };
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (draft.text && sameScope(draft.scope, scope) && cards.some((c) => c.value.id === draft.id)) {
      const next = blankCapture(scope);
      current.current = next;
      setDraft(next);
      try {
        callbacks.current.persist(JSON.stringify(next));
      } catch {
        setError(
          "Device storage is unavailable. The saved card is safe; this draft could not be cleared.",
        );
      }
    }
  }, [cards, draft.id, draft.text, draft.scope, scope]);
  const preview = useMemo(() => {
    try {
      return { request: prepareCapture(draft), error: "" };
    } catch {
      return {
        request: null,
        error: "This date could not be parsed. Edit the capture to continue.",
      };
    }
  }, [draft]);
  const moved = !!draft.text && !sameScope(draft.scope, scope);
  const disabled = !ready || readOnly || busy;
  const run = async (editor: boolean, kind?: NoteKind) => {
    if (working.current || disabled || moved || preview.error || (!editor && !draft.text.trim()))
      return;
    working.current = true;
    setBusy(true);
    setError("");
    const original = current.current;
    try {
      const request = prepareCapture(original.text ? original : blankCapture(scope), kind);
      if (editor) await open(request);
      else {
        const note = await notesApi.capture(request);
        // On remount the authoritative card snapshot acknowledges this ID. A late
        // reply from a destroyed view must not overwrite a newer preserved draft.
        if (active.current && current.current.id === original.id) {
          const next = blankCapture(scope);
          current.current = next;
          persistDraft(next);
          if (active.current) setDraft(next);
        }
        if (active.current) callbacks.current.saved?.(note);
      }
    } catch {
      if (active.current)
        setError(
          "Your capture is still here. Saving or opening failed; retry when this workspace is available.",
        );
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  };
  const d = preview.request?.draft,
    reminder = preview.request?.reminders[0]?.value;
  const icon = (name: "checklist" | "link" | "image", asset: string) =>
    island ? <IslandAsset group="9:200" name={asset} /> : <NotesIcon name={name} />;
  const reminderLabel = reminder
    ? (() => {
        const options = { timeZone: reminder.timeZone };
        const day = new Date(reminder.at).toLocaleDateString("en-US", options);
        const today = new Date(draft.clock).toLocaleDateString("en-US", options);
        const tomorrow = new Date(Date.parse(draft.clock) + 86400000).toLocaleDateString(
          "en-US",
          options,
        );
        return `${day === today ? "Today" : day === tomorrow ? "Tomorrow" : new Date(reminder.at).toLocaleDateString("en-US", { ...options, month: "short", day: "numeric" })} ${new Date(reminder.at).toLocaleTimeString("en-GB", { ...options, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
      })()
    : "";
  return (
    <div className={`quick-capture ${island ? "quick-capture--island" : ""}`}>
      <div className="quick-capture-field">
        <input
          aria-label="Note title"
          data-note-capture
          placeholder="Take a note…  #label  !now  tomorrow 9am"
          maxLength={10000}
          value={draft.text}
          disabled={disabled}
          aria-describedby={moved ? "capture-workspace" : undefined}
          onChange={(e) => {
            setError("");
            replace({
              ...(current.current.text ? current.current : blankCapture(scope)),
              id: crypto.randomUUID(),
              text: e.target.value,
            });
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
            if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) {
              e.preventDefault();
              e.stopPropagation();
              void run(e.key === "Tab" || e.shiftKey, e.shiftKey ? "checklist" : undefined);
            }
          }}
        />
        <IconButton
          label="New checklist"
          size={28}
          disabled={disabled || moved}
          onClick={() => void run(true, "checklist")}
        >
          {icon("checklist", "iconListChecks")}
        </IconButton>
        <IconButton
          label="New link note"
          size={28}
          disabled={disabled || moved}
          onClick={() => void run(true, "bookmark")}
        >
          {icon("link", "iconLink")}
        </IconButton>
        <IconButton label="Image attachments are read-only" size={28} disabled>
          {icon("image", "iconImage")}
        </IconButton>
        <kbd>Enter</kbd>
      </div>
      {draft.text.trim() && d ? (
        <div className="quick-capture-preview" role="group" aria-label="Capture preview">
          <span>Saves as</span>
          <span className="capture-chip is-kind">
            {d.kind === "bookmark" ? "Link" : d.kind![0].toUpperCase() + d.kind!.slice(1)}
          </span>
          <span className="capture-chip">
            {d.priority![0].toUpperCase() + d.priority!.slice(1)}
          </span>
          {d.labels?.map((label) => (
            <span className="capture-chip" key={label}>
              #{label}
            </span>
          ))}
          {reminder && (
            <span
              className="capture-chip capture-reminder"
              title={`${reminder.timeZone} · ${reminder.repeat}`}
            >
              <span>{reminderLabel.slice(0, reminderLabel.lastIndexOf(" "))}</span>
              <span className="capture-mono">
                {reminderLabel.slice(reminderLabel.lastIndexOf(" ") + 1)}
              </span>
            </span>
          )}
          <span className="capture-detail-hint">Tab for details</span>
        </div>
      ) : null}
      {/@|\+/.test(draft.text) && (
        <small className="capture-help">@people and +projects stay as text in this note.</small>
      )}
      {moved && (
        <p id="capture-workspace" role="status">
          Workspace changed. Your draft is preserved.{" "}
          <button
            onClick={() => replace({ ...blankCapture(scope), text: draft.text })}
            disabled={disabled}
          >
            Use current workspace
          </button>
        </p>
      )}
      {(!ready || readOnly) && (
        <p
          role="status"
          tabIndex={-1}
          data-note-capture-disabled={ready && readOnly ? "" : undefined}
        >
          {!ready ? "Loading notes…" : "Read-only workspace. Your capture is preserved."}
        </p>
      )}
      {(error || preview.error) && <p role="alert">{error || preview.error}</p>}
    </div>
  );
}
