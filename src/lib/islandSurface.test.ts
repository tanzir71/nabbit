import { afterEach, expect, it, vi } from "vitest";
import { connectIslandSurface, type SurfaceInstruction } from "./islandSurface";
// @ts-expect-error Standalone JS fixture deliberately has no application-side declarations.
import { installMockIpc } from "../../scripts/screenshots/mock-ipc.mjs";
// @ts-expect-error Standalone JS fixture deliberately has no application-side declarations.
import { fixtureData } from "../../scripts/screenshots/fixtures.mjs";
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of [
    "__TAURI_INTERNALS__",
    "__TAURI_EVENT_PLUGIN_INTERNALS__",
    "__NABBIT_CAPTURE__",
    "isTauri",
  ])
    Reflect.deleteProperty(globalThis, key);
  localStorage.clear();
});
const surface = (generation: number, label = "island") =>
  ({
    label,
    generation,
    state: "peek",
    owner: "webview",
    shape: "island",
    reducedMotion: false,
    width: 320,
    height: 32,
    snapshot: {
      revision: 0,
      views: [],
      preferences: {
        order: [],
        disabled: [],
        showAlertsOverFullscreen: false,
        focusMode: false,
        hiddenUntilMs: null,
      },
      syncState: "localOnly",
    },
  }) as SurfaceInstruction;
it("rejects stale and other-monitor instructions and releases its native subscription", async () => {
  installMockIpc({
    label: "island",
    theme: "dark",
    data: fixtureData("island-idle"),
    responses: { get_island_surface: surface(2) },
  });
  const seen: SurfaceInstruction[] = [],
    error = vi.fn();
  const control = connectIslandSurface("island", (value) => seen.push(value), error);
  await control.ready;
  const fixture = (
    globalThis as unknown as {
      __NABBIT_CAPTURE__: {
        emit: (event: string, value: unknown) => void;
        snapshot: () => { listenerCount: number };
      };
    }
  ).__NABBIT_CAPTURE__;
  fixture.emit("nabbit://island-surface", surface(100, "island-other"));
  fixture.emit("nabbit://island-surface", { ...surface(4), ready: false });
  expect(seen.map((value) => value.generation)).toEqual([2]);
  // The shown notification for the same generation must still be accepted.
  fixture.emit("nabbit://island-surface", { ...surface(4), ready: true });
  fixture.emit("nabbit://island-surface", surface(4));
  fixture.emit("nabbit://island-surface", surface(3));
  expect(seen.map((value) => value.generation)).toEqual([2, 4, 4]);
  expect(error).not.toHaveBeenCalled();
  control.dispose();
  expect(fixture.snapshot().listenerCount).toBe(0);
  fixture.emit("nabbit://island-surface", surface(5));
  expect(seen).toHaveLength(3);
});
it("primes hidden content once and applies only the latest shown instruction after it is ready", async () => {
  installMockIpc({
    label: "island",
    theme: "dark",
    data: fixtureData("island-idle"),
    responses: { get_island_surface: { ...surface(1), ready: false } },
  });
  let prepared!: () => void;
  const prepare = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        prepared = resolve;
      }),
  );
  const seen: SurfaceInstruction[] = [],
    error = vi.fn();
  const control = connectIslandSurface("island", (value) => seen.push(value), error, prepare);
  await control.ready;
  const fixture = (
    globalThis as unknown as {
      __NABBIT_CAPTURE__: { emit: (event: string, value: unknown) => void };
    }
  ).__NABBIT_CAPTURE__;
  expect(prepare).toHaveBeenCalledOnce();
  expect(seen).toEqual([]);
  fixture.emit("nabbit://island-surface", { ...surface(1), ready: true });
  fixture.emit("nabbit://island-surface", { ...surface(2), ready: true });
  fixture.emit("nabbit://island-surface", { ...surface(3), ready: false });
  fixture.emit("nabbit://island-surface", { ...surface(3), ready: true });
  // An older hidden snapshot arriving after the shown notification must not
  // cancel the shown generation's pending preparation.
  fixture.emit("nabbit://island-surface", { ...surface(3), ready: false });
  expect(seen).toEqual([]);
  prepared();
  await Promise.resolve();
  expect(seen.map((value) => value.generation)).toEqual([3]);
  expect(prepare).toHaveBeenCalledOnce();
  expect(error).not.toHaveBeenCalled();
  control.dispose();
});
