import { useEffect, useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cachedThemePreference, connectTheme, type ThemePreference } from "./theme";

export function useTheme(preference?: ThemePreference) {
  const controller = useRef<ReturnType<typeof connectTheme> | null>(null);
  useEffect(() => {
    const nativeWindow = isTauri() ? getCurrentWindow() : null;
    const current = connectTheme(
      document.documentElement,
      window.matchMedia("(prefers-color-scheme: dark)"),
      cachedThemePreference(),
      nativeWindow
        ? {
            current: () => nativeWindow.theme(),
            listen: (receive) => nativeWindow.onThemeChanged(({ payload }) => receive(payload)),
          }
        : undefined,
    );
    controller.current = current;
    return () => {
      controller.current = null;
      current.close();
    };
  }, []);
  useEffect(() => {
    if (preference) controller.current?.setPreference(preference);
  }, [preference]);
}
