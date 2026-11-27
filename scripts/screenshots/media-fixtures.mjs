import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { fixtureData } from "./fixtures.mjs";
import { clipboardSnapshot } from "./clipboard-fixtures.mjs";
export const recordedMedia = JSON.parse(
  readFileSync(new URL("../../tests/fixtures/media/sessions.json", import.meta.url), "utf8"),
);
export const mediaArtwork = `data:image/png;base64,${readFileSync(new URL("../../tests/fixtures/media/artwork.png", import.meta.url)).toString("base64")}`;
export function mediaFixture(mode = "expanded") {
  const data = fixtureData("tray-downloads");
  data.media = globalThis.structuredClone(recordedMedia);
  data.media.sessions[0].art = mediaArtwork;
  if (mode === "paused") data.media.sessions[0].playing = false;
  if (mode === "no-timeline") data.media.selected = "browser";
  if (mode === "empty") {
    data.media.sessions = [];
    data.media.selected = null;
  }
  if (mode === "error") {
    data.media.sessions = [];
    data.media.selected = null;
    data.media.error = "Media session access is unavailable.";
  }
  const activity = globalThis.structuredClone(clipboardSnapshot);
  const session = data.media.sessions.find((s) => s.id === data.media.selected);
  if (session?.playing)
    activity.views[0].primary = {
      id: `media:${session.id}`,
      category: "media",
      alert: false,
      event: {
        kind: "mediaChanged",
        sessionId: session.id,
        title: session.title,
        artist: `${session.artist} · ${session.app}`,
        playing: true,
        timeline: session.timeline,
        art: session.art,
      },
    };
  const state = ["compact", "peek"].includes(mode)
    ? mode === "compact"
      ? "live"
      : "peek"
    : "expanded";
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
        width: state === "live" ? 272 : state === "peek" ? 400 : 680,
        height: state === "live" ? 32 : state === "peek" ? 94 : 234,
        snapshot: activity,
        keyboard: null,
      },
    },
  };
}
