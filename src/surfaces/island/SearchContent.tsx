import { useEffect, useId, useLayoutEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IslandAsset } from "./IslandAsset";
import { Kbd } from "../../components/Kbd";
import type { ClipboardEntry } from "../../lib/types";
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
};
export default function SearchContent({
  query,
  setQuery,
  collapse,
  fail,
}: {
  query: string;
  setQuery: (value: string) => void;
  collapse: () => void;
  fail: (reason: unknown) => void;
}) {
  const [results, setItems] = useState<Result[]>([]),
    [loadedQuery, setLoadedQuery] = useState<string | null>(null),
    [selected, select] = useState(0),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const listId = useId();
  const items = loadedQuery === query ? results : [];
  useLayoutEffect(() => {
    document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, selected, results]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([
      invoke<ClipboardEntry[]>("list_clipboard_entries", { query: query || null }),
      invoke<IslandPin[]>("list_island_pins"),
    ])
      .then(([clipboard, pins]) => {
        if (!active) return;
        setLoadedQuery(query);
        const term = query.trim().toLocaleLowerCase();
        setItems(
          [
            ...pins
              .filter((pin) => `${pin.label ?? ""} ${pin.path}`.toLocaleLowerCase().includes(term))
              .map((pin): Result => ({
                id: `pin:${pin.id}`,
                group: "PINS",
                title: pin.label || pin.path.split(/[\\/]/).pop() || pin.path,
                detail: `${pin.path}${pin.slot ? ` · Alt+${pin.slot}` : ""}`,
                icon: pin.kind === "folder" ? "iconFolder" : "iconFile",
                run: () => invoke("island_open_pin", { id: pin.id, slot: null }),
              })),
            ...clipboard.map((entry): Result => ({
              id: `clipboard:${entry.id}`,
              group: "CLIPBOARD",
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
  }, [query, fail]);
  const activate = async (index: number) => {
    if (!items[index] || busy || loading) return;
    setBusy(true);
    try {
      await items[index].run();
      collapse();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="island-search-content">
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
                : "Search your pins and clipboard"}
          </p>
        )}
      </div>
    </div>
  );
}
