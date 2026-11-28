import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "../../components/Toggle";
import { Button } from "../../components/Button";
export interface ContextPreferences {
  sendTo: boolean;
  contextMenu: boolean;
  selectionCopyFallback: boolean;
}
export function ContextSettings() {
  const [preferences, setPreferences] = useState<ContextPreferences>(),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [error, setError] = useState("");
  const alive = useRef(true),
    working = useRef(false);
  useEffect(() => {
    alive.current = true;
    let active = true;
    void invoke<ContextPreferences>("context_preferences")
      .then((next) => {
        if (active) setPreferences(next);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      alive.current = false;
      active = false;
    };
  }, []);
  const change = (patch: Partial<ContextPreferences>) => {
    setPreferences((current) => (current ? { ...current, ...patch } : current));
    setSaved(false);
  };
  return (
    <section className="grid gap-3" aria-label="Explorer and selected text settings">
      <h3 className="type-heading">Explorer and selected text</h3>
      <Toggle
        label="Show Nabbit in Send To"
        checked={preferences?.sendTo ?? false}
        disabled={!preferences || busy}
        onChange={(sendTo) => change({ sendTo })}
        description="Collect selected files on the Shelf."
      />
      <Toggle
        label="Show Nabbit in the classic right-click menu"
        checked={preferences?.contextMenu ?? false}
        disabled={!preferences || busy}
        onChange={(contextMenu) => change({ contextMenu })}
        description="Choose a file preset under Show more options."
      />
      <Toggle
        label="Allow clipboard fallback for selected text"
        checked={preferences?.selectionCopyFallback ?? false}
        disabled={!preferences || busy}
        onChange={(selectionCopyFallback) => change({ selectionCopyFallback })}
        description="Use Ctrl+C when an app cannot expose its selection, then restore every clipboard format."
      />
      <Button
        variant="secondary"
        disabled={!preferences || busy}
        onClick={async () => {
          if (!preferences || working.current) return;
          working.current = true;
          setBusy(true);
          setError("");
          setSaved(false);
          try {
            const next = await invoke<ContextPreferences>("save_context_preferences", {
              preferences,
            });
            if (alive.current) {
              setPreferences(next);
              setSaved(true);
            }
          } catch (reason) {
            if (alive.current) setError(String(reason));
          } finally {
            working.current = false;
            if (alive.current) setBusy(false);
          }
        }}
      >
        {busy ? "Saving…" : "Save integration options"}
      </Button>
      {saved && (
        <p role="status" className="text-sm">
          Integration options saved
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
    </section>
  );
}
