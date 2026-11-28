import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { PresetChip } from "../../components/PresetChip";
import { Kbd } from "../../components/Kbd";
import { IslandAsset } from "../../surfaces/island/IslandAsset";
import type { IslandAction, IslandModel } from "../../store/islandStore";
import type { ClipboardEntry } from "../../lib/types";
import { formatRelativeTime } from "../../lib/search";
import { ClipboardContext } from "./ClipboardContext";
import { newestClipboardEntry } from "../notes/linkPresentation";
import { clipboardApi, type ClipboardSnapshot, type ClipboardPick } from "./api";
import { clipboardFilters, clipboardRows, clipboardThumbnail, clipboardTitle } from "./model";
import "./islandClipboard.css";

export function IslandClipboard({
  model,
  dispatch,
}: {
  model: IslandModel;
  dispatch: (action: IslandAction) => void;
}) {
  const [snapshot, setSnapshot] = useState<ClipboardSnapshot>();
  const [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [disconnected, setDisconnected] = useState(false);
  const [selection, setSelection] = useState({ view: "", id: "" });
  const [menuEntry, setMenuEntry] = useState<ClipboardEntry>();
  const alive = useRef(true),
    working = useRef(false),
    generation = useRef({ value: 0 });
  const root = useRef<HTMLElement>(null),
    search = useRef<HTMLInputElement>(null),
    rowsElement = useRef<HTMLDivElement>(null);
  const searchId = useId(),
    resultId = useId(),
    helpId = useId();
  const query = model.filters.clipboardQuery || "",
    filter = clipboardFilters.find((value) => value === model.filters.clipboard) || "All";
  const entries = snapshot?.entries ?? [];
  const rows = useMemo(
    () => clipboardRows(snapshot?.entries ?? [], query, filter),
    [snapshot?.entries, query, filter],
  );
  const view = JSON.stringify([query, filter]);
  const selectedIndex = Math.max(
    0,
    rows.findIndex((r) => selection.view === view && r.id === selection.id),
  );
  const selected = rows[selectedIndex];
  const contextEntry = query.trim() || filter !== "All" ? rows[0] : newestClipboardEntry(entries);
  const refresh = useCallback(async () => {
    const current = ++generation.current.value;
    try {
      const next = await clipboardApi.snapshot();
      if (alive.current && current === generation.current.value) {
        setSnapshot(next);
        setLoading(false);
        setError("");
      }
    } catch {
      if (alive.current && current === generation.current.value) {
        setError("Clipboard could not be loaded. Refresh to try again.");
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    const stops: Array<() => void> = [];
    const counter = generation.current;
    let active = true;
    void Promise.allSettled(
      ["clipboard:new", "clipboard:changed"].map((name) =>
        listen(name, () => {
          if (active) void refresh();
        }),
      ),
    ).then((results) => {
      for (const r of results)
        if (r.status === "fulfilled") {
          if (active) stops.push(r.value);
          else r.value();
        }
      if (active) {
        setDisconnected(results.some((r) => r.status === "rejected"));
        void refresh();
      }
    });
    return () => {
      active = false;
      alive.current = false;
      counter.value++;
      stops.forEach((stop) => stop());
    };
  }, [refresh]);
  const restoredScroll = useRef(false),
    initialScroll = useRef(Math.max(0, Number(model.filters.clipboardScroll) || 0));
  useEffect(() => {
    if (snapshot && !restoredScroll.current && rowsElement.current) {
      rowsElement.current.scrollTop = initialScroll.current;
      restoredScroll.current = true;
    }
  }, [snapshot]);
  const choose = (entry: ClipboardEntry) => setSelection({ view, id: entry.id });
  const reveal = (index: number, moveFocus: boolean) => {
    const row = rowsElement.current?.querySelectorAll<HTMLElement>("[data-clipboard-id]")[index];
    row?.scrollIntoView?.({ block: "nearest" });
    if (moveFocus)
      row
        ?.querySelector<HTMLButtonElement>("[data-clipboard-copy]:not(:disabled)")
        ?.focus({ preventScroll: true });
  };
  const run = async (action: () => Promise<ClipboardPick | void>, acknowledgement: string) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await action();
      if (alive.current) {
        setMessage(result?.message || acknowledgement);
        if (result?.kind === "pasteSent") dispatch({ type: "collapse" });
        else await refresh();
      }
    } catch {
      if (alive.current) setError("The clipboard action could not finish. Refresh and try again.");
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const pick = (entry: ClipboardEntry, mode: "copy" | "paste") => {
    choose(entry);
    void run(() => clipboardApi.pick(entry.id, mode), "Copied");
  };
  const remove = (entry: ClipboardEntry) =>
    void run(async () => {
      await clipboardApi.remove(entry.id);
    }, "Clipboard item removed");
  const handleKey = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.getModifierState("AltGraph")
    )
      return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const input = target?.closest(
      "input,textarea,[contenteditable=true]",
    ) as HTMLInputElement | null;
    const searching = input === search.current;
    if (input && !searching) return;
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "f"
    ) {
      event.preventDefault();
      search.current?.focus();
      search.current?.select();
      return;
    }
    if (
      event.altKey ||
      event.shiftKey ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() !== "c")
    )
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      if (searching && input && input.selectionStart !== input.selectionEnd) return;
      event.preventDefault();
      if (selected && !event.repeat) pick(selected, "copy");
      return;
    }
    if (event.ctrlKey || event.metaKey) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && rows.length) {
      event.preventDefault();
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? rows.length - 1
            : Math.max(
                0,
                Math.min(rows.length - 1, selectedIndex + (event.key === "ArrowDown" ? 1 : -1)),
              );
      choose(rows[index]);
      reveal(index, !searching);
      return;
    }
    if (
      event.key === "Enter" &&
      selected &&
      (!target?.closest("button,a") || target.matches("[data-clipboard-copy]"))
    ) {
      event.preventDefault();
      if (!event.repeat) pick(selected, "paste");
      return;
    }
    if (event.key === "Delete" && selected && (!searching || !query)) {
      event.preventDefault();
      if (!event.repeat) remove(selected);
      return;
    }
    if (/^[1-9]$/.test(event.key) && !searching) {
      const entry = rows[Number(event.key) - 1];
      if (entry) {
        event.preventDefault();
        if (!event.repeat) {
          pick(entry, "copy");
          reveal(Number(event.key) - 1, true);
        }
      }
    }
  };
  const latestKeyHandler = useRef(handleKey);
  latestKeyHandler.current = handleKey;
  useEffect(() => {
    const host = root.current?.closest(".island-host");
    const route = (event: Event) =>
      latestKeyHandler.current((event as CustomEvent<KeyboardEvent>).detail);
    host?.addEventListener("nabbit:island-clipboard-key", route);
    return () => host?.removeEventListener("nabbit:island-clipboard-key", route);
  }, []);
  const setFilter = (value: string) => {
    if (rowsElement.current) rowsElement.current.scrollTop = 0;
    dispatch({ type: "filter", name: "clipboard", value });
    dispatch({ type: "filter", name: "clipboardScroll", value: "0" });
  };
  const download = async (url: string) => {
    await invoke("island_review_url", { url });
    dispatch({ type: "tab", tab: "nab" });
  };
  return (
    <section
      ref={root}
      className="island-clipboard"
      aria-label="Clipboard"
      data-context={contextEntry?.contentType === "url"}
      onKeyDown={(event: ReactKeyboardEvent) => handleKey(event.nativeEvent)}
    >
      <h1 className="island-sr-only">Clipboard</h1>
      <div className="island-clipboard-controls">
        <label className="island-clipboard-field" htmlFor={searchId}>
          <IslandAsset group="9:330" name="iconSearch1" />
          <input
            ref={search}
            id={searchId}
            aria-label="Search clipboard"
            role="combobox"
            aria-haspopup="grid"
            aria-controls={resultId}
            aria-expanded="true"
            aria-activedescendant={selected ? resultId + "-" + selected.id : undefined}
            aria-describedby={helpId}
            placeholder="Search clipboard"
            value={query}
            onChange={(event) => {
              if (rowsElement.current) rowsElement.current.scrollTop = 0;
              dispatch({ type: "filter", name: "clipboardQuery", value: event.target.value });
              dispatch({ type: "filter", name: "clipboardScroll", value: "0" });
            }}
          />
          <Kbd>Ctrl F</Kbd>
        </label>
        <div className="island-clipboard-filters" role="group" aria-label="Clipboard filters">
          {clipboardFilters.map((name) => (
            <PresetChip
              key={name}
              surface="island"
              selected={filter === name}
              onClick={() => setFilter(name)}
            >
              {name}
            </PresetChip>
          ))}
        </div>
      </div>
      <ClipboardContext
        key={menuEntry?.id ?? "context"}
        entry={menuEntry ?? contextEntry}
        download={download}
        silent={model.fullscreen}
        menu={!!menuEntry}
        closeMenu={() => setMenuEntry(undefined)}
        pasted={() => dispatch({ type: "collapse" })}
      />
      <div
        ref={rowsElement}
        id={resultId}
        className="island-clipboard-results"
        role="grid"
        aria-label="Clipboard history"
        aria-busy={loading}
        aria-rowcount={Math.max(1, rows.length)}
        aria-colcount={3}
        onScroll={(event) =>
          dispatch({
            type: "filter",
            name: "clipboardScroll",
            value: String(event.currentTarget.scrollTop),
          })
        }
      >
        {rows.map((entry, index) => {
          const active = selected?.id === entry.id,
            thumbnail = clipboardThumbnail(entry),
            title = clipboardTitle(entry),
            subtitle = `${entry.sourceApp || { text: "Text", url: "Link", file: "Path", image: thumbnail ? "Image" : "Image preview unavailable" }[entry.contentType]} · ${formatRelativeTime(entry.lastUsedAt)}`;
          return (
            <div
              key={entry.id}
              id={resultId + "-" + entry.id}
              className="island-clipboard-entry"
              role="row"
              aria-selected={active}
              data-clipboard-id={entry.id}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenuEntry(entry);
              }}
              onKeyDownCapture={(event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                  event.preventDefault();
                  event.stopPropagation();
                  setMenuEntry(entry);
                }
              }}
              onFocus={() => choose(entry)}
              onPointerMove={() => {
                if (!working.current) choose(entry);
              }}
            >
              <div role="gridcell" className="island-clipboard-item">
                <button
                  type="button"
                  className="island-clipboard-type"
                  aria-label={(entry.pinned ? "Unpin " : "Pin ") + title}
                  aria-pressed={entry.pinned}
                  tabIndex={active ? 0 : -1}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      async () => {
                        await clipboardApi.pin(entry.id);
                      },
                      entry.pinned ? "Item unpinned" : "Item pinned",
                    )
                  }
                >
                  {entry.contentType === "image" ? (
                    thumbnail ? (
                      <img className="clipboard-thumbnail" src={thumbnail} alt="" />
                    ) : (
                      <span className="island-clipboard-image-fallback" aria-hidden="true" />
                    )
                  ) : (
                    <IslandAsset
                      group="9:330"
                      name={
                        entry.contentType === "url"
                          ? "iconLink"
                          : entry.contentType === "file"
                            ? "iconFile"
                            : "iconType"
                      }
                    />
                  )}
                </button>
                <button
                  type="button"
                  data-clipboard-copy
                  className="island-clipboard-text"
                  tabIndex={active ? 0 : -1}
                  aria-label={"Copy " + title + " " + subtitle}
                  disabled={busy}
                  onClick={() => pick(entry, "copy")}
                >
                  <span className={entry.contentType === "file" ? "is-path" : ""}>{title}</span>{" "}
                  <small>{subtitle}</small>
                </button>
              </div>
              <div role="gridcell" className="island-clipboard-row-actions">
                {entry.contentType === "url" && (
                  <button
                    type="button"
                    className="island-clipboard-nab"
                    tabIndex={active ? 0 : -1}
                    disabled={busy}
                    aria-label={"Nab " + title}
                    onClick={() =>
                      void run(async () => {
                        await download(entry.content);
                      }, "Ready to download")
                    }
                  >
                    <IslandAsset group="9:330" name="iconDownload1" />
                    Nab
                  </button>
                )}
                {entry.pinned && (
                  <span className="island-clipboard-pinned" aria-label="Pinned">
                    <IslandAsset group="9:330" name="iconPin" />
                  </span>
                )}
              </div>
              <div role="gridcell">{index < 9 && <Kbd>{index + 1}</Kbd>}</div>
            </div>
          );
        })}
        {!rows.length && (
          <div role="row">
            <div role="gridcell" aria-colspan={3}>
              <p className="island-clipboard-empty" role="status">
                {loading
                  ? "Loading clipboard…"
                  : query || filter !== "All"
                    ? "No clipboard items match these filters."
                    : "Your clipboard history is empty."}
              </p>
            </div>
          </div>
        )}
      </div>
      {(error || disconnected) && (
        <p role="alert" className="island-clipboard-error">
          {error || "Live clipboard updates are unavailable."}{" "}
          <button type="button" onClick={() => void refresh()}>
            Refresh clipboard
          </button>
        </p>
      )}
      {message && (
        <p role="status" className="island-clipboard-status">
          {message}
        </p>
      )}
      <footer className="island-clipboard-footer">
        <span id={helpId}>Enter pastes · Ctrl+C copies · 1–9 pick · Del removes</span>
        <span>
          {snapshot
            ? "Kept " +
              snapshot.retentionDays +
              " days · " +
              Math.max(snapshot.total, entries.length).toLocaleString() +
              " items" +
              (snapshot.total > entries.length ? " (" + entries.length + " shown)" : "")
            : "History stays on this PC"}
        </span>
      </footer>
    </section>
  );
}
