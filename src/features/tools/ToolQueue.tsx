import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { MiniButton } from "../../surfaces/island/CompactContent";
import { basename, bytes } from "../../lib/islandPresentation";
import { toolsApi, type ToolJob } from "./api";
import "./tools.css";
export function ToolQueue() {
  const [jobs, setJobs] = useState<ToolJob[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const alive = useRef(false),
    generation = useRef({ value: 0 }),
    working = useRef(false);
  const refresh = useCallback(async () => {
    const current = ++generation.current.value;
    try {
      const rows = await toolsApi.jobs();
      if (alive.current && current === generation.current.value) {
        setJobs(rows);
        setError("");
      }
    } catch (reason) {
      if (alive.current && current === generation.current.value) setError(String(reason));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    const counter = generation.current;
    let active = true;
    let stop: (() => void) | undefined;
    void listen("tools:changed", () => {
      if (active) void refresh();
    })
      .then((unlisten) => {
        if (active) {
          stop = unlisten;
          void refresh();
        } else unlisten();
      })
      .catch((reason) => {
        if (active) {
          setError(String(reason));
          void refresh();
        }
      });
    return () => {
      active = false;
      alive.current = false;
      counter.value++;
      stop?.();
    };
  }, [refresh]);
  const action = async (name: "cancel" | "retry" | "reveal" | "undo", id: string) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await toolsApi.action(name, id);
      await refresh();
    } catch (reason) {
      if (alive.current) setError(String(reason));
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section className="tool-queue" aria-label="Tool jobs">
      <h2>Tool jobs</h2>
      {error && (
        <p role="alert" className="island-error">
          {error} <button onClick={() => void refresh()}>Refresh jobs</button>
        </p>
      )}
      {!jobs.length && !error && (
        <p className="island-muted">Your file tool results will appear here.</p>
      )}
      {jobs.map((job) => (
        <article
          className="tool-result"
          key={job.id}
          aria-label={`${job.preset.name} · ${basename(job.request.input)}`}
        >
          <div className="island-row">
            <strong
              className="island-spacer island-ellipsis"
              title={job.output ?? job.request.input}
            >
              {basename(job.output ?? job.request.input)}
            </strong>
            <span className="island-muted">{job.preset.name}</span>
          </div>
          {job.status === "running" && (
            <progress aria-label={`${job.preset.name} progress`} max={100} value={job.percent} />
          )}
          <div className="island-row">
            <span className="island-spacer island-muted">
              {job.status === "completed" || job.status === "undone"
                ? `${bytes(job.beforeBytes)} → ${bytes(job.afterBytes)} · ${job.status === "undone" ? "Moved to Recycle Bin" : (job.note ?? "Done")}`
                : job.status === "running"
                  ? `${Math.floor(job.percent)}%`
                  : job.status}
            </span>
            {job.status === "completed" ? (
              <>
                <MiniButton disabled={busy} onClick={() => void action("reveal", job.id)}>
                  Reveal
                </MiniButton>
                <MiniButton disabled={busy} onClick={() => void action("undo", job.id)}>
                  Undo
                </MiniButton>
              </>
            ) : ["failed", "cancelled"].includes(job.status) ? (
              <MiniButton disabled={busy} onClick={() => void action("retry", job.id)}>
                Retry
              </MiniButton>
            ) : (
              job.status !== "undone" && (
                <MiniButton disabled={busy} onClick={() => void action("cancel", job.id)}>
                  Cancel
                </MiniButton>
              )
            )}
          </div>
          {job.error && <p className="island-muted">{job.error}</p>}
        </article>
      ))}
    </section>
  );
}
