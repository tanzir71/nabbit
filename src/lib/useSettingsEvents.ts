import { useEffect } from "react";
import { api } from "./ipc";
import type { AppSettings } from "./types";
import { useAppStore } from "../store/useAppStore";

export function useSettingsEvents() {
  useEffect(() => {
    let active = true;
    const stop = api
      .onEvent<AppSettings>("nabbit://settings-changed", (settings) => {
        if (active) useAppStore.getState().acceptSettings(settings);
      })
      .catch(() => () => {});
    return () => {
      active = false;
      void stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
}
