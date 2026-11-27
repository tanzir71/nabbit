import { StrictMode, useEffect, useRef } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { IslandClipboard } from "./IslandClipboard";
import { clipboardApi, type ClipboardSnapshot } from "./api";
import { createIslandStore } from "../../store/islandStore";
import { connectIslandKeyboard } from "../../lib/islandKeyboard";
import type { ClipboardEntry } from "../../lib/types";
vi.mock("./api", () => ({
  clipboardApi: { snapshot: vi.fn(), pick: vi.fn(), pin: vi.fn(), remove: vi.fn() },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const entry = (
  id: string,
  content: string,
  contentType: ClipboardEntry["contentType"] = "text",
  pinned = false,
): ClipboardEntry => ({
  id,
  content,
  preview: content,
  contentType,
  pinned,
  sourceApp: "Fixture",
  hash: id,
  createdAt: "2026-11-27T04:00:00Z",
  lastUsedAt: "2026-11-27T04:00:00Z",
});
const makeRows = () => [
  entry("text", "Meeting moved to 4:30", "text", true),
  entry("url", "https://example.invalid/research", "url"),
  entry("image", "Screenshot 1280 × 720", "image"),
  entry("path", "C:\\Fixture\\README.md", "file"),
  entry("number", "Plan for 2027"),
];
let data: ClipboardSnapshot,
  callbacks: Map<string, () => void>,
  stops: Array<ReturnType<typeof vi.fn>>;
function mount(strict = false) {
  const store = createIslandStore("island", {
    tab: "clipboard",
    filters: {},
    searchText: "",
    scroll: {},
  });
  store.setState({ state: "expanded", gate: "visible" });
  function View() {
    const model = useStore(store);
    const host = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const keyboard = connectIslandKeyboard(host.current!, store, {
        toggle: vi.fn(),
        pin: vi.fn(),
      });
      return () => keyboard.dispose();
    }, []);
    return (
      <div className="island-host" ref={host}>
        <button type="button" data-island-tab="clipboard">
          Clipboard tab
        </button>
        <IslandClipboard model={model} dispatch={model.dispatch} />
      </div>
    );
  }
  return {
    ...render(
      strict ? (
        <StrictMode>
          <View />
        </StrictMode>
      ) : (
        <View />
      ),
    ),
    store,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  data = { entries: makeRows(), retentionDays: 30, total: 1284 };
  callbacks = new Map();
  stops = [];
  vi.mocked(clipboardApi.snapshot).mockImplementation(async () => structuredClone(data));
  vi.mocked(clipboardApi.pick).mockResolvedValue({ kind: "copied", message: "Copied" });
  vi.mocked(clipboardApi.pin).mockImplementation(async (id) => {
    const row = data.entries.find((e) => e.id === id)!;
    row.pinned = !row.pinned;
    return structuredClone(row);
  });
  vi.mocked(clipboardApi.remove).mockImplementation(async (id) => {
    data.entries = data.entries.filter((e) => e.id !== id);
  });
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    const stop = vi.fn();
    stops.push(stop);
    callbacks.set(name, () => handler({ event: name, id: 1, payload: null }));
    return stop;
  });
  vi.mocked(invoke).mockResolvedValue(undefined);
});
const grid = () => screen.getByRole("grid", { name: "Clipboard history" });
const rows = () =>
  within(grid())
    .queryAllByRole("row")
    .filter((row) => row.hasAttribute("data-clipboard-id"));
async function loaded() {
  await waitFor(() => expect(rows()).toHaveLength(5));
}
describe("Clipboard island", () => {
  it("reuses fuzzy search and all six type/pin filters without requesting OS clipboard access", async () => {
    const user = userEvent.setup();
    mount();
    await loaded();
    expect(screen.getByText("Kept 30 days · 1,284 items (5 shown)")).toBeVisible();
    for (const [name, id] of [
      ["Text", "text"],
      ["Links", "url"],
      ["Images", "image"],
      ["Files", "path"],
      ["Pinned", "text"],
    ]) {
      await user.click(screen.getByRole("button", { name }));
      expect(rows()[0]).toHaveAttribute("data-clipboard-id", id);
      expect(rows()).toHaveLength(name === "Text" ? 2 : 1);
    }
    await user.click(screen.getByRole("button", { name: "All" }));
    await user.type(screen.getByRole("combobox", { name: "Search clipboard" }), "meetng");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveAttribute("data-clipboard-id", "text");
    expect(clipboardApi.pick).not.toHaveBeenCalled();
  });
  it("routes bare number pick before global search, then Enter pastes the selected item", async () => {
    const user = userEvent.setup();
    const view = mount();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Clipboard tab" }));
    await user.keyboard("2");
    await waitFor(() => expect(clipboardApi.pick).toHaveBeenCalledWith("url", "copy"));
    expect(view.store.getState().filters.searchOpen).not.toBe("true");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Copy example\.invalid\/research / }),
      ).toBeEnabled(),
    );
    vi.mocked(clipboardApi.pick).mockResolvedValueOnce({
      kind: "pasteSent",
      message: "Paste sent",
    });
    await user.keyboard("{Enter}");
    await waitFor(() => expect(clipboardApi.pick).toHaveBeenLastCalledWith("url", "paste"));
    expect(view.store.getState().state).not.toBe("expanded");
  });
  it("Ctrl+F focuses search; numeric queries and IME/modifiers never pick an item", async () => {
    const user = userEvent.setup();
    mount();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Clipboard tab" }));
    await user.keyboard("{Control>}f{/Control}");
    const search = screen.getByRole("combobox", { name: "Search clipboard" });
    expect(search).toHaveFocus();
    await user.type(search, "2027");
    expect(rows()).toHaveLength(1);
    expect(clipboardApi.pick).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "Enter", isComposing: true, keyCode: 229 });
    fireEvent.keyDown(search, { key: "1", altKey: true });
    expect(clipboardApi.pick).not.toHaveBeenCalled();
    await user.keyboard("{Delete}");
    expect(clipboardApi.remove).not.toHaveBeenCalled();
  });
  it("arrows select within filtered results; Ctrl+C copies, Del removes and pinning updates Pinned", async () => {
    const user = userEvent.setup();
    mount();
    await loaded();
    const search = screen.getByRole("combobox", { name: "Search clipboard" });
    await user.click(search);
    await user.keyboard("{ArrowDown}{Control>}c{/Control}");
    await waitFor(() => expect(clipboardApi.pick).toHaveBeenCalledWith("url", "copy"));
    await waitFor(() => expect(screen.queryByText("Copied")).toBeVisible());
    await user.keyboard("{Delete}");
    await waitFor(() => expect(clipboardApi.remove).toHaveBeenCalledWith("url"));
    await waitFor(() => expect(rows()).toHaveLength(4));
    await user.click(screen.getByRole("button", { name: "Unpin Meeting moved to 4:30" }));
    await waitFor(() => expect(clipboardApi.pin).toHaveBeenCalledWith("text"));
    await user.click(screen.getByRole("button", { name: "Pinned" }));
    expect(rows()).toHaveLength(0);
    expect(screen.getByText("No clipboard items match these filters.")).toBeVisible();
  });
  it("Nab only stages URL review and switches tab; it never copies, pastes or downloads", async () => {
    const user = userEvent.setup();
    const view = mount();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Nab example.invalid/research" }));
    expect(invoke).toHaveBeenCalledExactlyOnceWith("island_review_url", {
      url: "https://example.invalid/research",
    });
    expect(view.store.getState().tab).toBe("nab");
    expect(clipboardApi.pick).not.toHaveBeenCalled();
  });
  it("keeps source and selection after failure, and avoids duplicate or repeated paste requests", async () => {
    const user = userEvent.setup();
    mount();
    await loaded();
    vi.mocked(clipboardApi.pick).mockRejectedValueOnce(new Error("Fixture failure"));
    const first = screen.getByRole("button", { name: /^Copy Meeting moved to 4:30 / });
    await user.click(first);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not finish");
    expect(rows()[0]).toHaveAttribute("aria-selected", "true");
    expect(rows()).toHaveLength(5);
    let finish!: (r: { kind: "copied"; message: string }) => void;
    vi.mocked(clipboardApi.pick).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await user.click(first);
    fireEvent.keyDown(first, { key: "Enter" });
    fireEvent.keyDown(first, { key: "Enter", repeat: true });
    expect(clipboardApi.pick).toHaveBeenCalledTimes(2);
    await act(async () => finish({ kind: "copied", message: "Copied. Use Ctrl+V." }));
    expect(screen.getByRole("status")).toHaveTextContent("Use Ctrl+V");
  });
  it("pushed changes refresh without polling; late reads and subscriptions cannot overwrite or outlive the tab", async () => {
    let finish!: (s: ClipboardSnapshot) => void;
    vi.mocked(clipboardApi.snapshot).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = mount();
    await waitFor(() => expect(clipboardApi.snapshot).toHaveBeenCalledTimes(1));
    data.entries = [entry("new", "Newest item")];
    await act(async () => callbacks.get("clipboard:changed")!());
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveAttribute("data-clipboard-id", "new");
    await act(async () => finish({ entries: makeRows(), retentionDays: 30, total: 5 }));
    expect(rows()).toHaveLength(1);
    view.unmount();
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    await act(async () => callbacks.get("clipboard:new")!());
    expect(clipboardApi.snapshot).toHaveBeenCalledTimes(2);
  });
  it("StrictMode cleans up each event listener and preserves native image payload limitations", async () => {
    const view = mount(true);
    await loaded();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Images" }));
    expect(screen.getByRole("button", { name: /^Copy Screenshot 1280 × 720 / })).toBeDisabled();
    fireEvent.keyDown(grid(), { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Image copying is not available");
    expect(clipboardApi.pick).not.toHaveBeenCalled();
    view.unmount();
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
  });
});
