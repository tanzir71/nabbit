import type { IslandStore } from "../../store/islandStore";
import { mediaApi } from "./api";
/** Wheel/pointer events only. This listener never reads or polls media state. */
export function connectMediaInput(
  pill: HTMLElement,
  store: IslandStore,
  fail: (e: unknown) => void,
) {
  let remainder = 0;
  const eligible = (target: EventTarget | null) => {
    const model = store.getState();
    return (
      model.gate !== "hidden" &&
      model.state !== "drop" &&
      !(
        target instanceof Element &&
        target.closest("input,textarea,select,button,a,[contenteditable=true],[data-island-tab]")
      ) &&
      (model.state !== "expanded" || model.tab === "media")
    );
  };
  const wheel = (event: WheelEvent) => {
    if (
      !eligible(event.target) ||
      !Number.isFinite(event.deltaY) ||
      event.deltaY === 0 ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
    )
      return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 120 : 1);
    if (Math.sign(delta) !== Math.sign(remainder)) remainder = 0;
    remainder += delta;
    // One Windows detent corresponds to 100 CSS pixels in Chromium. Accumulate trackpads.
    const steps = Math.min(10, Math.floor(Math.abs(remainder) / 100));
    if (!steps) return;
    remainder -= Math.sign(remainder) * steps * 100;
    for (let i = 0; i < steps; i++)
      void mediaApi
        .action({ kind: "volumeStep", direction: delta < 0 ? 1 : -1, fine: event.shiftKey })
        .catch(fail);
  };
  const down = (event: MouseEvent) => {
    if (event.button === 1 && eligible(event.target)) event.preventDefault();
  };
  const middle = (event: MouseEvent) => {
    if (event.button !== 1 || !eligible(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    // Resolve the selected session in Rust at gesture time, without a renderer snapshot.
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("media_toggle")).catch(fail);
  };
  pill.addEventListener("wheel", wheel, { passive: false });
  pill.addEventListener("mousedown", down);
  pill.addEventListener("auxclick", middle);
  return () => {
    pill.removeEventListener("wheel", wheel);
    pill.removeEventListener("mousedown", down);
    pill.removeEventListener("auxclick", middle);
  };
}
