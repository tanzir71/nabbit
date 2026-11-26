import { StrictMode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { IslandApp } from "./IslandApp";
import { createIslandStore } from "../../store/islandStore";
import { activityOrder } from "../../lib/activity";
// @ts-expect-error Test-only standalone screenshot fixture.
import { installMockIpc } from "../../../scripts/screenshots/mock-ipc.mjs";
// @ts-expect-error Test-only standalone screenshot fixture.
import { fixtureData } from "../../../scripts/screenshots/fixtures.mjs";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
it("does not close an opening native Peek when the activity snapshot initializes first", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve(), load: vi.fn().mockResolvedValue([]) },
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  const snapshot = {
    revision: 1,
    preferences: {
      order: activityOrder,
      disabled: [],
      showAlertsOverFullscreen: false,
      focusMode: false,
      hiddenUntilMs: null,
    },
    syncState: "localOnly",
    views: [
      {
        label: "island",
        gate: "visible",
        fullscreen: false,
        userHidden: false,
        focusMode: false,
        primary: {
          id: "download:d",
          category: "download",
          event: {
            kind: "downloadProgress",
            jobId: "d",
            title: "A download",
            percent: 38,
            speed: null,
            eta: null,
          },
          alert: false,
          bubbleOnly: false,
        },
        bubble: null,
        queue: [],
      },
    ],
  };
  installMockIpc({
    label: "island",
    theme: "dark",
    data: fixtureData("island-idle"),
    responses: {
      get_activity_snapshot: snapshot,
      get_island_surface: {
        label: "island",
        generation: 2,
        state: "peek",
        owner: "webview",
        shape: "island",
        reducedMotion: false,
        width: 320,
        height: 32,
        snapshot,
      },
    },
  });
  const store = createIslandStore("island");
  const app = render(
    <StrictMode>
      <IslandApp suppliedStore={store} />
    </StrictMode>,
  );
  await waitFor(() => expect(store.getState().state).toBe("peek"));
  expect(app.container.querySelector("main")?.style.opacity).toBe("1");
  act(() => store.getState().dispatch({ type: "filter", name: "preset", value: "720p" }));
  expect(app.container.querySelector("main")?.style.opacity).toBe("1");
  const fixture = (
    globalThis as unknown as {
      __NABBIT_CAPTURE__: {
        snapshot: () => {
          calls: Array<{ command: string }>;
          unsupported: string[];
          listenerCount: number;
        };
      };
    }
  ).__NABBIT_CAPTURE__;
  expect(
    fixture.snapshot().calls.filter((call) => call.command === "island_surface_request"),
  ).toEqual([]);
  expect(fixture.snapshot().unsupported).toEqual([]);
  expect(app.container.querySelector("main")?.getAttribute("data-compact-prepared")).toBe("true");
  app.unmount();
  await Promise.resolve();
  expect(fixture.snapshot().listenerCount).toBe(0);
});
