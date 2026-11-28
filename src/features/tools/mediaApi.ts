import { invoke } from "@tauri-apps/api/core";
import type { ToolJob } from "./api";
export interface MediaOptions {
  mode: "exact" | "fast";
  maxMb: number | null;
  keepAudio: boolean;
  downscale: boolean;
  audioKbps: number | null;
  maxHeight: number;
  trim: { startMs: number; endMs: number } | null;
  gifFps: number;
  gifPixels: number;
}
export const defaultMediaOptions = (): MediaOptions => ({
  mode: "exact",
  maxMb: null,
  keepAudio: true,
  downscale: true,
  audioKbps: null,
  maxHeight: 1080,
  trim: null,
  gifFps: 15,
  gifPixels: 720,
});
export interface MediaInfo {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  video: boolean;
  audio: boolean;
  channels: number;
  videoCodec: string | null;
  audioCodec: string | null;
  bytes: number;
}
export interface MediaPlan {
  targetBytes: number;
  seconds: number;
  width: number;
  height: number;
  videoKbps: number;
  audioKbps: number;
  mono: boolean;
  estimatedBytes: number;
}
export interface MediaCapabilities {
  adapters: Array<{ id: string; driver: number | null }>;
  selected: string | null;
  probes: Array<{ encoder: string; working: boolean; error: string | null }>;
  webp: boolean;
  checked: boolean;
  cached: boolean;
  cacheable: boolean;
}
export interface MediaIntent {
  presetId?: string;
  inputs?: string[];
  id: string;
  toolId: string;
  input: string;
}
export const mediaApi = {
  open: (intent: MediaIntent) => invoke<void>("tool_open_media_sheet", { intent }),
  current: () => invoke<MediaIntent | null>("tool_media_sheet"),
  ready: (id: string, height: number) => invoke<void>("tool_media_sheet_ready", { id, height }),
  close: (id: string) => invoke<void>("tool_close_media_sheet", { id }),
  inspect: (path: string) => invoke<MediaInfo>("tool_media_inspect", { path }),
  capabilities: (probeGpu = false) =>
    invoke<MediaCapabilities>("tool_media_capabilities", { probeGpu }),
  estimate: (info: MediaInfo, options: MediaOptions, maxMb: number) =>
    invoke<MediaPlan>("tool_media_estimate", { info, options, maxMb }),
  start: (toolId: string, input: string, presetId: string, options: MediaOptions) =>
    invoke<ToolJob>("tool_start", {
      request: { requestId: crypto.randomUUID(), toolId, input, presetId, options },
    }),
};
