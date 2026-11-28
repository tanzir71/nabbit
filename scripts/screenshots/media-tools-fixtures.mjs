import { fixtureData } from "./fixtures.mjs";
import { toolsFixture } from "./tools-fixtures.mjs";
const video = ["mp4", "mov", "mkv", "webm", "avi", "m4v"],
  audio = ["mp3", "m4a", "wav", "aac", "flac", "ogg", "opus", "wma"];
export const mediaTools = [
  ["fit-size", "Fit under a size", ["discord", "email", "outlook", "whatsapp", "custom-fit"], true],
  ["to-mp4", "To MP4", ["mp4"], false],
  ["trim-video", "Trim video", ["trim"], false],
  ["extract-mp3", "Extract MP3", ["mp3"], true],
  ["extract-m4a", "Extract M4A", ["m4a"], true],
  ["to-gif", "To GIF", ["gif"], false],
  ["animated-webp", "Animated WebP", ["animated-webp"], false],
  ["strip-metadata", "Remove location and camera data", ["strip"], true],
].map(([id, name, presets, acceptAudio]) => ({
  id,
  name,
  presets,
  category: "media",
  icon: "iconFile",
  keywords: [],
  accepts: {
    filetypes: acceptAudio ? [...video, ...audio] : video,
    text: false,
    link: false,
    image: false,
  },
  form: [],
}));
export const mediaPresets = [
  ["discord", "Fit for Discord", 20],
  ["email", "Fit for email", 25],
  ["outlook", "Fit for Outlook", 10],
  ["whatsapp", "Fit for WhatsApp", 100],
  ["custom-fit", "Fit under a size", 20],
  ["mp4", "To MP4", null],
  ["trim", "Trimmed", null],
  ["mp3", "Extract audio", null],
  ["m4a", "Extract audio", null],
  ["gif", "To GIF", null],
  ["animated-webp", "Animated WebP", null],
  ["strip", "Metadata removed", null],
].map(([id, name, maxMb]) => ({ id, name, maxMb, quality: 85 }));
export function mediaToolsFixture(mode) {
  if (mode === "running") {
    const seed = toolsFixture("running-compact");
    seed.responses.get_activity_snapshot.views[0].primary.event.label =
      "Fit for Discord · try 1 of 3";
    seed.responses.get_activity_snapshot.views[0].primary.event.toolId = "fit-size";
    return seed;
  }
  const id =
    {
      mp4: "to-mp4",
      trim: "trim-video",
      audio: "extract-mp3",
      gif: "to-gif",
      webp: "animated-webp",
      strip: "strip-metadata",
    }[mode] ?? "fit-size";
  const audioOnly = mode === "audio-fit";
  return {
    data: fixtureData("tray"),
    responses: {
      tool_catalog: mediaTools,
      tool_presets: mediaPresets,
      tool_media_sheet: {
        id: "59000000-0000-4000-8000-000000000001",
        toolId: id,
        input:
          mode === "choose"
            ? ""
            : audioOnly
              ? "C:\\Fixture\\voice.m4a"
              : "C:\\Fixture\\launch-clip.mp4",
      },
      tool_media_sheet_ready: null,
      tool_media_inspect: {
        durationMs: 180000,
        width: audioOnly ? 0 : 1920,
        height: audioOnly ? 0 : 1080,
        fps: audioOnly ? 0 : 30,
        video: !audioOnly,
        audio: true,
        channels: 1,
        bytes: 42000000,
        videoCodec: audioOnly ? null : "h264",
        audioCodec: "aac",
      },
      tool_media_estimate: {
        targetBytes: mode === "custom" ? 18000000 : 20000000,
        seconds: mode === "advanced" ? 60 : 180,
        width: mode === "advanced" ? 1280 : 852,
        height: mode === "advanced" ? 720 : 480,
        videoKbps: audioOnly ? 0 : mode === "custom" ? 680 : mode === "advanced" ? 2458 : 766,
        audioKbps: mode === "advanced" ? 128 : 96,
        mono: true,
        estimatedBytes: audioOnly ? 2160000 : mode === "custom" ? 17460000 : 19400000,
      },
      tool_media_capabilities: {
        adapters: [],
        selected: mode === "fast" ? "h264_qsv" : null,
        probes: [],
        webp: true,
        checked: mode === "fast" || mode === "no-gpu",
        cached: false,
        cacheable: false,
      },
    },
    ...(mode === "error"
      ? { failures: { tool_media_inspect: "This file has no supported finite duration." } }
      : {}),
  };
}
