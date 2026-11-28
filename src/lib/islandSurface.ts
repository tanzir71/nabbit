import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { IslandMode, IslandTab } from "../store/islandStore";
import type { ActivitySnapshot } from "./activity";
export interface SurfaceInstruction {
  ready?: boolean;
  keyboard?: { id: number; target: "tab" | "preserve" | "notes" | "clipboard" | "files" } | null;
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
  prepare?: (value: SurfaceInstruction) => Promise<unknown>,
) {
  let active = true,
    stop: (() => void) | undefined,
    revision = -1,
    shownRevision = -1,
    ticket = 0,
    preparing: Promise<unknown> | undefined;
  let resolveShown!: () => void;
  const shown = new Promise<void>((resolve) => {
    resolveShown = resolve;
  });
  const failed = (reason: unknown) => {
    if (active) onError(reason);
  };
  const prime = (value: SurfaceInstruction) => (preparing ??= prepare?.(value));
  const receive = (value: SurfaceInstruction) => {
    if (!active || value.label !== label || value.generation < revision) return;
    if (value.ready === false) {
      if (value.generation <= shownRevision) return;
      if (value.generation > revision) {
        revision = value.generation;
        ++ticket;
      }
      void prime(value)?.catch(failed);
      return;
    }
    revision = value.generation;
    shownRevision = value.generation;
    resolveShown();
    const current = ++ticket;
    const pending = prime(value);
    if (pending) {
      void pending
        .then(() => {
          if (active && current === ticket) apply(value);
        })
        .catch(failed);
    } else apply(value);
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
    .catch(failed);
  return {
    ready,
    shown,
    dispose: () => {
      active = false;
      resolveShown();
      stop?.();
    },
  };
}
