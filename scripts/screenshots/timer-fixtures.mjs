import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { fixtureData } from "./fixtures.mjs";
import { clipboardSnapshot } from "./clipboard-fixtures.mjs";
export const recordedTimer = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/timer/running.json", import.meta.url), "utf8"),
);
export function timerFixture(mode = "running") {
  const data = fixtureData("tray-downloads");
  data.timer = globalThis.structuredClone(recordedTimer);
  if (mode === "idle") {
    data.timer.session = null;
    data.timer.linkedCard = null;
    data.timer.config.card = null;
  }
  if (mode === "paused") {
    data.timer.session.status = "paused";
    data.timer.session.deadlineMs = null;
  }
  if (mode === "ending") data.timer.session.remainingS = 42;
  if (mode === "ended") {
    data.timer.session.status = "ended";
    data.timer.session.remainingS = 0;
  }
  if (mode === "break") {
    data.timer.session.phase = "break";
    data.timer.session.plannedS = 300;
    data.timer.session.remainingS = 180;
  }
  if (mode === "unavailable") {
    data.timer.linkedCard = null;
    data.timer.linkUnavailable = true;
  }
  const activity = globalThis.structuredClone(clipboardSnapshot),
    s = data.timer.session;
  if (s)
    activity.views[0].primary = {
      id: `timer:${s.id}`,
      category: mode === "ending" || mode === "ended" ? "timerEnding" : "timer",
      alert: mode === "ended",
      event:
        s.status === "ended"
          ? { kind: "timerEnded", id: s.id }
          : {
              kind: s.status === "paused" ? "timerPaused" : "timerTick",
              id: s.id,
              label: s.phase === "break" ? "Break" : "Focus",
              remainingS: s.remainingS,
            },
    };
  const state = mode === "compact" ? "live" : mode === "peek" ? "peek" : "expanded";
  return {
    data,
    responses: {
      get_activity_snapshot: activity,
      get_island_drop: null,
      list_island_pins: [],
      get_island_surface: {
        label: "island",
        generation: 1,
        state,
        owner: "webview",
        shape: "island",
        reducedMotion: true,
        width: state === "live" ? 240 : state === "peek" ? 400 : 680,
        height: state === "live" ? 32 : state === "peek" ? 72 : 192,
        snapshot: activity,
        keyboard: null,
      },
    },
  };
}
