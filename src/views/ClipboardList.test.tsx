import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipboardEntry } from "../lib/types";
import { useAppStore } from "../store/useAppStore";
import { ClipboardList } from "./ClipboardList";

const makeEntry = (id: string, content: string, lastUsedAt = "2026-07-09T12:00:00Z"): ClipboardEntry => ({
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

  beforeEach(() => {
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
    });
  });

  it("filters instantly, copies by click, and supports keyboard copy/delete/focus shortcuts", async () => {
    const user = userEvent.setup();
    render(<ClipboardList />);

    const search = screen.getByPlaceholderText("Search clipboard");
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
    expect(copyEntry).toHaveBeenLastCalledWith("gamma");

    await user.keyboard("{Delete}");
    expect(deleteEntry).toHaveBeenLastCalledWith("beta");

    search.blur();
    await user.keyboard("{Control>}f{/Control}");
    expect(search).toHaveFocus();
  });

  it("hands video URL rows to the download tab without copying the row", async () => {
    const user = userEvent.setup();
    render(<ClipboardList />);

    await user.click(screen.getByLabelText("Stage as download"));

    expect(stageUrl).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abc123");
    expect(setLastTab).toHaveBeenCalledWith("download");
    expect(copyEntry).not.toHaveBeenCalledWith("gamma");
  });
});
