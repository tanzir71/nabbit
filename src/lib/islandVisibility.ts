import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface IslandVisibility {
  label: string;
  mode: "visible" | "faded" | "hidden";
  base: "visible" | "faded" | "hidden";
  reason: string;
  opacity: number;
  revision: number;
}
export interface VisibilityTransport {
  subscribe: (receive: (value: IslandVisibility) => void) => Promise<() => void>;
  snapshot: () => Promise<{ visibility?: IslandVisibility[] }>;
}
const native: VisibilityTransport = {
  subscribe: (receive) =>
    listen<IslandVisibility>("nabbit://island-visibility", (event) => receive(event.payload)),
  snapshot: () => invoke("get_island_snapshot"),
};

/** Subscribe before reading, reject stale revisions, and keep the HWND composited.
 * Only opacity/pointer handling changes; layout and the measured rectangle stay put.
 */
export function connectIslandVisibility(
  host: HTMLElement,
  options: {
    label?: string;
    transport?: VisibilityTransport;
    onError?: (error: unknown) => void;
  } = {},
) {
  const label = options.label ?? getCurrentWindow().label;
  const transport = options.transport ?? native;
  let live = true,
    revision = -1,
    stop: (() => void) | undefined;
  let resolveKnown!: () => void;
  const known = new Promise<void>((resolve) => {
    resolveKnown = resolve;
  });
  const apply = (value: IslandVisibility) => {
    if (!live || value.label !== label || value.revision < revision) return;
    revision = value.revision;
    const previousMode = host.dataset.islandVisibility;
    host.style.transition = previousMode === "visible" && value.mode === "faded" ? "" : "none";
    host.dataset.islandVisibility = value.mode;
    host.style.setProperty(
      "--native-island-opacity",
      String(value.mode === "hidden" ? 0 : value.mode === "faded" ? 0.35 : 1),
    );
    host.style.opacity = String(value.mode === "hidden" ? 0 : value.mode === "faded" ? 0.35 : 1);
    host.style.pointerEvents = value.mode === "visible" ? "auto" : "none";
    host.setAttribute("aria-hidden", value.mode === "hidden" ? "true" : "false");
    resolveKnown();
  };
  const ready = transport
    .subscribe(apply)
    .then(async (unlisten) => {
      if (!live) {
        unlisten();
        return;
      }
      stop = unlisten;
      const snapshot = await transport.snapshot();
      const value = snapshot.visibility?.find((value) => value.label === label);
      if (value) apply(value);
    })
    .catch(
      options.onError ?? ((error: unknown) => console.warn("Island visibility unavailable", error)),
    );
  return {
    ready,
    known,
    dispose: () => {
      live = false;
      resolveKnown();
      stop?.();
      stop = undefined;
    },
  };
}
