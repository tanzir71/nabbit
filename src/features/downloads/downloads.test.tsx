import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/ipc";
import { defaultDownloadPresets } from "../../lib/downloadPresets";
import type { DownloadJob, DownloadMetadata } from "../../lib/types";
import { useAppStore } from "../../store/useAppStore";
import { DownloadPanel } from "../../views/DownloadPanel";
import { DownloadReview } from "./DownloadReview";
import { DownloadQueue } from "./DownloadQueue";
import { IslandNab } from "./IslandNab";
import { PeekContent } from "../../surfaces/island/PeekContent";
import * as clipboard from "@tauri-apps/plugin-clipboard-manager";
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: vi.fn() }));
import { estimatedBytes, formatLabel, jobSummary } from "./model";
const metadata: DownloadMetadata = {
  url: "https://example.invalid/video",
  normalizedUrl: "https://example.invalid/video",
  title: "A reviewed video",
  channel: "Fixture channel",
  duration: 768,
  isPlaylist: false,
  qualities: [
    { height: 1080, estimatedBytes: 420000000 },
    { height: 720, estimatedBytes: null },
  ],
};
const job = (id: string, status: DownloadJob["status"]): DownloadJob => ({
  id,
  url: metadata.url,
  title: `Video ${id}`,
  status,
  progress: 62,
  speed: "3.1 MB/s",
  eta: "0:48",
  quality: "720p",
  playlistMode: "video",
  createdAt: "2026-11-26T09:00:00Z",
  updatedAt: "2026-11-26T09:00:00Z",
  outputPath: status === "completed" ? "C:\\Fixture\\video.mp4" : null,
  error: status === "failed" ? "This video needs you to be signed in" : null,
  failure:
    status === "failed"
      ? ({
          kind: "SignInRequired",
          title: "YouTube wants you signed in",
          description:
            "Use your browser’s sign-in for this one download. Nabbit reads that browser’s cookies only for this request.",
          actions: ["signIn", "retry"],
        } as DownloadJob["failure"])
      : null,
});
let jobs: DownloadJob[];
beforeEach(async () => {
  jobs = [job("run", "running"), job("done", "completed"), job("failed", "failed")];
  const settings = await api.getSettings();
  useAppStore.setState({
    settings,
    metadata,
    stagedUrl: metadata.url,
    downloads: structuredClone(jobs),
    engine: { missing: [] },
    error: null,
    loading: false,
  });
  vi.spyOn(api, "openDownloadSheet").mockResolvedValue(undefined);
  vi.spyOn(api, "resolveDownloadPreset").mockResolvedValue(defaultDownloadPresets()[0]);
  vi.spyOn(api, "listDownloads").mockImplementation(async () => structuredClone(jobs));
  vi.spyOn(api, "getCapturedLink").mockResolvedValue(metadata);
  vi.spyOn(api, "startDownload").mockImplementation(async (request) => ({
    ...job("new", "queued"),
    url: request.url,
    options: request.options,
  }));
  vi.spyOn(api, "pauseDownload").mockImplementation(async (id) => {
    jobs.find((j) => j.id === id)!.status = "paused";
  });
  vi.spyOn(api, "cancelDownload").mockImplementation(async (id) => {
    jobs.find((j) => j.id === id)!.status = "cancelled";
  });
  vi.spyOn(api, "resumeDownload").mockImplementation(async (id) => {
    const j = jobs.find((j) => j.id === id)!;
    j.status = "queued";
    return structuredClone(j);
  });
  vi.spyOn(api, "retryDownload").mockImplementation(async (id) => {
    const j = jobs.find((j) => j.id === id)!;
    j.status = "queued";
    j.error = null;
    return structuredClone(j);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("Nab review and persistent queue", () => {
  it("reads Paste through the clipboard plugin and only stages review", async () => {
    const read = vi.mocked(clipboard.readText).mockResolvedValue("https://example.invalid/pasted");
    const capture = vi.spyOn(api, "captureUrl").mockResolvedValue({
      ...metadata,
      url: "https://example.invalid/pasted",
      normalizedUrl: "https://example.invalid/pasted",
    });
    render(<DownloadReview />);
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await waitFor(() => expect(capture).toHaveBeenCalledWith("https://example.invalid/pasted"));
    expect(read).toHaveBeenCalledOnce();
    expect(api.startDownload).not.toHaveBeenCalled();
  });
  it("makes a remembered M4A choice visible and selected in the tray", async () => {
    vi.mocked(api.resolveDownloadPreset).mockResolvedValue(defaultDownloadPresets()[3]);
    render(<DownloadReview />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "M4A" })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(api.startDownload).not.toHaveBeenCalled();
  });
  it("carries the Peek selection into More and only starts on Nab it", async () => {
    const intent = vi.fn();
    const item = {
      id: "link",
      category: "link" as const,
      event: {
        kind: "linkDetected" as const,
        url: metadata.url,
        title: metadata.title,
        duration: 768,
        site: "example.invalid",
      },
      alert: false,
      bubbleOnly: false,
    };
    render(<PeekContent item={item} act={intent} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "MP3 320" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "MP3 320" }));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(intent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "review",
        preset: expect.objectContaining({ id: "mp3_320" }),
      }),
    );
    expect(api.startDownload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Nab it" }));
    expect(intent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "nab",
        options: expect.objectContaining({ format: "mp3" }),
      }),
    );
  });
  it("selects the remembered site preset and only enqueues after the explicit shortcut", async () => {
    vi.mocked(api.resolveDownloadPreset).mockResolvedValue(defaultDownloadPresets()[2]);
    render(<DownloadReview />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "MP3 320" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(api.startDownload).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(api.startDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          url: metadata.url,
          options: expect.objectContaining({ format: "mp3", height: null }),
        }),
      ),
    );
  });
  it("applies a chip choice to the explicit download and disables repeat activation while pending", async () => {
    let finish!: (value: DownloadJob) => void;
    vi.mocked(api.startDownload).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<DownloadReview />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "MP4 720p" }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.keyDown(document, { key: "Enter", ctrlKey: true });
    expect(api.startDownload).toHaveBeenCalledTimes(1);
    expect(api.startDownload).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ height: 720 }) }),
    );
    await act(async () => {
      finish(job("new", "queued"));
    });
  });
  it("does not activate Ctrl+Enter behind the settings surface", async () => {
    render(<DownloadReview active={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toBeEnabled());
    fireEvent.keyDown(document, { key: "Enter", ctrlKey: true });
    expect(api.startDownload).not.toHaveBeenCalled();
  });
  it("opens playlist review with the selected range and never creates a multi-video job from the tray", async () => {
    const playlist = {
      ...metadata,
      url: "https://www.youtube.com/playlist?list=fixture",
      normalizedUrl: "https://www.youtube.com/playlist?list=fixture",
      isPlaylist: true,
      playlistCount: 12,
    };
    useAppStore.getState().acceptCapturedLink(playlist);
    render(<DownloadReview />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() =>
      expect(api.openDownloadSheet).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "playlist", url: playlist.url }),
      ),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Download" }), {
      target: { value: "playlist" },
    });
    fireEvent.change(screen.getByLabelText("Playlist items"), { target: { value: "1-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() =>
      expect(api.openDownloadSheet).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: "playlist",
          options: expect.objectContaining({ playlistItems: "1-5" }),
        }),
      ),
    );
    expect(api.startDownload).not.toHaveBeenCalled();
  });
  it("restores a per-link island draft across panel teardown and uses site defaults for a different link", async () => {
    let memory = "";
    const save = (value: string) => {
      memory = value;
    };
    const view = render(<DownloadReview island memory={memory} onMemoryChange={save} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "MP4 1080p" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "MP3 320" }));
    expect(memory).toContain('"format":"mp3"');
    view.unmount();
    const restored = render(<DownloadReview island memory={memory} onMemoryChange={save} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "MP3 320" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    act(() =>
      useAppStore.getState().acceptCapturedLink({
        ...metadata,
        url: "https://other.invalid/new",
        normalizedUrl: "https://other.invalid/new",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "MP4 1080p" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    restored.unmount();
  });
  it("carries the current subtitle/preset choices into the trim sheet without starting", async () => {
    render(<DownloadReview />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    fireEvent.click(screen.getByRole("button", { name: "Trim" }));
    await waitFor(() =>
      expect(api.openDownloadSheet).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "trim",
          options: expect.objectContaining({ subtitles: { languages: ["en"], embed: true } }),
        }),
      ),
    );
    expect(api.startDownload).not.toHaveBeenCalled();
  });
  it("stages a synthetic URL drop through capture and creates no job", async () => {
    const capture = vi.spyOn(api, "captureUrl").mockResolvedValue({
      ...metadata,
      url: "https://example.invalid/dropped",
      normalizedUrl: "https://example.invalid/dropped",
    });
    const view = render(<DownloadPanel />);
    fireEvent.drop(view.container.firstChild!, {
      dataTransfer: {
        types: ["text/uri-list"],
        files: [],
        getData: (type: string) =>
          type === "text/uri-list" ? "# browser\r\nhttps://example.invalid/dropped" : "",
      },
    });
    await waitFor(() => expect(capture).toHaveBeenCalledWith("https://example.invalid/dropped"));
    expect(api.startDownload).not.toHaveBeenCalled();
  });
  it("pauses, resumes, cancels and retries a real queue row through the service callbacks", async () => {
    render(<DownloadQueue />);
    fireEvent.click(screen.getByRole("button", { name: "Pause: Video run" }));
    await screen.findByRole("button", { name: "Resume: Video run" });
    fireEvent.click(screen.getByRole("button", { name: "Resume: Video run" }));
    await screen.findByRole("button", { name: "Pause: Video run" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel: Video run" }));
    await waitFor(() =>
      expect(useAppStore.getState().downloads.find((j) => j.id === "run")?.status).toBe(
        "cancelled",
      ),
    );
    const row = screen.getByRole("article", { name: "Video run, cancelled" });
    fireEvent.click(row.querySelector("button")!);
    await waitFor(() => expect(api.retryDownload).toHaveBeenCalledWith("run"));
    expect(api.pauseDownload).toHaveBeenCalledWith("run");
    expect(api.resumeDownload).toHaveBeenCalledWith("run");
    expect(api.cancelDownload).toHaveBeenCalledWith("run");
  });
  it("opens/reveals only on click and surfaces a missing-file failure", async () => {
    const open = vi
      .spyOn(api, "openDownload")
      .mockRejectedValue(new Error("The downloaded file is no longer here"));
    const reveal = vi.spyOn(api, "revealDownload").mockResolvedValue(undefined);
    render(<DownloadQueue />);
    expect(open).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByText("Error: The downloaded file is no longer here");
    fireEvent.click(screen.getByRole("button", { name: "Reveal: Video done" }));
    await waitFor(() => expect(reveal).toHaveBeenCalledWith("done"));
  });
  it("clears completed history while preserving actionable failures and running items", async () => {
    const clear = vi.spyOn(api, "clearFinishedDownloads").mockImplementation(async () => {
      jobs = jobs.filter((j) => j.status !== "completed");
    });
    render(<DownloadQueue />);
    fireEvent.click(screen.getByRole("button", { name: "Clear finished" }));
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: "Video done, completed" })).toBeNull(),
    );
    expect(screen.getByRole("article", { name: "Video failed, failed" })).toBeInTheDocument();
    expect(clear).toHaveBeenCalledOnce();
  });
  it("offers Chrome sign-in as an explicit job-scoped retry without reading any profile", async () => {
    const retry = vi
      .spyOn(api, "retryDownloadWithBrowser")
      .mockResolvedValue(job("failed", "queued"));
    render(<DownloadQueue />);
    expect(retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use Chrome sign-in" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("failed", "chrome"));
  });
  it("exposes island cancel/reveal actions through the keyboard-accessible row menu", async () => {
    render(<DownloadQueue island />);
    const row = screen.getByRole("article", { name: "Video run, running" });
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "Cancel" }));
    await waitFor(() => expect(api.cancelDownload).toHaveBeenCalledWith("run"));
  });
  it("loads the expanded Nab from persisted downloads and cleans up pushed listeners", async () => {
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    vi.spyOn(api, "onEvent").mockImplementation(async () => {
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    });
    const clipboard = vi.spyOn(api, "listClipboard");
    const view = render(<IslandNab />);
    await screen.findByRole("heading", { name: "A reviewed video" });
    await waitFor(() => expect(api.listDownloads).toHaveBeenCalled());
    expect(clipboard).not.toHaveBeenCalled();
    view.unmount();
    expect(stops.length).toBeGreaterThanOrEqual(5);
    stops.forEach((stop) => expect(stop).toHaveBeenCalledOnce());
  });
});
it("keeps unknown sizes unknown and formats the saved output snapshot", () => {
  expect(estimatedBytes(metadata, { format: "mp4", height: 1080 })).toBe(420000000);
  expect(estimatedBytes(metadata, { format: "mp4", height: 720 })).toBeNull();
  expect(estimatedBytes(metadata, { format: "mp3" })).toBeNull();
  expect(
    formatLabel({ ...job("done", "completed"), options: { format: "webm", height: 480 } }),
  ).toBe("WEBM 480p");
  expect(jobSummary(job("run", "running"))).toBe("62% · 3.1 MB/s · 0:48 left");
});
