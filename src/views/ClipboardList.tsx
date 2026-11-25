import { Copy, Download, Pin, PinOff, Search, Trash2 } from "lucide-react";
import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "../components/IconButton";
import { filterClipboardEntries, formatRelativeTime, clampIndex } from "../lib/search";
import type { ClipboardEntry } from "../lib/types";
import { useAppStore } from "../store/useAppStore";

export function ClipboardList() {
  const entries = useAppStore((state) => state.clipboardEntries);
  const copyEntry = useAppStore((state) => state.copyEntry);
  const togglePin = useAppStore((state) => state.togglePin);
  const deleteEntry = useAppStore((state) => state.deleteEntry);
  const stageUrl = useAppStore((state) => state.stageUrl);
  const setLastTab = useAppStore((state) => state.setLastTab);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => filterClipboardEntries(entries, query), [entries, query]);

  useEffect(() => {
    setActiveIndex((index) => clampIndex(index, filtered.length));
  }, [filtered.length]);

  useEffect(() => {
    searchRef.current?.focus();
    const focus = () => searchRef.current?.focus();
    const focusOnShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        focus();
      }
    };
    window.addEventListener("nabbit:focus-search", focus);
    window.addEventListener("keydown", focusOnShortcut);
    return () => {
      window.removeEventListener("nabbit:focus-search", focus);
      window.removeEventListener("keydown", focusOnShortcut);
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => clampIndex(index + 1, filtered.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => clampIndex(index - 1, filtered.length));
      return;
    }
    if (event.key === "Enter" && filtered[activeIndex]) {
      event.preventDefault();
      void copyEntry(filtered[activeIndex].id);
      return;
    }
    if (event.key === "Delete" && filtered[activeIndex]) {
      event.preventDefault();
      void deleteEntry(filtered[activeIndex].id);
      return;
    }
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (filtered[index]) {
        event.preventDefault();
        void copyEntry(filtered[index].id);
      }
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden" onKeyDown={handleKeyDown}>
      <div className="shrink-0 border-b border-subtle p-4">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-2.5 text-tertiary" size={16} />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search clipboard"
            className="h-10 w-full rounded-lg border border-subtle bg-surface pl-9 pr-3 text-sm outline-none transition focus:border-strong focus:ring-2 focus:ring-action-primary/20"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {filtered.length === 0 ? (
          <div className="grid h-full place-items-center p-8 text-center">
            <div>
              <p className="font-medium">History stays on this device.</p>
              <p className="mt-1 text-sm text-secondary">
                Copied text and links appear here after the desktop watcher sees them.
              </p>
            </div>
          </div>
        ) : null}
        <div className="grid gap-1">
          {filtered.map((entry, index) => (
            <ClipboardRow
              key={entry.id}
              entry={entry}
              active={index === activeIndex}
              onCopy={() => void copyEntry(entry.id)}
              onPin={() => void togglePin(entry.id)}
              onDelete={() => void deleteEntry(entry.id)}
              onDownload={() => {
                void stageUrl(entry.content);
                void setLastTab("download");
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ClipboardRow({
  entry,
  active,
  onCopy,
  onPin,
  onDelete,
  onDownload,
}: {
  entry: ClipboardEntry;
  active: boolean;
  onCopy: () => void;
  onPin: () => void;
  onDelete: () => void;
  onDownload: () => void;
}) {
  const isVideoUrl =
    entry.contentType === "url" &&
    /(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(entry.content);

  return (
    <article
      className={`group grid cursor-default grid-cols-[1fr_auto] gap-2 rounded-lg border p-3 transition ${
        active
          ? "border-strong bg-raised"
          : "border-transparent hover:border-subtle hover:bg-raised"
      }`}
      onClick={onCopy}
    >
      <div className="min-w-0">
        <div className="mb-1 flex items-center gap-2 text-xs text-secondary">
          <span className="rounded bg-sunken px-1.5 py-0.5 uppercase">{entry.contentType}</span>
          {entry.sourceApp ? <span className="truncate">{entry.sourceApp}</span> : null}
          <span>{formatRelativeTime(entry.lastUsedAt)}</span>
          {entry.pinned ? <Pin size={12} className="text-primary" /> : null}
        </div>
        <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm leading-5">
          {entry.preview}
        </p>
      </div>
      <div className="flex items-start gap-0.5 opacity-100 sm:opacity-0 sm:transition sm:group-hover:opacity-100">
        {isVideoUrl ? (
          <IconButton
            label="Stage as download"
            onClick={(event) => {
              event.stopPropagation();
              onDownload();
            }}
          >
            <Download size={15} />
          </IconButton>
        ) : null}
        <IconButton
          label="Copy"
          onClick={(event) => {
            event.stopPropagation();
            onCopy();
          }}
        >
          <Copy size={15} />
        </IconButton>
        <IconButton
          label={entry.pinned ? "Unpin" : "Pin"}
          active={entry.pinned}
          onClick={(event) => {
            event.stopPropagation();
            onPin();
          }}
        >
          {entry.pinned ? <PinOff size={15} /> : <Pin size={15} />}
        </IconButton>
        <IconButton
          label="Delete"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 size={15} />
        </IconButton>
      </div>
    </article>
  );
}
