import { useEffect, useId, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { Toggle } from "../../components/Toggle";
import { PresetChip } from "../../components/PresetChip";
import { LinkIcon } from "./LinkIcon";
import { sameScope } from "./captureDraft";
import {
  linksApi,
  type BookmarkCatalog,
  type BookmarkOptions,
  type BookmarkPreview,
  type BookmarkImport,
  type ImportProgress,
} from "./linksApi";
import type { NotesContext } from "./types";
import { tackApi, type TackConnection, type TackProfile } from "./tackApi";
import { TackConnectionSheet } from "./TackConnectionSheet";
import "./links.css";

export function BookmarkImportSheet({
  scope,
  readOnly = false,
  close,
  changed,
}: {
  scope: NotesContext | null;
  readOnly?: boolean;
  close: () => void;
  changed: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    title = useId();
  const [destination, setDestination] = useState(scope),
    [catalog, setCatalog] = useState<BookmarkCatalog | null>(null),
    [selected, setSelected] = useState<string[]>([]);
  const [options, setOptions] = useState<BookmarkOptions>({
    foldersAsLabels: true,
    skipDuplicates: true,
    priority: "later",
  });
  const [preview, setPreview] = useState<{ value: BookmarkPreview; fingerprint: string } | null>(
      null,
    ),
    [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<BookmarkImport | null>(null),
    [history, setHistory] = useState<BookmarkImport[]>([]),
    [progress, setProgress] = useState<ImportProgress | null>(null);
  const [connection, setConnection] = useState<{
      initial: TackConnection;
      profile: TackProfile;
    } | null>(null),
    [connectionOpen, setConnectionOpen] = useState(false);
  const alive = useRef(true),
    working = useRef(false),
    loadGeneration = useRef(0),
    previewGeneration = useRef(0),
    session = useRef<string | null>(null),
    committing = useRef<string | null>(null);
  const stale = !sameScope(scope, destination);
  const fingerprint = JSON.stringify([catalog?.sessionId, selected, options, destination]);
  const ready = preview?.fingerprint === fingerprint ? preview.value : null;
  const locked = busy || previewing || stale || readOnly;
  const loadConnection = async () => {
    try {
      const [initial, profile] = await Promise.all([tackApi.snapshot(), tackApi.profile()]);
      if (alive.current) setConnection({ initial, profile });
    } catch {
      /* Bookmark files remain usable in local mode. */
    }
  };
  const load = async () => {
    if (working.current) return;
    working.current = true;
    const generation = ++loadGeneration.current;
    setBusy(true);
    setError("");
    setPreview(null);
    setResult(null);
    setDestination(scope);
    ++previewGeneration.current;
    try {
      const [next] = await Promise.all([linksApi.discover(), loadConnection()]);
      if (!alive.current || generation !== loadGeneration.current) {
        await linksApi.release(next.sessionId);
        return;
      }
      if (session.current) await linksApi.release(session.current);
      session.current = next.sessionId;
      setCatalog(next);
      setSelected(next.sources.filter((s) => !s.error && s.browser !== "Firefox").map((s) => s.id));
      const recent = await linksApi.history(scope);
      if (alive.current && generation === loadGeneration.current) setHistory(recent);
    } catch {
      if (alive.current && generation === loadGeneration.current)
        setError("Bookmark sources could not be scanned. Try again or choose an HTML export.");
    } finally {
      if (generation === loadGeneration.current) {
        working.current = false;
        if (alive.current) setBusy(false);
      }
    }
  };
  const initialLoad = useRef(load);
  initialLoad.current = load;
  useEffect(() => {
    alive.current = true;
    const origin = document.activeElement;
    dialog.current?.showModal();
    void initialLoad.current();
    let active = true;
    let stop: (() => void) | undefined;
    void listen<ImportProgress>("notes:import-progress", (event) => {
      if (active && alive.current && event.payload.id === committing.current)
        setProgress(event.payload);
    }).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      alive.current = false;
      working.current = false;
      stop?.();
      if (session.current) void linksApi.release(session.current).catch(() => {});
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus();
    };
    // A sheet owns its initial read session; destination changes require Rescan.
  }, []);
  useEffect(() => {
    if (!catalog || stale || readOnly || result) {
      setPreviewing(false);
      setPreview(null);
      return;
    }
    const generation = ++previewGeneration.current;
    let active = true;
    setPreviewing(true);
    setPreview(null);
    void linksApi
      .preview(catalog.sessionId, selected, destination, options)
      .then((value) => {
        if (active && alive.current && generation === previewGeneration.current) {
          setPreview({ value, fingerprint });
          setError("");
        }
      })
      .catch(() => {
        if (active && alive.current)
          setError(
            "The preview could not be prepared. Review the destination and rescan the bookmark sources.",
          );
      })
      .finally(() => {
        if (active && alive.current && generation === previewGeneration.current)
          setPreviewing(false);
      });
    return () => {
      active = false;
    };
  }, [catalog, selected, destination, options, stale, readOnly, result, fingerprint]);
  const pick = async () => {
    if (working.current || !catalog) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await linksApi.pickHtml(catalog.sessionId);
      if (next && alive.current) {
        setCatalog(next);
        setSelected((current) => [
          ...new Set([
            ...current,
            ...next.sources.filter((s) => s.browser === "HTML" && !s.error).map((s) => s.id),
          ]),
        ]);
      }
    } catch {
      if (alive.current)
        setError("The HTML export could not be read. Choose a UTF-8 .html bookmarks export.");
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const commit = async () => {
    if (working.current || locked || !ready || !ready.eligible) return;
    working.current = true;
    setBusy(true);
    setError("");
    committing.current = ready.planId;
    try {
      const saved = await linksApi.commit(ready.planId, destination);
      if (alive.current) {
        setResult(saved);
        setHistory(await linksApi.history(destination));
        await changed();
      }
    } catch {
      if (alive.current)
        setError(
          "The import could not finish. Your bookmarks were not removed. Retry this import or check Recent imports before starting another.",
        );
    } finally {
      working.current = false;
      committing.current = null;
      if (alive.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  };
  const undo = async (id: string) => {
    if (working.current || stale || readOnly) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await linksApi.undo(id, destination);
      if (alive.current) {
        setHistory(await linksApi.history(destination));
        setResult((current) =>
          current?.id === id ? { ...current, undoAvailable: false } : current,
        );
        await changed();
      }
    } catch {
      if (alive.current)
        setError("This import could not be undone. Return to its workspace and try again.");
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const sources = catalog?.sources ?? [],
    browserCount = new Set(sources.filter((s) => s.browser !== "HTML").map((s) => s.browser)).size;
  return (
    <>
      <dialog
        ref={dialog}
        className="bookmark-import"
        aria-labelledby={title}
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) close();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy) close();
        }}
      >
        <header>
          <div>
            <h2 id={title}>Import bookmarks</h2>
            <p>
              {busy && !catalog
                ? "Looking for bookmarks…"
                : `Found in ${browserCount} ${browserCount === 1 ? "browser" : "browsers"} on this PC`}
            </p>
          </div>
          <IconButton label="Close bookmark import" disabled={busy} onClick={close}>
            <LinkIcon name="importImgIcon" />
          </IconButton>
        </header>
        <div className="bookmark-import-body">
          {stale && (
            <p role="status" className="links-error">
              The workspace changed. Rescan to review the new destination before importing.
            </p>
          )}
          {readOnly && (
            <p role="status" className="links-error">
              This workspace is read only. Choose a writable destination to import bookmarks.
            </p>
          )}
          {error && (
            <p role="alert" className="links-error">
              {error}
            </p>
          )}
          {result ? (
            <section className="bookmark-import-result" aria-label="Import result">
              <h3>Imported {result.imported.toLocaleString()} links</h3>
              <p>
                {result.duplicates.toLocaleString()} duplicates found ·{" "}
                {result.skipped.toLocaleString()} unsupported links skipped
              </p>
              <p>
                {destination
                  ? "Changes are saved on this PC and queued for Tack."
                  : "Saved on this PC. No Tack connection is needed."}
              </p>
              {result.undoAvailable ? (
                <Button disabled={busy || stale || readOnly} onClick={() => void undo(result.id)}>
                  Undo import
                </Button>
              ) : (
                <p>
                  {result.imported
                    ? "Import undone. Its links are in Trash."
                    : "No new links were added."}
                </p>
              )}
              <Button disabled={busy || stale} onClick={() => void load()}>
                Import more
              </Button>
            </section>
          ) : (
            <>
              <h3 className="bookmark-import-label">Sources</h3>
              <div className="bookmark-sources">
                {sources.map((source) => (
                  <label className="bookmark-source" key={source.id}>
                    <span className="bookmark-source-check">
                      <input
                        type="checkbox"
                        aria-label={source.name}
                        disabled={locked || !!source.error}
                        checked={selected.includes(source.id)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setPreview(null);
                          setSelected((current) =>
                            checked
                              ? [...current, source.id]
                              : current.filter((id) => id !== source.id),
                          );
                        }}
                      />
                      <LinkIcon
                        name={
                          selected.includes(source.id)
                            ? "importImgIconSquareCheck"
                            : "importImgIconSquare"
                        }
                      />
                    </span>
                    <span>
                      <strong>{source.name}</strong>
                      <small>
                        {source.error ??
                          `${source.links.toLocaleString()} links${source.folders ? ` · ${source.folders.toLocaleString()} folders` : ""}${source.browser === "Firefox" ? " · read from a copy, Firefox can stay open" : ""}`}
                      </small>
                    </span>
                  </label>
                ))}
                <button
                  type="button"
                  className="bookmark-source bookmark-file"
                  disabled={busy || previewing || !catalog}
                  onClick={() => void pick()}
                >
                  <LinkIcon name="importImgIconFolderOpen" />
                  <span>
                    <strong>Bookmarks file (.html)…</strong>
                    <small>Safari, Opera or any export</small>
                  </span>
                </button>
              </div>
              {!sources.length && catalog && (
                <p className="bookmark-import-help">
                  No browser bookmark files were found. Choose an HTML export to continue.
                </p>
              )}
              <h3 className="bookmark-import-label bookmark-options-label">Options</h3>
              <div className="bookmark-options">
                <Toggle
                  checked={options.foldersAsLabels}
                  disabled={locked}
                  label="Folders become labels"
                  description="Bookmarks bar › Design › Fonts → #Design #Fonts"
                  onChange={(value) => {
                    setPreview(null);
                    setOptions((current) => ({ ...current, foldersAsLabels: value }));
                  }}
                />
                <Toggle
                  checked={options.skipDuplicates}
                  disabled={locked}
                  label="Skip links already in Tack"
                  description={
                    ready
                      ? `${ready.duplicates.toLocaleString()} duplicates found (same address, tracking removed)`
                      : "Same address, tracking removed"
                  }
                  onChange={(value) => {
                    setPreview(null);
                    setOptions((current) => ({ ...current, skipDuplicates: value }));
                  }}
                />
                <div className="bookmark-option-row">
                  <span>Add as</span>
                  <div>
                    <PresetChip
                      selected={options.priority === "inbox"}
                      disabled={locked}
                      onClick={() => {
                        setPreview(null);
                        setOptions((current) => ({ ...current, priority: "inbox" }));
                      }}
                    >
                      Inbox
                    </PresetChip>
                    <PresetChip
                      selected={options.priority === "later"}
                      disabled={locked}
                      onClick={() => {
                        setPreview(null);
                        setOptions((current) => ({ ...current, priority: "later" }));
                      }}
                    >
                      Later
                    </PresetChip>
                  </div>
                </div>
                <div className="bookmark-option-row">
                  <span>Save to</span>
                  <Button
                    size="sm"
                    disabled={busy || !connection}
                    onClick={() => setConnectionOpen(true)}
                  >
                    {destination
                      ? `Tack · ${connection?.initial.workspace?.name ?? "Current workspace"}`
                      : "This PC"}
                    <LinkIcon name="importImgIconChevronDown" />
                  </Button>
                </div>
              </div>
              {ready?.skipped ? (
                <p className="bookmark-import-help">
                  {ready.skipped.toLocaleString()} unsupported links will be skipped. Bookmarks in
                  Archive or Trash also count as existing links.
                </p>
              ) : null}
            </>
          )}
          {catalog && (
            <details className="bookmark-read-files">
              <summary>Files read on this PC</summary>
              <ul>
                {catalog.readFiles.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
              <p>
                Only bookmark files and profile display names were read. Firefox was queried from a
                temporary read-only copy.
              </p>
            </details>
          )}
          {history.length > 0 && (
            <details className="bookmark-import-history">
              <summary>Recent imports</summary>
              <ul>
                {history.map((item) => (
                  <li key={item.id}>
                    <span>
                      {item.imported.toLocaleString()} links
                      {item.undoAvailable ? "" : item.imported ? " · undone" : " · no new links"}
                    </span>
                    {item.undoAvailable && (
                      <Button
                        size="sm"
                        disabled={busy || stale || readOnly}
                        onClick={() => void undo(item.id)}
                      >
                        Undo import
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!result && (
            <button
              type="button"
              className="bookmark-rescan"
              disabled={busy || previewing}
              onClick={() => void load()}
            >
              Rescan sources
            </button>
          )}
        </div>
        <footer>
          <p>
            {destination
              ? "Read on this PC; links go only to your Tack"
              : "Read on this PC; links stay on this PC"}
          </p>
          {result ? (
            <Button size="sm" variant="primary" disabled={busy} onClick={close}>
              Done
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={locked || !ready?.eligible}
              onClick={() => void commit()}
            >
              <LinkIcon name="importImgIcon1" />
              {busy
                ? progress?.total
                  ? `Importing ${progress.done}/${progress.total}`
                  : "Importing…"
                : previewing
                  ? "Preparing preview…"
                  : `Import ${(ready?.eligible ?? 0).toLocaleString()} links`}
            </Button>
          )}
        </footer>
      </dialog>
      {connectionOpen && connection && (
        <TackConnectionSheet
          initial={connection.initial}
          profile={connection.profile}
          close={() => setConnectionOpen(false)}
          complete={() => {
            setConnectionOpen(false);
            void loadConnection();
            void changed();
          }}
        />
      )}
    </>
  );
}
