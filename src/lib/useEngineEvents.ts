import { useEffect } from "react";
import { api } from "./ipc";
import type { EngineStatus } from "./types";
import { useAppStore } from "../store/useAppStore";

// Shared tray/settings data follows native pushes; collapsed island JS has no timer.
export function useEngineEvents() {
  useEffect(() => {
    let active = true,
      stop: (() => void) | undefined;
    void api
      .onEvent<EngineStatus>("engine:health", (engine) => {
        if (active) useAppStore.setState({ engine });
      })
      .then((unlisten) => {
        if (active) stop = unlisten;
        else unlisten();
      })
      .catch(() => {
        /* The visible health card exposes a failed subscription. */
      });
    return () => {
      active = false;
      stop?.();
    };
  }, []);
}
