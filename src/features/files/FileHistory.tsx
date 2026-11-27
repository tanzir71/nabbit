import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { MiniButton } from "../../surfaces/island/CompactContent";
import { filesApi, pinName, type Operation } from "./api";
export function FileHistory() {
  const [items, setItems] = useState<Operation[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const generation = useRef({ value: 0 });
  useEffect(() => {
    let active = true,
      stop: (() => void) | undefined;
    const counter = generation.current;
    const load = async () => {
      const revision = ++generation.current.value;
      try {
        const items = await filesApi.history();
        if (active && revision === generation.current.value)
          setItems(items.filter((op) => op.entries.some((e) => e.output)));
      } catch (reason) {
        if (active) setError(String(reason));
      }
    };
    void listen("files:changed", () => {
      if (active) void load();
    })
      .then((unlisten) => {
        if (active) {
          stop = unlisten;
          void load();
        } else unlisten();
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
      counter.value++;
      stop?.();
    };
  }, []);
  if (!items.length && !error) return null;
  return (
    <details className="files-history">
      <summary>File history · {items.length}</summary>
      {items.slice(0, 50).map((op) => (
        <article key={op.id}>
          <p>
            {op.entries.every((e) => e.verb === "copy") ? "Copied" : "Moved"} to{" "}
            {pinName({ path: op.destination.path, label: null })} ·{" "}
            {op.entries.filter((e) => e.output).length} files
          </p>
          <p className="island-muted">
            {op.status}
            {op.error ? ` · ${op.error}` : ""}
          </p>
          {op.status !== "undone" &&
            op.entries.some((e) => e.output && e.fingerprint && !e.undone) && (
              <MiniButton
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void filesApi
                    .undo(op.id)
                    .catch((reason) => setError(String(reason)))
                    .finally(() => setBusy(false));
                }}
              >
                Undo
              </MiniButton>
            )}
        </article>
      ))}
      {error && (
        <p role="alert" className="island-error">
          {error}
        </p>
      )}
    </details>
  );
}
