import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ContextSettings } from "./ContextSettings";
import { ExplorerBatch } from "./ExplorerBatch";
import { MediaInputChoice } from "../tools/MediaSheetApp";
import { toolsApi, type Tool } from "../tools/api";
import { mediaApi } from "../tools/mediaApi";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../tools/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/api")>()),
  toolsApi: { catalog: vi.fn(), presets: vi.fn(), suggest: vi.fn() },
}));
vi.mock("../tools/mediaApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/mediaApi")>()),
  mediaApi: { open: vi.fn(), start: vi.fn() },
}));
const tool: Tool = {
  id: "to-jpg",
  name: "Convert images",
  category: "images",
  icon: "iconImage",
  keywords: [],
  form: [],
  presets: ["jpg", "webp"],
  accepts: { filetypes: ["png", "jpg"], image: true, text: false, link: false },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(mediaApi.open).mockResolvedValue();
  vi.mocked(toolsApi.catalog).mockResolvedValue([tool]);
  vi.mocked(toolsApi.presets).mockResolvedValue([
    { id: "webp", name: "To WebP", quality: 85, maxMb: null },
  ]);
  vi.mocked(toolsApi.suggest).mockResolvedValue(null);
});
it("integration options are off by default and change the backend only after Save", async () => {
  const preferences = { sendTo: false, contextMenu: false, selectionCopyFallback: false };
  vi.mocked(invoke)
    .mockResolvedValueOnce(preferences)
    .mockResolvedValue({ ...preferences, sendTo: true });
  const user = userEvent.setup();
  render(<ContextSettings />);
  const send = await screen.findByRole("switch", { name: "Show Nabbit in Send To" });
  await waitFor(() => expect(send).toBeEnabled());
  for (const toggle of screen.getAllByRole("switch"))
    expect(toggle).toHaveAttribute("aria-checked", "false");
  await user.click(send);
  expect(
    vi.mocked(invoke).mock.calls.filter(([name]) => name === "save_context_preferences"),
  ).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Save integration options" }));
  expect(await screen.findByRole("status")).toHaveTextContent("saved");
  expect(invoke).toHaveBeenCalledWith("save_context_preferences", {
    preferences: { ...preferences, sendTo: true },
  });
});
it("an Explorer batch retains every path and the requested preset and only opens review", async () => {
  const paths = ["C:\\Fixture\\one.png", "C:\\Fixture\\two.png"];
  vi.mocked(invoke).mockResolvedValue({
    batch: {
      id: "batch",
      paths,
      reviews: [{ target: { kind: "tool", toolId: "to-jpg", presetId: "webp" }, paths }],
    },
    error: null,
  });
  const user = userEvent.setup();
  render(<ExplorerBatch />);
  expect(await screen.findByText("2 files added to Shelf")).toBeVisible();
  await user.click(await screen.findByRole("button", { name: "Review To WebP" }));
  expect(mediaApi.open).toHaveBeenCalledExactlyOnceWith({
    id: expect.any(String),
    toolId: "to-jpg",
    presetId: "webp",
    input: paths[0],
    inputs: paths,
  });
  expect(mediaApi.start).not.toHaveBeenCalled();
  expect(vi.mocked(invoke).mock.calls.some(([name]) => name === "tool_start")).toBe(false);
});
it("a one-file executor makes the user choose rather than silently ignoring extra inputs", async () => {
  const paths = ["C:\\Fixture\\one.mp4", "C:\\Fixture\\two.mp4"];
  const intent = {
    id: "batch-review",
    toolId: "fit-size",
    presetId: "email",
    input: paths[0],
    inputs: paths,
  };
  const user = userEvent.setup();
  render(<MediaInputChoice intent={intent} inputs={paths} close={vi.fn()} />);
  expect(screen.getByText(/All 2 files stay in your batch/)).toBeVisible();
  expect(mediaApi.open).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "two.mp4" }));
  expect(mediaApi.open).toHaveBeenCalledExactlyOnceWith({
    ...intent,
    id: expect.any(String),
    input: paths[1],
    inputs: [paths[1]],
  });
  expect(intent.inputs).toEqual(paths);
  expect(mediaApi.start).not.toHaveBeenCalled();
});
it("full-screen suppression does not query or offer incoming batch actions", () => {
  render(<ExplorerBatch silent />);
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "Incoming Explorer batch" })).not.toBeInTheDocument();
});
