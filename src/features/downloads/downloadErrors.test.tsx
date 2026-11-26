import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixtureText from "../../../src-tauri/src/download/fixtures/errors.json?raw";
import { api } from "../../lib/ipc";
import type { DownloadFailure as Failure, DownloadJob } from "../../lib/types";
import { downloadErrorTitle } from "../../lib/downloadErrors";
import { useAppStore } from "../../store/useAppStore";
import { CompactContent } from "../../surfaces/island/CompactContent";
import { DownloadQueue } from "./DownloadQueue";
import { DownloadFailure } from "./DownloadFailure";

const fixtures: Array<{ kind: Failure["kind"]; stderr: string; failure: Failure }> =
  JSON.parse(fixtureText);
const cases = fixtures.filter(
  (fixture, index) => fixtures.findIndex((other) => other.kind === fixture.kind) === index,
);
const job = (fixture = cases[0]): DownloadJob => ({
  id: "failed-original",
  url: "https://www.youtube.com/watch?v=fixture",
  title: "Fixture media",
  status: "failed",
  progress: 0,
  quality: "1080p",
  playlistMode: "video",
  createdAt: "2026-11-26T09:00:00Z",
  updatedAt: "2026-11-26T09:01:00Z",
  options: { format: "mp4", height: 1080, outputDir: "D:\\Videos" },
  error: fixture.stderr,
  failure: fixture.failure as Failure,
});
const find = (kind: string) => cases.find((f) => f.kind === kind)!;
beforeEach(() => {
  vi.spyOn(api, "listDownloads").mockResolvedValue([]);
  vi.spyOn(api, "retryDownload").mockResolvedValue({
    ...job(),
    status: "queued",
    error: null,
    failure: null,
  });
  vi.spyOn(api, "retryDownloadWithBrowser").mockResolvedValue({
    ...job(),
    status: "queued",
    error: null,
    failure: null,
  });
  vi.spyOn(api, "recoverDownload").mockResolvedValue({
    ...job(),
    status: "queued",
    error: null,
    failure: null,
  });
  vi.spyOn(api, "cancelDownload").mockResolvedValue(undefined);
  vi.spyOn(api, "copyDownloadDetails").mockResolvedValue(undefined);
  vi.spyOn(api, "dismissDownloadProblem").mockResolvedValue(undefined);
  vi.spyOn(api, "repairEngine").mockResolvedValue({ missing: [], busy: false });
  vi.spyOn(api, "openDownloadSheet").mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("download error contract", () => {
  it.each(cases)(
    "renders $kind full tray copy, with no raw log and at most two recovery actions",
    (fixture) => {
      const failed = job(fixture);
      useAppStore.setState({ downloads: [failed] });
      const view = render(<DownloadQueue />);
      expect(screen.getByRole("heading", { name: fixture.failure.title })).toBeInTheDocument();
      expect(screen.getByText(fixture.failure.description)).toBeInTheDocument();
      const actions = view.container.querySelectorAll(".download-failure-actions button");
      expect(actions.length).toBe(fixture.failure.actions.length);
      expect(actions.length).toBeLessThanOrEqual(2);
      expect(view.container).not.toHaveTextContent("ERROR:");
      expect(view.container).not.toHaveTextContent("Traceback");
      expect(api.retryDownload).not.toHaveBeenCalled();
      expect(api.repairEngine).not.toHaveBeenCalled();
    },
  );
  it.each(cases)(
    "renders $kind compact Error and routes Fix to review without starting",
    (fixture) => {
      const act = vi.fn();
      const kind = fixture.failure.kind as Failure["kind"];
      render(
        <CompactContent
          item={{
            id: "downloadFailed:fixture",
            category: "download",
            event: { kind: "downloadFailed", jobId: "fixture", error: kind },
            alert: true,
            bubbleOnly: false,
          }}
          act={act}
        />,
      );
      expect(screen.getByText(downloadErrorTitle[kind])).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Fix" }));
      expect(act).toHaveBeenCalledWith(expect.objectContaining({ action: "review" }));
      expect(api.retryDownload).not.toHaveBeenCalled();
    },
  );
  it("uses an explicitly selected browser for this job only", async () => {
    render(<DownloadFailure job={job(find("SignInRequired"))} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Browser sign-in" }), {
      target: { value: "firefox" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use Firefox sign-in" }));
    await waitFor(() =>
      expect(api.retryDownloadWithBrowser).toHaveBeenCalledWith("failed-original", "firefox"),
    );
    expect(api.recoverDownload).not.toHaveBeenCalled();
  });
  it("updates/installs the engine before retrying and does not retry a failed repair", async () => {
    vi.mocked(api.repairEngine).mockResolvedValueOnce({
      missing: ["deno"],
      updateError: "Traceback: fixture",
    });
    render(<DownloadFailure job={job(find("MissingJsRuntime"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Install Deno" }));
    await screen.findByText(/The engine still needs attention/);
    expect(api.retryDownload).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent("Traceback");
    fireEvent.click(screen.getByRole("button", { name: "Install Deno" }));
    await waitFor(() => expect(api.retryDownload).toHaveBeenCalledWith("failed-original"));
    expect(api.repairEngine).toHaveBeenCalledTimes(2);
  });
  it("copies raw details only through the explicit job command", async () => {
    render(<DownloadFailure job={job(find("Unknown"))} />);
    expect(api.copyDownloadDetails).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await screen.findByText("Details copied.");
    expect(api.copyDownloadDetails).toHaveBeenCalledWith("failed-original");
    expect(document.body).not.toHaveTextContent("Traceback");
  });
  it("retries best quality once and keeps Choose attached to the original job", async () => {
    let finish!: () => void;
    vi.mocked(api.recoverDownload).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ...job(), status: "queued" });
        }),
    );
    const view = render(<DownloadFailure job={job(find("FormatUnavailable"))} />);
    const best = screen.getByRole("button", { name: "Use best available" });
    fireEvent.click(best);
    fireEvent.click(best);
    expect(api.recoverDownload).toHaveBeenCalledTimes(1);
    expect(api.recoverDownload).toHaveBeenCalledWith("failed-original", { kind: "bestAvailable" });
    finish();
    await waitFor(() => expect(best).toBeEnabled());
    view.unmount();
    render(<DownloadFailure job={job(find("FormatUnavailable"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() =>
      expect(api.openDownloadSheet).toHaveBeenCalledWith(
        expect.objectContaining({
          retryJobId: "failed-original",
          remember: false,
          options: expect.objectContaining({ height: 1080 }),
        }),
      ),
    );
  });
  it("edits this job's folder and never starts while opening the editor", async () => {
    render(<DownloadFailure job={job(find("Disk"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    expect(api.recoverDownload).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Save this download to" }), {
      target: { value: "E:\\Other" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and retry" }));
    await waitFor(() =>
      expect(api.recoverDownload).toHaveBeenCalledWith("failed-original", {
        kind: "folder",
        outputDir: "E:\\Other",
      }),
    );
  });
  it("offers only acknowledgement for DRM and does not offer any retry or workaround", async () => {
    render(<DownloadFailure job={job(find("Drm"))} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(api.dismissDownloadProblem).toHaveBeenCalledWith("failed-original"));
    fireEvent.click(await screen.findByRole("button", { name: "Show fix" }));
    expect(screen.getByRole("button", { name: "OK" })).toBeInTheDocument();
    expect(api.retryDownload).not.toHaveBeenCalled();
    expect(api.recoverDownload).not.toHaveBeenCalled();
  });
  it("offers Cancel for offline and an explicit replay wait that remains cancellable", async () => {
    const view = render(<DownloadFailure job={job(find("Offline"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(api.cancelDownload).toHaveBeenCalledWith("failed-original"));
    view.unmount();
    const waiting = job(find("Live"));
    render(<DownloadFailure job={waiting} />);
    fireEvent.click(screen.getByRole("button", { name: "Download when it ends" }));
    await waitFor(() =>
      expect(api.recoverDownload).toHaveBeenCalledWith("failed-original", { kind: "waitForVideo" }),
    );
    cleanup();
    render(
      <DownloadFailure job={{ ...waiting, options: { ...waiting.options, waitForVideo: true } }} />,
    );
    expect(screen.getByRole("button", { name: "Download when it ends" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});
