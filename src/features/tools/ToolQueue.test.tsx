import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { ToolQueue } from "./ToolQueue";
import { ToolSheet } from "./ToolSheet";
import { toolsApi, type ToolJob, type Tool } from "./api";
import { shelfApi } from "../shelf/api";
vi.mock("./api", async (original) => ({
  ...(await original<object>()),
  toolsApi: {
    jobs: vi.fn(),
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
it("requires a supported input and explicit click before submission", async () => {
  const close = vi.fn();
  render(<ToolSheet tool={tool} close={close} />);
  const button = await screen.findByRole("button", { name: "To JPG" });
  expect(button).toBeDisabled();
  expect(toolsApi.start).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("File path"), {
    target: { value: "C:\\Fixtures\\photo.png" },
  });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(toolsApi.start).toHaveBeenCalledWith(tool, "C:\\Fixtures\\photo.png"));
  expect(close).toHaveBeenCalledOnce();
});
