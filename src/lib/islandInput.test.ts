import { afterEach, expect, it, vi } from "vitest";
import { measureIsland, observeIslandInput, type IslandInputTransport } from "./islandInput";

let resize: () => void;
const disconnect = vi.fn();
class Observer {
  constructor(callback: () => void) {
    resize = callback;
  }
  observe() {}
  disconnect = disconnect;
}
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup() {
  vi.stubGlobal("ResizeObserver", Observer);
  const host = document.createElement("main"),
    pill = document.createElement("div");
  host.append(pill);
  document.body.append(host);
  let box = { left: 327, top: 50, width: 112, height: 26 };
  vi.spyOn(host, "getBoundingClientRect").mockImplementation(
    () => ({ left: 23, top: 44, width: 720, height: 460 }) as DOMRect,
  );
  vi.spyOn(pill, "getBoundingClientRect").mockImplementation(() => box as DOMRect);
  const transport: IslandInputTransport = {
    rect: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    drag: vi.fn().mockResolvedValue(undefined),
  };
  return {
    host,
    pill,
    transport,
    setBox: (value: typeof box) => {
      box = value;
    },
    event: (name: string, types: string[] = [], relatedTarget: EventTarget | null = null) => {
      const event = new Event(name, { bubbles: true });
      Object.defineProperties(event, {
        dataTransfer: { value: { types } },
        relatedTarget: { value: relatedTarget },
      });
      host.dispatchEvent(event);
    },
  };
}
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
it("reports padded reference geometry, coalesces layouts, and schedules no idle polling", async () => {
  const { host, pill, transport, setBox } = setup();
  const interval = vi.spyOn(window, "setInterval"),
    frames = vi.spyOn(window, "requestAnimationFrame");
  const input = observeIslandInput(pill, host, { transport });
  await tick();
  expect(transport.rect).toHaveBeenLastCalledWith({ x: 296, y: -2, w: 128, h: 42 });
  resize();
  resize();
  window.dispatchEvent(new Event("resize"));
  await tick();
  expect(transport.rect).toHaveBeenCalledTimes(1);
  setBox({ left: 43, top: 50, width: 680, height: 297 });
  resize();
  await tick();
  expect(transport.rect).toHaveBeenLastCalledWith({ x: 12, y: -2, w: 696, h: 313 });
  expect(interval).not.toHaveBeenCalled();
  expect(frames).not.toHaveBeenCalled();
  await input.dispose();
  resize();
  await tick();
  expect(transport.clear).toHaveBeenCalledOnce();
  expect(transport.rect).toHaveBeenCalledTimes(2);
});
it("normalizes explicit size once and clears hidden or invalid geometry", async () => {
  const { host, pill, transport, setBox } = setup();
  let scale = 1.5;
  setBox({ left: 23 + 304 * scale, top: 44 + 6 * scale, width: 112 * scale, height: 26 * scale });
  expect(measureIsland(pill, host, scale)).toEqual({ x: 296, y: -2, w: 128, h: 42 });
  const input = observeIslandInput(pill, host, { transport, scale: () => scale });
  await tick();
  scale = 0;
  resize();
  await tick();
  expect(transport.clear).toHaveBeenCalledOnce();
  scale = 1;
  setBox({ left: 0, top: 0, width: 0, height: 0 });
  resize();
  await tick();
  expect(transport.clear).toHaveBeenCalledOnce();
  await input.dispose();
});
it("serializes slow IPC, keeps the newest layout, and prevents a replaced binding from clearing it", async () => {
  const { host, pill, transport, setBox } = setup();
  let release!: () => void;
  vi.mocked(transport.rect).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = observeIslandInput(pill, host, { transport });
  await tick();
  setBox({ left: 43, top: 50, width: 400, height: 74 });
  resize();
  await tick();
  setBox({ left: 43, top: 50, width: 680, height: 297 });
  resize();
  await tick();
  expect(transport.rect).toHaveBeenCalledOnce();
  release();
  await tick();
  expect(transport.rect).toHaveBeenCalledTimes(2);
  expect(transport.rect).toHaveBeenLastCalledWith({ x: 12, y: -2, w: 696, h: 313 });
  const second = observeIslandInput(pill, host, { transport });
  await tick();
  await first.dispose();
  expect(transport.clear).not.toHaveBeenCalled();
  await second.dispose();
  expect(transport.clear).toHaveBeenCalledOnce();
});
it("tracks URL, file and text OLE lifetimes without consuming payloads or starting work", async () => {
  const { host, pill, transport, event } = setup();
  const input = observeIslandInput(pill, host, { transport });
  await tick();
  for (const type of ["text/uri-list", "Files", "text/plain"]) {
    event("dragenter", [type]);
    event("dragenter", [type]);
    event("drop", [type]);
  }
  expect(transport.drag).toHaveBeenCalledTimes(6);
  event("dragenter", ["application/unsupported"]);
  expect(transport.drag).toHaveBeenCalledTimes(6);
  event("dragenter", ["Files"]);
  event("dragleave", [], pill);
  expect(transport.drag).toHaveBeenLastCalledWith(true);
  event("dragleave");
  expect(transport.drag).toHaveBeenLastCalledWith(false);
  await input.dispose();
});

it("clears a hidden layout even when the preceding IPC write fails", async () => {
  const { host, pill, transport, setBox } = setup();
  let reject!: (error: Error) => void;
  vi.mocked(transport.rect).mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, no) => {
        reject = no;
      }),
  );
  const onError = vi.fn(),
    input = observeIslandInput(pill, host, { transport, onError });
  await tick();
  setBox({ left: 0, top: 0, width: 0, height: 0 });
  resize();
  await tick();
  reject(new Error("surface changed"));
  await tick();
  expect(onError).toHaveBeenCalledOnce();
  expect(transport.clear).toHaveBeenCalledOnce();
  await input.dispose();
});

it("lets a replacement binding finish an active drag", async () => {
  const { host, pill, transport, event } = setup();
  const first = observeIslandInput(pill, host, { transport });
  await tick();
  event("dragenter", ["Files"]);
  expect(transport.drag).toHaveBeenLastCalledWith(true);
  const second = observeIslandInput(pill, host, { transport });
  await tick();
  await first.dispose();
  expect(transport.drag).toHaveBeenCalledTimes(1);
  event("drop");
  expect(transport.drag).toHaveBeenLastCalledWith(false);
  await second.dispose();
});
