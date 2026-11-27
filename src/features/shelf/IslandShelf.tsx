import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { IslandAction, IslandModel } from "../../store/islandStore";
import { IslandAsset } from "../../surfaces/island/IslandAsset";
import { MiniButton } from "../../surfaces/island/CompactContent";
import { shelfApi, type ShelfItem } from "./api";
import { shelfSelection, shelfSize } from "./model";
import "./shelf.css";

function ShelfPreview({ item, selectedMode }: { item: ShelfItem; selectedMode: boolean }) {
  const root = useRef<HTMLSpanElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (item.kind !== "image" || !item.available || !root.current) return;
    let active = true,
      loaded = false;
    const load = () => {
      if (loaded) return;
      loaded = true;
      void shelfApi
        .preview(item.id)
        .then((url) => {
          if (active) setPreview(url);
        })
        .catch(() => {});
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((events) => {
            if (events.some((event) => event.isIntersecting)) {
              load();
              observer?.disconnect();
            }
          });
    if (observer) observer.observe(root.current);
    else load();
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [item.id, item.kind, item.available]);
  return (
    <span ref={root} className="shelf-preview">
      {preview ? (
        <img
          className="shelf-thumbnail"
          src={preview}
          alt=""
          draggable={false}
          onError={() => setPreview(null)}
        />
      ) : (
        <IslandAsset
          group={selectedMode ? "34:897" : "10:249"}
          name={
            item.kind === "video"
              ? "iconFilm"
              : selectedMode && item.kind === "image" && !/\.hei[cf]$/i.test(item.name)
                ? "iconImage"
                : "iconFile"
          }
        />
      )}
    </span>
  );
}
export function IslandShelf({
  model,
  dispatch,
}: {
  model: IslandModel;
  dispatch: (action: IslandAction) => void;
}) {
  const [items, setItems] = useState<ShelfItem[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [disconnected, setDisconnected] = useState(false);
  const root = useRef<HTMLElement>(null),
    alive = useRef(true),
    working = useRef(false),
    generation = useRef({ value: 0 });
  const wanted = useMemo(
    () => shelfSelection(model.filters.shelfSelection),
    [model.filters.shelfSelection],
  );
  const selected = useMemo(
    () => wanted.filter((id) => items.some((item) => item.id === id)),
    [items, wanted],
  );
  useEffect(() => {
    if (!loading && selected.length !== wanted.length)
      dispatch({
        type: "filter",
        name: "shelfSelection",
        value: selected.length ? JSON.stringify(selected) : "",
      });
  }, [loading, selected, wanted, dispatch]);
  const selectedMode = selected.length > 0;
  const refresh = useCallback(async () => {
    const revision = ++generation.current.value;
    try {
      const rows = await shelfApi.list();
      if (alive.current && revision === generation.current.value) {
        setItems(rows);
        setLoading(false);
        setError("");
      }
    } catch {
      if (alive.current && revision === generation.current.value) {
        setError("The Shelf could not be loaded. Refresh to try again.");
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    const counter = generation.current;
    let active = true;
    const stops: Array<() => void> = [];
    void Promise.allSettled([
      listen("shelf:changed", () => {
        if (active) void refresh();
      }),
      listen<boolean>("tauri://focus", (event) => {
        if (active && event.payload) void refresh();
      }),
    ]).then((results) => {
      for (const result of results)
        if (result.status === "fulfilled") {
          if (active) stops.push(result.value);
          else result.value();
        }
      if (active) {
        setDisconnected(results.some((r) => r.status === "rejected"));
        void refresh();
      }
    });
    return () => {
      alive.current = false;
      active = false;
      counter.value++;
      stops.forEach((stop) => stop());
    };
  }, [refresh]);
  const select = (ids: string[]) =>
    dispatch({
      type: "filter",
      name: "shelfSelection",
      value: ids.length ? JSON.stringify(ids) : "",
    });
  const toggle = (id: string) =>
    select(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);
  const run = async (action: () => Promise<unknown>, acknowledgement: string) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      if (alive.current) {
        setMessage(acknowledgement);
        await refresh();
      }
    } catch {
      if (alive.current) {
        await refresh();
        if (alive.current)
          setError("The Shelf action could not finish. Refresh to check the files and try again.");
      }
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const copy = () => void run(() => shelfApi.copy(selectedMode ? selected : null), "Paths copied");
  const remove = (ids: string[] | null) =>
    void run(
      async () => {
        await shelfApi.remove(ids);
        select([]);
      },
      ids === null
        ? "Shelf cleared. Original files are unchanged."
        : "Removed from Shelf. Original files are unchanged.",
    );
  const drag = (item: ShelfItem) => {
    if (!item.available) return;
    const ids = selected.includes(item.id) ? selected : [item.id];
    void run(async () => {
      const host = root.current?.closest<HTMLElement>(".island-host");
      if (host) host.dataset.shelfOutgoing = "true";
      try {
        await shelfApi.drag(ids);
      } finally {
        if (host) delete host.dataset.shelfOutgoing;
      }
    }, "Drag finished. Files remain on the Shelf.");
  };
  const handleKey = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.altKey ||
      event.shiftKey ||
      event.getModifierState("AltGraph")
    )
      return;
    if (
      event.target instanceof Element &&
      event.target.closest("input,textarea,[contenteditable=true]")
    )
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      if (!busy) select(items.map((i) => i.id));
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      if (!event.repeat && items.length) copy();
    } else if (event.key === "Delete" && selectedMode && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (!event.repeat) remove(selected);
    }
  };
  const latestKey = useRef(handleKey);
  latestKey.current = handleKey;
  useEffect(() => {
    const host = root.current?.closest(".island-host");
    const route = (event: Event) => latestKey.current((event as CustomEvent<KeyboardEvent>).detail);
    host?.addEventListener("nabbit:island-shelf-key", route);
    return () => host?.removeEventListener("nabbit:island-shelf-key", route);
  }, []);
  return (
    <section
      ref={root}
      className="island-shelf"
      aria-label="Shelf"
      data-selection={selectedMode}
      data-drop-zone="shelf"
      onKeyDown={(event) => handleKey(event.nativeEvent)}
    >
      <h1 className="island-sr-only">Files on the Shelf</h1>
      {!selectedMode && (
        <header className="shelf-heading">
          <span>SHELF · {items.length}</span>
          <span>Files in transit</span>
        </header>
      )}
      <ul className="shelf-grid" aria-label="Shelf files" aria-busy={loading}>
        {items.map((item) => (
          <li
            key={item.id}
            data-shelf-id={item.id}
            className={`shelf-card${selected.includes(item.id) ? " is-selected" : ""}${item.available ? "" : " is-missing"}`}
          >
            <button
              type="button"
              className="shelf-item"
              aria-pressed={selected.includes(item.id)}
              aria-label={`Select ${item.name} ${shelfSize(item)}`}
              title={item.path}
              disabled={busy}
              draggable={item.available && !busy}
              onDragStart={(event) => {
                event.preventDefault();
                event.stopPropagation();
                drag(item);
              }}
              onClick={() => toggle(item.id)}
            >
              <ShelfPreview item={item} selectedMode={selectedMode} />
              <span className="shelf-name">
                <span>{item.name}</span>
                {selected.includes(item.id) && <IslandAsset group="34:897" name="iconCheck" />}
              </span>{" "}
              <small>{shelfSize(item)}</small>
            </button>
            {!item.available && (
              <button
                type="button"
                className="shelf-remove"
                aria-label={`Remove ${item.name}`}
                disabled={busy}
                onClick={() => remove([item.id])}
              >
                Remove
              </button>
            )}
          </li>
        ))}
        {!selectedMode && (
          <li className="shelf-drop" data-drop-zone="shelf" aria-label="Drop files on the Shelf">
            <IslandAsset group="10:249" name="iconPlus" />
            <span>Drop files</span>
          </li>
        )}
      </ul>
      {loading && (
        <p role="status" className="shelf-status">
          Loading Shelf…
        </p>
      )}
      {!loading && !items.length && (
        <p className="shelf-status">Drop files here. The originals stay where they are.</p>
      )}
      {(error || disconnected) && (
        <p className="shelf-error" role="alert">
          {error || "Live Shelf updates are unavailable."}{" "}
          <button type="button" onClick={() => void refresh()}>
            Refresh Shelf
          </button>
        </p>
      )}
      {message && (
        <p role="status" className="shelf-status">
          {message}
        </p>
      )}
      <footer className="shelf-footer">
        <span>
          {selectedMode
            ? `${selected.length} selected`
            : "Drag files into another app. Originals stay in place."}
        </span>
        <MiniButton disabled={!items.length || busy} onClick={copy}>
          <IslandAsset group="10:249" name="iconCopy" />
          Copy paths
        </MiniButton>
        <MiniButton
          disabled={!items.length || busy}
          onClick={() => remove(selectedMode ? selected : null)}
        >
          <IslandAsset group="10:249" name="iconTrash2" />
          {selectedMode ? "Remove" : "Clear"}
        </MiniButton>
        {selectedMode && (
          <MiniButton disabled={busy} onClick={() => select([])}>
            Deselect
          </MiniButton>
        )}
      </footer>
    </section>
  );
}
