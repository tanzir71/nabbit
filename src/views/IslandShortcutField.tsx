import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Field } from "../components/Field";
export function IslandShortcutField({
  value,
  save,
}: {
  value: string;
  save: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  useEffect(() => {
    setDraft(value);
    dirty.current = false;
    let active = true;
    if ("__TAURI_INTERNALS__" in window)
      void invoke<{ keyboard?: { shortcutError?: string | null } }>("get_island_snapshot")
        .then((snapshot) => {
          if (active && !dirty.current) setError(snapshot.keyboard?.shortcutError ?? "");
        })
        .catch((reason) => {
          if (active && !dirty.current) setError(String(reason));
        });
    return () => {
      active = false;
    };
  }, [value]);
  const commit = async () => {
    if (busy || draft.trim() === value.trim()) return;
    setBusy(true);
    try {
      await save(draft.trim());
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Field
      label="Island shortcut"
      data-island-shortcut="true"
      description="Opens or collapses the island. Leave empty to disable."
      className="font-mono"
      value={draft}
      error={error}
      disabled={busy}
      maxLength={80}
      onChange={(event) => {
        dirty.current = true;
        setDraft(event.target.value);
        setError("");
      }}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229
        ) {
          event.preventDefault();
          void commit();
        }
      }}
    />
  );
}
