import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FileDropContent from "../files/FileDropContent";
import { filesApi } from "../files/api";
import { ImageReview } from "./ImageReview";
import { DocumentReview } from "./DocumentReview";
import { imageApi } from "./imageApi";
import { documentApi, pageGroups } from "./documentApi";
import { toolsApi, type Tool } from "./api";
import { shelfApi } from "../shelf/api";
vi.mock("./imageApi", async (original) => ({
  ...(await original<object>()),
  imageApi: { inspect: vi.fn(), start: vi.fn(), codec: vi.fn() },
}));
vi.mock("./documentApi", async (original) => ({
  ...(await original<object>()),
  documentApi: { pages: vi.fn(), start: vi.fn() },
}));
vi.mock("./api", async (original) => ({
  ...(await original<object>()),
  toolsApi: { presets: vi.fn(), pick: vi.fn(), catalog: vi.fn(), suggest: vi.fn() },
}));
vi.mock("../files/api", async (original) => ({
  ...(await original<object>()),
  filesApi: { pins: vi.fn(), hints: vi.fn() },
}));
vi.mock("../shelf/api", () => ({ shelfApi: { list: vi.fn() } }));
const tool: Tool = {
  id: "to-jpg",
  name: "Convert images",
  category: "images",
  icon: "iconImage",
  keywords: [],
  accepts: { filetypes: ["png", "heic"], text: false, link: false, image: true },
  presets: ["jpg", "png", "webp", "avif"],
  form: [],
};
const photo = "D:\\Owned\\photo.png",
  second = "D:\\Owned\\second.png";
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(shelfApi.list).mockResolvedValue([]);
  vi.mocked(toolsApi.presets).mockResolvedValue([]);
  vi.mocked(imageApi.inspect).mockResolvedValue({
    info: {
      width: 640,
      height: 480,
      bytes: 120000,
      format: "png",
      orientation: 1,
      hasExif: true,
      hasProfile: true,
      animated: false,
      decoder: "image",
    },
    error: null,
    codecRequired: false,
  });
  vi.mocked(imageApi.codec).mockResolvedValue(undefined);
  vi.mocked(imageApi.start).mockResolvedValue({} as never);
  vi.mocked(documentApi.start).mockResolvedValue({} as never);
  vi.mocked(documentApi.pages).mockResolvedValue(6);
});
afterEach(cleanup);
it("keeps defaults and reuses request IDs after partial batch submission fails", async () => {
  vi.mocked(imageApi.start)
    .mockResolvedValueOnce({} as never)
    .mockRejectedValueOnce("Queue unavailable");
  render(<ImageReview tool={tool} inputs={[photo, second]} close={vi.fn()} />);
  const run = screen.getByRole("button", { name: "Convert 2 photos" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "AVIF" }));
  fireEvent.click(run);
  await screen.findByRole("alert");
  expect(imageApi.start).toHaveBeenCalledTimes(2);
  const firstId = vi.mocked(imageApi.start).mock.calls[0][0];
  fireEvent.click(run);
  await waitFor(() => expect(imageApi.start).toHaveBeenCalledTimes(4));
  expect(vi.mocked(imageApi.start).mock.calls[2][0]).toBe(firstId);
  expect(imageApi.start).toHaveBeenCalledWith(
    firstId,
    "to-jpg",
    photo,
    "avif",
    expect.objectContaining({
      format: "avif",
      keepDates: true,
      keepProfile: true,
      stripMetadata: false,
    }),
    null,
  );
});
it("offers both codec pages and keeps Run disabled when HEIC cannot decode", async () => {
  vi.mocked(imageApi.inspect).mockResolvedValue({
    info: null,
    error: "Could not decode HEIC",
    codecRequired: true,
  });
  render(<ImageReview tool={tool} inputs={["D:\\Owned\\photo.heic"]} close={vi.fn()} />);
  await screen.findByText(/HEVC may cost/);
  fireEvent.click(screen.getByRole("button", { name: "Get HEIF extension" }));
  expect(imageApi.codec).toHaveBeenCalledWith("heif");
  expect(screen.getByRole("button", { name: "Convert 1 photo" })).toBeDisabled();
  expect(imageApi.start).not.toHaveBeenCalled();
});
it("preserves reordered PDF inputs and emits each selected page as its own PNG job", async () => {
  const pdfTool = {
    ...tool,
    id: "merge-pdf",
    name: "Merge PDFs",
    category: "documents",
    accepts: { ...tool.accepts, filetypes: ["pdf"] },
    presets: ["pdf"],
  };
  const a = "D:\\Owned\\a.pdf",
    b = "D:\\Owned\\b.pdf";
  const view = render(<DocumentReview tool={pdfTool} inputs={[a, b]} close={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Move b.pdf up" }));
  fireEvent.click(screen.getByRole("button", { name: "Merge PDFs" }));
  await waitFor(() =>
    expect(documentApi.start).toHaveBeenCalledWith(expect.any(String), "merge-pdf", b, "pdf", {
      inputs: [a],
      pages: [],
    }),
  );
  view.unmount();
  vi.mocked(documentApi.start).mockClear();
  render(
    <DocumentReview
      tool={{ ...pdfTool, id: "pdf-png", name: "PDF to PNG", presets: ["png"] }}
      inputs={[a]}
      close={vi.fn()}
    />,
  );
  await screen.findByText("6 pages");
  fireEvent.click(screen.getByLabelText("Page ranges"));
  fireEvent.change(screen.getByLabelText("Ranges"), { target: { value: "2-3, 6" } });
  fireEvent.click(screen.getByRole("button", { name: "PDF to PNG" }));
  await waitFor(() => expect(documentApi.start).toHaveBeenCalledTimes(3));
  expect(vi.mocked(documentApi.start).mock.calls.map((c) => c[4].pages)).toEqual([[2], [3], [6]]);
});
it("validates ranges and overlap before queueing any work", () => {
  expect(pageGroups("1-3, 5-6", 6, false)).toEqual([
    [1, 2, 3],
    [5, 6],
  ]);
  for (const value of ["0", "7", "3-1", "1-3, 3", "1,", "abc"])
    expect(() => pageGroups(value, 6, false)).toThrow();
  expect(pageGroups("", 2, true)).toEqual([[1], [2]]);
});

it("offers Make PDF first for a batch of images without starting any work", async () => {
  vi.mocked(filesApi.pins).mockResolvedValue([]);
  vi.mocked(filesApi.hints).mockResolvedValue({});
  vi.mocked(toolsApi.catalog).mockResolvedValue([
    { ...tool, id: "images-pdf", name: "Make PDF", category: "documents", presets: ["pdf"] },
  ]);
  vi.mocked(toolsApi.suggest).mockResolvedValue("images-pdf");
  const view = render(
    <FileDropContent payload={{ files: [photo, second] }} over={null} setOver={vi.fn()} />,
  );
  await screen.findByText("Make PDF");
  expect(toolsApi.suggest).toHaveBeenCalledWith([photo, second]);
  expect(view.container.querySelector("[data-drop-zone]")).toHaveAttribute(
    "data-drop-zone",
    "tool:images-pdf",
  );
  expect(imageApi.start).not.toHaveBeenCalled();
  expect(documentApi.start).not.toHaveBeenCalled();
});

it("uses saved preset quality and preserves an explicit quality edit", async () => {
  vi.mocked(toolsApi.presets).mockResolvedValue([
    { id: "jpg", name: "To JPG", quality: 93, maxMb: null },
    { id: "avif", name: "To AVIF", quality: 41, maxMb: null },
  ]);
  render(<ImageReview tool={tool} inputs={[photo]} close={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole("slider", { name: "Image quality" })).toHaveValue("93"),
  );
  fireEvent.click(screen.getByRole("button", { name: "AVIF" }));
  expect(screen.getByRole("slider", { name: "Image quality" })).toHaveValue("41");
  fireEvent.change(screen.getByRole("slider", { name: "Image quality" }), {
    target: { value: "66" },
  });
  const run = screen.getByRole("button", { name: "Convert 1 photo" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  await waitFor(() =>
    expect(imageApi.start).toHaveBeenCalledWith(
      expect.any(String),
      "to-jpg",
      photo,
      "avif",
      expect.objectContaining({ quality: 66 }),
      null,
    ),
  );
});
it("keeps an incoming Explorer format and waits for its saved quality before enabling Run", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof toolsApi.presets>>) => void;
  vi.mocked(toolsApi.presets).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<ImageReview tool={tool} inputs={[photo]} initialPreset="webp" close={vi.fn()} />);
  expect(screen.getByRole("button", { name: "WebP" })).toHaveAttribute("aria-pressed", "true");
  const run = screen.getByRole("button", { name: "Convert 1 photo" });
  await screen.findByText("640 × 480", { exact: false });
  expect(run).toBeDisabled();
  resolve([{ id: "webp", name: "To WebP", quality: 73, maxMb: null }]);
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  await waitFor(() =>
    expect(imageApi.start).toHaveBeenCalledWith(
      expect.any(String),
      "to-jpg",
      photo,
      "webp",
      expect.objectContaining({ format: "webp", quality: 73 }),
      null,
    ),
  );
});
it("loads the requested size preset while preserving a limit edited before preferences arrive", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof toolsApi.presets>>) => void;
  vi.mocked(toolsApi.presets).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(
    <ImageReview
      tool={{ ...tool, id: "fit-size", name: "Fit under a size", presets: ["discord", "email"] }}
      inputs={[photo]}
      initialPreset="email"
      close={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Maximum MB"), { target: { value: "17" } });
  resolve([{ id: "email", name: "Fit for email", quality: 78, maxMb: 25 }]);
  const run = screen.getByRole("button", { name: "Make smaller 1 photo" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  await waitFor(() =>
    expect(imageApi.start).toHaveBeenCalledWith(
      expect.any(String),
      "fit-size",
      photo,
      "email",
      expect.anything(),
      17,
    ),
  );
});
