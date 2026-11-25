import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type SurfaceState = "idle" | "live" | "peek" | "expanded" | "drop";
interface Instruction {
  state: SurfaceState;
  owner: "native" | "webview";
  generation: number;
}
declare global {
  interface Window {
    __NABBIT_NATIVE_COMPACT__?: boolean;
    __NABBIT_NATIVE_START__?: SurfaceState;
  }
}

export function connectNativeSurface(
  element: HTMLElement,
  ready: Promise<void>,
  render: (state: SurfaceState) => void,
) {
  let closed = false,
    generation = -1;
  let stop: (() => void) | undefined;
  async function receive(instruction: Instruction) {
    if (closed || instruction.generation < generation) return;
    generation = instruction.generation;
    render(instruction.state);
    document.documentElement.dataset.nativeWaiting = "false";
    element.getBoundingClientRect();
    if (instruction.owner === "native")
      await Promise.allSettled(
        element.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
    else
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    if (!closed && instruction.generation === generation)
      await invoke("island_spike_handoff", {
        generation: instruction.generation,
        owner: instruction.owner,
      });
  }
  async function subscribe() {
    // Keep the native pill visible until the larger view has its bundled faces.
    await Promise.all([
      ready,
      document.fonts.load('400 12px "Geist"'),
      document.fonts.load('500 12px "Geist Mono"'),
    ]);
    if (closed) return;
    const off = await listen<Instruction>(
      "nabbit://spike-surface",
      (event) => void receive(event.payload),
    );
    if (closed) {
      off();
      return;
    }
    stop = off;
    await receive(await invoke<Instruction>("island_spike_ready"));
  }
  if (window.__NABBIT_NATIVE_COMPACT__) void subscribe();
  return {
    setState: (state: SurfaceState) => invoke("island_spike_surface", { state }),
    close: () => {
      closed = true;
      stop?.();
    },
  };
}
