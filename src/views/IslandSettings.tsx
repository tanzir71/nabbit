import { useEffect, useRef, useState } from "react";
import { PresetChip } from "../components/PresetChip";
import { Select } from "../components/Select";
import { Toggle } from "../components/Toggle";
import { api } from "../lib/ipc";
import type { IslandPreferences, IslandSnapshot } from "../lib/types";
import { useAppStore } from "../store/useAppStore";
import "./island-settings.css";

export function IslandSettings({ value }: { value: IslandPreferences }) {
  const [snapshot, setSnapshot] = useState<IslandSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    const update = (next: IslandSnapshot) => {
      if (active) setSnapshot(next);
    };
    const stop = api
      .onEvent<IslandSnapshot>("nabbit://island-config", update)
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
        return () => undefined;
      });
    void api
      .getIslandSnapshot()
      .then(update)
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
      void stop.then((unlisten) => unlisten());
    };
  }, []);
  const patch = async (change: Partial<IslandPreferences>) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveIslandPreferences({ ...value, ...change });
      useAppStore.setState({ settings: saved });
    } catch (reason) {
      setError(String(reason));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const monitors = snapshot?.desktop.monitors ?? [];
  const missing = value.monitorId && !monitors.some((monitor) => monitor.id === value.monitorId);
  return (
    <section className="island-settings" aria-labelledby="island-settings-title">
      <h3 id="island-settings-title">Shape and place</h3>
      <fieldset
        className="island-settings-card"
        disabled={saving || snapshot?.supported === false}
        aria-busy={saving}
      >
        <legend className="sr-only">Island settings</legend>
        <div className="island-setting-row">
          <Toggle
            label="Show island"
            checked={value.enabled}
            onChange={(enabled) => void patch({ enabled })}
          />
        </div>
        <div className="island-setting-row">
          <div>
            <p id="island-shape-label">Shape</p>
            <span className="island-setting-help">Notch sits flush with the top edge</span>
          </div>
          <div className="island-setting-choices" role="group" aria-labelledby="island-shape-label">
            <PresetChip
              selected={value.shape === "island"}
              onClick={() => void patch({ shape: "island" })}
            >
              Floating island
            </PresetChip>
            <PresetChip
              selected={value.shape === "notch"}
              onClick={() => void patch({ shape: "notch" })}
            >
              Notch
            </PresetChip>
          </div>
        </div>
        <div className="island-setting-row island-monitor-row">
          <Select
            label="Monitor"
            value={value.monitorMode}
            onChange={(event) =>
              void patch({ monitorMode: event.target.value as IslandPreferences["monitorMode"] })
            }
          >
            <option value="primary">Primary only</option>
            <option value="followMouse">Follow mouse</option>
            <option value="all">All monitors</option>
            <option value="specific">Specific monitor</option>
          </Select>
        </div>
        {value.monitorMode === "specific" && (
          <div className="island-setting-row island-monitor-row">
            <Select
              label="Specific monitor"
              value={value.monitorId ?? ""}
              description={
                missing ? "Disconnected. Using the primary display until it returns." : undefined
              }
              onChange={(event) => void patch({ monitorId: event.target.value || null })}
            >
              <option value="">Choose a display</option>
              {missing && <option value={value.monitorId!}>Disconnected display</option>}
              {monitors.map((monitor, index) => (
                <option key={monitor.id} value={monitor.id}>
                  {index + 1}. {monitor.name}
                  {monitor.primary ? " (primary)" : ""}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="island-setting-row">
          <div>
            <p id="island-size-label">Size</p>
            <span className="island-setting-help">Scales with Windows display scaling</span>
          </div>
          <div className="island-setting-choices" role="group" aria-labelledby="island-size-label">
            {(["small", "standard", "large"] as const).map((size) => (
              <PresetChip
                key={size}
                selected={value.size === size}
                onClick={() => void patch({ size })}
              >
                {size[0].toUpperCase() + size.slice(1)}
              </PresetChip>
            ))}
          </div>
        </div>
      </fieldset>
      {snapshot?.supported === false && (
        <p className="island-setting-help">Island is available on Windows.</p>
      )}
      {(error || snapshot?.lastError) && (
        <p role="alert" className="text-danger">
          {error || snapshot?.lastError}
        </p>
      )}
    </section>
  );
}
