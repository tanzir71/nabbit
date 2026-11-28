import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { DesignIcon } from "../components/DesignIcon";
import { IconButton } from "../components/IconButton";
import { DownloadIcon } from "../features/downloads/DownloadIcon";
import { Kbd } from "../components/Kbd";
import { PresetChip } from "../components/PresetChip";
import { formatRelativeTime, clampIndex } from "../lib/search";
import { useAppStore } from "../store/useAppStore";
import { ClipboardContext } from "../features/clipboard/ClipboardContext";
import { isVideo, newestClipboardEntry } from "../features/notes/linkPresentation";
import {
  clipboardFilters,
  clipboardRows,
  clipboardThumbnail,
  clipboardTitle,
} from "../features/clipboard/model";
import { trayClipboardAssets as assets } from "../features/clipboard/trayAssets";
import "../features/clipboard/trayClipboard.css";

export function ClipboardList() {
  const entries = useAppStore((state) => state.clipboardEntries);
  const settings = useAppStore((state) => state.settings);
  const copyEntry = useAppStore((state) => state.copyEntry);
  const togglePin = useAppStore((state) => state.togglePin);
  const deleteEntry = useAppStore((state) => state.deleteEntry);
  const stageUrl = useAppStore((state) => state.stageUrl);
  const setLastTab = useAppStore((state) => state.setLastTab);
  const patchSettings = useAppStore((state) => state.patchSettings);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof clipboardFilters)[number]>("All");
  const [activeIndex, setActiveIndex] = useState(0);
  const [contextId, setContextId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const working = useRef(false),
    alive = useRef(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLElement>(null);
  const filtered = useMemo(() => clipboardRows(entries, query, filter), [entries, query, filter]);
  const contextEntry = entries.find((entry) => entry.id === contextId);
  const adaptiveEntry =
    query.trim() || filter !== "All" ? filtered[0] : newestClipboardEntry(entries);
  useEffect(() => {
    setActiveIndex((index) => clampIndex(index, filtered.length));
  }, [filtered.length]);
  useEffect(() => {
    alive.current = true;
    searchRef.current?.focus();
    const focus = () => searchRef.current?.focus();
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        !event.isComposing &&
        !event.altKey &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        focus();
      }
    };
    window.addEventListener("nabbit:focus-search", focus);
    window.addEventListener("keydown", shortcut);
    const outside = (event: Event) => {
      for (const menu of root.current?.querySelectorAll<HTMLDetailsElement>("details[open]") ??
        []) {
        if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      alive.current = false;
      window.removeEventListener("nabbit:focus-search", focus);
      window.removeEventListener("keydown", shortcut);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, []);
  const run = async (action: () => Promise<unknown>, success: string) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setMessage("");
    setActionError("");
    try {
      await action();
      if (alive.current) setMessage(success);
    } catch (error) {
      if (alive.current) setActionError(String(error));
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const download = (url: string) =>
    run(async () => {
      await stageUrl(url);
      await setLastTab("download");
    }, "Link ready to review");
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.altKey ||
      event.shiftKey ||
      event.getModifierState("AltGraph")
    )
      return;
    const target = event.target as HTMLElement;
    const input = target.closest("input,textarea,[contenteditable=true]");
    const searching = input === searchRef.current;
    if (input && !searching) return;
    if (event.metaKey || event.ctrlKey) return;
    if (event.key === "Escape" && contextId) {
      event.preventDefault();
      setContextId(null);
      return;
    }
    if (event.key === "Escape") {
      const menu = root.current?.querySelector<HTMLDetailsElement>("details[open]");
      if (menu) {
        event.preventDefault();
        event.stopPropagation();
        menu.open = false;
        menu.querySelector("summary")?.focus();
        return;
      }
    }
    if (target.closest("button,a,summary,select") && !target.closest("[data-copy-entry]")) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && filtered.length) {
      event.preventDefault();
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? filtered.length - 1
            : clampIndex(activeIndex + (event.key === "ArrowDown" ? 1 : -1), filtered.length);
      setActiveIndex(index);
      document
        .querySelectorAll<HTMLElement>("[data-tray-clipboard-id]")
        [index]?.scrollIntoView?.({ block: "nearest" });
    } else if (event.key === "Enter" && filtered[activeIndex] && !event.repeat) {
      event.preventDefault();
      void run(() => copyEntry(filtered[activeIndex].id), "Copied");
    } else if (
      event.key === "Delete" &&
      filtered[activeIndex] &&
      (!searching || !query) &&
      !event.repeat
    ) {
      event.preventDefault();
      void run(() => deleteEntry(filtered[activeIndex].id), "Item removed");
    } else if (/^[1-9]$/.test(event.key) && !input && !event.repeat) {
      const entry = filtered[Number(event.key) - 1];
      if (entry) {
        event.preventDefault();
        void run(() => copyEntry(entry.id), "Copied");
      }
    }
  };
  return (
    <section
      ref={root}
      className="tray-clipboard"
      aria-label="Clipboard history"
      onKeyDown={handleKeyDown}
    >
      <div className="tray-clipboard-body">
        <label className="tray-clipboard-search">
          <DesignIcon asset={assets.search} />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder={
              entries.length
                ? `Search ${entries.length.toLocaleString()} items`
                : "Search clipboard"
            }
            aria-label="Search clipboard"
          />
          <Kbd>Ctrl F</Kbd>
        </label>
        <div className="tray-clipboard-filters" role="group" aria-label="Clipboard filter">
          {clipboardFilters.map((value) => (
            <PresetChip
              key={value}
              selected={value === filter}
              onClick={() => {
                setFilter(value);
                setActiveIndex(0);
                setContextId(null);
              }}
            >
              {value}
            </PresetChip>
          ))}
        </div>
        <div className="tray-clipboard-rows" role="group" aria-label="Clipboard items">
          <ClipboardContext
            entry={adaptiveEntry}
            download={async (url) => {
              await stageUrl(url);
              await setLastTab("download");
            }}
          />
          {filtered.map((entry, index) => {
            const thumbnail = clipboardThumbnail(entry);
            return (
              <article
                key={entry.id}
                data-tray-clipboard-id={entry.id}
                className={`tray-clipboard-row${index === activeIndex ? " is-selected" : ""}`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextId(entry.id);
                }}
              >
                <button
                  type="button"
                  data-copy-entry
                  aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
                  aria-disabled={busy}
                  className="tray-clipboard-copy"
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => {
                    setActiveIndex(index);
                    void run(() => copyEntry(entry.id), "Copied");
                  }}
                >
                  <span className="sr-only">Copy </span>
                  <span className="tray-clipboard-type">
                    {thumbnail ? (
                      <img className="tray-clipboard-thumbnail" src={thumbnail} alt="" />
                    ) : (
                      <DesignIcon
                        asset={
                          entry.contentType === "url"
                            ? assets.link
                            : entry.contentType === "file" || entry.contentType === "image"
                              ? assets.file
                              : assets.text
                        }
                      />
                    )}
                  </span>
                  <span
                    className={`tray-clipboard-text${entry.contentType === "file" ? " is-path" : ""}`}
                  >
                    <span>{clipboardTitle(entry)}</span>{" "}
                    <small>
                      {[entry.sourceApp, formatRelativeTime(entry.lastUsedAt)]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </span>
                </button>
                {entry.contentType === "url" && isVideo(entry.content) && (
                  <button
                    type="button"
                    className="tray-clipboard-nab"
                    aria-label="Nab: Stage as download"
                    aria-disabled={busy}
                    onClick={() => void download(entry.content)}
                  >
                    <DesignIcon asset={assets.nab} />
                    Nab
                  </button>
                )}
                {entry.pinned && (
                  <span title="Pinned" className="tray-clipboard-pinned">
                    <DesignIcon asset={assets.pin} />
                  </span>
                )}
                {index < 9 && <Kbd>{index + 1}</Kbd>}
                <details className="tray-clipboard-actions">
                  <summary aria-label={`Actions for ${clipboardTitle(entry)}`} title="Item actions">
                    ···
                  </summary>
                  <div>
                    <button
                      type="button"
                      aria-disabled={busy}
                      onClick={() =>
                        void run(() => togglePin(entry.id), entry.pinned ? "Unpinned" : "Pinned")
                      }
                    >
                      {entry.pinned ? "Unpin" : "Pin"}
                    </button>
                    <button type="button" onClick={() => setContextId(entry.id)}>
                      Context actions
                    </button>
                    <button
                      type="button"
                      aria-disabled={busy}
                      onClick={() => void run(() => deleteEntry(entry.id), "Item removed")}
                    >
                      Delete
                    </button>
                  </div>
                </details>
              </article>
            );
          })}
          {!filtered.length && (
            <div className="tray-clipboard-empty">
              <h2>{entries.length ? "No matching items" : "History stays on this device."}</h2>
              <p>
                {entries.length
                  ? "Try another filter or search."
                  : "Copied text, links, images and files appear here when capture is on."}
              </p>
            </div>
          )}
        </div>
        {contextEntry && (
          <section className="tray-clipboard-context" aria-label="Clipboard context actions">
            <IconButton label="Close context actions" onClick={() => setContextId(null)}>
              <DownloadIcon name="close" />
            </IconButton>
            <ClipboardContext
              entry={contextEntry}
              download={async (url) => {
                await stageUrl(url);
                await setLastTab("download");
              }}
            />
          </section>
        )}
        <span className="sr-only" role="status">
          {message}
        </span>
        {actionError && (
          <p role="alert" className="tray-clipboard-action-error">
            {actionError}
          </p>
        )}
      </div>
      <footer className="tray-clipboard-footer">
        <span>
          {settings?.pauseClipboardCapture
            ? "Capture paused"
            : `Kept for ${settings?.retentionDays ?? 30} days · skips passwords and card numbers`}
        </span>
        <button
          type="button"
          aria-disabled={busy}
          aria-pressed={!!settings?.pauseClipboardCapture}
          onClick={() =>
            void run(
              () => patchSettings({ pauseClipboardCapture: !settings?.pauseClipboardCapture }),
              "Capture preference saved",
            )
          }
        >
          <DesignIcon asset={assets.pause} />
          {settings?.pauseClipboardCapture ? "Resume" : "Pause"}
        </button>
      </footer>
    </section>
  );
}
