import { fixtureData } from "./fixtures.mjs";
import { clipboardSnapshot } from "./clipboard-fixtures.mjs";
export function privacyFixture(mode = "mic") {
  const snapshot = globalThis.structuredClone(clipboardSnapshot),
    view = snapshot.views[0];
  const event = {
    kind: "privacyChanged",
    mic: mode === "camera" ? [] : ["Teams"],
    camera: ["camera", "both", "peek"].includes(mode) ? ["Virtual Camera Host"] : [],
  };
  if (mode === "long") event.mic = ["An application with a very long descriptive name", "Recorder"];
  view.primary =
    mode === "off"
      ? null
      : { id: "privacy", category: "privacy", alert: false, bubbleOnly: false, event };
  if (mode === "split")
    view.bubble = {
      id: "timer:t",
      category: "timer",
      alert: false,
      bubbleOnly: false,
      event: { kind: "timerTick", id: "t", label: "Focus", remainingS: 1200 },
    };
  const state = mode === "off" ? "idle" : mode === "peek" ? "peek" : "live";
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
        width: mode === "off" ? 112 : mode === "peek" ? 400 : mode === "split" ? 298 : 232,
        height: mode === "off" ? 26 : mode === "peek" ? 78 : 32,
        snapshot,
        keyboard: null,
      },
    },
  };
}
