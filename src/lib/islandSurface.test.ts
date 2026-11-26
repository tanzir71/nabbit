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
  fixture.emit("nabbit://island-surface", surface(4));
  fixture.emit("nabbit://island-surface", surface(3));
  expect(seen.map((value) => value.generation)).toEqual([2, 4]);
  expect(error).not.toHaveBeenCalled();
  control.dispose();
  expect(fixture.snapshot().listenerCount).toBe(0);
  fixture.emit("nabbit://island-surface", surface(5));
  expect(seen).toHaveLength(2);
});
