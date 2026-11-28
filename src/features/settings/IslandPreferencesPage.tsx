import { useSettings } from "./context";
import { IslandSettings } from "../../views/IslandSettings";
import { Select } from "../../components/Select";
import { Button } from "../../components/Button";
import { SettingsRow, SettingsSection, SettingsToggle } from "./SettingsControls";
export function IslandPreferencesPage({ activities }: { activities: () => void }) {
  const { settings, patch, busy } = useSettings();
  const hover = settings.island.peekOnHoverMs === undefined ? 180 : settings.island.peekOnHoverMs;
  return (
    <>
      <div className="settings-island-preview" role="img" aria-label="Island preview">
        <span className={`settings-live-preview is-${settings.island.shape}`}>
          <span className="settings-preview-art" />
          <span className="settings-preview-bars">
            {[6, 12, 8, 14, 5].map((height, i) => (
              <i key={i} style={{ height }} />
            ))}
          </span>
        </span>
      </div>
      <IslandSettings
        value={settings.island}
        saveChange={async (change) => {
          if (!(await patch({ island: change })))
            throw new Error("Island settings could not be saved.");
        }}
      />
      <SettingsSection title="Behaviour">
        <div className="settings-hover-row">
          <Select
            label="Peek on hover"
            description="Shows controls after a short pause"
            value={hover ?? "off"}
            disabled={busy}
            onChange={(event) =>
              void patch({
                island: {
                  peekOnHoverMs: event.target.value === "off" ? null : Number(event.target.value),
                },
              })
            }
          >
            <option value={180}>180 ms</option>
            <option value={300}>300 ms</option>
            <option value={500}>500 ms</option>
            <option value="off">Off</option>
          </Select>
        </div>
        <SettingsToggle
          label="Fade over maximised windows"
          help="Becomes click-through so tabs under it still work"
          checked={settings.island.fadeOverMaximized ?? true}
          change={(fadeOverMaximized) => ({ island: { fadeOverMaximized } })}
        />
        <SettingsToggle
          label="Hide over fullscreen apps and games"
          checked={settings.island.hideOverFullscreen ?? true}
          change={(hideOverFullscreen) => ({ island: { hideOverFullscreen } })}
        />
        <SettingsToggle
          label="Show alerts over fullscreen"
          help="Only timers ending and failed downloads"
          checked={settings.islandActivity?.showAlertsOverFullscreen ?? false}
          change={(showAlertsOverFullscreen) => ({ islandActivity: { showAlertsOverFullscreen } })}
        />
        <SettingsToggle
          label="Scroll on the pill changes volume"
          checked={settings.island.scrollToChangeVolume ?? true}
          change={(scrollToChangeVolume) => ({ island: { scrollToChangeVolume } })}
        />
      </SettingsSection>
      <SettingsSection title="Live activities">
        <SettingsRow title="Choose what appears" help="Enable activities and set their priority">
          <Button size="sm" variant="secondary" onClick={activities}>
            Live activities
          </Button>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
