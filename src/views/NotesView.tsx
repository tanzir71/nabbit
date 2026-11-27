import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api } from "../lib/ipc";
import { useNotesStore } from "../store/notesStore";
import { Button } from "../components/Button";
import { IconButton } from "../components/IconButton";
import { PresetChip } from "../components/PresetChip";
import { NoteCard, type NoteColor } from "../components/NoteCard";
import { DesignIcon } from "../components/DesignIcon";
import { NotesIcon } from "../features/notes/NotesIcon";
import { TackSettings } from "../features/notes/TackSettings";
import {
  visibleNotes,
  type NoteKind,
  type NotePriority,
  type NoteItem,
  type NotesView as View,
  type StoredNote,
} from "../features/notes/types";
import "../features/notes/notes.css";

const priorities = ["all", "inbox", "now", "next", "later"] as const;
const colors: NoteColor[] = ["default", "blue", "purple", "green", "pink", "gray"];
const titleCase = (s: string) => s[0].toUpperCase() + s.slice(1);
const NoteEditor = lazy(() =>
  import("../features/notes/NoteEditor").then((module) => ({ default: module.NoteEditor })),
);
type Composer = {
  card: StoredNote | null;
  kind: NoteKind;
  title: string;
  body: string;
  url: string;
  items: NoteItem[];
  priority: NotePriority;
  color: NoteColor;
  labels: string;
};
const blank = (kind: NoteKind = "note"): Composer => ({
  card: null,
  kind,
  title: "",
  body: "",
  url: "",
  items: [],
  priority: "inbox",
  color: "default",
  labels: "",
});

export function NotesView() {
  const {
    cards,
    scope,
    preferences,
    readOnly,
    loading,
    error,
    busy,
    refresh,
    createNote,
    updateNote,
  } = useNotesStore();
  const [filter, setFilter] = useState<(typeof priorities)[number]>("all");
  const [label, setLabel] = useState("");
  const [view, setView] = useState<View>("notes");
  const [search, setSearch] = useState<string | null>(null);
  const [draft, setDraft] = useState<Composer>(() => blank());
  const [expanded, setExpanded] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [editing, setEditing] = useState<StoredNote | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const labels = [...new Set(cards.flatMap((c) => c.value.labels))].sort();
  const found = visibleNotes(
    cards,
    view,
    filter,
    label,
    search ?? "",
    scope ? preferences : undefined,
  );
  const pinned = found.filter((c) => c.value.pinned),
    others = found.filter((c) => !c.value.pinned);
  const saving = readOnly || busy.includes(draft.card?.value.id ?? "new");
  useEffect(() => {
    let active = true,
      stop: (() => void) | undefined;
    void api
      .onEvent<void>("notes:updated", () => {
        if (active) void refresh();
      })
      .then((unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        stop = unlisten;
        void refresh();
      })
      .catch((reason) => {
        if (active) useNotesStore.setState({ loading: false, error: String(reason) });
      });
    const focusSearch = () => {
      setSearch((s) => s ?? "");
      requestAnimationFrame(() => searchRef.current?.focus());
    };
    window.addEventListener("nabbit:focus-notes-search", focusSearch);
    const closeOutside = (event: Event) => {
      for (const menu of document.querySelectorAll<HTMLDetailsElement>(
        ".notes-view details[open]",
      )) {
        if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
      }
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const open = document.querySelector<HTMLDetailsElement>(".notes-view details[open]");
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        open.open = false;
        open.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      active = false;
      stop?.();
      window.removeEventListener("nabbit:focus-notes-search", focusSearch);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [refresh]);
  const closeViewMenu = () => {
    if (menuRef.current) {
      menuRef.current.open = false;
      menuRef.current.querySelector("summary")?.focus();
    }
  };
  const edit = (card: StoredNote) => {
    setEditing(card);
  };
  const reset = () => {
    setDraft(blank());
    setExpanded(false);
  };
  const save = async () => {
    const common = {
      title: draft.title,
      body: draft.body,
      url: draft.url,
      kind: draft.kind,
      priority: draft.priority,
      color: draft.color,
      labels:
        draft.card && draft.labels === draft.card.value.labels.join(", ")
          ? draft.card.value.labels
          : [
              ...new Set(
                draft.labels
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              ),
            ],
    };
    // Existing checklist IDs, checked state and unknown item fields survive text edits.
    const items = draft.items.filter((item) => item.text.trim());
    const saved = draft.card
      ? await updateNote(draft.card, { ...common, items })
      : await createNote({ ...common, items: items.map((item) => item.text) });
    if (saved) {
      reset();
      setAnnouncement("Note saved on this device");
    }
  };
  const group = (name: string, notes: StoredNote[]) =>
    notes.length > 0 && (
      <section className="notes-group" aria-label={name}>
        <h2>{name}</h2>
        <div className="notes-masonry">
          {[0, 1].map((column) => (
            <div key={column} className="notes-column">
              {notes
                .filter((_, index) => index % 2 === column)
                .map((note) => {
                  const c = note.value,
                    disabled = readOnly || busy.includes(c.id);
                  const content =
                    c.kind === "note"
                      ? { kind: c.kind, body: c.body }
                      : c.kind === "bookmark"
                        ? { kind: c.kind, url: c.url }
                        : {
                            kind: c.kind,
                            items: c.items.map((i) => ({ ...i, disabled })),
                            onItemChange: (id: string, checked: boolean) =>
                              void updateNote(note, {
                                items: c.items.map((i) => (i.id === id ? { ...i, checked } : i)),
                              }),
                          };
                  return (
                    <div className="notes-card-wrap" key={c.id} data-note-id={c.id}>
                      <NoteCard
                        {...content}
                        title={c.title || (c.kind === "bookmark" ? c.url : "Untitled note")}
                        color={c.color}
                        labels={c.labels}
                        reference={c.ref}
                        status={
                          c.kind === "task"
                            ? (c.status ?? (c.completed ? "done" : "open"))
                            : undefined
                        }
                        onOpen={() => edit(note)}
                      />
                      <details className="notes-card-menu">
                        <summary
                          aria-label={`Actions for ${c.title || "Untitled note"}`}
                          title="Note actions"
                        >
                          <DesignIcon name="more16" />
                        </summary>
                        <div className="notes-menu">
                          <button disabled={disabled} onClick={() => edit(note)}>
                            Edit
                          </button>
                          <button
                            disabled={busy.includes(c.id)}
                            onClick={() => void updateNote(note, { pinned: !c.pinned })}
                          >
                            {c.pinned ? "Unpin" : "Pin"}
                          </button>
                          {!c.trashedAt && (
                            <button
                              disabled={disabled}
                              onClick={() => void updateNote(note, { archived: !c.archived })}
                            >
                              {c.archived ? "Unarchive" : "Archive"}
                            </button>
                          )}
                          <button
                            disabled={disabled}
                            onClick={() =>
                              void updateNote(note, {
                                trashedAt: c.trashedAt ? null : new Date().toISOString(),
                              })
                            }
                          >
                            {c.trashedAt ? "Restore" : "Move to Trash"}
                          </button>
                        </div>
                      </details>
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      </section>
    );
  return (
    <section className="notes-view" aria-label="Notes collection">
      <div className="notes-body">
        {readOnly ? (
          <p className="tack-help" role="status">
            Read-only Tack workspace. You can browse cards; editing is disabled.
          </p>
        ) : null}
        <form
          className="notes-composer"
          aria-label={draft.card ? "Edit local note" : "Create local note"}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="notes-capture">
            <input
              ref={titleRef}
              aria-label="Note title"
              placeholder="Take a note…"
              maxLength={300}
              value={draft.title}
              onChange={(event) => setDraft((d) => ({ ...d, title: event.target.value }))}
              onFocus={() => setExpanded(true)}
              disabled={saving}
            />
            <IconButton
              label="New checklist"
              size={28}
              disabled={saving}
              onClick={() => {
                setDraft((d) => ({ ...d, kind: "checklist" }));
                setExpanded(true);
                titleRef.current?.focus();
              }}
            >
              <NotesIcon name="checklist" />
            </IconButton>
            <IconButton
              label="New link note"
              size={28}
              disabled={saving}
              onClick={() => {
                setDraft((d) => ({ ...d, kind: "bookmark" }));
                setExpanded(true);
                titleRef.current?.focus();
              }}
            >
              <NotesIcon name="link" />
            </IconButton>
            <IconButton label="Image attachments are read-only" size={28} disabled>
              <NotesIcon name="image" />
            </IconButton>
          </div>
          {expanded && (
            <div className="notes-compose-fields">
              <label>
                Type
                <select
                  aria-label="Note type"
                  value={draft.kind}
                  disabled={saving}
                  onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as NoteKind }))}
                >
                  {["note", "checklist", "bookmark", "task"].map((kind) => (
                    <option key={kind} value={kind}>
                      {titleCase(kind)}
                    </option>
                  ))}
                </select>
              </label>
              {draft.kind === "bookmark" ? (
                <label>
                  Link
                  <input
                    aria-label="Link URL"
                    type="url"
                    required
                    value={draft.url}
                    disabled={saving}
                    onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
                  />
                </label>
              ) : null}
              {(draft.kind === "checklist" || draft.kind === "task") && (
                <fieldset className="notes-item-editor">
                  <legend>Checklist items</legend>
                  {draft.items.map((item, index) => (
                    <div key={item.id}>
                      <input
                        aria-label={`Checklist item ${index + 1}`}
                        value={item.text}
                        disabled={saving}
                        onChange={(event) =>
                          setDraft((d) => ({
                            ...d,
                            items: d.items.map((i) =>
                              i.id === item.id ? { ...i, text: event.target.value } : i,
                            ),
                          }))
                        }
                      />
                      <Button
                        size="sm"
                        disabled={saving}
                        onClick={() =>
                          setDraft((d) => ({
                            ...d,
                            items: d.items.filter((i) => i.id !== item.id),
                          }))
                        }
                      >
                        Remove item {index + 1}
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    disabled={saving}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        items: [...d.items, { id: crypto.randomUUID(), text: "", checked: false }],
                      }))
                    }
                  >
                    Add item
                  </Button>
                </fieldset>
              )}
              <label>
                Note
                <textarea
                  aria-label="Note body"
                  maxLength={200000}
                  value={draft.body}
                  disabled={saving}
                  onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                />
              </label>
              <div className="notes-properties">
                <label>
                  Priority
                  <select
                    aria-label="Note priority"
                    value={draft.priority}
                    disabled={saving}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, priority: e.target.value as NotePriority }))
                    }
                  >
                    {priorities
                      .filter((p) => p !== "all")
                      .map((p) => (
                        <option key={p} value={p}>
                          {titleCase(p)}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Colour
                  <select
                    aria-label="Note colour"
                    value={draft.color}
                    disabled={saving}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, color: e.target.value as NoteColor }))
                    }
                  >
                    {colors.map((color) => (
                      <option key={color} value={color}>
                        {titleCase(color)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Labels, separated by commas
                <input
                  aria-label="Note labels"
                  value={draft.labels}
                  disabled={saving}
                  onChange={(e) => setDraft((d) => ({ ...d, labels: e.target.value }))}
                />
              </label>
              <div className="notes-compose-actions">
                <Button type="submit" variant="primary" disabled={saving}>
                  {saving ? "Saving…" : "Save note"}
                </Button>
                <Button disabled={saving} variant="ghost" onClick={reset}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </form>
        {error && (
          <div role="alert" className="notes-error">
            {error}
            <button
              type="button"
              onClick={() => {
                useNotesStore.setState({ error: null });
                void refresh();
              }}
            >
              Retry
            </button>
          </div>
        )}
        <div className="notes-filters" role="group" aria-label="Note priority filter">
          {priorities.map((p) => (
            <PresetChip key={p} selected={filter === p} onClick={() => setFilter(p)}>
              {titleCase(p)}
            </PresetChip>
          ))}
          <details className="notes-view-menu" ref={menuRef}>
            <summary aria-label="Notes view and labels" title="Notes view and labels">
              <NotesIcon name="grid" />
            </summary>
            <div className="notes-menu">
              <p>View</p>
              {(["notes", "archive", "trash"] as const).map((v) => (
                <button
                  key={v}
                  aria-pressed={view === v}
                  onClick={() => {
                    setView(v);
                    closeViewMenu();
                  }}
                >
                  {titleCase(v)}
                </button>
              ))}
              <label>
                Labels
                <select
                  aria-label="Filter by label"
                  value={label}
                  onChange={(e) => {
                    setLabel(e.target.value);
                    closeViewMenu();
                  }}
                >
                  <option value="">All labels</option>
                  {labels.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
            </div>
          </details>
        </div>
        {(label || view !== "notes") && (
          <div className="notes-current-filter">
            <span>
              {titleCase(view)}
              {label ? ` · ${label}` : ""}
            </span>
            <button
              onClick={() => {
                setLabel("");
                setView("notes");
              }}
            >
              Reset view
            </button>
          </div>
        )}
        {search !== null && (
          <label className="notes-search">
            Search notes
            <input
              ref={searchRef}
              aria-label="Search notes"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearch(null);
                  titleRef.current?.focus();
                }
              }}
            />
          </label>
        )}
        {loading ? (
          <p role="status">Loading notes…</p>
        ) : found.length ? (
          <>
            {group("Pinned", pinned)}
            {group(pinned.length ? "Others" : view === "notes" ? "Notes" : titleCase(view), others)}
          </>
        ) : (
          <div className="notes-empty">
            <h2>{cards.length ? "No matching notes" : "A place for your notes"}</h2>
            <p>
              {cards.length
                ? "Try another priority, label or search."
                : "Take a note above. It stays on this device."}
            </p>
          </div>
        )}
        <span className="sr-only" role="status">
          {announcement}
        </span>
      </div>
      <footer className="notes-footer">
        <TackSettings compact />
      </footer>
      {editing ? (
        <Suspense fallback={<span role="status">Opening note…</span>}>
          <NoteEditor card={editing} close={() => setEditing(null)} />
        </Suspense>
      ) : null}
    </section>
  );
}
