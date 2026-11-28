import { createContext, useContext } from "react";
import type { AppSettings, SettingsPatch } from "../../lib/types";
export const SettingsContext = createContext<{
  settings: AppSettings;
  busy: boolean;
  patch: (change: SettingsPatch) => Promise<boolean>;
} | null>(null);
export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("Settings controls need their settings window");
  return context;
}
