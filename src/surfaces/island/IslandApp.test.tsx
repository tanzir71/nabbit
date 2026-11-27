import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
        emit: (event: string, payload: unknown) => void;
        snapshot: () => {
          calls: Array<{ command: string; args?: Record<string, unknown> }>;
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
  act(() => {
    store.getState().dispatch({ type: "filter", name: "searchOpen", value: "true" });
    fixture.emit("nabbit://island-surface", {
      label: "island",
      generation: 3,
      state: "expanded",
      owner: "webview",
      shape: "island",
      reducedMotion: true,
      width: 340,
      height: 32,
      snapshot,
      focusTab: "files",
    });
  });
  await waitFor(() => expect(store.getState().tab).toBe("files"));
  expect(store.getState().filters.searchOpen).toBe("false");
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => null,
  });
  await act(async () => {
    fixture.emit("nabbit://native-drop", {
      kind: "enter",
      payload: { files: ["D:\\Owned\\memo.txt"] },
      x: 0,
      y: 0,
      shift: false,
      ctrl: true,
    });
    await Promise.resolve();
  });
  expect(fixture.snapshot().calls).toContainEqual({
    command: "island_set_drag",
    args: { active: true },
  });
  expect(store.getState().state).toBe("drop");
  act(() =>
    fixture.emit("nabbit://native-drop", {
      kind: "leave",
      payload: {},
      x: 0,
      y: 0,
      shift: false,
      ctrl: false,
    }),
  );
  expect(fixture.snapshot().calls).toContainEqual({
    command: "island_set_drag",
    args: { active: false },
  });
  const restingState = store.getState().state;
  await act(async () => {
    for (const kind of ["enter", "leave"])
      fixture.emit("nabbit://native-drop", {
        kind,
        payload: { files: ["D:\\Owned\\memo.txt"] },
        x: 0,
        y: 0,
        shift: false,
        ctrl: false,
      });
    await Promise.resolve();
  });
  expect(store.getState().state).toBe(restingState);
  act(() => {
    store.getState().dispatch({
      type: "filter",
      name: "fileMove",
      value: '{"paths":["D:\\\\Owned\\\\memo.txt"]}',
    });
    store.getState().dispatch({ type: "collapse" });
  });
  await waitFor(() => expect(store.getState().filters.fileMove).toBe(""));
  const doneSnapshot = {
    ...snapshot,
    revision: 1000,
    views: [
      {
        ...snapshot.views[0],
        primary: {
          ...snapshot.views[0].primary,
          event: { kind: "downloadDone", jobId: "d", path: "D:\\Owned\\Lecture.mkv" },
        },
      },
    ],
  };
  act(() =>
    fixture.emit("nabbit://island-surface", {
      label: "island",
      generation: 1000,
      state: "peek",
      owner: "webview",
      shape: "island",
      reducedMotion: true,
      width: 400,
      height: 120,
      snapshot: doneSnapshot,
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Move to…" }));
  await waitFor(() => expect(store.getState().state).toBe("expanded"));
  const reviewDraft = store.getState().filters.fileMove;
  expect(JSON.parse(reviewDraft).paths).toHaveLength(1);
  act(() =>
    fixture.emit("nabbit://island", {
      kind: "dismissed",
      id: "downloadDone:d",
      snapshot: {
        ...doneSnapshot,
        revision: 1001,
        views: [{ ...doneSnapshot.views[0], primary: null }],
      },
    }),
  );
  expect(store.getState().state).toBe("expanded");
  expect(store.getState().filters.fileMove).toBe(reviewDraft);
  app.unmount();
  await Promise.resolve();
  expect(fixture.snapshot().listenerCount).toBe(0);
});
