import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DownloadSheetApp from "./DownloadSheetApp";
import { api } from "../../lib/ipc";
import { defaultDownloadOptions } from "../../lib/downloadPresets";
import type { DownloadJob, DownloadMetadata, DownloadSheetIntent } from "../../lib/types";
import {
  covers,
  parseSection,
  selection,
  selectionLabel,
  snap,
  timecode,
  toggleChapter,
  union,
} from "./sheetModel";

const metadata: DownloadMetadata = {
  url: "https://www.youtube.com/watch?v=fixture",
  normalizedUrl: "https://www.youtube.com/watch?v=fixture",
  title: "A fixture walkthrough",
  duration: 768,
  isPlaylist: false,
  qualities: [
    { height: 1080, estimatedBytes: 420000000 },
    { height: 720, estimatedBytes: null },
  ],
  details: {
    thumbnails: [],
    truncated: false,
    entries: [],
    chapters: [
      { title: "Intro", startMs: 0, endMs: 192000 },
      { title: "Tray icon", startMs: 192000, endMs: 340000 },
      { title: "Popover", startMs: 340000, endMs: 478500 },
      { title: "Packaging", startMs: 478500, endMs: 680000 },
      { title: "Wrap-up", startMs: 680000, endMs: 768000 },
    ],
  },
};
let intent: DownloadSheetIntent,
  receive: (i: DownloadSheetIntent) => void,
  stop: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => ({
      media,
      matches: false,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  intent = {
    id: "fixture-intent",
    draft: {
      kind: "options",
      url: metadata.url,
      options: defaultDownloadOptions(),
      remember: false,
    },
    metadata: structuredClone(metadata),
  };
  stop = vi.fn();
  vi.spyOn(api, "getDownloadSheet").mockImplementation(async () => structuredClone(intent));
  vi.spyOn(api, "onEvent").mockImplementation(
    async <T,>(event: string, handler: (value: T) => void) => {
      if (event === "download:sheet") receive = (i) => handler(i as T);
      return stop;
    },
  );
  vi.spyOn(api, "downloadSheetReady").mockResolvedValue(undefined);
  vi.spyOn(api, "closeDownloadSheet").mockResolvedValue(undefined);
  vi.spyOn(api, "startDownload").mockImplementation(async (request) => ({
    id: "job",
    url: request.url,
    title: "Fixture",
    status: "queued",
    progress: 0,
    quality: "1080p",
    playlistMode: "video",
    createdAt: "2026-11-26T00:00:00Z",
    updatedAt: "2026-11-26T00:00:00Z",
    options: request.options,
  }));
  vi.spyOn(api, "startPlaylistDownload").mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mount = async () => {
  render(<DownloadSheetApp />);
  await screen.findByRole("dialog");
};
describe("download sheet workflows", () => {
  it("subscribes before reading the initial intent so startup cannot lose an intervening review", async () => {
    let registered!: (stop: () => void) => void;
    vi.mocked(api.onEvent).mockReturnValue(
      new Promise((resolve) => {
        registered = resolve;
      }),
    );
    render(<DownloadSheetApp />);
    expect(api.getDownloadSheet).not.toHaveBeenCalled();
    intent = {
      ...intent,
      id: "arrived-during-registration",
      draft: { ...intent.draft, kind: "trim" },
    };
    await act(async () => registered(stop));
    expect(await screen.findByRole("dialog")).toHaveAttribute("data-sheet", "trim");
    expect(api.getDownloadSheet).toHaveBeenCalledOnce();
  });
  it("preserves a newer pushed intent when the initial getter resolves late", async () => {
    let finish!: (value: DownloadSheetIntent) => void;
    vi.mocked(api.getDownloadSheet).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<DownloadSheetApp />);
    await waitFor(() => expect(api.onEvent).toHaveBeenCalled());
    act(() => receive({ ...intent, id: "newer", draft: { ...intent.draft, kind: "trim" } }));
    await act(async () => finish(intent));
    expect(await screen.findByRole("dialog")).toHaveAttribute("data-sheet", "trim");
    expect(api.startDownload).not.toHaveBeenCalled();
  });
  it("finishes an older enqueue using its original intent id while a newer review stays open", async () => {
    let finish!: (value: DownloadJob) => void;
    vi.mocked(api.startDownload).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    act(() => receive({ ...intent, id: "newer-review", draft: { ...intent.draft, kind: "trim" } }));
    await act(async () =>
      finish({
        id: "old-job",
        url: metadata.url,
        title: "Old",
        status: "queued",
        progress: 0,
        quality: "1080p",
        playlistMode: "video",
        createdAt: "",
        updatedAt: "",
      }),
    );
    expect(api.closeDownloadSheet).toHaveBeenCalledWith("fixture-intent");
    expect(screen.getByRole("dialog")).toHaveAttribute("data-sheet", "trim");
  });
  it("opening or closing options never starts work and releases its listener", async () => {
    await mount();
    expect(api.startDownload).not.toHaveBeenCalled();
    expect(api.startPlaylistDownload).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(api.closeDownloadSheet).toHaveBeenCalledOnce();
    cleanup();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("reopens remembered custom fields, preserves subtitle output and labels a customized app default accurately", async () => {
    const settings = await api.getSettings();
    vi.spyOn(api, "getSettings").mockResolvedValue({
      ...settings,
      filenameTemplate: "%(id)s.%(ext)s",
    });
    intent.draft.options = {
      ...defaultDownloadOptions(),
      filenameTemplate: "clip %(id)s.%(ext)s",
      subtitles: { languages: ["en", "bn"], embed: false },
    };
    await mount();
    expect(screen.getByLabelText("Custom filename template")).toHaveValue("clip %(id)s.%(ext)s");
    expect(screen.getAllByLabelText("Subtitle languages")[0]).toBeVisible();
    expect(screen.getByLabelText("Subtitle output")).toHaveValue("file");
    fireEvent.change(screen.getAllByLabelText("Subtitle languages")[0], {
      target: { value: "en,fr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() =>
      expect(api.startDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            subtitles: { languages: ["en", "fr"], embed: false },
          }),
        }),
      ),
    );
    act(() =>
      receive({
        ...intent,
        id: "default-name",
        draft: { ...intent.draft, options: defaultDownloadOptions() },
      }),
    );
    expect(screen.getByLabelText("Name files")).toHaveDisplayValue("Default template");
  });
  it("wires every options control, remembered site choice and job-scoped browser into the explicit request", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "MKV" }));
    fireEvent.click(screen.getByRole("radio", { name: /720p/ }));
    fireEvent.change(screen.getByLabelText("Subtitles"), { target: { value: "all:file" } });
    fireEvent.change(screen.getByLabelText("Chapters"), { target: { value: "split" } });
    fireEvent.change(screen.getByLabelText("SponsorBlock"), { target: { value: "cut" } });
    fireEvent.click(screen.getByRole("switch", { name: "Embed thumbnail and metadata" }));
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("Output folder"), {
      target: { value: "C:\\Fixture\\Selected" },
    });
    fireEvent.change(screen.getByLabelText("Name files"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Custom filename template"), {
      target: { value: "%(title)s clip [%(id)s].%(ext)s" },
    });
    fireEvent.change(screen.getByLabelText("Signed-in videos"), { target: { value: "chrome" } });
    fireEvent.click(screen.getByRole("switch", { name: "Remember for youtube.com" }));
    fireEvent.click(screen.getByText("Advanced"));
    fireEvent.change(screen.getByLabelText("Speed limit"), { target: { value: "2M" } });
    expect(api.startDownload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(api.startDownload).toHaveBeenCalledOnce());
    const request = vi.mocked(api.startDownload).mock.calls[0][0];
    expect(request).toMatchObject({
      url: metadata.url,
      rememberForSite: true,
      cookiesFromBrowser: "chrome",
      options: {
        format: "mkv",
        height: 720,
        subtitles: { languages: ["all"], embed: false },
        chapters: "split",
        sponsorBlock: "cut",
        embedThumbnail: true,
        embedMetadata: true,
        outputDir: "C:\\Fixture\\Selected",
        filenameTemplate: "%(title)s clip [%(id)s].%(ext)s",
        speedLimit: "2M",
      },
    });
    expect(request.options).not.toHaveProperty("cookiesFromBrowser");
    await waitFor(() => expect(api.closeDownloadSheet).toHaveBeenCalledOnce());
  });
  it("accepts custom subtitle codes and converts embedding to a sidecar for audio", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Subtitles"), { target: { value: "custom" } });
    fireEvent.change(screen.getAllByLabelText("Subtitle languages")[0], {
      target: { value: "en,bn" },
    });
    fireEvent.click(screen.getByRole("button", { name: "MP3" }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() =>
      expect(api.startDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            format: "mp3",
            height: null,
            subtitles: { languages: ["en", "bn"], embed: false },
          }),
        }),
      ),
    );
  });
  it("guards repeated click/Ctrl+Enter while the queue command is pending", async () => {
    let finish!: (job: DownloadJob) => void;
    vi.mocked(api.startDownload).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    expect(api.startDownload).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();
    await act(async () => {
      finish({
        id: "new",
        url: metadata.url,
        title: "New",
        status: "queued",
        progress: 0,
        quality: "1080p",
        playlistMode: "video",
        createdAt: "",
        updatedAt: "",
      });
    });
  });
  it("retains a submitted state if closing fails, so another click cannot enqueue twice", async () => {
    vi.mocked(api.closeDownloadSheet).mockRejectedValue(new Error("Fixture close failure"));
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    expect(api.startDownload).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Close download sheet" })).toBeEnabled();
  });
  it("clears browser choice and unsaved edits on a new sheet intent", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Signed-in videos"), { target: { value: "brave" } });
    fireEvent.click(screen.getByRole("button", { name: "Opus" }));
    act(() => receive({ ...intent, id: "next-intent" }));
    expect(screen.getByLabelText("Signed-in videos")).toHaveValue("");
    expect(screen.getByRole("button", { name: "MP4" })).toHaveAttribute("aria-pressed", "true");
    expect(api.startDownload).not.toHaveBeenCalled();
  });
  it("keeps custom options while navigating into trim, unions chapter ranges and passes precise cuts", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "MKV" }));
    fireEvent.click(screen.getByText("Advanced"));
    fireEvent.click(screen.getByRole("button", { name: "Trim and chapters" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("data-sheet", "trim");
    fireEvent.click(screen.getByRole("button", { name: /Tray icon/ }));
    fireEvent.click(screen.getByRole("button", { name: /Packaging/ }));
    fireEvent.click(screen.getByText("Advanced"));
    fireEvent.click(screen.getByRole("switch", { name: "Precise cuts" }));
    fireEvent.click(screen.getByRole("button", { name: "Download section" }));
    await waitFor(() =>
      expect(api.startDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            format: "mkv",
            preciseCuts: true,
            sections: [
              { startMs: 192000, endMs: 340000 },
              { startMs: 478500, endMs: 680000 },
            ],
          }),
        }),
      ),
    );
  });
  it("snaps handles within one second and refuses malformed, inverted or out-of-video fields", async () => {
    intent.draft.kind = "trim";
    await mount();
    fireEvent.change(screen.getByLabelText("Trim start handle"), { target: { value: 192800 } });
    expect(screen.getByLabelText("Start")).toHaveValue("03:12.0");
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "99:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Download section" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("within this video");
    expect(api.startDownload).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "00:01" } });
    fireEvent.click(screen.getByRole("button", { name: "Download section" }));
    expect(screen.getByRole("alert")).toHaveTextContent("after start");
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "07:58.125" } });
    fireEvent.click(screen.getByRole("button", { name: "Download section" }));
    await waitFor(() =>
      expect(api.startDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ sections: [{ startMs: 192000, endMs: 478125 }] }),
        }),
      ),
    );
  });
  it("Reset restores the full duration and disables precise cutting; preview is explicit", async () => {
    intent.draft.kind = "trim";
    intent.draft.options = {
      ...defaultDownloadOptions(),
      sections: [{ startMs: 2000, endMs: 5000 }],
      preciseCuts: true,
    };
    vi.spyOn(api, "previewDownloadSource").mockResolvedValue(undefined);
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByLabelText("Start")).toHaveValue("00:00.0");
    expect(screen.getByLabelText("End")).toHaveValue("12:48.0");
    fireEvent.click(screen.getByText("Advanced"));
    expect(screen.getByRole("switch", { name: "Precise cuts" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(api.previewDownloadSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Preview on source site" }));
    expect(api.previewDownloadSource).toHaveBeenCalledWith(metadata.url, 0);
    expect(api.startDownload).not.toHaveBeenCalled();
  });
  it("keeps unknown quality totals unknown", async () => {
    await mount();
    expect(screen.getByRole("radio", { name: /720p Size unknown/ })).toBeInTheDocument();
  });
  it("loads missing metadata once and never enqueues from that result", async () => {
    intent.metadata = null;
    vi.spyOn(api, "probeUrl").mockResolvedValue(metadata);
    await mount();
    await screen.findByRole("button", { name: "MP4" });
    expect(api.probeUrl).toHaveBeenCalledOnce();
    expect(api.startDownload).not.toHaveBeenCalled();
  });
  it("keeps options and explicit browser choice usable when the unsigned metadata probe fails", async () => {
    intent.metadata = null;
    vi.spyOn(api, "probeUrl").mockRejectedValue(new Error("Fixture sign-in requirement"));
    await mount();
    await screen.findByRole("button", { name: "MP4" });
    expect(screen.getByRole("alert")).toHaveTextContent("You can still choose options");
    fireEvent.change(screen.getByLabelText("Signed-in videos"), { target: { value: "chrome" } });
    expect(api.startDownload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() =>
      expect(api.startDownload).toHaveBeenCalledWith(
        expect.objectContaining({ cookiesFromBrowser: "chrome", url: metadata.url }),
      ),
    );
  });
});

function playlist() {
  const entries = [1, 2, 3, 4].map((index) => ({
    index,
    url: index === 4 ? null : `https://example.invalid/video-${index}`,
    title: `Film ${index}`,
    duration: 120,
    thumbnail: null,
    qualities: [{ height: 720, estimatedBytes: index === 3 ? null : 90000000 }],
  }));
  intent = {
    ...intent,
    metadata: {
      ...metadata,
      url: "https://example.invalid/playlist",
      normalizedUrl: "https://example.invalid/playlist",
      title: "Fixture films",
      isPlaylist: true,
      playlistCount: 4,
      details: { chapters: [], thumbnails: [], truncated: false, entries },
    },
    draft: {
      ...intent.draft,
      kind: "playlist",
      url: "https://example.invalid/playlist",
      options: {
        ...defaultDownloadOptions(),
        height: 720,
        playlistItems: "1-2",
        playlistMode: "playlist",
      },
    },
  };
}
describe("playlist selection", () => {
  it("supports ranges, sparse checkbox changes and a separate explicit per-item batch", async () => {
    playlist();
    await mount();
    expect(screen.getByText(/2 selected · about 180 MB/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Film 4" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Range"), { target: { value: "1,3" } });
    expect(screen.getByText(/2 selected · Size unknown/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Film 1" }));
    expect(screen.getByLabelText("Range")).toHaveValue("3");
    expect(api.startPlaylistDownload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download 1" }));
    await waitFor(() =>
      expect(api.startPlaylistDownload).toHaveBeenCalledWith(
        expect.objectContaining({ url: "https://example.invalid/playlist" }),
        [3],
      ),
    );
    expect(api.startDownload).not.toHaveBeenCalled();
  });
  it("selects only available items, handles none selected, and rejects unavailable/out-of-range input", async () => {
    playlist();
    await mount();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByRole("button", { name: "Download 3" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByRole("button", { name: "Download 0" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Range"), { target: { value: "1–4" } });
    expect(screen.getByRole("alert")).toHaveTextContent("4 is unavailable");
    expect(screen.getByRole("button", { name: "Download 0" })).toBeDisabled();
    expect(api.startPlaylistDownload).not.toHaveBeenCalled();
  });
  it("moves options to playlist review without starting and keeps the explicit browser selection", async () => {
    playlist();
    intent.draft.kind = "options";
    await mount();
    fireEvent.change(screen.getByLabelText("Signed-in videos"), { target: { value: "edge" } });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("data-sheet", "playlist");
    expect(api.startDownload).not.toHaveBeenCalled();
    expect(api.startPlaylistDownload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download 2" }));
    await waitFor(() =>
      expect(api.startPlaylistDownload).toHaveBeenCalledWith(
        expect.objectContaining({ cookiesFromBrowser: "edge" }),
        [1, 2],
      ),
    );
  });
});
describe("trim/selection boundaries", () => {
  it("keeps millisecond precision, unions overlaps and toggles chapters without filling gaps", () => {
    expect(timecode(3125)).toBe("00:03.125");
    expect(parseSection("1:02.125", "2:00.5", 130000)).toEqual({ startMs: 62125, endMs: 120500 });
    expect(() => parseSection("1:60", "2:00", 130000)).toThrow();
    expect(() => parseSection("0:10", "0:05", 130000)).toThrow();
    expect(
      union([
        { startMs: 0, endMs: 3000 },
        { startMs: 2000, endMs: 5000 },
        { startMs: 8000, endMs: 9000 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 5000 },
      { startMs: 8000, endMs: 9000 },
    ]);
    const chapter = { title: "Middle", startMs: 2000, endMs: 4000 };
    expect(toggleChapter([{ startMs: 0, endMs: 6000 }], chapter)).toEqual([
      { startMs: 0, endMs: 2000 },
      { startMs: 4000, endMs: 6000 },
    ]);
    expect(covers([{ startMs: 0, endMs: 6000 }], chapter)).toBe(true);
    expect(snap(2999, [chapter])).toBe(2000);
    expect(snap(3001, [chapter])).toBe(4000);
    expect(snap(9999, [chapter])).toBe(9999);
  });
  it("bounds expansion, deduplicates/sorts ranges and preserves sparse playlist indices", () => {
    playlist();
    const entries = intent.metadata!.details!.entries;
    expect(selection("3,1–2,2", entries)).toEqual([1, 2, 3]);
    expect(selectionLabel([3, 1, 2, 7, 9, 9])).toBe("1–3,7,9");
    expect(selection("", entries)).toEqual([]);
    for (const bad of ["0", "2-1", "1-9999999999", "1;run", "4"]) {
      expect(() => selection(bad, entries)).toThrow();
    }
  });
});
