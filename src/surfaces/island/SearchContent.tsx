import { useEffect, useId, useLayoutEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IslandAsset } from "./IslandAsset";
import { Kbd } from "../../components/Kbd";
import type { ClipboardEntry } from "../../lib/types";
import { listen } from "@tauri-apps/api/event";
import { notesApi } from "../../features/notes/api";
import { visibleNotes } from "../../features/notes/types";
import { shelfApi } from "../../features/shelf/api";
import { toolsApi, type Tool } from "../../features/tools/api";
import { ToolSheet } from "../../features/tools/ToolSheet";
export interface IslandPin {
  id: string;
  kind: "file" | "folder";
  path: string;
  label: string | null;
  slot: number | null;
}
type Result = {
  id: string;
  group: string;
  title: string;
  detail: string;
  icon: string;
  run: () => Promise<unknown>;
  keepOpen?: boolean;
};
export default function SearchContent({
  query,
  setQuery,
  collapse,
  fail,
  openShelf,
}: {
  query: string;
  setQuery: (value: string) => void;
  collapse: () => void;
  fail: (reason: unknown) => void;
  openShelf: (id: string) => void;
}) {
  const [results, setItems] = useState<Result[]>([]),
    [loadedQuery, setLoadedQuery] = useState<string | null>(null),
    [selected, select] = useState(0),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [revision, refresh] = useState(0),
    [subscriptionsReady, setSubscriptionsReady] = useState(false),
    [chosenTool, chooseTool] = useState<Tool | null>(null);
  const listId = useId();
  const items = loadedQuery === query ? results : [];
  useEffect(() => {
    let active = true;
    setSubscriptionsReady(false);
    const stops: Array<() => void> = [];
    void Promise.allSettled(
      ["notes:updated", "shelf:changed", "clipboard:changed", "nabbit://pin-opened"].map((name) =>
        listen(name, () => {
          if (active) {
            setItems([]);
            setLoadedQuery(null);
            refresh((value) => value + 1);
          }
        }),
      ),
    ).then((values) => {
      for (const value of values)
        if (value.status === "fulfilled") {
          if (active) stops.push(value.value);
          else value.value();
        }
      if (active) {
        if (values.every((value) => value.status === "fulfilled")) setSubscriptionsReady(true);
        else
          fail(
            new Error("Live search updates are unavailable. Close and reopen Search to try again."),
          );
      }
    });
    return () => {
      active = false;
      stops.forEach((stop) => stop());
    };
  }, [fail]);
  useLayoutEffect(() => {
    document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, selected, results]);
  useEffect(() => {
    if (!subscriptionsReady) return;
    let active = true;
    setLoading(true);
    void Promise.all([
      invoke<ClipboardEntry[]>("list_clipboard_entries", { query: query || null }),
      invoke<IslandPin[]>("list_island_pins"),
      toolsApi.catalog(),
      notesApi.state(),
      shelfApi.list(),
    ])
      .then(([clipboard, pins, tools, notes, shelf]) => {
        if (!active) return;
        setLoadedQuery(query);
        const term = query.trim().toLocaleLowerCase();
        setItems(
          [
            ...tools
              .filter((tool) =>
                [tool.name, ...tool.keywords].join(" ").toLocaleLowerCase().includes(term),
              )
              .map((tool): Result => ({
                id: `tool:${tool.id}`,
                group: "TOOLS",
                title: tool.name,
                detail:
                  tool.category === "images"
                    ? "Create a new image file"
                    : tool.category === "documents"
                      ? "Create a new document or image file"
                      : "Create a shareable media file",
                icon: tool.icon,
                keepOpen: true,
                run: async () => chooseTool(tool),
              })),
            ...visibleNotes(notes.cards, "notes", "all", "", query, notes.preferences)
              .slice(0, 15)
              .map((note): Result => ({
                id: `note:${note.value.id}`,
                group: note.localOnly ? "NOTES · LOCAL" : "NOTES · TACK",
                title: note.value.title || "Untitled note",
                detail:
                  note.value.kind === "bookmark"
                    ? note.value.url
                    : [
                        note.value.ref,
                        note.value.priority,
                        ...note.value.labels.map((label) => `#${label}`),
                      ]
                        .filter(Boolean)
                        .join(" · "),
                icon: note.value.kind === "bookmark" ? "iconLink" : "iconStickyNote1",
                run: () =>
                  notesApi.open({
                    kind: "card",
                    id: note.value.id,
                    expectedScope: note.scope ?? null,
                  }),
              }))
              .sort((a, b) => a.group.localeCompare(b.group)),
            ...pins
              .filter((pin) => `${pin.label ?? ""} ${pin.path}`.toLocaleLowerCase().includes(term))
              .slice(0, 10)
              .map((pin): Result => ({
                id: `pin:${pin.id}`,
                group: "PINS",
                title: pin.label || pin.path.split(/[\\/]/).pop() || pin.path,
                detail: `${pin.path}${pin.slot ? ` · Alt+${pin.slot}` : ""}`,
                icon: pin.kind === "folder" ? "iconFolder" : "iconFile",
                run: () => invoke("island_open_pin", { id: pin.id, slot: null }),
              })),
            ...shelf
              .filter((item) => `${item.name} ${item.path}`.toLocaleLowerCase().includes(term))
              .slice(0, 10)
              .map((item): Result => ({
                id: `shelf:${item.id}`,
                group: "SHELF AND CLIPBOARD",
                title: item.name,
                detail: `Shelf${item.available ? "" : " · File unavailable"}`,
                icon: "iconFile",
                keepOpen: true,
                run: async () => openShelf(item.id),
              })),
            ...clipboard.slice(0, 15).map((entry): Result => ({
              id: `clipboard:${entry.id}`,
              group: "SHELF AND CLIPBOARD",
              title: entry.preview || entry.content,
              detail: entry.sourceApp || entry.contentType,
              icon: entry.contentType === "url" ? "iconLink" : "iconFile",
              run: () => invoke("copy_clipboard_entry", { id: entry.id }),
            })),
          ].slice(0, 50),
        );
        select(0);
      })
      .catch((error) => {
        if (active) fail(error);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [query, fail, revision, openShelf, subscriptionsReady]);
  const activate = async (index: number) => {
    if (!items[index] || busy || loading) return;
    setBusy(true);
    try {
      await items[index].run();
      if (!items[index].keepOpen) collapse();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  if (chosenTool) return <ToolSheet tool={chosenTool} close={() => chooseTool(null)} />;
  return (
    <div className="island-search-content">
      <h1 className="island-sr-only">Search everything</h1>
      <label className="island-search">
        <IslandAsset group="search" name="iconSearch" />
        <input
          role="combobox"
          aria-label="Search island"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={items[selected] ? `${listId}-${selected}` : undefined}
          autoComplete="off"
          placeholder="Search notes, links, files…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.isDefaultPrevented() ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              select((old) =>
                items.length
                  ? (old + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
                  : 0,
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              void activate(selected);
            }
          }}
        />
        <Kbd>Esc</Kbd>
      </label>
      <div id={listId} role="listbox" aria-label="Search results" aria-busy={loading}>
        {items.map((item, index) => (
          <div key={item.id}>
            {(index === 0 || item.group !== items[index - 1].group) && (
              <div className="island-search-group">{item.group}</div>
            )}
            <button
              id={`${listId}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={selected === index}
              disabled={busy}
              className={`island-search-result${selected === index ? " is-selected" : ""}`}
              onPointerMove={() => select(index)}
              onClick={() => void activate(index)}
            >
              <span className="island-search-type">
                <IslandAsset group="search" name={item.icon} />
              </span>
              <span className="island-text-stack island-spacer">
                <span className="island-ellipsis" title={item.title}>
                  {item.title}
                </span>
                <span className="island-ellipsis island-muted" title={item.detail}>
                  {item.detail}
                </span>
              </span>
              {selected === index && <Kbd>Enter</Kbd>}
            </button>
          </div>
        ))}
        {!items.length && (
          <p className="island-empty" role="status">
            {loading
              ? "Searching…"
              : query.trim()
                ? "No matches"
                : "Search tools, notes, links, pins and files"}
          </p>
        )}
      </div>
    </div>
  );
}
