import { invoke } from "@tauri-apps/api/core";

export interface HitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface IslandInputTransport {
  rect: (rect: HitRect) => Promise<void>;
  clear: () => Promise<void>;
  drag: (active: boolean) => Promise<void>;
}
const native: IslandInputTransport = {
  rect: (rect) => invoke("island_set_hitrect", { rect }),
  clear: () => invoke("island_clear_hitrect"),
  drag: (active) => invoke("island_set_drag", { active }),
};
let bindingGeneration = 0;
const dragStates = new WeakMap<IslandInputTransport, boolean>();

/** CSS viewport pixels → unscaled 720×460 reference pixels, plus 8px padding.
 * Native input multiplies this frame by user size and monitor DPI exactly once.
 */
export function measureIsland(element: HTMLElement, host: HTMLElement, scale = 1): HitRect {
  const box = element.getBoundingClientRect(),
    origin = host.getBoundingClientRect();
  return {
    x: (box.left - origin.left) / scale - 8,
    y: (box.top - origin.top) / scale - 8,
    w: box.width / scale + 16,
    h: box.height / scale + 16,
  };
}

/** Event/ResizeObserver driven; no idle timers or animation-frame loop. */
export function observeIslandInput(
  element: HTMLElement,
  host: HTMLElement,
  options: {
    scale?: () => number;
    enabled?: () => boolean;
    transport?: IslandInputTransport;
    onError?: (error: unknown) => void;
  } = {},
) {
  const transport = options.transport ?? native;
  const generation = ++bindingGeneration;
  let live = true,
    queued = false,
    last = "",
    ownsRect = false,
    pending: HitRect | false | null = null;
  let sending: Promise<void> | null = null,
    dragging = dragStates.get(transport) ?? false;
  const fail =
    options.onError ?? ((error: unknown) => console.warn("Island input unavailable", error));
  const flush = () => {
    if (sending) return;
    sending = (async () => {
      while (live && pending !== null) {
        const rect = pending;
        pending = null;
        if (rect === false) {
          await transport.clear();
          ownsRect = false;
        } else {
          await transport.rect(rect);
          ownsRect = true;
        }
      }
    })()
      .catch(fail)
      .finally(() => {
        sending = null;
        if (live && pending !== null) flush();
      });
  };
  const report = () => {
    if (!live || queued || options.enabled?.() === false) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!live || options.enabled?.() === false) return;
      const scale = options.scale?.() ?? 1;
      if (!Number.isFinite(scale) || scale <= 0) {
        if (last !== "clear") {
          last = "clear";
          pending = false;
          flush();
        }
        return;
      }
      const rect = measureIsland(element, host, scale);
      if (
        ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ||
        rect.w <= 16 ||
        rect.h <= 16
      ) {
        if (last !== "clear") {
          last = "clear";
          pending = false;
          flush();
        }
        return;
      }
      const key = JSON.stringify(rect);
      if (last === key) return;
      last = key;
      pending = rect;
      flush();
    });
  };
  const drag = (active: boolean) => {
    if (dragging === active) return;
    dragging = active;
    dragStates.set(transport, active);
    void transport.drag(active).catch(fail);
  };
  const enter = (event: DragEvent) => {
    if (
      [...(event.dataTransfer?.types ?? [])].some((type) =>
        ["Files", "text/plain", "text/uri-list"].includes(type),
      )
    )
      drag(true);
  };
  const leave = (event: DragEvent) => {
    if (event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return;
    drag(false);
  };
  const end = () => drag(false);
  const observer = new ResizeObserver(report);
  observer.observe(element);
  observer.observe(host);
  element.addEventListener("transitionend", report);
  element.addEventListener("animationend", report);
  host.addEventListener("dragenter", enter);
  host.addEventListener("dragleave", leave);
  host.addEventListener("drop", end);
  host.addEventListener("dragend", end);
  window.addEventListener("resize", report);
  report();
  return {
    report,
    dispose: async () => {
      live = false;
      pending = null;
      observer.disconnect();
      element.removeEventListener("transitionend", report);
      element.removeEventListener("animationend", report);
      host.removeEventListener("dragenter", enter);
      host.removeEventListener("dragleave", leave);
      host.removeEventListener("drop", end);
      host.removeEventListener("dragend", end);
      window.removeEventListener("resize", report);
      await sending;
      if (generation === bindingGeneration) {
        if (dragging) {
          dragging = false;
          dragStates.set(transport, false);
          await transport.drag(false).catch(fail);
        }
        if (ownsRect) await transport.clear().catch(fail);
      }
    },
  };
}
