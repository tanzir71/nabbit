import { useCallback, useEffect, useId, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { useSettings } from "./context";
import { SettingsRow, SettingsSection } from "./SettingsControls";
import {
  keycaps,
  recordedShortcut,
  shortcutActions,
  shortcutsApi,
  shortcutValue,
  type ShortcutAction,
  type ShortcutsSnapshot,
} from "./shortcuts";
import "./shortcuts.css";

function Keys({ value }: { value: string }) {
  return value ? (
    <span className="settings-keycaps" aria-label={keycaps(value).join(" + ")} role="group">
      {keycaps(value).map((key, index) => (
        <kbd key={index}>{key}</kbd>
      ))}
    </span>
  ) : (
    <span className="settings-help">Disabled</span>
  );
}
export function ShortcutsSettings() {
  const { settings, busy } = useSettings();
  const [snapshot, setSnapshot] = useState<ShortcutsSnapshot | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ShortcutAction["id"] | null>(null);
  const alive = useRef(true),
    generation = useRef({ value: 0 }),
    buttons = useRef(new Map<string, HTMLButtonElement>());
  const refresh = useCallback(async () => {
    const revision = ++generation.current.value;
    try {
      const next = await shortcutsApi.snapshot();
      if (alive.current && revision === generation.current.value) {
        setSnapshot(next);
        setError("");
      }
      return next;
    } catch (reason) {
      if (alive.current && revision === generation.current.value) setError(String(reason));
      return null;
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    const counter = generation.current;
    let active = true;
    let stop: (() => void) | undefined;
    void refresh();
    if (isTauri())
      void listen("shortcuts:changed", () => void refresh())
        .then((unlisten) => {
          if (active) {
            stop = unlisten;
            void refresh();
          } else unlisten();
        })
        .catch((reason) => {
          if (active) setError(`Shortcut status is unavailable: ${String(reason)}`);
        });
    return () => {
      active = false;
      alive.current = false;
      ++counter.value;
      stop?.();
    };
  }, [refresh]);
  const close = (id: string) => {
    setEditing(null);
    requestAnimationFrame(() => buttons.current.get(id)?.focus());
  };
  const row = (action: ShortcutAction) => {
    const status = snapshot?.rows.find((row) => row.id === action.id);
    const value = shortcutValue(settings, action);
    const problem = status?.problem;
    return (
      <div className="shortcut-entry" data-shortcut-id={action.id} key={action.id}>
        <SettingsRow
          title={action.title}
          help={
            problem
              ? `${keycaps(problem.shortcut).join(" + ")} could not be assigned. ${problem.message}${status?.activeShortcut ? ` ${keycaps(status.activeShortcut).join(" + ")} is still active.` : " Nabbit skips this shortcut until you choose another."}`
              : undefined
          }
        >
          <Keys value={value} />
          {problem && <Badge tone="warning">Conflict</Badge>}
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Change ${action.title}`}
            aria-expanded={editing === action.id}
            aria-disabled={busy}
            onClick={() => {
              if (!busy) setEditing(action.id);
            }}
          >
            <span
              ref={(node) => {
                const button = node?.closest("button");
                if (button) buttons.current.set(action.id, button);
                else buttons.current.delete(action.id);
              }}
            >
              Change
            </span>
          </Button>
        </SettingsRow>
        {editing === action.id && (
          <Recorder
            key={action.id}
            action={action}
            value={value}
            refresh={refresh}
            close={() => close(action.id)}
          />
        )}
      </div>
    );
  };
  return (
    <>
      {error && (
        <p role="alert" className="settings-error">
          {error}{" "}
          <Button size="sm" onClick={() => void refresh()}>
            Retry status
          </Button>
        </p>
      )}
      {snapshot?.cleanupError && (
        <p role="alert" className="settings-error">
          {snapshot.cleanupError}
        </p>
      )}
      <SettingsSection title="Global shortcuts">
        {shortcutActions.slice(0, 6).map(row)}
      </SettingsSection>
      <SettingsSection title="In the island">
        {[
          ["Switch tabs", "Ctrl+1–6"],
          ["Collapse", "Esc"],
          ["Paste selected clipboard item", "Enter"],
          ["Download with last preset / save note", "Ctrl+Enter"],
          ["Open a pin", "Alt+1–9"],
        ].map(([title, keys]) => (
          <SettingsRow key={title} title={title}>
            <Keys value={keys} />
          </SettingsRow>
        ))}
      </SettingsSection>
      <SettingsSection title="Other global shortcuts">
        {shortcutActions.slice(6).map(row)}
      </SettingsSection>
    </>
  );
}
function Recorder({
  action,
  value,
  refresh,
  close,
}: {
  action: ShortcutAction;
  value: string;
  refresh: () => Promise<ShortcutsSnapshot | null>;
  close: () => void;
}) {
  const { patch, busy } = useSettings();
  const [draft, setDraft] = useState(value),
    [error, setError] = useState(""),
    [typing, setTyping] = useState(false),
    [ready, setReady] = useState(false),
    [saving, setSaving] = useState(false);
  const [token] = useState(() => crypto.randomUUID());
  const root = useRef<HTMLElement>(null),
    working = useRef(false),
    alive = useRef(true);
  const hint = useId();
  useEffect(() => {
    if (ready) root.current?.querySelector("input")?.focus();
  }, [typing, ready]);
  useEffect(() => {
    alive.current = true;
    let stop: (() => void) | undefined;
    let active = true;
    const begin = () => shortcutsApi.recording(token, true);
    const resume = () => {
      void begin()
        .then(() => {
          if (active) setReady(true);
        })
        .catch((reason) => {
          if (active) {
            setReady(false);
            setError(String(reason));
          }
        });
    };
    const pause = () => {
      if (active) setReady(false);
      void shortcutsApi.recording(token, false).catch(() => {});
    };
    void (async () => {
      if (isTauri())
        stop = await listen<{ token: string; shortcut: string }>(
          "shortcuts:recorded",
          ({ payload }) => {
            if (active && payload.token === token && !working.current) {
              setDraft(payload.shortcut);
              setError("");
            }
          },
        );
      if (!active) {
        stop?.();
        return;
      }
      await begin();
      if (active) {
        setReady(true);
        window.addEventListener("focus", resume);
        window.addEventListener("blur", pause);
      } else {
        stop?.();
        await shortcutsApi.recording(token, false);
      }
    })().catch((reason) => {
      if (active) setError(`The recorder could not start: ${String(reason)}`);
    });
    return () => {
      active = false;
      alive.current = false;
      stop?.();
      window.removeEventListener("focus", resume);
      window.removeEventListener("blur", pause);
      pause();
    };
  }, [token]);
  const save = async () => {
    if (working.current || busy || !ready) return;
    working.current = true;
    setSaving(true);
    setError("");
    try {
      if (await patch({ [action.field]: draft.trim() })) {
        if (alive.current) close();
      } else {
        const snapshot = await refresh();
        if (alive.current)
          setError(
            snapshot?.rows.find((row) => row.id === action.id)?.problem?.message ??
              "Shortcut could not be saved. Try again.",
          );
      }
    } finally {
      working.current = false;
      if (alive.current) setSaving(false);
    }
  };
  return (
    <section
      ref={root}
      className="shortcut-recorder"
      aria-label={`Record ${action.title}`}
      aria-busy={saving}
    >
      <p id={hint} className="settings-help">
        Press a shortcut. Esc cancels; Delete disables. Use Type instead if another app captures the
        keys.
      </p>
      <Field
        label="Shortcut combination"
        value={draft}
        readOnly={!typing || saving}
        disabled={!ready}
        aria-disabled={saving || !ready}
        maxLength={80}
        aria-describedby={hint}
        error={error || undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          setError("");
        }}
        onKeyDown={(event) => {
          if (!ready || working.current) {
            event.preventDefault();
            return;
          }
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.repeat)
            return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
          }
          if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) return;
          if (
            event.key === "Enter" &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey &&
            !event.metaKey
          ) {
            event.preventDefault();
            void save();
            return;
          }
          if (typing) return;
          event.preventDefault();
          event.stopPropagation();
          if (
            ["Delete", "Backspace"].includes(event.key) &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey &&
            !event.metaKey
          ) {
            setDraft("");
            setError("");
            return;
          }
          const chord = recordedShortcut(event.nativeEvent);
          if (chord) {
            setDraft(chord);
            setError("");
          }
        }}
      />
      {!draft && (
        <p role="status" className="settings-help">
          This shortcut will be disabled when you save.
        </p>
      )}
      <div className="shortcut-recorder-buttons">
        <Button
          size="sm"
          variant="primary"
          aria-disabled={saving || busy || !ready}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save shortcut"}
        </Button>
        <Button
          size="sm"
          aria-disabled={saving}
          onClick={() => {
            if (!working.current) close();
          }}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-disabled={saving}
          onClick={() => {
            if (!working.current) setTyping((value) => !value);
          }}
        >
          {typing ? "Record keys" : "Type instead"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-disabled={saving}
          onClick={() => {
            if (!working.current) {
              setDraft("");
              setError("");
              root.current?.querySelector("input")?.focus();
            }
          }}
        >
          Disable
        </Button>
      </div>
    </section>
  );
}
