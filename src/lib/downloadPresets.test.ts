import { afterEach, expect, it, vi } from "vitest";
import { api } from "./ipc";
import { defaultDownloadOptions, defaultDownloadPresets } from "./downloadPresets";
import type { DownloadOptions, DownloadPreset } from "./types";

afterEach(() => vi.unstubAllGlobals());
it("parses trim field timecodes without network and rejects malformed input", async () => {
  expect(await api.parseDownloadTimecode("01:02.500")).toBe(62500);
  expect(await api.parseDownloadTimecode("1:02:03.1")).toBe(3723100);
  await expect(api.parseDownloadTimecode("1:60")).rejects.toThrow();
  await expect(api.parseDownloadTimecode("1.:00")).rejects.toThrow();
});
it("exposes the five preset choices with independent options", () => {
  const presets = defaultDownloadPresets();
  expect(presets.map((p) => p.label)).toEqual([
    "MP4 · 1080p",
    "MP4 · 720p",
    "MP3 · 320",
    "M4A",
    "Custom…",
  ]);
  presets[0].options.height = 999;
  expect(defaultDownloadPresets()[0].options.height).toBe(1080);
  expect(presets[2].options).toMatchObject({ format: "mp3", height: null });
});
it("uses the real Tauri client for preset reads, remembering and explicit start", async () => {
  const options: DownloadOptions = { format: "webm", height: 720 };
  const result: DownloadPreset = { id: "custom", label: "Custom…", options };
  const invoke = vi.fn().mockResolvedValue(result);
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  expect(await api.resolveDownloadPreset("https://vimeo.com/42")).toEqual(result);
  expect(invoke).toHaveBeenLastCalledWith(
    "resolve_download_preset",
    {
      url: "https://vimeo.com/42",
    },
    undefined,
  );
  await api.rememberDownloadPreset("https://vimeo.com/42", options);
  expect(invoke).toHaveBeenLastCalledWith(
    "remember_download_preset",
    {
      url: "https://vimeo.com/42",
      options,
    },
    undefined,
  );
  await api.startDownloadWithPreset("https://vimeo.com/43");
  expect(invoke).toHaveBeenLastCalledWith(
    "start_download_with_preset",
    {
      url: "https://vimeo.com/43",
    },
    undefined,
  );
});
it("keeps preview site choices separate and never starts media when remembering", async () => {
  const before = (await api.listDownloads()).length;
  await api.rememberDownloadPreset("https://youtu.be/preview-preset", {
    ...defaultDownloadOptions(),
    format: "opus",
    sections: [{ startMs: 0, endMs: 3000 }],
    preciseCuts: true,
    playlistMode: "playlist",
    playlistItems: "1-5",
    outputDir: "job-folder",
  });
  const recalled = await api.resolveDownloadPreset("https://music.youtube.com/watch?v=another");
  expect(recalled.options).toMatchObject({
    format: "opus",
    height: null,
    sections: [],
    preciseCuts: false,
    playlistMode: "video",
    playlistItems: null,
    outputDir: null,
  });
  expect(
    (await api.resolveDownloadPreset("https://vimeo.com/preview-isolated")).options.format,
  ).toBe("mp4");
  expect((await api.listDownloads()).length).toBe(before);
  const job = await api.startDownloadWithPreset("https://youtube.com/watch?v=preview");
  expect(job.quality).toBe("audio_opus");
  expect(job.options?.format).toBe("opus");
  if (job.options) job.options.format = "mp3";
  expect((await api.resolveDownloadPreset("https://youtu.be/another-preview")).options.format).toBe(
    "opus",
  );
});
it("sends browser choice on one explicit request and never as a saved preset field", async () => {
  const invoke = vi.fn().mockResolvedValue({});
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  const options: DownloadOptions = { format: "mp3" };
  await api.startDownload({ url: "https://vimeo.com/42", options, cookiesFromBrowser: "firefox" });
  expect(invoke).toHaveBeenLastCalledWith(
    "start_download",
    {
      request: { url: "https://vimeo.com/42", options, cookiesFromBrowser: "firefox" },
    },
    undefined,
  );
  await api.rememberDownloadPreset("https://vimeo.com/42", options);
  expect(JSON.stringify(invoke.mock.calls.at(-1))).not.toContain("firefox");
  await api.startDownload({ url: "https://vimeo.com/43", options });
  expect(invoke.mock.calls.at(-1)?.[1].request).not.toHaveProperty("cookiesFromBrowser");
});
