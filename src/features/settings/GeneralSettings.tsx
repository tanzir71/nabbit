import { useSettings } from "./context";
import { useState } from "react";
import { version } from "../../../package.json";
import { Button } from "../../components/Button";
import { api } from "../../lib/ipc";
import type { AppSettings, AppUpdateStatus } from "../../lib/types";
import {
  SettingsAsset,
  SettingsChoices,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "./SettingsControls";

const modes: Array<{
  value: NonNullable<AppSettings["displayMode"]>;
  title: string;
  help: string;
}> = [
  {
    value: "islandAndTray",
    title: "Island + tray",
    help: "Live pill at the top, full window from the tray. Recommended.",
  },
  {
    value: "trayOnly",
    title: "Tray only",
    help: "No overlay. Progress shows on the tray icon and in toasts.",
  },
  {
    value: "islandOnly",
    title: "Island only",
    help: "Hide the tray icon. Open settings from the island.",
  },
];
export function UpdateSettings() {
  const [checking, setChecking] = useState(false),
    [status, setStatus] = useState<AppUpdateStatus | null>(null);
  return (
    <SettingsSection title="Updates">
      <SettingsRow title={`Nabbit ${version}`} help="Signed updates from GitHub Releases">
        <Button
          size="sm"
          variant="secondary"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            try {
              setStatus(await api.checkAppUpdate());
            } catch (reason) {
              setStatus({ available: false, error: String(reason) });
            } finally {
              setChecking(false);
            }
          }}
        >
          <SettingsAsset name="7b23d.svg" />
          {checking ? "Checking…" : "Check for updates"}
        </Button>
      </SettingsRow>
      {status && (
        <p role="status" className="settings-message">
          {status.error ??
            (status.available
              ? `Update ${status.version ?? ""} available.`
              : "Nabbit is up to date.")}
        </p>
      )}
    </SettingsSection>
  );
}
export function GeneralSettings() {
  const { settings, patch, busy } = useSettings();
  const mode = settings.displayMode ?? (settings.island.enabled ? "islandAndTray" : "trayOnly");
  return (
    <>
      <SettingsSection title="Where Nabbit lives" card={false}>
        <div className="settings-mode-options" role="group" aria-label="Where Nabbit lives">
          {modes.map((item) => (
            <button
              type="button"
              key={item.value}
              className="settings-mode"
              aria-pressed={mode === item.value}
              aria-disabled={busy}
              onClick={() => {
                if (!busy) void patch({ displayMode: item.value });
              }}
            >
              <span className="settings-mode-preview" aria-hidden="true">
                {item.value !== "trayOnly" && <span className="settings-mode-pill" />}
                <span className="settings-mode-taskbar" />
                {item.value !== "islandOnly" && (
                  <>
                    <span className="settings-mode-popover" />
                    <span className="settings-mode-tray" />
                  </>
                )}
              </span>
              <span className="settings-mode-title">
                <SettingsAsset name={mode === item.value ? "fd956.svg" : "ef790.svg"} />
                {item.title}
              </span>
              <span className="settings-mode-help">{item.help}</span>
            </button>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection title="Startup">
        <SettingsToggle
          label="Launch at sign-in"
          checked={settings.launchAtLogin}
          change={(launchAtLogin) => ({ launchAtLogin })}
        />
        <SettingsToggle
          label="Start hidden"
          help="Open from the island or tray when you need it"
          checked={settings.startHidden}
          change={(startHidden) => ({ startHidden })}
        />
      </SettingsSection>
      <SettingsSection title="Appearance">
        <SettingsChoices
          label="Theme"
          help="The island always stays dark"
          value={settings.theme}
          options={[
            { label: "System", value: "system" },
            { label: "Light", value: "light" },
            { label: "Dark", value: "dark" },
          ]}
          change={(theme) => ({ theme })}
        />
      </SettingsSection>
      <UpdateSettings />
    </>
  );
}
