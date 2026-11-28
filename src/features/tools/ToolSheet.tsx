import { useEffect, useRef, useState } from "react";
import { MiniButton } from "../../surfaces/island/CompactContent";
import { toolsApi, acceptsFile, type Tool, type ToolPreset } from "./api";
import { shelfApi, type ShelfItem } from "../shelf/api";
import { mediaApi } from "./mediaApi";
import "./tools.css";
export function ToolSheet({
  tool,
  inputs = [],
  close,
}: {
  tool: Tool;
  inputs?: string[];
  close: () => void;
}) {
  return tool.category === "media" ? (
    <MediaEntry tool={tool} input={inputs[0] ?? ""} close={close} />
  ) : (
    <GenericToolSheet tool={tool} inputs={inputs} close={close} />
  );
}
function MediaEntry({ tool, input, close }: { tool: Tool; input: string; close: () => void }) {
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const id = useRef(crypto.randomUUID());
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    let active = true;
    void mediaApi
      .open({ id: id.current, toolId: tool.id, input })
      .then(() => {
        if (active) closeRef.current();
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [tool.id, input, retry]);
  return (
    <section className="tool-sheet" aria-label={`${tool.name} options`}>
      <h1 className="island-sr-only">{tool.name} options</h1>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <MiniButton
            onClick={() => {
              setError("");
              setRetry((value) => value + 1);
            }}
          >
            Try opening again
          </MiniButton>
          <MiniButton onClick={close}>Back</MiniButton>
        </>
      ) : (
        <p role="status">Opening {tool.name}…</p>
      )}
    </section>
  );
}
function GenericToolSheet({
  tool,
  inputs,
  close,
}: {
  tool: Tool;
  inputs: string[];
  close: () => void;
}) {
  const [path, setPath] = useState(inputs[0] ?? ""),
    [shelf, setShelf] = useState<ShelfItem[]>([]),
    [preset, setPreset] = useState<ToolPreset | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const working = useRef(false);
  useEffect(() => {
    let active = true;
    void Promise.all([shelfApi.list(), toolsApi.presets()])
      .then(([items, presets]) => {
        if (active) {
          setShelf(items.filter((item) => item.available && acceptsFile(tool, item.path)));
          setPreset(presets.find((p) => p.id === tool.presets[0]) ?? null);
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [tool]);
  return (
    <section className="tool-sheet" aria-label={`${tool.name} options`}>
      <h1 className="island-sr-only">{tool.name} options</h1>
      <div className="island-row">
        <h2 className="island-spacer">{tool.name}</h2>
        <MiniButton disabled={busy} onClick={close}>
          Back
        </MiniButton>
      </div>
      <label>
        File path
        <input
          autoFocus
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Choose a file from the Shelf or enter its full path"
        />
      </label>
      {shelf.length > 0 && (
        <label>
          From Shelf
          <select
            value={shelf.some((i) => i.path === path) ? path : ""}
            onChange={(e) => setPath(e.target.value)}
          >
            <option value="" disabled>
              Choose a file
            </option>
            {shelf.map((i) => (
              <option key={i.id} value={i.path}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <MiniButton
        disabled={busy}
        onClick={async () => {
          if (working.current) return;
          working.current = true;
          setBusy(true);
          setError("");
          try {
            const file = await toolsApi.pick(tool.id);
            if (file) setPath(file);
          } catch (reason) {
            setError(String(reason));
          } finally {
            working.current = false;
            setBusy(false);
          }
        }}
      >
        Choose file…
      </MiniButton>
      <p className="island-muted">
        Creates a new file next to the original. Existing files are kept.
      </p>
      {!!tool.form.length && preset && (
        <details>
          <summary>Advanced</summary>
          {tool.form.map((field) => (
            <label key={field.key}>
              {field.label}
              <input
                type="number"
                min={field.min}
                max={field.max}
                value={preset.quality}
                onChange={(e) => setPreset({ ...preset, quality: Number(e.target.value) })}
              />
            </label>
          ))}
        </details>
      )}
      {error && (
        <p className="island-error" role="alert">
          {error}
        </p>
      )}
      <MiniButton
        signal
        disabled={
          busy ||
          !preset ||
          !acceptsFile(tool, path) ||
          !Number.isInteger(preset.quality) ||
          preset.quality < 1 ||
          preset.quality > 100
        }
        onClick={async () => {
          if (working.current || !preset) return;
          working.current = true;
          setBusy(true);
          setError("");
          try {
            await toolsApi.savePreset(preset);
            await toolsApi.start(tool, path);
            close();
          } catch (reason) {
            setError(String(reason));
          } finally {
            working.current = false;
            setBusy(false);
          }
        }}
      >
        {busy ? "Adding to queue…" : tool.name}
      </MiniButton>
    </section>
  );
}
