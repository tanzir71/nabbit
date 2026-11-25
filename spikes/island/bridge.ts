import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type DropZone, type Payload, zoneOrder, classify } from "./drop";

export interface HitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Presentation {
  hidden: boolean;
  dragging: boolean;
  revision: number;
}
export interface NativeReport {
  presentation: Presentation;
  decision: { hidden: boolean; dragging: boolean; interactive: boolean; pollMs: number };
  hitrect: HitRect | null;
  cursorSamples: number;
  foregroundSamples: number;
  hookInstalled: boolean;
  foregroundEvents: number;
}

export function connectInteraction(
  element: HTMLElement,
  present: (value: Presentation) => void,
  incoming: (payload: Payload, zone?: DropZone) => void,
  hover: (payload: Payload) => void,
) {
  const native = isTauri();
  let closed = false;
  let lastRect: HitRect | null = null;
  let dragging: boolean | undefined;
  let receivedFiles: string[] = [];
  const cleanups: Array<() => void> = [];
  function measure() {
    const box = element.getBoundingClientRect();
    const rect = { x: box.x - 8, y: box.y - 8, w: box.width + 16, h: box.height + 16 };
    if (
      lastRect &&
      Object.keys(rect).every(
        (key) => rect[key as keyof HitRect] === lastRect?.[key as keyof HitRect],
      )
    )
      return;
    lastRect = rect;
    if (native && !closed)
      void invoke<Presentation>("island_set_hitrect", { rect }).then((value) => {
        if (!closed) present(value);
      });
  }
  function setDrag(active: boolean) {
    if (dragging === active) return;
    dragging = active;
    if (native && !closed) void invoke("island_spike_set_drag", { active });
  }
  function zoneAt(x: number, y: number): DropZone | undefined {
    return document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-zone]")?.dataset
      .dropZone as DropZone | undefined;
  }
  async function subscribe() {
    if (!native) return;
    const off = await listen<Presentation>("nabbit://spike-interaction", (event) => {
      if (!closed) present(event.payload);
    });
    if (closed) {
      off();
      return;
    }
    cleanups.push(off);
    const offDrop = await getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (closed) return;
      if (event.payload.type === "enter") {
        hover({ files: event.payload.paths });
        setDrag(true);
      } else if (event.payload.type === "over") setDrag(true);
      else if (event.payload.type === "leave") setDrag(false);
      else if (event.payload.type === "drop") {
        receivedFiles = event.payload.paths;
        const payload = { files: event.payload.paths };
        incoming(
          payload,
          zoneAt(
            event.payload.position.x / devicePixelRatio,
            event.payload.position.y / devicePixelRatio,
          ) ?? zoneOrder(classify(payload))[0],
        );
        setDrag(false);
      }
    });
    if (closed) {
      offDrop();
      return;
    }
    cleanups.push(offDrop);
    // Subscribe before the first report; its response also supplies initial visibility.
    lastRect = null;
    measure();
  }
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  measure();
  const ready = subscribe();
  return {
    ready,
    rect: () => lastRect,
    receivedFiles: () => receivedFiles,
    setDrag,
    files: (data: DataTransfer, x: number, y: number) => {
      if (!native || !data.files.length) return false;
      const host = window as unknown as {
        chrome: {
          webview: {
            postMessageWithAdditionalObjects: (message: string, files: File[]) => void;
          };
        };
      };
      try {
        host.chrome.webview.postMessageWithAdditionalObjects(
          JSON.stringify({ nabbit_file_drop: true, x, y, scale: devicePixelRatio }),
          Array.from(data.files),
        );
      } catch {
        // Virtual browser files have no native path; finish with an unsupported receipt.
        incoming({});
        setDrag(false);
      }
      return true;
    },
    snapshot: (refresh = false) => invoke<NativeReport>("island_spike_snapshot", { refresh }),
    close: () => {
      closed = true;
      observer.disconnect();
      cleanups.forEach((off) => off());
    },
  };
}
