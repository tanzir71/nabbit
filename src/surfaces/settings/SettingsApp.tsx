import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "../../components/Button";
import { useTheme } from "../../lib/useTheme";
import { useAppStore } from "../../store/useAppStore";
import { SettingsPanel } from "../../views/SettingsPanel";

export function SettingsApp() {
  const settings = useAppStore((state) => state.settings);
  const loading = useAppStore((state) => state.loading);
  const error = useAppStore((state) => state.error);
  const load = useAppStore((state) => state.loadSettingsData);
  useTheme(settings?.theme);
  useEffect(() => {
    void load();
  }, [load]);
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
    <SettingsPanel
      onClose={() => {
        if (isTauri()) void getCurrentWindow().hide();
        else window.location.assign("./index.html");
      }}
    />
  );
}
