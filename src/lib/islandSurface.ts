import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { IslandMode, IslandTab } from "../store/islandStore";
import type { ActivitySnapshot } from "./activity";
export interface SurfaceInstruction {
  keyboard?: { id: number; target: "tab" | "preserve" } | null;
  focusTab?: IslandTab | null;
  label: string;
  generation: number;
  state: IslandMode;
  owner: "native" | "webview";
  shape: "island" | "notch";
  reducedMotion: boolean;
  width: number;
  height: number;
  snapshot: ActivitySnapshot;
}
export function connectIslandSurface(
  label: string,
  apply: (value: SurfaceInstruction) => void,
  onError: (reason: unknown) => void,
) {
  let active = true,
    stop: (() => void) | undefined,
    revision = -1;
  const receive = (value: SurfaceInstruction) => {
    if (!active || value.label !== label || value.generation < revision) return;
    revision = value.generation;
    apply(value);
  };
  const ready = listen<SurfaceInstruction>("nabbit://island-surface", (e) => receive(e.payload))
    .then(async (unlisten) => {
      if (!active) {
        unlisten();
        return;
      }
      stop = unlisten;
      receive(await invoke<SurfaceInstruction>("get_island_surface"));
    })
    .catch(onError);
  return {
    ready,
    dispose: () => {
      active = false;
      stop?.();
    },
  };
}
