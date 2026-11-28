import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MediaReview } from "./MediaReview";
import { ToolSheet } from "./ToolSheet";
import { toolsApi, type Tool } from "./api";
import { mediaApi, type MediaInfo, type MediaCapabilities } from "./mediaApi";
vi.mock("./api", async (original) => ({
  ...(await original<object>()),
  toolsApi: { presets: vi.fn(), savePreset: vi.fn(), pick: vi.fn() },
}));
vi.mock("./mediaApi", async (original) => ({
  ...(await original<object>()),
  mediaApi: {
    open: vi.fn(),
    inspect: vi.fn(),
    capabilities: vi.fn(),
    estimate: vi.fn(),
    start: vi.fn(),
  },
}));
const source = "D:\\Owned\\source.mp4";
const info: MediaInfo = {
  durationMs: 180000,
  width: 1920,
  height: 1080,
  fps: 30,
  video: true,
  audio: true,
  channels: 1,
  bytes: 42000000,
  videoCodec: "h264",
  audioCodec: "aac",
};
const caps: MediaCapabilities = {
  adapters: [],
  selected: null,
  probes: [],
  webp: true,
  checked: false,
  cached: false,
  cacheable: false,
};
const preset = (id: string, name: string, maxMb: number | null) => ({
  id,
  name,
  maxMb,
  quality: 85,
});
const presets = [
  preset("discord", "Fit for Discord", 20),
  preset("email", "Fit for email", 25),
  preset("whatsapp", "Fit for WhatsApp", 100),
  preset("outlook", "Fit for Outlook", 10),
  preset("custom-fit", "Fit under a size", 20),
  preset("trim", "Trimmed", null),
  preset("gif", "To GIF", null),
  preset("animated-webp", "Animated WebP", null),
];
const tool: Tool = {
  id: "fit-size",
  name: "Fit under a size",
  category: "media",
  icon: "iconFile",
  keywords: [],
  accepts: { filetypes: ["mp4", "mp3"], text: false, link: false, image: false },
  presets: ["discord", "email", "outlook", "whatsapp", "custom-fit"],
  form: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(toolsApi.presets).mockResolvedValue(presets);
  vi.mocked(toolsApi.savePreset).mockResolvedValue(undefined);
  vi.mocked(mediaApi.inspect).mockResolvedValue(info);
  vi.mocked(mediaApi.capabilities).mockResolvedValue(caps);
  vi.mocked(mediaApi.estimate).mockImplementation(async (_info, _options, cap) => ({
    targetBytes: cap * 1e6,
    seconds: 180,
    width: 852,
    height: 480,
    videoKbps: 766,
    audioKbps: 96,
    mono: true,
    estimatedBytes: 19400000,
  }));
  vi.mocked(mediaApi.start).mockResolvedValue({} as never);
  vi.mocked(mediaApi.open).mockResolvedValue(undefined);
});
afterEach(cleanup);
it("defaults to Exact without a GPU test and submits edited limits only after the explicit click", async () => {
  const close = vi.fn();
  render(<MediaReview tool={tool} input={source} close={close} />);
  const run = await screen.findByRole("button", { name: "Fit under 20 MB" });
  await waitFor(() => expect(run).toBeEnabled());
  expect(mediaApi.capabilities).toHaveBeenCalledWith();
  expect(mediaApi.capabilities).not.toHaveBeenCalledWith(true);
  expect(mediaApi.start).not.toHaveBeenCalled();
  expect(toolsApi.savePreset).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Custom…" }));
  fireEvent.change(screen.getByLabelText("Maximum size (MB)", { selector: "input" }), {
    target: { value: "18" },
  });
  const custom = screen.getByRole("button", { name: "Fit under 18 MB" });
  await waitFor(() => expect(custom).toBeEnabled());
  let resolve!: () => void;
  vi.mocked(mediaApi.start).mockReturnValue(
    new Promise((done) => {
      resolve = () => done({} as never);
    }),
  );
  fireEvent.click(custom);
  fireEvent.click(custom);
  await waitFor(() => expect(mediaApi.start).toHaveBeenCalledOnce());
  expect(mediaApi.start).toHaveBeenCalledWith(
    "fit-size",
    source,
    "custom-fit",
    expect.objectContaining({ mode: "exact", maxMb: 18, keepAudio: true }),
  );
  expect(toolsApi.savePreset).toHaveBeenCalledWith(
    expect.objectContaining({ id: "custom-fit", maxMb: 18 }),
  );
  await act(async () => resolve());
  expect(close).toHaveBeenCalledOnce();
});
it("uses only the encoder returned by a successful lazy GPU probe", async () => {
  render(<MediaReview tool={tool} input={source} close={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Fit under 20 MB" })).toBeEnabled(),
  );
  vi.mocked(mediaApi.capabilities).mockResolvedValue({
    ...caps,
    checked: true,
    selected: "h264_qsv",
    probes: [{ encoder: "h264_qsv", working: true, error: null }],
  });
  fireEvent.click(screen.getByRole("button", { name: "Fast · GPU" }));
  expect(await screen.findByRole("button", { name: "Fast · GPU (h264_qsv)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(mediaApi.capabilities).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Fit under 20 MB" }));
  await waitFor(() =>
    expect(mediaApi.start).toHaveBeenCalledWith(
      "fit-size",
      source,
      "discord",
      expect.objectContaining({ mode: "fast" }),
    ),
  );
});
it("keeps Exact available when every GPU probe fails", async () => {
  render(<MediaReview tool={tool} input={source} close={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Fit under 20 MB" })).toBeEnabled(),
  );
  vi.mocked(mediaApi.capabilities).mockResolvedValue({ ...caps, checked: true });
  fireEvent.click(screen.getByRole("button", { name: "Fast · GPU" }));
  expect(await screen.findByText(/No GPU encoder passed/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Fast · GPU" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Exact size · 2 passes" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
it("invalid numeric and section drafts cannot submit an older valid configuration", async () => {
  render(<MediaReview tool={tool} input={source} close={vi.fn()} />);
  const run = await screen.findByRole("button", { name: "Fit under 20 MB" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(screen.getByText(/Advanced: trim/, { selector: "summary" }));
  fireEvent.change(screen.getByLabelText("Audio bitrate (kb/s)"), { target: { value: "12" } });
  expect(run).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("displayed limits");
  fireEvent.change(screen.getByLabelText("Audio bitrate (kb/s)"), { target: { value: "96" } });
  fireEvent.click(screen.getByRole("switch", { name: "Use a section" }));
  fireEvent.change(screen.getByLabelText("End"), { target: { value: "0:00.0" } });
  expect(run).toBeDisabled();
  fireEvent.click(run);
  expect(mediaApi.start).not.toHaveBeenCalled();
});
it("reuses the trim handles and precise time fields for a local file", async () => {
  render(
    <MediaReview
      tool={{ ...tool, id: "trim-video", name: "Trim video", presets: ["trim"] }}
      input={source}
      close={vi.fn()}
    />,
  );
  const start = await screen.findByLabelText("Start");
  expect(screen.getByLabelText("Trim end handle")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Preview on source site" })).not.toBeInTheDocument();
  fireEvent.change(start, { target: { value: "0:01.2" } });
  fireEvent.change(screen.getByLabelText("End"), { target: { value: "0:03.3" } });
  fireEvent.click(screen.getByRole("button", { name: "Trim video" }));
  await waitFor(() =>
    expect(mediaApi.start).toHaveBeenCalledWith(
      "trim-video",
      source,
      "trim",
      expect.objectContaining({ trim: { startMs: 1200, endMs: 3300 } }),
    ),
  );
});
it("an unavailable animated WebP encoder cannot start a job", async () => {
  vi.mocked(mediaApi.capabilities).mockResolvedValue({ ...caps, webp: false });
  render(
    <MediaReview
      tool={{ ...tool, id: "animated-webp", name: "Animated WebP", presets: ["animated-webp"] }}
      input={source}
      close={vi.fn()}
    />,
  );
  expect(await screen.findByText(/no animated WebP encoder/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Animated WebP" })).toBeDisabled();
});
it("Search and Shelf open a single intent under StrictMode without starting a tool", async () => {
  const close = vi.fn();
  render(
    <StrictMode>
      <ToolSheet tool={tool} inputs={[source]} close={close} />
    </StrictMode>,
  );
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(mediaApi.open).toHaveBeenCalledTimes(2);
  const [a, b] = vi.mocked(mediaApi.open).mock.calls;
  expect(a).toEqual(b);
  expect(a[0]).toMatchObject({ toolId: "fit-size", input: source });
  expect(mediaApi.start).not.toHaveBeenCalled();
});
it("allows a failed inspection to be retried without changing the path", async () => {
  vi.mocked(mediaApi.inspect).mockRejectedValueOnce(new Error("Unsupported media"));
  render(<MediaReview tool={tool} input={source} close={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported media");
  fireEvent.click(screen.getByRole("button", { name: "Load file" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Fit under 20 MB" })).toBeEnabled(),
  );
  expect(mediaApi.inspect).toHaveBeenCalledTimes(2);
});
it("changing the source invalidates the old estimate and a late GPU probe cannot change the new audio mode", async () => {
  render(<MediaReview tool={tool} input="" close={vi.fn()} />);
  const path = screen.getByLabelText("File path");
  fireEvent.change(path, { target: { value: source } });
  fireEvent.click(screen.getByRole("button", { name: "Load file" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Fit under 20 MB" })).toBeEnabled(),
  );
  let resolve!: (value: MediaCapabilities) => void;
  vi.mocked(mediaApi.capabilities).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Fast · GPU" }));
  vi.mocked(mediaApi.inspect).mockResolvedValueOnce({
    ...info,
    video: false,
    width: 0,
    height: 0,
    fps: 0,
  });
  fireEvent.change(path, { target: { value: "D:\\Owned\\voice.mp3" } });
  fireEvent.click(screen.getByRole("button", { name: "Load file" }));
  await screen.findByRole("button", { name: "Exact size · audio" });
  await act(async () => resolve({ ...caps, checked: true, selected: "h264_nvenc" }));
  expect(screen.getByRole("button", { name: "Exact size · audio" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "Fast · GPU (h264_nvenc)" })).toBeDisabled();
  expect(mediaApi.start).not.toHaveBeenCalled();
});
