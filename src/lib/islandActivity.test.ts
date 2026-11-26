import { afterEach, expect, it, vi } from "vitest";
import { connectIslandActivity, loadIslandMemory, type ActivityTransport } from "./islandActivity";
import { activityOrder, type ActivityMessage, type ActivitySnapshot, type Gate } from "./activity";
import { createIslandStore } from "../store/islandStore";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});
function data(gate: Gate = "visible", live = false, revision = 0): ActivitySnapshot {
  return {
    revision,
    views: [
      {
        label: "island",
        gate,
        primary: live
          ? {
              id: "timer:t",
              category: "timer",
              event: { kind: "timerTick", id: "t", label: "Focus", remainingS: 100 },
              alert: false,
              bubbleOnly: false,
            }
          : null,
        bubble: null,
        queue: [],
        fullscreen: gate === "hidden",
        userHidden: false,
        focusMode: false,
      },
    ],
    preferences: {
      order: activityOrder,
      disabled: [],
      showAlertsOverFullscreen: false,
      focusMode: false,
      hiddenUntilMs: null,
    },
    syncState: "localOnly",
  };
}
function setup(snapshot: () => Promise<ActivitySnapshot> = async () => data()) {
  let receive!: (value: ActivityMessage) => void;
  const stop = vi.fn(),
    store = createIslandStore("island");
  const transport: ActivityTransport = {
    subscribe: vi.fn(async (callback) => {
      receive = callback;
      return stop;
    }),
    snapshot,
  };
  const connection = connectIslandActivity(store, { transport, now: () => Date.now() });
  return {
    store,
    connection,
    stop,
    send: (snapshot: ActivitySnapshot) => receive({ kind: "refresh", target: null, snapshot }),
  };
}
it("schedules no idle/faded/hidden polling; only live intent and Peek leave get a single cancellable timeout", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const interval = vi.spyOn(window, "setInterval"),
    frames = vi.spyOn(window, "requestAnimationFrame");
  const { store, connection, send } = setup();
  await connection.ready;
  for (const [index, gate] of ["visible", "hidden", "faded"].entries()) {
    send(data(gate as Gate, false, index + 1));
    store.getState().dispatch({ type: "enter", now: 0 });
    expect(vi.getTimerCount()).toBe(0);
  }
  send(data("visible", true, 4));
  store.getState().dispatch({ type: "enter", now: 0 });
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(179);
  expect(store.getState().state).toBe("live");
  vi.advanceTimersByTime(1);
  expect(store.getState().state).toBe("peek");
  expect(vi.getTimerCount()).toBe(0);
  store.getState().dispatch({ type: "leave", now: 180 });
  expect(vi.getTimerCount()).toBe(1);
  store.getState().dispatch({ type: "open" });
  expect(vi.getTimerCount()).toBe(0);
  store.getState().dispatch({ type: "leave", now: 181 });
  vi.advanceTimersByTime(10000);
  expect(store.getState().state).toBe("expanded");
  send(data("hidden", false, 5));
  expect(vi.getTimerCount()).toBe(0);
  expect(interval).not.toHaveBeenCalled();
  expect(frames).not.toHaveBeenCalled();
  connection.dispose();
});
it("subscribes before snapshot, rejects stale responses and ignores messages after teardown", async () => {
  let resolve!: (snapshot: ActivitySnapshot) => void;
  const { store, connection, stop, send } = setup(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await Promise.resolve();
  send(data("visible", true, 9));
  resolve(data());
  await connection.ready;
  expect(store.getState().primary?.id).toBe("timer:t");
  connection.dispose();
  send(data("hidden", false, 10));
  expect(store.getState().state).toBe("live");
  expect(stop).toHaveBeenCalledOnce();
});
it("cleans up late subscription setup without fetching or scheduling", async () => {
  let resolve!: (stop: () => void) => void;
  const stop = vi.fn(),
    snapshot = vi.fn();
  const connection = connectIslandActivity(createIslandStore("island"), {
    transport: {
      subscribe: () =>
        new Promise((done) => {
          resolve = done;
        }),
      snapshot,
    },
  });
  connection.dispose();
  resolve(stop);
  await connection.ready;
  expect(stop).toHaveBeenCalledOnce();
  expect(snapshot).not.toHaveBeenCalled();
});
it("ignores a late snapshot and reports connection errors while allowing cleanup", async () => {
  let resolve!: (snapshot: ActivitySnapshot) => void;
  const { store, connection, stop } = setup(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await Promise.resolve();
  connection.dispose();
  resolve(data("visible", true));
  await connection.ready;
  expect(store.getState().state).toBe("hidden");
  expect(stop).toHaveBeenCalledOnce();
  const onError = vi.fn(),
    error = new Error("fixture transport");
  await connectIslandActivity(store, {
    transport: { subscribe: () => Promise.reject(error), snapshot: vi.fn() },
    onError,
  }).ready;
  expect(onError).toHaveBeenCalledWith(error);
});
it("retains panel memory through a destroyed/recreated store and tolerates corrupt or unavailable storage", async () => {
  const { store, connection } = setup();
  await connection.ready;
  for (const action of [
    { type: "tab", tab: "files" },
    { type: "filter", name: "kind", value: "image" },
    { type: "search", text: "fixture query" },
    { type: "scroll", tab: "files", offset: 121 },
  ] as const)
    store.getState().dispatch(action);
  connection.dispose();
  const recreated = createIslandStore("island", loadIslandMemory("island", localStorage));
  expect(recreated.getState()).toMatchObject({
    tab: "files",
    filters: { kind: "image" },
    searchText: "fixture query",
    scroll: { files: 121 },
  });
  localStorage.setItem("nabbit.island.ui.v1.island", "invalid");
  expect(loadIslandMemory("island", localStorage).tab).toBe("nab");
  expect(
    loadIslandMemory("island", {
      getItem: () => {
        throw new Error("blocked");
      },
    }).searchText,
  ).toBe("");
});
it("reschedules an early timeout and tears down pending live intent", async () => {
  vi.useFakeTimers();
  let now = 0;
  const store = createIslandStore("island"),
    connection = connectIslandActivity(store, {
      transport: { subscribe: async () => () => {}, snapshot: async () => data("visible", true) },
      now: () => now,
    });
  await connection.ready;
  store.getState().dispatch({ type: "enter", now: 0 });
  vi.advanceTimersByTime(180);
  expect(store.getState().state).toBe("live");
  expect(vi.getTimerCount()).toBe(1);
  now = 180;
  vi.advanceTimersByTime(180);
  expect(store.getState().state).toBe("peek");
  store.getState().dispatch({ type: "leave", now });
  connection.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
