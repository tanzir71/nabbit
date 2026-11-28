import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toolsApi, acceptsFile, type Tool, type ToolPreset } from "../tools/api";
import { mediaApi } from "../tools/mediaApi";
import "./context.css";
import "../notes/links.css";
interface Review {
  target: { kind: "tool"; toolId: string; presetId: string };
  paths: string[];
}
interface Batch {
  id: string;
  paths: string[];
  reviews: Review[];
}
interface Snapshot {
  batch: Batch | null;
  error: string | null;
}
export function ExplorerBatch({ silent = false }: { silent?: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(),
    [tools, setTools] = useState<Tool[]>([]),
    [presets, setPresets] = useState<ToolPreset[]>([]),
    [suggestion, setSuggestion] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const alive = useRef(true),
    working = useRef(false);
  useEffect(() => {
    alive.current = true;
    let active = true,
      revision = 0;
    let stop: (() => void) | undefined;
    const refresh = async () => {
      const current = ++revision;
      try {
        const value = silent ? undefined : await invoke<Snapshot>("context_batch");
        if (active && current === revision) {
          setSnapshot(value);
          setError("");
        }
      } catch (reason) {
        if (active && current === revision) setError(String(reason));
      }
    };
    void listen("context:batch", () => {
      if (active) void refresh();
    })
      .then((value) => {
        if (active) stop = value;
        else value();
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    void refresh();
    return () => {
      active = false;
      alive.current = false;
      stop?.();
    };
  }, [silent]);
  const batch = snapshot?.batch,
    key = JSON.stringify(batch?.paths ?? []);
  useEffect(() => {
    let active = true;
    setSuggestion(null);
    setTools([]);
    setPresets([]);
    const paths = JSON.parse(key) as string[];
    if (!paths.length || silent) return;
    void Promise.all([toolsApi.catalog(), toolsApi.presets(), toolsApi.suggest(paths)])
      .then(([catalog, presets, suggestion]) => {
        if (active) {
          setTools(catalog);
          setPresets(presets);
          setSuggestion(suggestion);
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [key, silent]);
  const run = async (action: () => Promise<unknown>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      if (alive.current) setError(String(reason));
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  if (silent || (!batch && !error && !snapshot?.error)) return null;
  const review = (tool: Tool, presetId: string, paths: string[]) =>
    void run(async () => {
      if (paths.length > 64)
        throw new Error(
          "Select up to 64 files from this batch on the Shelf to review them together.",
        );
      await mediaApi.open({
        id: crypto.randomUUID(),
        toolId: tool.id,
        presetId,
        input: paths[0] ?? "",
        inputs: paths,
      });
    });
  const compatible = batch
    ? tools.filter((t) => batch.paths.every((path) => acceptsFile(t, path)))
    : [];
  const primary = compatible.find((t) => t.id === suggestion);
  return (
    <section className="clipboard-link-context explorer-batch" aria-label="Incoming Explorer batch">
      {batch && (
        <>
          <div className="clipboard-link-heading">
            <code>
              {batch.paths.length} {batch.paths.length === 1 ? "file added" : "files added"} to
              Shelf
            </code>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => invoke("context_batch_dismiss", { id: batch.id }))}
            >
              Dismiss
            </button>
          </div>
          <div className="clipboard-link-buttons">
            {batch.reviews.length
              ? batch.reviews.map((intent, index) => {
                  const tool = tools.find((t) => t.id === intent.target.toolId),
                    preset = presets.find((p) => p.id === intent.target.presetId);
                  return tool && preset ? (
                    <button
                      key={index}
                      type="button"
                      className="is-signal"
                      disabled={busy}
                      onClick={() => review(tool, preset.id, intent.paths)}
                    >
                      Review {preset.name}
                    </button>
                  ) : null;
                })
              : primary && (
                  <button
                    type="button"
                    className="is-signal"
                    disabled={busy}
                    onClick={() => review(primary, primary.presets[0], batch.paths)}
                  >
                    Review {primary.name}
                  </button>
                )}
          </div>
          {compatible.length > 0 && (
            <details>
              <summary>More file tools</summary>
              <div className="clipboard-link-buttons">
                {compatible.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    disabled={busy}
                    onClick={() => review(tool, tool.presets[0], batch.paths)}
                  >
                    {tool.name}
                  </button>
                ))}
              </div>
            </details>
          )}
        </>
      )}
      {(error || snapshot?.error) && (
        <p role="alert">
          {error || snapshot?.error}
          {!batch && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => invoke("context_batch_dismiss", { id: null }))}
            >
              Dismiss
            </button>
          )}
        </p>
      )}
    </section>
  );
}
