import { useEffect, useRef, useState } from "react";
import { MiniButton } from "../../surfaces/island/CompactContent";
import { IslandAsset } from "../../surfaces/island/IslandAsset";
import { bytes } from "../../lib/islandPresentation";
import { filesApi, pinName, type Pin, type Operation, type Modifiers } from "./api";
import "./files.css";
export function MoveTo({
  paths,
  site = null,
  initialPin = null,
  initialDestination = null,
  modifiers = { shift: false, ctrl: false },
  close,
  onFiled,
}: {
  paths: string[];
  site?: string | null;
  initialPin?: string | null;
  initialDestination?: string | null;
  modifiers?: Modifiers;
  close: () => void;
  onFiled?: () => void;
}) {
  const [pins, setPins] = useState<Pin[]>([]),
    [suggestions, setSuggestions] = useState<string[]>([]),
    [folder, setFolder] = useState(""),
    [plan, setPlan] = useState<Operation | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(false);
  const alive = useRef(true),
    working = useRef(false),
    started = useRef(false);
  const run = async (destination: string | null, pinId: string | null = null) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      const operation = await filesApi.plan(paths, destination, pinId, modifiers, site);
      if (!alive.current) return;
      if (operation.reasons.length) setPlan(operation);
      else await execute(operation, false);
    } catch (reason) {
      if (alive.current) setError(String(reason));
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const execute = async (operation: Operation, confirmed: boolean) => {
    const result = await filesApi.execute(operation.id, confirmed);
    if (!alive.current) return;
    setPlan(result);
    if (result.error) setError(result.error);
    setDone(true);
    if (!result.error && result.entries.some((entry) => entry.output)) onFiled?.();
  };
  useEffect(() => {
    alive.current = true;
    let active = true;
    void Promise.all([filesApi.pins(), filesApi.suggestions(paths, site)])
      .then(([pins, suggestions]) => {
        if (active) {
          setPins(pins.filter((p) => p.kind === "folder" && p.available));
          setSuggestions(suggestions);
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
      alive.current = false;
    };
  }, [paths, site]);
  useEffect(() => {
    if ((initialPin || initialDestination) && !started.current) {
      started.current = true;
      void run(initialDestination, initialPin);
    }
  }); // A native drop is already an explicit action.
  const pick = async () => {
    if (busy) return;
    try {
      const path = await filesApi.choose(true);
      if (path && alive.current) {
        setFolder(path);
        void run(path);
      }
    } catch (reason) {
      if (alive.current) setError(String(reason));
    }
  };
  return (
    <section className="files-move-sheet" aria-label="Move to folder">
      <div className="island-row">
        <IslandAsset group="34:897" name="iconFolderInput" />
        <h2 className="island-spacer">Move to…</h2>
        <MiniButton onClick={close} disabled={busy}>
          Close
        </MiniButton>
      </div>
      {done ? (
        <>
          <p role="status">
            {plan?.entries.filter((e) => e.output && !e.undone).length || 0} files filed.{" "}
            {error ? "Some files could not be filed." : "You can undo this in File history."}
          </p>
          <MiniButton onClick={close}>Done</MiniButton>
        </>
      ) : plan ? (
        <>
          <p>
            {plan.entries.length} files · {bytes(plan.bytes)}
          </p>
          <p className="island-mono">{plan.destination.path}</p>
          {plan.reasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
          <div className="island-row">
            <MiniButton onClick={() => setPlan(null)} disabled={busy}>
              Back
            </MiniButton>
            <MiniButton
              signal
              disabled={busy}
              onClick={() => {
                if (working.current) return;
                working.current = true;
                setBusy(true);
                void execute(plan, true)
                  .catch((reason) => setError(String(reason)))
                  .finally(() => {
                    working.current = false;
                    if (alive.current) setBusy(false);
                  });
              }}
            >
              Confirm {plan.entries.every((e) => e.verb === "copy") ? "copy" : "move"}
            </MiniButton>
          </div>
        </>
      ) : (
        <>
          <p className="island-muted">
            {paths.length} {paths.length === 1 ? "file" : "files"} · same drive moves, other drive
            copies
          </p>
          {suggestions.length > 0 && (
            <div className="files-destinations" role="group" aria-label="Suggested folders">
              <h3>Recent destinations</h3>
              {suggestions.map((path) => (
                <MiniButton key={path} disabled={busy} onClick={() => void run(path)}>
                  {pinName({ path, label: null })}
                  <span className="island-muted island-ellipsis">{path}</span>
                </MiniButton>
              ))}
            </div>
          )}
          {pins.length > 0 && (
            <div className="files-destinations" role="group" aria-label="Pinned folders">
              <h3>Pins</h3>
              {pins.map((pin) => (
                <MiniButton key={pin.id} disabled={busy} onClick={() => void run(null, pin.id)}>
                  <IslandAsset
                    group="10:249"
                    name={pin.network ? "iconHardDrive" : "iconFolder1"}
                  />
                  {pinName(pin)}
                  {pin.alwaysMove && <span className="island-muted">Always move</span>}
                </MiniButton>
              ))}
            </div>
          )}
          <MiniButton disabled={busy} onClick={() => void pick()}>
            Choose folder…
          </MiniButton>
          <details>
            <summary>Enter a folder path</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (folder.trim()) void run(folder.trim());
              }}
            >
              <label>
                Destination folder
                <input
                  value={folder}
                  onChange={(event) => setFolder(event.target.value)}
                  disabled={busy}
                />
              </label>
              <MiniButton type="submit" onClick={() => {}} disabled={busy || !folder.trim()}>
                Use folder
              </MiniButton>
            </form>
          </details>
        </>
      )}
      {busy && <p role="status">Filing files…</p>}
      {error && (
        <p role="alert" className="island-error">
          {error}
        </p>
      )}
    </section>
  );
}
export function MoveButton({ paths, site = null }: { paths: string[]; site?: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MiniButton onClick={() => setOpen(true)}>
        <IslandAsset group="34:897" name="iconFolderInput" />
        Move to…
      </MiniButton>
      {open && <MoveTo paths={paths} site={site} close={() => setOpen(false)} />}
    </>
  );
}
