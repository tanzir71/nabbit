import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClipboardContext } from "./ClipboardContext";
import { contextApi, type ClipboardContextSnapshot } from "./contextApi";
import { TextToolsMenu } from "./TextToolsMenu";
import type { ClipboardEntry } from "../../lib/types";
vi.mock("./contextApi", () => ({
  contextApi: {
    snapshot: vi.fn(),
    transform: vi.fn(),
    review: vi.fn(),
    action: vi.fn(),
    dismiss: vi.fn(),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const entry: ClipboardEntry = {
  id: "original",
  content: "Original বাংলা",
  contentType: "text",
  preview: "Original বাংলা",
  hash: "fixture",
  sourceApp: "Fixture",
  pinned: false,
  createdAt: "2026-11-28T00:00:00Z",
  lastUsedAt: "2026-11-28T00:00:00Z",
};
const tools: ClipboardContextSnapshot["textTools"] = [
  { id: "upper", name: "UPPERCASE", group: "case" },
  { id: "lower", name: "lowercase", group: "case" },
  { id: "title", name: "Title Case", group: "case" },
  { id: "sentence", name: "Sentence case", group: "case" },
  { id: "kebab", name: "kebab-case", group: "case" },
  { id: "snake", name: "snake_case", group: "case" },
  { id: "trim", name: "Trim lines", group: "lines" },
  { id: "base64-encode", name: "Encode Base64", group: "encoding" },
];
let snapshot: ClipboardContextSnapshot;
beforeEach(() => {
  vi.resetAllMocks();
  snapshot = { entry, kind: "text", selection: false, tools: [], textTools: tools };
  vi.mocked(contextApi.snapshot).mockImplementation(async () => structuredClone(snapshot));
  vi.mocked(contextApi.transform).mockResolvedValue({
    ...entry,
    id: "result",
    content: "ORIGINAL বাংলা",
  });
});
describe("clipboard context", () => {
  it("does not act until clicked, offers keyboard case navigation and retries the same frozen request", async () => {
    const user = userEvent.setup();
    vi.mocked(contextApi.transform).mockRejectedValueOnce(new Error("clipboard busy"));
    render(<ClipboardContext entry={entry} download={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Text tools" }));
    expect(contextApi.transform).not.toHaveBeenCalled();
    const change = screen.getByRole("menuitem", { name: "Change case" });
    change.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("menu", { name: "Change case submenu" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "UPPERCASE" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("clipboard busy");
    await user.click(screen.getByRole("menuitem", { name: "UPPERCASE" }));
    await waitFor(() => expect(contextApi.transform).toHaveBeenCalledTimes(2));
    expect(vi.mocked(contextApi.transform).mock.calls[0]).toEqual(
      vi.mocked(contextApi.transform).mock.calls[1],
    );
    expect(vi.mocked(contextApi.transform).mock.calls[0].slice(0, 2)).toEqual([entry.id, "upper"]);
    expect(entry.content).toBe("Original বাংলা");
  });
  it("uses the registry image tools and requests review before a job can run", async () => {
    snapshot = {
      ...snapshot,
      entry: { ...entry, contentType: "image" },
      kind: "image",
      tools: [
        {
          id: "image-text",
          name: "Text from image",
          category: "documents",
          icon: "iconFile",
          keywords: [],
          presets: ["text"],
          form: [],
          accepts: { filetypes: ["png"], image: true, text: false, link: false },
        },
      ],
    };
    const user = userEvent.setup();
    render(<ClipboardContext entry={snapshot.entry} download={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Save as file" })).toBeVisible();
    expect(contextApi.review).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Text" }));
    expect(contextApi.review).toHaveBeenCalledExactlyOnceWith(entry.id, "image-text");
    expect(contextApi.transform).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save as file" }));
    expect(contextApi.action).toHaveBeenCalledWith(entry.id, "save-image");
  });
  it("opens selected text tools with the selection intact, and can dismiss without copying", async () => {
    snapshot = { ...snapshot, selection: true };
    const user = userEvent.setup();
    render(<ClipboardContext download={vi.fn()} />);
    expect(await screen.findByRole("menu", { name: "Text tools" })).toBeVisible();
    expect(screen.getByText(/Selected text · Original বাংলা/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(contextApi.dismiss).toHaveBeenCalledOnce();
    expect(contextApi.transform).not.toHaveBeenCalled();
  });
  it("offers Save link first for a selected video URL without starting a download", async () => {
    snapshot = {
      ...snapshot,
      selection: true,
      kind: "video",
      entry: { ...entry, content: "https://youtu.be/fixture", contentType: "url" },
    };
    const download = vi.fn();
    render(<ClipboardContext download={download} />);
    const row = await screen.findByRole("region", { name: "Copied link actions" });
    expect(within(row).getAllByRole("button")[0]).toHaveTextContent("Save link");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(download).not.toHaveBeenCalled();
    expect(contextApi.transform).not.toHaveBeenCalled();
  });
  it("restores the trigger after Escape and closes on an outside pointer", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Outside</button>
        <ClipboardContext entry={entry} download={vi.fn()} />
      </>,
    );
    const trigger = await screen.findByRole("button", { name: "Text tools" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    const restored = screen.getByRole("button", { name: "Text tools" });
    expect(restored).toHaveFocus();
    await user.click(restored);
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
    expect(contextApi.transform).not.toHaveBeenCalled();
  });
  it("privacy suppression does not fall back to the old copied link and full-screen makes no context read", async () => {
    vi.mocked(contextApi.snapshot).mockResolvedValue(null);
    const view = render(
      <ClipboardContext
        entry={{ ...entry, content: "https://example.invalid/", contentType: "url" }}
        download={vi.fn()}
      />,
    );
    await waitFor(() => expect(contextApi.snapshot).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Save link" })).not.toBeInTheDocument();
    vi.mocked(contextApi.snapshot).mockClear();
    view.rerender(<ClipboardContext entry={entry} download={vi.fn()} silent />);
    expect(contextApi.snapshot).not.toHaveBeenCalled();
    expect(contextApi.transform).not.toHaveBeenCalled();
  });
  it("ignores an older snapshot after the requested clipboard item changes", async () => {
    let resolve!: (s: ClipboardContextSnapshot) => void;
    vi.mocked(contextApi.snapshot).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const view = render(<ClipboardContext entry={entry} download={vi.fn()} />);
    snapshot = { ...snapshot, kind: "json", entry: { ...entry, id: "new", content: "{}" } };
    view.rerender(<ClipboardContext entry={snapshot.entry} download={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Format JSON" })).toBeVisible();
    resolve({ ...snapshot, kind: "image" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save as file" })).not.toBeInTheDocument(),
    );
  });
});
it("keeps the approved menu order, disabled future snippet action and submenu keyboard return", async () => {
  const user = userEvent.setup(),
    run = vi.fn(),
    close = vi.fn();
  render(
    <TextToolsMenu
      tools={tools}
      busy={false}
      run={run}
      paste={vi.fn()}
      qr={vi.fn()}
      save={vi.fn()}
      close={close}
    />,
  );
  const menu = screen.getByRole("menu", { name: "Text tools" });
  expect(within(menu).getAllByRole("menuitem")).toHaveLength(10);
  expect(screen.getByRole("menuitem", { name: "Pin as snippet (v2.1)" })).toBeDisabled();
  await user.click(screen.getByRole("menuitem", { name: "Change case" }));
  expect(screen.getByRole("menuitem", { name: "UPPERCASE" })).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "lowercase" })).toHaveFocus();
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByRole("menu", { name: "Text tools" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "Change case" })).toHaveFocus();
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  expect(run).not.toHaveBeenCalled();
});
