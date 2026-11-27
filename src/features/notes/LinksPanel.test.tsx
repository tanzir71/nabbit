import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { LinksPanel } from "./LinksPanel";
import { ClipboardLinkRow } from "./ClipboardLinkRow";
import { linksApi } from "./linksApi";
import { notesApi } from "./api";
import { captureCard } from "./captureDraft";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { StoredNote } from "./types";
import type { ClipboardEntry } from "../../lib/types";
vi.mock("./linksApi", () => ({
  linksApi: { bulk: vi.fn(), open: vi.fn(), openUrl: vi.fn(), clean: vi.fn() },
}));
vi.mock("./api", () => ({ notesApi: { state: vi.fn(), capture: vi.fn() } }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
const scope = { key: "scope-a", epoch: 1 };
function card(
  id: string,
  title: string,
  url: string,
  labels: string[] = [],
  priority: "later" | "inbox" = "later",
): StoredNote {
  return {
    ...captureCard({
      requestId: id,
      expectedScope: scope,
      draft: { kind: "bookmark", title, url, labels, priority },
      patch: {},
      reminders: [],
    }),
    editToken: `guard-${id}`,
  };
}
const entries = () => [
  card("a", "Atoll", "https://github.com/fixture/atoll", ["research"]),
  card("b", "Fraunces variable font", "https://fonts.google.com/specimen/Fraunces", [
    "design",
    "fonts",
  ]),
  card(
    "c",
    "Windows context menu docs",
    "https://learn.microsoft.com/windows",
    ["design"],
    "inbox",
  ),
  card("d", "Tiny tray app", "https://www.youtube.com/watch?v=fixture"),
];
const copied = (content = "https://example.invalid/docs?utm_source=x#part"): ClipboardEntry => ({
  id: content,
  contentType: "url",
  content,
  preview: content,
  hash: "fixture-hash",
  sourceApp: "Fixture",
  pinned: false,
  createdAt: "2026-11-27T00:00:00Z",
  lastUsedAt: "2026-11-27T00:00:00Z",
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(linksApi.bulk).mockResolvedValue(2);
  vi.mocked(linksApi.open).mockResolvedValue(2);
  vi.mocked(linksApi.openUrl).mockResolvedValue();
  vi.mocked(writeText).mockResolvedValue();
  vi.mocked(notesApi.state).mockResolvedValue({ cards: [], scope: null });
});
describe("Links collection", () => {
  it("combines domain search, folder label chips and Later while keeping bookmark addresses", async () => {
    const user = userEvent.setup();
    render(
      <LinksPanel
        cards={entries()}
        scope={scope}
        all={vi.fn()}
        importBookmarks={vi.fn()}
        refresh={vi.fn(async () => {})}
        download={vi.fn(async () => {})}
      />,
    );
    await user.type(screen.getByRole("textbox", { name: "Search links" }), "LEARN.MICROSOFT.COM");
    expect(screen.getByText("Windows context menu docs")).toBeVisible();
    expect(screen.queryByText("Atoll")).not.toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Search links" }));
    await user.click(screen.getByRole("button", { name: "#design" }));
    expect(screen.getByText("Windows context menu docs")).toBeVisible();
    expect(screen.getByText("Fraunces variable font")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByText("Windows context menu docs")).not.toBeInTheDocument();
    expect(screen.getByText("Fraunces variable font")).toBeVisible();
    expect(linksApi.bulk).not.toHaveBeenCalled();
  });
  it("uses frozen card guards for bulk labels and clears selection only after acknowledgement", async () => {
    const user = userEvent.setup(),
      refresh = vi.fn(async () => {}),
      rows = entries();
    render(
      <LinksPanel
        cards={rows}
        scope={scope}
        all={vi.fn()}
        importBookmarks={vi.fn()}
        refresh={refresh}
        download={vi.fn(async () => {})}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select Atoll" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Fraunces variable font" }));
    await user.click(screen.getByRole("button", { name: "Open all" }));
    expect(linksApi.open).toHaveBeenCalledWith([rows[0], rows[1]], scope);
    expect(refresh).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Label" }));
    await user.type(
      screen.getByRole("textbox", { name: "Labels for selected links" }),
      "#design, reading",
    );
    await user.click(screen.getByRole("button", { name: "Apply labels" }));
    await waitFor(() =>
      expect(linksApi.bulk).toHaveBeenCalledWith([rows[0], rows[1]], scope, {
        kind: "label",
        labels: ["design", "reading"],
      }),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Selected link actions")).not.toBeInTheDocument();
  });
  it("does not carry a selection into another workspace even when card IDs collide", async () => {
    const user = userEvent.setup(),
      rows = entries(),
      common = {
        all: vi.fn(),
        importBookmarks: vi.fn(),
        refresh: vi.fn(async () => {}),
        download: vi.fn(async () => {}),
      };
    const view = render(<LinksPanel cards={rows} scope={scope} {...common} />);
    await user.click(screen.getByRole("checkbox", { name: "Select Atoll" }));
    expect(screen.getByRole("button", { name: "Open all" })).toBeVisible();
    view.rerender(
      <LinksPanel
        cards={rows.map((n) => ({
          ...n,
          scope: { key: "scope-b", epoch: 2 },
          editToken: "different",
        }))}
        scope={{ key: "scope-b", epoch: 2 }}
        {...common}
      />,
    );
    expect(screen.queryByRole("button", { name: "Open all" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Atoll" })).not.toBeChecked();
    expect(linksApi.bulk).not.toHaveBeenCalled();
  });
  it("keeps stale selections recoverable after a rejected write and permits read-only open/copy", async () => {
    const user = userEvent.setup(),
      rows = entries(),
      common = {
        all: vi.fn(),
        importBookmarks: vi.fn(),
        refresh: vi.fn(async () => {}),
        download: vi.fn(async () => {}),
      };
    vi.mocked(linksApi.bulk).mockRejectedValueOnce(new Error("stale guard"));
    const view = render(<LinksPanel cards={rows} scope={scope} {...common} />);
    await user.click(screen.getByRole("checkbox", { name: "Select Atoll" }));
    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed");
    expect(screen.getByRole("checkbox", { name: "Select Atoll" })).toBeChecked();
    view.rerender(<LinksPanel cards={rows} scope={scope} readOnly {...common} />);
    expect(screen.getByRole("button", { name: "Archive" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Label" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Copy Atoll" }));
    expect(writeText).toHaveBeenCalledWith(rows[0].value.url);
    await user.click(screen.getByRole("button", { name: "Open all" }));
    expect(linksApi.open).toHaveBeenCalledWith([rows[0]], scope);
  });
  it("retains a Download action for supported video links", async () => {
    const user = userEvent.setup(),
      download = vi.fn(async () => {});
    render(
      <LinksPanel
        cards={entries()}
        scope={scope}
        all={vi.fn()}
        importBookmarks={vi.fn()}
        refresh={vi.fn(async () => {})}
        download={download}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Download Tiny tray app" }));
    expect(download).toHaveBeenCalledWith("https://www.youtube.com/watch?v=fixture");
    expect(linksApi.open).not.toHaveBeenCalled();
  });
});
describe("Copied link actions", () => {
  it("saves with an idempotent scoped packet, cleans a copy and preserves the original URL", async () => {
    const user = userEvent.setup(),
      entry = copied();
    const saved = {
      ...card("saved", "Page", "https://example.invalid/docs"),
      scope: null,
      localOnly: true,
    };
    vi.mocked(notesApi.capture)
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValue(saved);
    vi.mocked(linksApi.clean).mockResolvedValue("https://example.invalid/docs#part");
    render(<ClipboardLinkRow entry={entry} download={vi.fn(async () => {})} />);
    await user.click(screen.getByRole("button", { name: "Save link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("original link is still here");
    await user.click(screen.getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(notesApi.capture).toHaveBeenCalledTimes(2));
    expect(vi.mocked(notesApi.capture).mock.calls[0][0]).toEqual(
      vi.mocked(notesApi.capture).mock.calls[1][0],
    );
    expect(vi.mocked(notesApi.capture).mock.calls[0][0].draft.url).toBe(entry.content);
    expect(vi.mocked(notesApi.capture).mock.calls[0][0].expectedScope).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clean link" }));
    expect(writeText).toHaveBeenCalledWith("https://example.invalid/docs#part");
    expect(screen.getByText("example.invalid/docs?utm_source=x#part")).toBeVisible();
  });
  it("does not apply an old save acknowledgement to a newer clipboard item", async () => {
    let resolve!: (note: StoredNote) => void;
    vi.mocked(notesApi.capture).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const user = userEvent.setup(),
      download = vi.fn(async () => {});
    const view = render(<ClipboardLinkRow entry={copied()} download={download} />);
    await user.click(screen.getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(notesApi.capture).toHaveBeenCalledTimes(1));
    view.rerender(
      <ClipboardLinkRow entry={copied("https://new.invalid/new")} download={download} />,
    );
    resolve(card("old", "Old", "https://old.invalid"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save link" })).toBeEnabled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("new.invalid/new")).toBeVisible();
  });
});
