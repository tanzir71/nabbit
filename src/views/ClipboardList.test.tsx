import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipboardEntry } from "../lib/types";
import { useAppStore } from "../store/useAppStore";
import { ClipboardList } from "./ClipboardList";
import { api } from "../lib/ipc";
const copyButton = (title: string) =>
  screen.getByRole("button", { name: (name) => name.startsWith(`Copy ${title} `) });

const makeEntry = (
  id: string,
  content: string,
  lastUsedAt = "2026-07-09T12:00:00Z",
): ClipboardEntry => ({
  id,
  content,
  contentType: content.startsWith("http") ? "url" : "text",
  preview: content,
  hash: id,
  sourceApp: "Test",
  pinned: false,
  createdAt: "2026-07-09T12:00:00Z",
  lastUsedAt,
});

describe("ClipboardList acceptance behavior", () => {
  const copyEntry = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const togglePin = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const deleteEntry = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const stageUrl = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const setLastTab = vi.fn<() => Promise<void>>(() => Promise.resolve());

  beforeEach(async () => {
    vi.clearAllMocks();
    useAppStore.setState({
      clipboardEntries: [
        makeEntry("alpha", "quarterly planning notes"),
        makeEntry("beta", "youtube research link"),
        makeEntry("gamma", "https://www.youtube.com/watch?v=abc123"),
      ],
      copyEntry,
      togglePin,
      deleteEntry,
      stageUrl,
      setLastTab,
      settings: { ...(await api.getSettings()), pauseClipboardCapture: false },
    });
  });

  it("filters instantly, copies by click, and supports keyboard copy/delete/focus shortcuts", async () => {
    const user = userEvent.setup();
    render(<ClipboardList />);

    const search = screen.getByRole("textbox", { name: "Search clipboard" });
    await waitFor(() => expect(search).toHaveFocus());

    await user.type(search, "plan");
    expect(screen.getByText("quarterly planning notes")).toBeInTheDocument();
    expect(screen.queryByText("youtube research link")).not.toBeInTheDocument();

    await user.click(screen.getByText("quarterly planning notes"));
    expect(copyEntry).toHaveBeenLastCalledWith("alpha");

    await user.clear(search);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(copyEntry).toHaveBeenLastCalledWith("beta");

    await user.keyboard("3");
    expect(copyEntry).toHaveBeenLastCalledWith("beta");
    expect(search).toHaveValue("3");
    await user.clear(search);
    await user.click(copyButton("quarterly planning notes"));
    await user.keyboard("3");
    expect(copyEntry).toHaveBeenLastCalledWith("gamma");

    await user.keyboard("{Delete}");
    expect(deleteEntry).toHaveBeenLastCalledWith("alpha");

    search.blur();
    await user.keyboard("{Control>}f{/Control}");
    expect(search).toHaveFocus();
  });

  it("hands video URL rows to the download tab without copying the row", async () => {
    const user = userEvent.setup();
    render(<ClipboardList />);

    await user.click(screen.getByLabelText("Nab: Stage as download"));

    expect(stageUrl).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abc123");
    expect(setLastTab).toHaveBeenCalledWith("download");
    expect(copyEntry).not.toHaveBeenCalledWith("gamma");
  });
  it("filters every payload type and pinned items without mutating history", async () => {
    const user = userEvent.setup();
    const original = [
      { ...makeEntry("text", "Owned text"), pinned: true },
      makeEntry("link", "https://example.test/video"),
      { ...makeEntry("image", "Owned image"), contentType: "image" as const },
      { ...makeEntry("file", "D:\\Owned\\note.md"), contentType: "file" as const },
    ];
    useAppStore.setState({ clipboardEntries: original });
    render(<ClipboardList />);
    for (const [filter, title] of [
      ["Text", "Owned text"],
      ["Links", "example.test/video"],
      ["Images", "Owned image"],
      ["Files", "D:\\Owned\\note.md"],
      ["Pinned", "Owned text"],
    ]) {
      await user.click(screen.getByRole("button", { name: filter }));
      expect(copyButton(title)).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /^Copy / })).toHaveLength(1);
    }
    expect(useAppStore.getState().clipboardEntries).toEqual(original);
    expect(copyEntry).not.toHaveBeenCalled();
    expect(deleteEntry).not.toHaveBeenCalled();
  });
  it("preserves keyboard focus and blocks duplicate capture-pause saves", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const patch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    useAppStore.setState({ patchSettings: patch });
    render(<ClipboardList />);
    const button = screen.getByRole("button", { name: "Pause" });
    await user.click(button);
    await user.keyboard("{Enter}{Enter}");
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({ pauseClipboardCapture: true });
    expect(button).toHaveFocus();
    finish();
    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "false"));
  });
  it("shows a failed copy and lets the user retry", async () => {
    const user = userEvent.setup();
    copyEntry.mockRejectedValueOnce(new Error("Owned clipboard busy"));
    render(<ClipboardList />);
    const button = copyButton("quarterly planning notes");
    await user.click(button);
    expect(await screen.findByText("Error: Owned clipboard busy")).toHaveAttribute("role", "alert");
    await user.click(button);
    await waitFor(() =>
      expect(screen.queryByText("Error: Owned clipboard busy")).not.toBeInTheDocument(),
    );
    expect(copyEntry).toHaveBeenCalledTimes(2);
  });
});
