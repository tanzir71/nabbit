import { describe, expect, it } from "vitest";
import {
  activityOrder,
  type ActivityItem,
  type ActivitySnapshot,
  type ActivityView,
  type Gate,
} from "../lib/activity";
import {
  initialIsland,
  islandReducer,
  type IslandAction,
  type IslandModel,
  type IslandMode,
} from "./islandStore";
export const item: ActivityItem = {
  id: "download:d",
  category: "download",
  event: {
    kind: "downloadProgress",
    jobId: "d",
    title: "Fixture",
    percent: 30,
    speed: null,
    eta: null,
  },
  alert: false,
  bubbleOnly: false,
};
export function snapshot(
  gate: Gate = "visible",
  primary: ActivityItem | null = null,
  revision = 0,
): ActivitySnapshot {
  return {
    revision,
    views: [
      {
        label: "island",
        gate,
        primary,
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
const reduce = (state: IslandModel, ...actions: IslandAction[]) =>
  actions.reduce(islandReducer, state);
const model = (primary: ActivityItem | null = null, gate: Gate = "visible") =>
  islandReducer(initialIsland("island"), { type: "backend", snapshot: snapshot(gate, primary) });
describe("island presentation transitions (§6.3)", () => {
  it("keeps fullscreen exception alerts compact and cancels every larger surface", () => {
    const data = snapshot("visible", { ...item, alert: true }, 1);
    data.views[0].fullscreen = true;
    const state = islandReducer(
      { ...model(item), state: "expanded" },
      { type: "backend", snapshot: data },
    );
    expect(state.state).toBe("live");
    for (const action of [
      { type: "open" },
      { type: "dragEnter" },
      { type: "enter", now: 0 },
    ] as const)
      expect(islandReducer(state, action).state).toBe("live");
  });
  it("moves hidden ⇄ idle ⇄ live and preserves backend priority, bubble and pending queue", () => {
    let state = model();
    expect(state.state).toBe("idle");
    const data = snapshot("visible", item, 1);
    data.views[0].bubble = { ...item, id: "bubble" };
    data.views[0].queue = [{ ...item, id: "waiting" }];
    state = islandReducer(state, { type: "backend", snapshot: data });
    expect(state.state).toBe("live");
    expect(state.primary).toBe(item);
    expect(state.bubble?.id).toBe("bubble");
    expect(state.queue).toHaveLength(1);
    state = islandReducer(state, { type: "backend", snapshot: snapshot("visible", null, 2) });
    expect(state.state).toBe("idle");
    state = islandReducer(state, { type: "backend", snapshot: snapshot("hidden", item, 3) });
    expect(state.state).toBe("hidden");
    state = islandReducer(state, { type: "backend", snapshot: snapshot("visible", item, 4) });
    expect(state.state).toBe("live");
  });
  it("requires 180ms continuous live hover, cancels interrupted intent and closes Peek after 300ms leave", () => {
    let state = reduce(model(item), { type: "enter", now: 0 }, { type: "clock", now: 179 });
    expect(state.state).toBe("live");
    state = reduce(state, { type: "leave", now: 179 }, { type: "clock", now: 1000 });
    expect(state.state).toBe("live");
    state = reduce(state, { type: "enter", now: 1000 }, { type: "clock", now: 1180 });
    expect(state.state).toBe("peek");
    state = reduce(state, { type: "leave", now: 1200 }, { type: "clock", now: 1499 });
    expect(state.state).toBe("peek");
    state = reduce(state, { type: "enter", now: 1499 }, { type: "clock", now: 1600 });
    expect(state.state).toBe("peek");
    state = reduce(state, { type: "leave", now: 1600 }, { type: "clock", now: 1900 });
    expect(state.state).toBe("live");
  });
  it.each(["escape", "outside"] as const)(
    "expands from idle/live/Peek/faded, stays open on leave, and collapses by %s",
    (type) => {
      for (const initial of [
        model(),
        model(item),
        reduce(model(item), { type: "enter", now: 0 }, { type: "clock", now: 180 }),
        model(null, "faded"),
      ]) {
        const expanded = reduce(
          initial,
          { type: "open" },
          { type: "leave", now: 1000 },
          { type: "clock", now: 10000 },
        );
        expect(expanded.state).toBe("expanded");
        const closed = islandReducer(expanded, { type });
        expect(closed.state).toBe(
          initial.primary ? "live" : initial.gate === "faded" ? "faded" : "idle",
        );
      }
    },
  );
  it("retains tab, filters, search and scroll across close/open and hidden restoration", () => {
    let state = reduce(
      model(item),
      { type: "open" },
      { type: "tab", tab: "notes" },
      { type: "filter", name: "label", value: "Work" },
      { type: "search", text: "fixture query" },
      { type: "scroll", tab: "notes", offset: 212 },
      { type: "escape" },
      { type: "open" },
    );
    state = islandReducer(state, { type: "backend", snapshot: snapshot("hidden", item, 1) });
    expect(state.state).toBe("hidden");
    state = reduce(
      state,
      { type: "backend", snapshot: snapshot("visible", item, 2) },
      { type: "open" },
    );
    expect([state.tab, state.filters.label, state.searchText, state.scroll.notes]).toEqual([
      "notes",
      "Work",
      "fixture query",
      212,
    ]);
  });
  it("uses Rust's faded/wake decision, stays click-through until wake, and never opens over hidden", () => {
    let state = model(null, "faded");
    expect(state.state).toBe("faded");
    state = reduce(state, { type: "enter", now: 0 }, { type: "clock", now: 400 });
    expect(state.state).toBe("faded");
    state = islandReducer(state, { type: "backend", snapshot: snapshot("visible", null, 1) });
    expect(state.state).toBe("idle");
    state = islandReducer(state, { type: "backend", snapshot: snapshot("faded", null, 2) });
    expect(state.state).toBe("faded");
    state = islandReducer(state, { type: "backend", snapshot: snapshot("hidden", null, 3) });
    expect(islandReducer(state, { type: "open" }).state).toBe("hidden");
  });
  it.each(["idle", "live", "peek", "expanded", "faded"] as const)(
    "returns from Drop to %s on drag leave",
    (mode) => {
      let state = model(
        mode === "idle" || mode === "faded" ? null : item,
        mode === "faded" ? "faded" : "visible",
      );
      if (mode === "peek")
        state = reduce(state, { type: "enter", now: 0 }, { type: "clock", now: 180 });
      if (mode === "expanded") state = islandReducer(state, { type: "open" });
      expect(state.state).toBe(mode);
      const drop = islandReducer(state, { type: "dragEnter" });
      expect(drop.state).toBe("drop");
      expect(islandReducer(drop, { type: "dragLeave" }).state).toBe(mode);
      const acknowledged = reduce(
        drop,
        { type: "present", state: "drop" },
        { type: "present", state: "drop" },
      );
      expect(islandReducer(acknowledged, { type: "dragLeave" }).state).toBe(mode);
      const nativeFirst = islandReducer(state, { type: "present", state: "drop" });
      expect(islandReducer(nativeFirst, { type: "dragLeave" }).state).toBe(mode);
    },
  );
  it("forbids hidden drag, cancels Drop on suppression, and avoids restoring expired Peek content", () => {
    expect(islandReducer(model(null, "hidden"), { type: "dragEnter" }).state).toBe("hidden");
    let state = reduce(
      model(item),
      { type: "enter", now: 0 },
      { type: "clock", now: 180 },
      { type: "dragEnter" },
    );
    state = islandReducer(state, { type: "backend", snapshot: snapshot("visible", null, 1) });
    expect(islandReducer(state, { type: "dragLeave" }).state).toBe("idle");
    state = reduce(
      model(item),
      { type: "dragEnter" },
      { type: "backend", snapshot: snapshot("hidden", item, 2) },
    );
    expect(state.state).toBe("hidden");
    expect(state.dropReturn).toBeNull();
  });
  it("overlays a selected alert on Live and returns to the current highest-priority activity", () => {
    const alert = { ...item, id: "done", category: "result", alert: true } satisfies ActivityItem;
    const state = islandReducer(model(item), {
      type: "backend",
      snapshot: snapshot("visible", alert, 1),
    });
    expect(state.state).toBe("live");
    expect(state.alert).toBe(alert);
    const resumed = islandReducer(state, {
      type: "backend",
      snapshot: snapshot("visible", item, 2),
    });
    expect(resumed.primary).toBe(item);
    expect(resumed.alert).toBeNull();
    expect(
      islandReducer(resumed, { type: "backend", snapshot: snapshot("visible", null, 3) }).state,
    ).toBe("idle");
  });
  it("gives hidden policy precedence from every visible state and keeps link-only bubbles compact", () => {
    for (const mode of [
      "idle",
      "live",
      "peek",
      "expanded",
      "faded",
      "drop",
    ] satisfies IslandMode[]) {
      const state = {
        ...model(item),
        state: mode,
        peekAt: 100,
        closeAt: 100,
        dropReturn: "expanded" as const,
      };
      const data = snapshot("hidden", null, 1);
      data.views[0].focusMode = true;
      const hidden = islandReducer(state, { type: "backend", snapshot: data });
      expect(hidden.state).toBe("hidden");
      expect([hidden.peekAt, hidden.closeAt, hidden.dropReturn]).toEqual([null, null, null]);
    }
    const data = snapshot();
    data.views[0].bubble = { ...item, category: "link", bubbleOnly: true };
    const state = islandReducer(model(), { type: "backend", snapshot: data });
    expect(state.state).toBe("idle");
    expect(state.bubble?.bubbleOnly).toBe(true);
  });
  it("rejects stale backend snapshots and scopes drag to its target while applying current shared state", () => {
    const state = islandReducer(model(), {
      type: "backend",
      snapshot: snapshot("visible", item, 5),
    });
    expect(islandReducer(state, { type: "backend", snapshot: snapshot("hidden", null, 4) })).toBe(
      state,
    );
    const data = snapshot("visible", item, 6);
    const other = islandReducer(state, {
      type: "backend",
      snapshot: data,
      event: { kind: "dragEnter", kinds: ["file"], target: "island-left", snapshot: data },
    });
    expect(other.state).toBe("live");
    const missing = { ...data, revision: 7, views: [] as ActivityView[] };
    expect(islandReducer(other, { type: "backend", snapshot: missing }).state).toBe("hidden");
  });
});
