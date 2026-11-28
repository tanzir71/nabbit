import { useSettings } from "./context";
import { useState } from "react";
import { Toggle } from "../../components/Toggle";
import { activityOrder, type ActivityKind } from "../../lib/activity";
import { SettingsAsset } from "./SettingsControls";

const items = {
  privacy: ["Mic / camera", "Privacy indicator", "2fe37.svg"],
  timerEnding: ["Timers / focus ending", "Countdown and session complete", "25673.svg"],
  download: ["Downloads", "Progress, done and errors", "d94ed.svg"],
  tool: ["File tools", "Conversion progress and errors", "d94ed.svg"],
  link: ["Link detected", "Ready to download", "a9f0b.svg"],
  result: ["Note saved / tool results", "Quick confirmation", "d31d6.svg"],
  media: ["Now playing", "Playback and volume", "bfe89.svg"],
  timer: ["Focus timer", "Current session", "25673.svg"],
  power: ["Power", "Charging and low battery", "9d176.svg"],
} as const;
export function ActivitySettings() {
  const { settings, patch, busy } = useSettings();
  const [drag, setDrag] = useState<ActivityKind | null>(null);
  const saved = settings.islandActivity;
  const order = [...new Set([...(saved?.order ?? []), ...activityOrder])];
  const disabled = saved?.disabled ?? [];
  const move = (kind: ActivityKind, target: number) => {
    const next = order.filter((item) => item !== kind);
    next.splice(Math.max(0, Math.min(next.length, target)), 0, kind);
    void patch({ islandActivity: { order: next } });
  };
  return (
    <>
      <p className="settings-help">
        Drag to change priority. Higher rows win when several activities are active.
      </p>
      <div
        className="settings-card settings-activities"
        role="list"
        aria-label="Live activity priority"
      >
        {order.map((kind, index) => (
          <div
            key={kind}
            role="listitem"
            className="settings-activity"
            onDragOver={(event) => {
              if (drag) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (drag && !busy) move(drag, index);
              setDrag(null);
            }}
          >
            <button
              className="settings-grip"
              type="button"
              aria-label={`Reorder ${items[kind][0]}`}
              title="Drag, or use Alt + Arrow keys"
              draggable={!busy}
              disabled={busy}
              onDragStart={(event) => {
                event.dataTransfer.setData("text/plain", kind);
                setDrag(kind);
              }}
              onDragEnd={() => setDrag(null)}
              onKeyDown={(event) => {
                if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                  event.preventDefault();
                  move(kind, index + (event.key === "ArrowUp" ? -1 : 1));
                }
              }}
            >
              <SettingsAsset name="4aaff.svg" />
            </button>
            <SettingsAsset name={items[kind][2]} className="settings-activity-icon" />
            <span className="settings-activity-copy">
              <span>{items[kind][0]}</span>
              <span>{items[kind][1]}</span>
            </span>
            <span className="settings-reorder">
              <button
                type="button"
                disabled={busy || index === 0}
                aria-label={`Move ${items[kind][0]} up`}
                onClick={() => move(kind, index - 1)}
              >
                Up
              </button>
              <button
                type="button"
                disabled={busy || index === order.length - 1}
                aria-label={`Move ${items[kind][0]} down`}
                onClick={() => move(kind, index + 1)}
              >
                Down
              </button>
            </span>
            <Toggle
              layout="control"
              label={items[kind][0]}
              checked={!disabled.includes(kind)}
              disabled={busy}
              onChange={(enabled) =>
                void patch({
                  islandActivity: {
                    disabled: enabled ? disabled.filter((k) => k !== kind) : [...disabled, kind],
                  },
                })
              }
            />
          </div>
        ))}
      </div>
    </>
  );
}
