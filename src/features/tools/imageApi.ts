import { invoke } from "@tauri-apps/api/core";
import type { ToolJob } from "./api";
export interface ImageOptions {
  format: "original" | "jpg" | "png" | "webp" | "avif";
  quality: number | null;
  maxWidth: number | null;
  stripMetadata: boolean;
  keepProfile: boolean;
  keepDates: boolean;
  outputDir: string | null;
}
export const defaultImageOptions = (): ImageOptions => ({
  format: "jpg",
  quality: 82,
  maxWidth: null,
  stripMetadata: false,
  keepProfile: true,
  keepDates: true,
  outputDir: null,
});
export interface ImageInfo {
  width: number;
  height: number;
  bytes: number;
  format: string;
  orientation: number;
  hasExif: boolean;
  hasProfile: boolean;
  animated: boolean;
  decoder: string;
}
export interface ImageInspection {
  info: ImageInfo | null;
  error: string | null;
  codecRequired: boolean;
}
export const imageApi = {
  inspect: (path: string) => invoke<ImageInspection>("tool_image_inspect", { path }),
  codec: (codec: "heif" | "hevc") => invoke<void>("tool_image_codec", { codec }),
  start: (
    requestId: string,
    toolId: string,
    input: string,
    presetId: string,
    imageOptions: ImageOptions,
    maxMb: number | null,
  ) =>
    invoke<ToolJob>("tool_start", {
      request: { requestId, toolId, input, presetId, imageOptions, options: { maxMb } },
    }),
};
export const isImagePath = (path: string) => /\.(jpe?g|png|webp|avif|heic|heif|svg)$/i.test(path);
