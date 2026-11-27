import { fixtureData } from "./fixtures.mjs";
import { clipboardSnapshot } from "./clipboard-fixtures.mjs";
export function powerFixture(mode = "charging") {
  const snapshot = globalThis.structuredClone(clipboardSnapshot),
    view = snapshot.views[0];
  const event = {
    kind: "powerChanged",
    percent: mode === "unknown" ? null : mode === "low" ? 20 : mode === "full" ? 100 : 82,
    charging: !["unplugged", "low", "full"].includes(mode),
    pluggedIn: !["unplugged", "low"].includes(mode),
  };
  view.primary =
    mode === "idle"
      ? null
      : { id: "power", category: "power", alert: false, bubbleOnly: false, event };
  if (mode === "split")
    view.bubble = {
      id: "timer:t",
      category: "timer",
      alert: false,
      bubbleOnly: false,
      event: { kind: "timerTick", id: "t", label: "Focus", remainingS: 1200 },
    };
  const state = mode === "idle" ? "idle" : mode === "peek" ? "peek" : "live";
  return {
    data: fixtureData("tray-downloads"),
    responses: {
      get_activity_snapshot: snapshot,
      get_island_drop: null,
      list_island_pins: [],
      get_island_surface: {
        label: "island",
        generation: 1,
        state,
        owner: "webview",
        shape: "island",
        reducedMotion: true,
        width: mode === "idle" ? 112 : mode === "peek" ? 400 : mode === "split" ? 298 : 232,
        height: mode === "idle" ? 26 : mode === "peek" ? 60 : 32,
        snapshot,
        keyboard: null,
      },
    },
  };
}
