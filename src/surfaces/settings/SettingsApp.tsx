import { useEngineEvents } from "../../lib/useEngineEvents";
import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "../../components/Button";
import { useTheme } from "../../lib/useTheme";
import { useAppStore } from "../../store/useAppStore";
import { SettingsPanel } from "../../views/SettingsPanel";
import { api } from "../../lib/ipc";
import { useSettingsEvents } from "../../lib/useSettingsEvents";

export function SettingsApp() {
  useEngineEvents();
  useSettingsEvents();
  const settings = useAppStore((state) => state.settings);
  const loading = useAppStore((state) => state.loading);
  const error = useAppStore((state) => state.error);
  const load = useAppStore((state) => state.loadSettingsData);
  useTheme(settings?.theme);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    let active = true;
    void api
      .settingsWindowReady()
      .then(({ mica }) => {
        if (active) document.documentElement.dataset.settingsBackdrop = mica ? "mica" : "solid";
      })
      .catch((reason: unknown) => {
        if (active) useAppStore.setState({ error: String(reason) });
      });
    return () => {
      active = false;
      delete document.documentElement.dataset.settingsBackdrop;
    };
  }, []);
  if (loading)
    return (
      <main className="p-4">
        <p role="status">Opening settings...</p>
      </main>
    );
  if (!settings)
    return (
      <main className="p-4">
        <p role="alert">{error ?? "Settings could not be loaded."}</p>
        <Button onClick={() => void load()}>Try again</Button>
      </main>
    );
  return (
    <main>
      <SettingsPanel
        onClose={() => {
          if (isTauri()) void getCurrentWindow().close();
          else window.location.assign("./index.html");
        }}
      />
    </main>
  );
}
