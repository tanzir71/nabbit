import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { ToolQueue } from "./ToolQueue";
import { mediaApi } from "./mediaApi";
vi.mock("./mediaApi", () => ({ mediaApi: { open: vi.fn() } }));
import { ToolSheet } from "./ToolSheet";
import { toolsApi, type ToolJob, type Tool } from "./api";
import { shelfApi } from "../shelf/api";
vi.mock("./api", async (original) => ({
  ...(await original<object>()),
  toolsApi: {
    jobs: vi.fn(),
    catalog: vi.fn(),
    action: vi.fn(),
    presets: vi.fn(),
    savePreset: vi.fn(),
    start: vi.fn(),
  },
}));
vi.mock("../shelf/api", () => ({ shelfApi: { list: vi.fn() } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const preset = { id: "jpg", name: "To JPG", quality: 85, maxMb: null };
const tool: Tool = {
  id: "to-jpg",
  name: "To JPG",
  category: "images",
  icon: "iconImage",
  keywords: [],
  accepts: { filetypes: ["png"], text: false, link: false, image: true },
  presets: ["jpg"],
  form: [],
};
let rows: ToolJob[], change: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  rows = [
    {
      id: "job",
      request: { toolId: "to-jpg", input: "C:\\Fixtures\\photo.png", presetId: "jpg" },
      preset,
      status: "completed",
      percent: 100,
      createdAt: "",
      output: "C:\\Fixtures\\photo (To JPG).jpg",
      beforeBytes: 42000000,
      afterBytes: 19600000,
      note: "To JPG",
      error: null,
    },
  ];
  vi.mocked(mediaApi.open).mockResolvedValue(undefined);
  vi.mocked(toolsApi.catalog).mockResolvedValue([
    {
      ...tool,
      id: "strip-metadata",
      name: "Remove location and camera data",
      accepts: { ...tool.accepts, filetypes: ["jpg", "jpeg", "png", "webp"] },
      presets: ["strip"],
    },
  ]);
  vi.mocked(toolsApi.jobs).mockImplementation(async () => structuredClone(rows));
  vi.mocked(listen).mockImplementation(async (_, callback) => {
    change = () => callback({ event: "tools:changed", id: 0, payload: null });
    return vi.fn();
  });
  vi.mocked(toolsApi.presets).mockResolvedValue([preset]);
  vi.mocked(shelfApi.list).mockResolvedValue([]);
});
it("renders result sizes and dispatches Reveal and Undo using the job ID", async () => {
  render(<ToolQueue />);
  fireEvent.click(await screen.findByRole("button", { name: "Reveal" }));
  await waitFor(() => expect(toolsApi.action).toHaveBeenCalledWith("reveal", "job"));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(toolsApi.action).toHaveBeenCalledWith("undo", "job"));
  expect(screen.getByText(/42 MB → 19.6 MB/)).toBeInTheDocument();
});
it("keeps cancelled work visible and offers Retry after pushed updates", async () => {
  rows[0].status = "running";
  rows[0].percent = 64;
  render(<ToolQueue />);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(toolsApi.action).toHaveBeenCalledWith("cancel", "job"));
  rows[0].status = "cancelled";
  await act(async () => change());
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(toolsApi.action).toHaveBeenCalledWith("retry", "job"));
  expect(screen.getByRole("article")).toBeInTheDocument();
});
it("retains a result when Undo fails", async () => {
  vi.mocked(toolsApi.action).mockRejectedValueOnce(new Error("Output changed"));
  render(<ToolQueue />);
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Output changed");
  expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
});
it("opens image review with the selected input without starting a job", async () => {
  vi.mocked(mediaApi.open).mockResolvedValue(undefined);
  const close = vi.fn();
  const input = "C:\\Fixtures\\photo.png";
  render(<ToolSheet tool={tool} inputs={[input]} close={close} />);
  await waitFor(() =>
    expect(mediaApi.open).toHaveBeenCalledWith({
      id: expect.any(String),
      toolId: "to-jpg",
      input,
      inputs: [input],
    }),
  );
  expect(toolsApi.start).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it("opens the registry privacy action on a completed image without auto-running it", async () => {
  render(<ToolQueue />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove location and camera data" }));
  await waitFor(() =>
    expect(mediaApi.open).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "strip-metadata",
        input: rows[0].output,
        inputs: [rows[0].output],
      }),
    ),
  );
  expect(toolsApi.start).not.toHaveBeenCalled();
});
