import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { PresetChip } from "../../components/PresetChip";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { sameScope } from "./captureDraft";
import { linksApi, type LinkAction } from "./linksApi";
import type { NotesContext, StoredNote } from "./types";
import { LinkIcon } from "./LinkIcon";
import "./links.css";
import { linkDomain as domain, linkDate as date, isVideo } from "./linkPresentation";

export function LinksPanel({
  cards,
  scope,
  readOnly = false,
  island = false,
  all,
  importBookmarks,
  refresh,
  download,
}: {
  cards: StoredNote[];
  scope: NotesContext | null;
  readOnly?: boolean;
  island?: boolean;
  all: () => void;
  importBookmarks: () => void;
  refresh: () => Promise<void>;
  download: (url: string) => Promise<void>;
}) {
  const [query, setQuery] = useState(""),
    [label, setLabel] = useState(""),
    [later, setLater] = useState(false);
  const [selection, setSelection] = useState<{ scope: NotesContext | null; cards: StoredNote[] }>({
    scope,
    cards: [],
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [labelOpen, setLabelOpen] = useState(false),
    [newLabels, setNewLabels] = useState("");
  const alive = useRef(true),
    working = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const links = useMemo(
    () =>
      cards.filter((n) => n.value.kind === "bookmark" && !n.value.archived && !n.value.trashedAt),
    [cards],
  );
  const selected = sameScope(selection.scope, scope) ? selection.cards : [];
  const availableLabels = [...new Set(links.flatMap((n) => n.value.labels))].sort();
  const visible = links.filter(
    (n) =>
      (!later || n.value.priority === "later") &&
      (!label || n.value.labels.includes(label)) &&
      (!query.trim() ||
        [n.value.title, domain(n.value.url)]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())),
  );
  const toggle = (note: StoredNote) => {
    setError("");
    setSelection({
      scope,
      cards: selected.some((n) => n.value.id === note.value.id)
        ? selected.filter((n) => n.value.id !== note.value.id)
        : [...selected, note],
    });
  };
  const run = async (action: () => Promise<unknown>, clear = false) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      if (alive.current) {
        if (clear) {
          setSelection({ scope, cards: [] });
          setLabelOpen(false);
        }
        if (clear) await refresh();
      }
    } catch {
      if (alive.current)
        setError(
          "Links could not be updated. The workspace or selected links may have changed. Refresh and select them again.",
        );
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const bulk = (action: LinkAction) => run(() => linksApi.bulk(selected, scope, action), true);
  return (
    <section
      className={`links-panel${island ? " links-panel--island" : ""}`}
      aria-label="Saved links"
    >
      <label className="links-search">
        <LinkIcon name="linksImgIconSearch" />
        <input
          aria-label="Search links"
          placeholder={`Search ${links.length.toLocaleString()} links`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="links-filters" role="group" aria-label="Link filters">
        <PresetChip surface={island ? "island" : "light"} onClick={all}>
          All
        </PresetChip>
        <PresetChip
          surface={island ? "island" : "light"}
          selected
          onClick={() => {
            setQuery("");
            setLabel("");
            setLater(false);
          }}
        >
          Links <span className="links-count">{links.length.toLocaleString()}</span>
        </PresetChip>
        <PresetChip
          surface={island ? "island" : "light"}
          selected={later}
          onClick={() => setLater((v) => !v)}
        >
          Later
        </PresetChip>
        {availableLabels.slice(0, island ? 2 : 3).map((l) => (
          <PresetChip
            surface={island ? "island" : "light"}
            key={l}
            selected={label === l}
            onClick={() => setLabel(label === l ? "" : l)}
          >
            #{l}
          </PresetChip>
        ))}
        <IconButton
          className="links-import"
          label="Import bookmarks"
          disabled={busy}
          onClick={importBookmarks}
        >
          <LinkIcon name="importImgIcon1" />
        </IconButton>
      </div>
      {availableLabels.length > (island ? 2 : 3) && (
        <label className="links-label-filter">
          Label
          <select aria-label="Link label" value={label} onChange={(e) => setLabel(e.target.value)}>
            <option value="">All labels</option>
            {availableLabels.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p role="alert" className="links-error">
          {error}
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                setSelection({ scope, cards: [] });
                await refresh();
              })
            }
          >
            Refresh links
          </button>
        </p>
      )}
      <div className="links-rows" role="group" aria-label="Links">
        {visible.map((note) => {
          const c = note.value,
            host = domain(c.url),
            checked = selected.some((n) => n.value.id === c.id),
            video = isVideo(c.url);
          return (
            <article className="link-row" key={c.id} data-link-id={c.id} data-selected={checked}>
              <label className="link-select">
                <input
                  type="checkbox"
                  aria-label={`Select ${c.title || host}`}
                  checked={checked}
                  disabled={busy}
                  onChange={() => toggle(note)}
                />
                <span
                  className={`link-letter link-letter--${Array.from(host).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 5}`}
                  aria-hidden="true"
                >
                  {(c.title || host).slice(0, 1).toUpperCase()}
                </span>
              </label>
              <button
                type="button"
                className="link-title"
                disabled={busy}
                onClick={() => void run(() => linksApi.open([note], scope))}
              >
                <span>{c.title || host}</span>
                <small>
                  {host}
                  {c.labels.length ? ` · ${c.labels.map((l) => `#${l}`).join(" ")}` : ""}
                  {c.priority === "later" ? " · Later" : ""} · {date(c.createdAt)}
                </small>
              </button>
              <div className="link-row-actions">
                {video ? (
                  <IconButton
                    label={`Download ${c.title || host}`}
                    disabled={busy}
                    onClick={() => void run(() => download(c.url))}
                  >
                    <LinkIcon name="linksImgIcon3" />
                  </IconButton>
                ) : (
                  <IconButton
                    label={`Open ${c.title || host}`}
                    disabled={busy}
                    onClick={() => void run(() => linksApi.open([note], scope))}
                  >
                    <LinkIcon name="linksImgIcon" />
                  </IconButton>
                )}
                <IconButton
                  label={`Copy ${c.title || host}`}
                  disabled={busy}
                  onClick={() => void run(() => writeText(c.url))}
                >
                  <LinkIcon name="linksImgIcon1" />
                </IconButton>
              </div>
            </article>
          );
        })}
        {!visible.length && (
          <p className="links-empty">
            {links.length
              ? "No links match these filters."
              : "Saved links appear here. Import bookmarks or save a copied link."}
          </p>
        )}
      </div>
      {selected.length > 0 && (
        <div className="links-bulk" role="group" aria-label="Selected link actions">
          <strong>{selected.length} selected</strong>
          <IconButton
            label="Clear link selection"
            disabled={busy}
            onClick={() => setSelection({ scope, cards: [] })}
          >
            <LinkIcon name="importImgIcon" />
          </IconButton>
          <Button size="sm" disabled={readOnly || busy} onClick={() => setLabelOpen((v) => !v)}>
            <LinkIcon name="linksImgIcon2" />
            Label
          </Button>
          <Button
            size="sm"
            disabled={readOnly || busy}
            onClick={() => void bulk({ kind: "later" })}
          >
            <LinkIcon name="linksImgIcon5" />
            Later
          </Button>
          <Button
            size="sm"
            disabled={readOnly || busy}
            onClick={() => void bulk({ kind: "archive" })}
          >
            Archive
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void run(() => linksApi.open(selected, scope))}
          >
            <LinkIcon name="linksImgIcon4" />
            Open all
          </Button>
        </div>
      )}
      {labelOpen && selected.length > 0 && (
        <form
          className="links-bulk-label"
          onSubmit={(e) => {
            e.preventDefault();
            void bulk({
              kind: "label",
              labels: newLabels
                .split(",")
                .map((s) => s.trim().replace(/^#/, ""))
                .filter(Boolean),
            });
          }}
        >
          <label>
            Labels, separated by commas
            <input
              aria-label="Labels for selected links"
              value={newLabels}
              onChange={(e) => setNewLabels(e.target.value)}
            />
          </label>
          <Button type="submit" size="sm" disabled={readOnly || busy || !newLabels.trim()}>
            Apply labels
          </Button>
        </form>
      )}
    </section>
  );
}
