import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineStatus } from "../lib/types";
import { EngineHealthCard } from "./EngineHealthCard";
import { CompactContent } from "../surfaces/island/CompactContent";

const mock = vi.hoisted(() => ({
  get: vi.fn(),
  check: vi.fn(),
  repair: vi.fn(),
  listen: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("../lib/ipc", () => ({
  api: {
    getEngineStatus: mock.get,
    checkEngine: mock.check,
    repairEngine: mock.repair,
    onEvent: mock.listen,
  },
}));
const healthy: EngineStatus = {
  missing: [],
  ytdlpVersion: "2026.11.23",
  denoVersion: "2.9.8",
  ffmpegVersion: "8.0",
  checkedAt: "2026-11-26T09:00:00Z",
  channel: "stable",
  extraction: { result: "passed", checkedAt: "2026-11-26T09:00:00Z" },
};
beforeEach(() => {
  vi.clearAllMocks();
  mock.get.mockResolvedValue(healthy);
  mock.listen.mockResolvedValue(mock.stop);
  mock.check.mockResolvedValue(healthy);
  mock.repair.mockResolvedValue(healthy);
});
afterEach(cleanup);
describe("engine health", () => {
  it("shows the engine error copy and opens review from Fix", () => {
    const item = {
      id: "downloadFailed:engine-health",
      category: "download" as const,
      alert: true,
      bubbleOnly: false,
      event: {
        kind: "downloadFailed" as const,
        jobId: "engine-health",
        error: "MissingJsRuntime" as const,
      },
    };
    const act = vi.fn();
    render(<CompactContent item={item} act={act} />);
    expect(screen.getByText("Download engine needs an update")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    expect(act).toHaveBeenCalledWith({ action: "review", item });
  });
  it("shows all real version fields and a separate extraction result", async () => {
    render(<EngineHealthCard />);
    await screen.findByText("Healthy");
    for (const text of ["2026.11.23", "2.9.8", "8.0", "Passed"])
      expect(screen.getByText(text)).toBeVisible();
    expect(mock.get).toHaveBeenCalledTimes(1);
    expect(mock.listen).toHaveBeenCalledWith("engine:health", expect.any(Function));
  });
  it("repairs a missing helper without creating a download", async () => {
    mock.get.mockResolvedValue({
      ...healthy,
      missing: ["deno"],
      denoVersion: null,
      failure: "MissingJsRuntime",
    });
    render(<EngineHealthCard />);
    await screen.findByText("Needs attention");
    fireEvent.click(screen.getByRole("button", { name: "Repair engine" }));
    await waitFor(() => expect(mock.repair).toHaveBeenCalledWith(undefined));
    await screen.findByText("Healthy");
  });
  it("disables duplicate commands while checking and reports skipped network checks", async () => {
    let finish!: (status: EngineStatus) => void;
    mock.check.mockImplementation(
      () =>
        new Promise<EngineStatus>((resolve) => {
          finish = resolve;
        }),
    );
    render(<EngineHealthCard />);
    await screen.findByText("Healthy");
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled();
    await act(async () =>
      finish({ ...healthy, extraction: { result: "skipped", detail: "Offline" } }),
    );
    expect(screen.getByText("Skipped")).toBeVisible();
    expect(screen.getByText("Ready")).toBeVisible();
    expect(mock.repair).not.toHaveBeenCalled();
  });
  it("switches channels only on explicit action and preserves failed-update copy", async () => {
    render(<EngineHealthCard />);
    await screen.findByText("Healthy");
    mock.repair.mockResolvedValue({ ...healthy, channel: "nightly" });
    fireEvent.click(screen.getByRole("button", { name: "Use nightly" }));
    await screen.findByRole("button", { name: "Use stable" });
    expect(mock.repair).toHaveBeenCalledWith("nightly");
    mock.repair.mockResolvedValue({
      ...healthy,
      channel: "nightly",
      updateError: "Engine checksum did not match. The existing engine was kept.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Use stable" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Use stable" })).toBeVisible();
  });
  it("pushes health updates without polling and unsubscribes on disposal", async () => {
    const view = render(<EngineHealthCard />);
    await screen.findByText("Healthy");
    const listener = mock.listen.mock.calls[0][1];
    await act(async () =>
      listener({ ...healthy, missing: ["deno"], denoVersion: null, failure: "MissingJsRuntime" }),
    );
    expect(screen.getByText("Needs attention")).toBeVisible();
    expect(mock.get).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(mock.stop).toHaveBeenCalledTimes(1);
  });
});
