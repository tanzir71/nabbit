import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { tackApi, type TackConflict } from "./tackApi";
import type { NotesContext } from "./types";
import { EditorIcon } from "./EditorIcon";
import { useNotesStore } from "../../store/notesStore";
import "./editor.css";

function Version({ value, pc }: { value: Record<string, unknown> | null; pc: boolean }) {
  return (
    <section
      className="note-conflict-version"
      data-pc={pc}
      aria-label={pc ? "This PC version" : "Tack version"}
    >
      <header>
        <EditorIcon name={pc ? "pc" : "remote"} />
        <strong>{pc ? "This PC" : "Tack"}</strong>
        <span>
          {typeof value?.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
            ? `Edited ${new Date(value.updatedAt).toLocaleString()}`
            : ""}
        </span>
      </header>
      {value === null ? (
        <p>This version deletes the record.</p>
      ) : (
        <>
          {typeof value.title === "string" && value.title ? <h3>{value.title}</h3> : null}
          {typeof value.body === "string" ? (
            <p>{value.body || "(Empty body)"}</p>
          ) : (
            <pre>{JSON.stringify(value, null, 2)}</pre>
          )}
          {typeof value.url === "string" && value.url ? <p>{value.url}</p> : null}
          {Array.isArray(value.items) ? (
            <ul>
              {value.items.map((v, index) => {
                const item = v as Record<string, unknown>;
                return (
                  <li key={index}>
                    {item.checked ? "✓ " : "☐ "}
                    {String(item.text ?? "")}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <details>
            <summary>All fields</summary>
            <pre>{JSON.stringify(value, null, 2)}</pre>
          </details>
        </>
      )}
    </section>
  );
}
export function ConflictSheet({ scope, close }: { scope: NotesContext; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null),
    heading = useId();
  const [conflicts, setConflicts] = useState<TackConflict[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const alive = useRef(true),
    working = useRef(false),
    [readOnly, setReadOnly] = useState(true);
  const reload = async () => {
    const [rows, profile] = await Promise.all([tackApi.conflicts(scope), tackApi.profile()]);
    if (alive.current) {
      setConflicts(rows);
      setReadOnly(profile.readOnly);
    }
  };
  const load = useRef(reload);
  load.current = reload;
  useEffect(() => {
    alive.current = true;
    const origin = document.activeElement;
    dialog.current?.showModal();
    void load.current().catch(() => {
      if (alive.current)
        setError(
          "The conflict changed or this workspace is no longer active. Close and reopen to review it.",
        );
    });
    return () => {
      alive.current = false;
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus();
    };
  }, []);
  const current = conflicts?.[0];
  const resolve = async (choice: "keepLocal" | "useRemote") => {
    if (!current || working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await tackApi.resolve(current, choice);
      await useNotesStore.getState().refresh();
      await reload();
    } catch {
      if (alive.current)
        setError(
          "The conflict could not be resolved. Both versions are preserved. Reload them before choosing again.",
        );
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="note-dialog note-conflict"
      aria-labelledby={heading}
      onCancel={(e) => {
        e.preventDefault();
        if (!working.current) close();
      }}
    >
      <div className="note-sheet">
        <header className="note-conflict-header">
          <h2 id={heading}>
            {current?.table === "reminders"
              ? "This reminder changed in two places"
              : "This note changed in two places"}
          </h2>
          <IconButton label="Close conflict" disabled={busy} onClick={close}>
            <EditorIcon name="close" />
          </IconButton>
        </header>
        <div className="note-conflict-body">
          <p>
            Tack merged every field it could. Review both versions. The version you don’t choose is
            kept in note history.
          </p>
          {error ? (
            <div className="notes-error" role="alert">
              {error}
              <Button
                disabled={busy}
                onClick={() => {
                  setError("");
                  void reload().catch(() =>
                    setError("This workspace is no longer active. Close and reopen the conflict."),
                  );
                }}
              >
                Reload versions
              </Button>
            </div>
          ) : null}
          {current ? (
            <>
              <Version value={current.local} pc />
              <Version value={current.remote.value} pc={false} />
              <span className="note-conflict-count">
                {conflicts?.length} unresolved {conflicts?.length === 1 ? "conflict" : "conflicts"}
              </span>
            </>
          ) : (
            <p role="status">
              {conflicts ? "No unresolved conflicts in this workspace." : "Loading both versions…"}
            </p>
          )}
        </div>
        <footer className="note-conflict-actions">
          <Button disabled={!current || busy || !!error} onClick={() => void resolve("useRemote")}>
            Use Tack version
          </Button>
          <Button
            variant="primary"
            disabled={!current || busy || !!error || readOnly}
            onClick={() => void resolve("keepLocal")}
          >
            Keep this PC’s
          </Button>
        </footer>
      </div>
    </dialog>
  );
}
