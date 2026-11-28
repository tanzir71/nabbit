import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { MiniButton } from "../../surfaces/island/CompactContent";
import { IslandAsset } from "../../surfaces/island/IslandAsset";
import {
  filesApi,
  pinName,
  pinTarget,
  recentTarget,
  type Pin,
  type PinPeek,
  type Target,
} from "./api";
import "./files.css";
async function drag(target: Target, element: HTMLElement) {
  const host = element.closest<HTMLElement>(".island-host");
  if (host) host.dataset.shelfOutgoing = "true";
  try {
    await filesApi.drag(target);
  } finally {
    if (host) delete host.dataset.shelfOutgoing;
  }
}
function ago(modified: number) {
  const days = Math.max(0, (Date.now() - modified / 1e6) / 86400000);
  return days < 1
    ? days < 1 / 24
      ? "Just now"
      : `${Math.floor(days * 24)} h ago`
    : days < 2
      ? "Yesterday"
      : new Date(modified / 1e6).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
export function PinPreview({
  pin,
  close,
  hold,
}: {
  pin: Pin;
  close: () => void;
  hold: () => void;
}) {
  const [peek, setPeek] = useState<PinPeek | null>(null),
    [error, setError] = useState(""),
    [capabilities, setCapabilities] = useState({ terminal: false, code: false });
  const generation = useRef({ value: 0 }),
    root = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true,
      token: string | null = null,
      stop: (() => void) | undefined;
    const counter = generation.current;
    const revision = ++counter.value;
    const reload = async () => {
      if (!token) return;
      const current = ++generation.current.value;
      try {
        const items = await filesApi.recent(token);
        if (active && current === generation.current.value)
          setPeek((value) => (value ? { ...value, items } : value));
      } catch (reason) {
        if (active) setError(String(reason));
      }
    };
    void listen<string>("pins:peek-changed", (event) => {
      if (active && event.payload === token) void reload();
    })
      .then(async (unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        stop = unlisten;
        const value = await filesApi.peek(pin.id);
        token = value.token;
        if (active && revision === generation.current.value) {
          setPeek(value);
          await reload();
        } else if (!active) await filesApi.closePeek(value.token);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    void filesApi
      .capabilities()
      .then((value) => {
        if (active) setCapabilities(value);
      })
      .catch(() => {});
    return () => {
      active = false;
      counter.value++;
      stop?.();
      if (token) void filesApi.closePeek(token).catch(() => {});
    };
  }, [pin.id]);
  const action = async (target: Target, name: string) => {
    try {
      await filesApi.action(target, name);
    } catch (reason) {
      setError(String(reason));
    }
  };
  return (
    <section
      ref={root}
      className="files-pin-peek"
      aria-label={`${pinName(pin)} recent items`}
      onPointerEnter={hold}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <h2 className="island-sr-only">{pinName(pin)} recent items</h2>
      <header>
        <IslandAsset group="pinPeek" name="iconFolder" />
        <strong>{pinName(pin)}</strong>
        <small title={pin.path}>{pin.path}</small>
        <button type="button" className="files-peek-close" aria-label="Close" onClick={close}>
          <IslandAsset group="peek" name="iconX" />
        </button>
      </header>
      <ul className="files-recent" aria-label="Recent items">
        {peek?.items.map((item) => (
          <li key={item.path}>
            <button
              type="button"
              title={item.path}
              draggable
              onDragStart={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void drag(recentTarget(peek.token, item.path), event.currentTarget).catch(
                  (reason) => setError(String(reason)),
                );
              }}
              onClick={() => void action(recentTarget(peek.token, item.path), "open")}
            >
              <IslandAsset
                group="pinPeek"
                name={
                  item.directory
                    ? "iconFolder1"
                    : /\.(png|jpe?g|webp|avif|heic)$/iu.test(item.name)
                      ? "iconFileImage"
                      : "iconFileText"
                }
              />
              <span>
                {item.name}
                {item.cloud ? " · Cloud" : ""}
              </span>
              <small>{item.directory ? "Folder" : ago(item.modified)}</small>
            </button>
          </li>
        ))}
      </ul>
      {!peek && !error && <p role="status">Loading recent items…</p>}
      {peek && !peek.items.length && <p className="island-muted">This folder is empty.</p>}
      <div className="files-peek-actions">
        <MiniButton onClick={() => void action(pinTarget(pin.id), "open")}>Open</MiniButton>
        <MiniButton onClick={() => void action(pinTarget(pin.id), "reveal")}>Reveal</MiniButton>
        {capabilities.terminal && (
          <MiniButton onClick={() => void action(pinTarget(pin.id), "terminal")}>
            Terminal
          </MiniButton>
        )}
        <MiniButton onClick={() => void action(pinTarget(pin.id), "copy")}>Copy path</MiniButton>
      </div>
      {error && (
        <p role="alert" className="island-error">
          {error}
        </p>
      )}
    </section>
  );
}
function PinEditor({
  pin,
  close,
  saved,
}: {
  pin: Pin | null;
  close: () => void;
  saved: () => void;
}) {
  const [path, setPath] = useState(pin?.path ?? ""),
    [label, setLabel] = useState(pin?.label ?? ""),
    [slot, setSlot] = useState(pin?.slot?.toString() ?? ""),
    [alwaysMove, setAlwaysMove] = useState(pin?.alwaysMove ?? false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [folders, setFolders] = useState<[string, string][]>([]);
  useEffect(() => {
    let active = true;
    void filesApi
      .capabilities()
      .then((value) => {
        if (active) setFolders(value.folders);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await filesApi.save({
        id: pin?.id ?? null,
        path,
        label: label || null,
        slot: slot ? Number(slot) : null,
        alwaysMove,
      });
      saved();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const choose = async (folder: boolean) => {
    try {
      const path = await filesApi.choose(folder);
      if (path) setPath(path);
    } catch (reason) {
      setError(String(reason));
    }
  };
  return (
    <form
      className="files-pin-editor"
      aria-label={pin ? "Edit pin" : "Add pin"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 className="type-body-strong">{pin ? "Edit pin" : "Add pin"}</h2>
      <label>
        File or folder path
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          required
          disabled={busy}
        />
      </label>
      <div className="files-pins-actions">
        <MiniButton onClick={() => void choose(true)} disabled={busy}>
          Choose folder…
        </MiniButton>
        <MiniButton onClick={() => void choose(false)} disabled={busy}>
          Choose file…
        </MiniButton>
        {folders.map(([name, path]) => (
          <MiniButton key={name} disabled={busy} onClick={() => setPath(path)}>
            {name}
          </MiniButton>
        ))}
      </div>
      <label>
        Name
        <input
          value={label}
          maxLength={200}
          onChange={(event) => setLabel(event.target.value)}
          disabled={busy}
        />
      </label>
      <label>
        Shortcut number (optional)
        <input
          type="number"
          min="1"
          max="9"
          value={slot}
          onChange={(event) => setSlot(event.target.value)}
          disabled={busy}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={alwaysMove}
          onChange={(event) => setAlwaysMove(event.target.checked)}
          disabled={busy}
        />
        Always move files dropped on this folder (Ctrl still copies)
      </label>
      <div className="island-row">
        <MiniButton onClick={close} disabled={busy}>
          Cancel
        </MiniButton>
        <MiniButton type="submit" onClick={() => {}} signal disabled={busy || !path.trim()}>
          Save pin
        </MiniButton>
      </div>
      {error && (
        <p role="alert" className="island-error">
          {error}
        </p>
      )}
    </form>
  );
}
export function Pins({ query: globalQuery = "" }: { query?: string }) {
  const [pins, setPins] = useState<Pin[]>([]),
    [query, setQuery] = useState(""),
    [editor, setEditor] = useState<Pin | null | false>(false),
    [menu, setMenu] = useState<Pin | null>(null),
    [peek, setPeek] = useState<Pin | null>(null),
    [error, setError] = useState(""),
    [disconnected, setDisconnected] = useState(false),
    [capabilities, setCapabilities] = useState({ terminal: false, code: false });
  const alive = useRef(true),
    generation = useRef({ value: 0 }),
    hover = useRef<ReturnType<typeof setTimeout>>(),
    leave = useRef<ReturnType<typeof setTimeout>>(),
    held = useRef(false);
  const refresh = useCallback(async () => {
    const revision = ++generation.current.value;
    try {
      const rows = await filesApi.pins();
      if (alive.current && revision === generation.current.value) {
        setPins(rows);
        setPeek((current) =>
          current ? (rows.find((p) => p.id === current.id && p.available) ?? null) : null,
        );
        setError("");
      }
    } catch (reason) {
      if (alive.current && revision === generation.current.value) setError(String(reason));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    let active = true;
    const stops: (() => void)[] = [];
    const counter = generation.current;
    void Promise.allSettled([
      listen("pins:changed", () => {
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
    void filesApi
      .capabilities()
      .then((value) => {
        if (active) setCapabilities(value);
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      active = false;
      counter.value++;
      clearTimeout(hover.current);
      clearTimeout(leave.current);
      stops.forEach((stop) => stop());
    };
  }, [refresh]);
  const action = async (pin: Pin, name: string) => {
    try {
      await filesApi.action(pinTarget(pin.id), name);
    } catch (reason) {
      setError(String(reason));
    }
  };
  const show = (pin: Pin, hold: boolean) => {
    clearTimeout(hover.current);
    clearTimeout(leave.current);
    held.current = hold;
    setPeek(pin);
  };
  const matching = pins.filter((pin) =>
    `${pinName(pin)} ${pin.path}`.toLowerCase().includes(globalQuery.trim().toLowerCase()),
  );
  const rows = query.trim()
    ? matching
        .filter((pin) =>
          `${pinName(pin)} ${pin.path}`.toLowerCase().includes(query.trim().toLowerCase()),
        )
        .slice(0, 32)
    : globalQuery.trim()
      ? matching.slice(0, 32)
      : pins.slice(0, 8);
  return (
    <section
      className="files-pins"
      aria-label="Pins"
      onKeyDown={(event) => {
        if (event.key === "Escape" && (peek || menu || editor !== false)) {
          event.preventDefault();
          event.stopPropagation();
          held.current = false;
          setPeek(null);
          setMenu(null);
          setEditor(false);
        }
      }}
    >
      <header className="files-heading">
        <span>PINS · {pins.length}</span>
        <span>Alt+1–9 opens a pin · drop files on a folder to move them</span>
        <button
          type="button"
          className="files-add"
          disabled={disconnected}
          onClick={() => {
            held.current = false;
            setEditor(null);
            setMenu(null);
            setPeek(null);
          }}
        >
          Add pin…
        </button>
      </header>
      <ul className="files-pin-grid" aria-label="Pinned files and folders">
        {rows.map((pin) => (
          <li
            key={pin.id}
            className={`files-pin${pin.available ? "" : " is-missing"}`}
            data-drop-zone={pin.kind === "folder" ? `pin:${pin.id}` : undefined}
            onPointerEnter={() => {
              if (pin.kind === "folder" && pin.available && !held.current) {
                clearTimeout(hover.current);
                hover.current = setTimeout(() => show(pin, false), 350);
              }
            }}
            onPointerLeave={() => {
              clearTimeout(hover.current);
              if (!held.current) leave.current = setTimeout(() => setPeek(null), 300);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              held.current = false;
              setMenu(pin);
              setPeek(null);
            }}
          >
            <button
              type="button"
              aria-description={`${pin.kind}${pin.slot ? ` · Alt+${pin.slot}` : ""}`}
              title={pin.path}
              draggable={pin.available}
              disabled={disconnected}
              onDragStart={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void drag(pinTarget(pin.id), event.currentTarget).catch((reason) =>
                  setError(String(reason)),
                );
              }}
              onClick={() => {
                if (pin.kind === "folder" && pin.available) show(pin, true);
                else void action(pin, "open");
              }}
            >
              <IslandAsset
                group="10:249"
                name={
                  pin.network
                    ? "iconHardDrive"
                    : pin.kind === "folder"
                      ? "iconFolder1"
                      : /\.(pdf|png|jpe?g)$/iu.test(pin.path)
                        ? "iconFileImage"
                        : /\.(txt|docx?|xlsx?|md)$/iu.test(pin.path)
                          ? "iconFileText"
                          : "iconFile1"
                }
              />
              <span className="files-pin-label">
                <span>{pinName(pin)}</span>
                <small>
                  {pin.available
                    ? `${pin.cloud ? "Cloud · " : ""}${pin.path.split(/[\\/]/u).slice(0, -1).join("\\")}`
                    : "Unavailable · remove or edit"}
                </small>
              </span>
              <span className="files-pin-slot">{pin.slot}</span>
            </button>
            <button
              type="button"
              className="files-pin-menu"
              aria-label={`Actions for ${pinName(pin)}`}
              onClick={() => {
                held.current = false;
                setMenu(pin);
                setPeek(null);
              }}
            >
              ···
            </button>
          </li>
        ))}
      </ul>
      {!pins.length && (
        <p className="island-muted">
          Pin a file or folder to keep it close. Removing a pin leaves the original unchanged.
        </p>
      )}
      {pins.length > 0 && !rows.length && <p className="island-muted">No matching pins.</p>}
      {pins.length > 8 && (
        <label>
          Find a pin
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a name or path"
          />
        </label>
      )}
      {disconnected && <MiniButton onClick={() => void refresh()}>Refresh pins</MiniButton>}
      {editor !== false && (
        <PinEditor
          key={editor?.id ?? "new"}
          pin={editor}
          close={() => setEditor(false)}
          saved={() => {
            setEditor(false);
            void refresh();
          }}
        />
      )}
      {menu && (
        <section className="files-pin-actions" aria-label={`${pinName(menu)} actions`}>
          <strong>{pinName(menu)}</strong>
          <div className="island-row">
            {[
              "open",
              "reveal",
              "copy",
              "openWith",
              ...(capabilities.terminal ? ["terminal"] : []),
              ...(capabilities.code ? ["code"] : []),
            ].map((name) => (
              <MiniButton
                key={name}
                disabled={!menu.available}
                onClick={() => void action(menu, name)}
              >
                {
                  {
                    open: "Open",
                    reveal: "Reveal",
                    copy: "Copy path",
                    openWith: "Open With…",
                    terminal: "Terminal",
                    code: "VS Code",
                  }[name]
                }
              </MiniButton>
            ))}
            <MiniButton
              onClick={() => {
                setEditor(menu);
                setMenu(null);
              }}
            >
              Edit
            </MiniButton>
            <MiniButton
              onClick={() => {
                void filesApi
                  .remove(menu.id)
                  .then(() => {
                    setMenu(null);
                    void refresh();
                  })
                  .catch((reason) => setError(String(reason)));
              }}
            >
              Remove pin
            </MiniButton>
            <MiniButton onClick={() => setMenu(null)}>Close</MiniButton>
          </div>
        </section>
      )}
      {peek && (
        <div
          className="files-pin-popover"
          onPointerDown={() => {
            held.current = true;
          }}
          onPointerLeave={() => {
            if (!held.current) leave.current = setTimeout(() => setPeek(null), 300);
          }}
        >
          <PinPreview
            key={peek.id}
            pin={peek}
            close={() => {
              held.current = false;
              setPeek(null);
            }}
            hold={() => clearTimeout(leave.current)}
          />
        </div>
      )}
      {(error || disconnected) && (
        <p role="alert" className="island-error">
          {error || "Live pin updates are unavailable."}
        </p>
      )}
    </section>
  );
}
