import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api } from "../lib/ipc";
import { useAppStore } from "../store/useAppStore";
import { useNotesStore } from "../store/notesStore";
import { PresetChip } from "../components/PresetChip";
import { NoteCard } from "../components/NoteCard";
import { DesignIcon } from "../components/DesignIcon";
import { NotesIcon } from "../features/notes/NotesIcon";
import { TackSettings } from "../features/notes/TackSettings";
import { visibleNotes, type NotesView as View, type StoredNote } from "../features/notes/types";
import { QuickCapture } from "../features/notes/QuickCapture";
import { type NoteCaptureRequest, type NotesNavigation } from "../features/notes/api";
import { captureCard, sameScope } from "../features/notes/captureDraft";
import "../features/notes/notes.css";

const LinksPanel = lazy(() =>
  import("../features/notes/LinksPanel").then((m) => ({ default: m.LinksPanel })),
);
const BookmarkImportSheet = lazy(() =>
  import("../features/notes/BookmarkImportSheet").then((m) => ({ default: m.BookmarkImportSheet })),
);
const priorities = ["all", "inbox", "now", "next", "later"] as const;
const titleCase = (s: string) => s[0].toUpperCase() + s.slice(1);
const NoteEditor = lazy(() =>
  import("../features/notes/NoteEditor").then((module) => ({ default: module.NoteEditor })),
);
export function NotesView({ navigation }: { navigation?: NotesNavigation | null }) {
  const { cards, scope, preferences, readOnly, loading, error, busy, refresh, updateNote } =
    useNotesStore();
  const [filter, setFilter] = useState<(typeof priorities)[number]>("all");
  const [label, setLabel] = useState("");
  const [view, setView] = useState<View>("notes");
  const [search, setSearch] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [editing, setEditing] = useState<StoredNote | null>(null);
  const [importing, setImporting] = useState(false);
  const [creation, setCreation] = useState<NoteCaptureRequest>();
  const [captureInitial] = useState(() => localStorage.getItem("nabbit:note-capture") ?? undefined);
  const consumed = useRef<string>();
  useEffect(() => {
    if (!navigation || navigation.id === consumed.current || loading || editing) return;
    consumed.current = navigation.id;
    const intent = navigation.intent;
    if (intent.kind === "new") {
      if (!sameScope(intent.request.expectedScope, scope)) {
        setAnnouncement("Workspace changed. Reopen your preserved capture in the island.");
        return;
      }
      setCreation(intent.request);
      setEditing(captureCard(intent.request));
    } else if (intent.kind === "card") {
      if (!sameScope(intent.expectedScope, scope)) {
        setAnnouncement("Workspace changed. Reopen Notes to review this card.");
        return;
      }
      const card = cards.find((c) => c.value.id === intent.id);
      if (card) {
        setCreation(undefined);
        setEditing(card);
      } else setAnnouncement("This note is no longer available in this workspace.");
    } else if (intent.kind === "links") {
      setView("links");
    } else if (intent.kind === "import") {
      setImporting(true);
    } else if (intent.kind === "capture") {
      document.querySelector<HTMLInputElement>("[data-note-capture]")?.focus();
    }
  }, [navigation, loading, editing, scope, cards]);
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
    setCreation(undefined);
    setEditing(card);
  };
  const openDraft = (request: NoteCaptureRequest) => {
    setCreation(request);
    setEditing(captureCard(request));
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
        {view === "links" ? (
          <Suspense fallback={<p role="status">Loading links…</p>}>
            <LinksPanel
              cards={visibleNotes(cards, "links", "all", "", "", scope ? preferences : undefined)}
              scope={scope}
              readOnly={readOnly}
              all={() => setView("notes")}
              importBookmarks={() => setImporting(true)}
              refresh={refresh}
              download={async (url) => {
                await useAppStore.getState().stageUrl(url);
                await useAppStore.getState().setLastTab("download");
              }}
            />
          </Suspense>
        ) : (
          <>
            <QuickCapture
              scope={scope}
              readOnly={readOnly}
              ready={!loading}
              cards={cards}
              initial={captureInitial}
              persist={(raw) => localStorage.setItem("nabbit:note-capture", raw)}
              open={openDraft}
              saved={() => {
                void refresh();
                setAnnouncement("Note saved on this device");
              }}
            />
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
              <PresetChip onClick={() => setView("links")}>
                Links{" "}
                {
                  visibleNotes(cards, "links", "all", "", "", scope ? preferences : undefined)
                    .length
                }
              </PresetChip>
              <details className="notes-view-menu" ref={menuRef}>
                <summary aria-label="Notes view and labels" title="Notes view and labels">
                  <NotesIcon name="grid" />
                </summary>
                <div className="notes-menu">
                  <p>View</p>
                  {(["notes", "links", "archive", "trash"] as const).map((v) => (
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
                  <button
                    type="button"
                    onClick={() => {
                      closeViewMenu();
                      setImporting(true);
                    }}
                  >
                    Import bookmarks
                  </button>
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
                      document.querySelector<HTMLInputElement>("[data-note-capture]")?.focus();
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
                {group(
                  pinned.length ? "Others" : view === "notes" ? "Notes" : titleCase(view),
                  others,
                )}
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
          </>
        )}
        <span className="sr-only" role="status">
          {announcement}
        </span>
      </div>
      <footer className="notes-footer">
        <TackSettings compact />
      </footer>
      {importing && (
        <Suspense fallback={<p role="status">Opening bookmark import…</p>}>
          <BookmarkImportSheet
            scope={scope}
            readOnly={readOnly}
            close={() => setImporting(false)}
            changed={refresh}
          />
        </Suspense>
      )}
      {editing ? (
        <Suspense fallback={<span role="status">Opening note…</span>}>
          <NoteEditor
            key={editing.value.id}
            card={editing}
            creation={creation}
            close={() => setEditing(null)}
          />
        </Suspense>
      ) : null}
    </section>
  );
}
