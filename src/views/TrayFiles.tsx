import { useEffect, useReducer, useRef, useState } from "react";
import { FilesPanel } from "../features/files/FilesPanel";
import { islandReducer, initialIsland } from "../store/islandStore";
import { shelfApi } from "../features/shelf/api";
import type { Modifiers } from "../features/files/api";
import "./trayFiles.css";
import { DownloadIcon } from "../features/downloads/DownloadIcon";

export interface TrayFileDrop {
  id: number;
  paths: string[];
  pinId: string | null;
  modifiers: Modifiers;
}
export function TrayFiles({
  drop,
  consumed,
}: {
  drop: TrayFileDrop | null;
  consumed: (id: number) => void;
}) {
  const [model, dispatch] = useReducer(islandReducer, undefined, () => ({
    ...initialIsland("main"),
    state: "expanded" as const,
    tab: "files" as const,
  }));
  const [error, setError] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const search = useRef<HTMLInputElement>(null),
    focusSearch = useRef(false);
  const consumedId = useRef<number>();
  const root = useRef<HTMLElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const focus = () => {
      if (model.filters.fileMove || model.filters.fileTool) {
        setMessage("Close the file review to search Shelf and Pins.");
        return;
      }
      setMessage("");
      dispatch({ type: "filter", name: "shelfSelection", value: "" });
      if (search.current) search.current.focus();
      else {
        focusSearch.current = true;
        setQuery("");
      }
    };
    window.addEventListener("nabbit:focus-files-search", focus);
    return () => window.removeEventListener("nabbit:focus-files-search", focus);
  }, [model.filters.fileMove, model.filters.fileTool]);
  useEffect(() => {
    if (focusSearch.current && search.current) {
      search.current.focus();
      focusSearch.current = false;
    }
  }, [query]);
  useEffect(() => {
    if (!drop || consumedId.current === drop.id) return;
    consumedId.current = drop.id;
    if (drop.pinId) {
      dispatch({
        type: "filter",
        name: "fileMove",
        value: JSON.stringify({ paths: drop.paths, pinId: drop.pinId, modifiers: drop.modifiers }),
      });
      consumed(drop.id);
    } else {
      void shelfApi
        .add(drop.paths)
        .catch((reason: unknown) => {
          if (alive.current) setError(String(reason));
        })
        .finally(() => {
          if (alive.current) consumed(drop.id);
        });
    }
  }, [drop, consumed]);
  return (
    <section ref={root} className="tray-files" aria-label="Files, Shelf and Pins">
      {query !== null && (
        <label className="tray-files-search">
          <DownloadIcon name="search" />
          <input
            ref={search}
            type="search"
            aria-label="Search Shelf and Pins"
            placeholder="Search Shelf and Pins"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setQuery(null);
                requestAnimationFrame(() =>
                  document
                    .querySelector<HTMLButtonElement>('button[aria-label="Search files"]')
                    ?.focus(),
                );
              }
            }}
          />
        </label>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      <FilesPanel model={model} dispatch={dispatch} query={query ?? ""} />
    </section>
  );
}
