import { afterEach, expect, it, vi } from "vitest";
import { api } from "../lib/ipc";
import type { DownloadJob, DownloadMetadata } from "../lib/types";
import { useAppStore } from "./useAppStore";
const metadata = (url: string, title = "Captured title"): DownloadMetadata => ({
  url,
  normalizedUrl: url,
  title,
  channel: null,
  duration: 768,
  thumbnail: null,
  isPlaylist: false,
  playlistCount: null,
  extractor: "fixture",
  qualities: [],
});
afterEach(() => vi.restoreAllMocks());
it("stages through Rust and consumes enrichment without probing again or starting a download", async () => {
  const captured = metadata("https://example.com/current");
  const capture = vi.spyOn(api, "captureUrl").mockResolvedValue(captured);
  const probe = vi.spyOn(api, "probeUrl");
  const start = vi.spyOn(api, "startDownload");
  await useAppStore.getState().stageUrl(captured.url);
  expect(capture).toHaveBeenCalledWith(captured.url);
  useAppStore.getState().acceptCapturedLink({ ...captured, title: "Enriched title" });
  expect(useAppStore.getState().metadata?.title).toBe("Enriched title");
  expect(probe).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});
it("does not overwrite a pushed newer capture with a delayed command response", async () => {
  let resolve!: (value: DownloadMetadata) => void;
  vi.spyOn(api, "captureUrl").mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const request = useAppStore.getState().stageUrl("https://example.com/old");
  useAppStore.getState().acceptCapturedLink(metadata("https://example.com/new"));
  resolve(metadata("https://example.com/old"));
  await request;
  expect(useAppStore.getState().stagedUrl).toBe("https://example.com/new");
});
it("clearing review prevents a pending stage response from restoring it", async () => {
  let resolve!: (value: DownloadMetadata) => void;
  vi.spyOn(api, "clearStagedUrl").mockResolvedValue(undefined);
  vi.spyOn(api, "captureUrl").mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const request = useAppStore.getState().stageUrl("https://example.com/old");
  useAppStore.getState().clearStagedUrl();
  resolve(metadata("https://example.com/old"));
  await request;
  expect(useAppStore.getState().stagedUrl).toBe("");
  expect(useAppStore.getState().metadata).toBeNull();
});
it("starting an older reviewed link preserves a new capture received while it enqueues", async () => {
  let resolve!: (job: DownloadJob) => void;
  vi.spyOn(api, "startDownload").mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  useAppStore.getState().acceptCapturedLink(metadata("https://example.com/old"));
  const started = useAppStore
    .getState()
    .startDownload({ url: "https://example.com/old", quality: "1080p", playlistMode: "video" });
  useAppStore.getState().acceptCapturedLink(metadata("https://example.com/new"));
  resolve({ id: "older-job", url: "https://example.com/old" } as DownloadJob);
  await started;
  expect(useAppStore.getState().stagedUrl).toBe("https://example.com/new");
  expect(useAppStore.getState().downloads[0].id).toBe("older-job");
});
