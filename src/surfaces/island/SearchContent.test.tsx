import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import SearchContent from "./SearchContent";
import type { StoredNote } from "../../features/notes/types";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const scope = { key: "fixture-scope", epoch: 2 };
const note = (id: string, bookmark = false): StoredNote => ({
  localOnly: false,
  scope,
  value: {
    id,
    revision: 1,
    assigneeId: null,
    priority: "now",
    ref: `tck-${id}`,
    doneWhen: "",
    frontmatter: "",
    kind: bookmark ? "bookmark" : "note",
    title: bookmark ? "Saved PDF link" : "PDF invoice",
    body: "",
    url: bookmark ? "https://example.test/pdf" : "",
    labels: ["admin"],
    items: [],
    attachmentIds: [],
    pinned: false,
    archived: false,
    trashedAt: null,
    completed: false,
    color: "default",
    rank: "a",
    projectId: null,
    createdAt: "",
    updatedAt: "",
    sourceId: null,
  },
});
const tool = {
  id: "to-jpg",
  name: "To JPG",
  category: "images",
  icon: "iconImage",
  keywords: ["image", "photo"],
  accepts: { filetypes: ["png"], text: false, link: false, image: true },
  presets: ["jpg"],
  form: [],
};
let cards: StoredNote[], events: Map<string, () => void>;
const collapse = vi.fn(),
  fail = vi.fn(),
  openShelf = vi.fn();
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  cards = [note("41"), note("42", true)];
  events = new Map();
  vi.mocked(listen).mockImplementation(async (name, callback) => {
    events.set(name, () => callback({ event: name, id: 0, payload: null }));
    return vi.fn();
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    switch (command) {
      case "get_notes_state":
        return { cards: structuredClone(cards), scope };
      case "tool_catalog":
        return [tool];
      case "list_island_pins":
        return [
          { id: "pin", kind: "folder", path: "C:\\Fixtures\\PDFs", label: "PDF folder", slot: 1 },
        ];
      case "shelf_list":
        return [
          {
            id: "shelf",
            name: "contract.pdf",
            path: "C:\\Fixtures\\contract.pdf",
            available: true,
          },
        ];
      case "list_clipboard_entries":
        return [
          {
            id: "clip",
            preview: "PDF clipboard",
            content: "PDF clipboard",
            contentType: "text",
            sourceApp: "Fixture",
          },
        ];
      case "tool_presets":
        return [{ id: "jpg", name: "To JPG", maxMb: null, quality: 85 }];
      default:
        return null;
    }
  });
});
function View({ initial = "pdf" }: { initial?: string }) {
  const [query, setQuery] = useState(initial);
  return (
    <SearchContent
      query={query}
      setQuery={setQuery}
      collapse={collapse}
      fail={fail}
      openShelf={openShelf}
    />
  );
}
it("searches current notes, saved links, pins, Shelf and clipboard with guarded actions", async () => {
  render(<View />);
  expect(await screen.findByRole("option", { name: /PDF invoice/ })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /Saved PDF link/ })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /PDF folder/ })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /contract.pdf/ })).toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole("option", { name: /Saved PDF link/ })));
  expect(invoke).toHaveBeenCalledWith("notes_open", {
    intent: { kind: "card", id: "42", expectedScope: scope },
  });
  expect(collapse).toHaveBeenCalledOnce();
  expect(fail).not.toHaveBeenCalled();
});
it("opens a tool's review form without starting a job", async () => {
  render(<View initial="photo" />);
  fireEvent.click(await screen.findByRole("option", { name: /To JPG/ }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("tool_open_media_sheet", {
      intent: expect.objectContaining({ toolId: "to-jpg", input: "", inputs: [] }),
    }),
  );
  expect(invoke).not.toHaveBeenCalledWith("tool_start", expect.anything());
  expect(collapse).not.toHaveBeenCalled();
});
it("keeps file results inside Files and respects IME before Enter", async () => {
  render(<View />);
  const file = await screen.findByRole("option", { name: /contract.pdf/ });
  fireEvent.pointerMove(file);
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", isComposing: true });
  expect(openShelf).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  await waitFor(() => expect(openShelf).toHaveBeenCalledWith("shelf"));
  expect(collapse).not.toHaveBeenCalled();
});
it("invalidates results when the accessible note scope changes", async () => {
  render(<View />);
  await screen.findByRole("option", { name: /PDF invoice/ });
  cards = [];
  await act(async () => events.get("notes:updated")?.());
  await waitFor(() =>
    expect(screen.queryByRole("option", { name: /PDF invoice/ })).not.toBeInTheDocument(),
  );
  expect(screen.queryByRole("option", { name: /Saved PDF link/ })).not.toBeInTheDocument();
});
it("does not surface archived or trashed notes", async () => {
  cards[0].value.archived = true;
  cards[1].value.trashedAt = "2026-11-28";
  render(<View />);
  await screen.findByRole("option", { name: /PDF folder/ });
  expect(screen.queryByRole("option", { name: /PDF invoice/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Saved PDF link/ })).not.toBeInTheDocument();
});
it("installs change subscriptions before loading scoped metadata and fails closed if they fail", async () => {
  vi.mocked(listen).mockRejectedValueOnce(new Error("Events unavailable"));
  render(<View />);
  await waitFor(() => expect(fail).toHaveBeenCalled());
  expect(invoke).not.toHaveBeenCalledWith("get_notes_state");
  expect(screen.queryByRole("option", { name: /Saved PDF link/ })).not.toBeInTheDocument();
});
it("keeps a failed activation open with its error", async () => {
  render(<View />);
  await screen.findByRole("option", { name: /PDF folder/ });
  vi.mocked(invoke).mockRejectedValueOnce(new Error("File unavailable"));
  fireEvent.click(screen.getByRole("option", { name: /PDF folder/ }));
  await waitFor(() => expect(fail).toHaveBeenCalled());
  expect(collapse).not.toHaveBeenCalled();
});
