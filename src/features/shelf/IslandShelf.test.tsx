import { StrictMode, useEffect, useRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { IslandShelf } from "./IslandShelf";
import { shelfApi, type ShelfItem } from "./api";
import { createIslandStore } from "../../store/islandStore";
import { connectIslandKeyboard } from "../../lib/islandKeyboard";
vi.mock("./api", () => ({
  shelfApi: { list: vi.fn(), preview: vi.fn(), copy: vi.fn(), remove: vi.fn(), drag: vi.fn() },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const fixtures = (): ShelfItem[] => [
  {
    id: "image",
    path: "C:\\Fixture\\photo.png",
    name: "photo.png",
    kind: "image",
    size: 2400000,
    available: true,
  },
  {
    id: "video",
    path: "C:\\Fixture\\movie.mp4",
    name: "movie.mp4",
    kind: "video",
    size: 18100000,
    available: true,
  },
  {
    id: "missing",
    path: "C:\\Fixture\\gone.md",
    name: "gone.md",
    kind: "file",
    size: null,
    available: false,
  },
];
let data: ShelfItem[],
  callbacks: Map<string, (payload?: unknown) => void>,
  stops: Array<ReturnType<typeof vi.fn>>;
function mount(strict = false) {
  const store = createIslandStore("island", {
    tab: "files",
    filters: {},
    searchText: "",
    scroll: {},
  });
  store.setState({ state: "expanded", gate: "visible" });
  function View() {
    const model = useStore(store),
      root = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const keyboard = connectIslandKeyboard(root.current!, store, {
        toggle: vi.fn(),
        pin: vi.fn(),
      });
      return () => keyboard.dispose();
    }, []);
    return (
      <div className="island-host" ref={root}>
        <button data-island-tab="files">Files tab</button>
        <IslandShelf model={model} dispatch={model.dispatch} />
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
  data = fixtures();
  callbacks = new Map();
  stops = [];
  vi.mocked(shelfApi.list).mockImplementation(async () => structuredClone(data));
  vi.mocked(shelfApi.preview).mockResolvedValue(null);
  vi.mocked(shelfApi.drag).mockResolvedValue("Cancelled");
  vi.mocked(shelfApi.remove).mockImplementation(async (ids) => {
    data = ids === null ? [] : data.filter((item) => !ids.includes(item.id));
  });
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    const stop = vi.fn();
    stops.push(stop);
    callbacks.set(name, (payload) => handler({ event: name, id: 1, payload }));
    return stop;
  });
});
const card = (name: string) => screen.getByRole("button", { name: new RegExp(`^Select ${name}`) });
async function loaded() {
  await screen.findByRole("button", { name: /^Select photo/ });
}
describe("Shelf island", () => {
  it("shows file names, real sizes, an unavailable row and a functional Remove without reading OS clipboard", async () => {
    const user = userEvent.setup();
    mount();
    await loaded();
    expect(screen.getByText("SHELF · 3")).toBeVisible();
    expect(screen.getByText("2.4 MB")).toBeVisible();
    expect(screen.getByText("Missing file")).toBeVisible();
    expect(card("gone")).not.toHaveAttribute("draggable", "true");
    await user.click(screen.getByRole("button", { name: "Remove gone.md" }));
    await waitFor(() => expect(shelfApi.remove).toHaveBeenCalledWith(["missing"]));
    expect(screen.queryByText("gone.md")).not.toBeInTheDocument();
    expect(shelfApi.copy).not.toHaveBeenCalled();
    expect(shelfApi.preview).toHaveBeenCalledWith("image");
  });
  it("selects a subset, copies exactly its IDs, and removes only those references", async () => {
    const user = userEvent.setup();
    const { store } = mount();
    await loaded();
    await user.click(card("photo"));
    await user.click(card("movie"));
    expect(screen.getByText("2 selected")).toBeVisible();
    expect(store.getState().filters.shelfSelection).toBe('["image","video"]');
    await user.click(screen.getByRole("button", { name: "Copy paths" }));
    await waitFor(() => expect(shelfApi.copy).toHaveBeenCalledWith(["image", "video"]));
    await user.click(screen.getByRole("button", { name: /^Remove$/ }));
    await waitFor(() => expect(shelfApi.remove).toHaveBeenCalledWith(["image", "video"]));
    expect(await screen.findByText("SHELF · 1")).toBeVisible();
    expect(card("gone")).toBeVisible();
  });
  it("Ctrl+A/C/Delete route from the tab before global search and preserve IME/modifier editing", async () => {
    const user = userEvent.setup();
    const { store } = mount();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Files tab" }));
    await user.keyboard("{Control>}a{/Control}");
    expect(screen.getByText("3 selected")).toBeVisible();
    await user.keyboard("{Control>}c{/Control}");
    await waitFor(() => expect(shelfApi.copy).toHaveBeenCalledWith(["image", "video", "missing"]));
    expect(store.getState().filters.searchOpen).not.toBe("true");
    fireEvent.keyDown(screen.getByRole("button", { name: "Files tab" }), {
      key: "Delete",
      isComposing: true,
    });
    expect(shelfApi.remove).not.toHaveBeenCalled();
    await user.keyboard("{Delete}");
    await waitFor(() => expect(data).toHaveLength(0));
  });
  it("Copy paths with no selection means all; Clear never implies deleting originals", async () => {
    const user = userEvent.setup();
    mount();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Copy paths" }));
    await waitFor(() => expect(shelfApi.copy).toHaveBeenCalledWith(null));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(await screen.findByText("Shelf cleared. Original files are unchanged.")).toBeVisible();
    expect(shelfApi.remove).toHaveBeenCalledWith(null);
    expect(screen.getByRole("button", { name: "Copy paths" })).toBeDisabled();
  });
  it("dragging a selected file builds the group, while another file drags alone", async () => {
    const user = userEvent.setup();
    mount();
    await loaded();
    await user.click(card("photo"));
    await user.click(card("movie"));
    fireEvent.dragStart(card("movie"));
    await waitFor(() => expect(shelfApi.drag).toHaveBeenCalledWith(["image", "video"]));
    await screen.findByText("Drag finished. Files remain on the Shelf.");
    await user.click(screen.getByRole("button", { name: "Deselect" }));
    fireEvent.dragStart(card("movie"));
    await waitFor(() => expect(shelfApi.drag).toHaveBeenLastCalledWith(["video"]));
    expect(shelfApi.remove).not.toHaveBeenCalled();
  });
  it("failed copy or drag stays recoverable and only one action can run at a time", async () => {
    const user = userEvent.setup();
    mount();
    await loaded();
    vi.mocked(shelfApi.copy).mockRejectedValueOnce(new Error("fixture clipboard denial"));
    await user.click(screen.getByRole("button", { name: "Copy paths" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not finish");
    expect(card("photo")).toBeVisible();
    let finish!: () => void;
    vi.mocked(shelfApi.drag).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve("Cancelled");
        }),
    );
    fireEvent.dragStart(card("photo"));
    fireEvent.dragStart(card("movie"));
    expect(shelfApi.drag).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(await screen.findByText("Drag finished. Files remain on the Shelf.")).toBeVisible();
  });
  it("uses pushed changes and focus refresh, ignores stale reads, and prunes removed selection", async () => {
    let finish!: (items: ShelfItem[]) => void;
    vi.mocked(shelfApi.list).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { store } = mount();
    await waitFor(() => expect(shelfApi.list).toHaveBeenCalledTimes(1));
    data = [fixtures()[1]];
    await act(async () => callbacks.get("shelf:changed")!());
    await screen.findByRole("button", { name: /^Select movie/ });
    await act(async () => finish(fixtures()));
    expect(screen.queryByText("photo.png")).not.toBeInTheDocument();
    await userEvent.click(card("movie"));
    data = [];
    await act(async () => callbacks.get("tauri://focus")!(true));
    await waitFor(() => expect(store.getState().filters.shelfSelection).toBe(""));
  });
  it("StrictMode and late subscription cleanup leave no live tab listeners", async () => {
    const view = mount(true);
    await loaded();
    view.unmount();
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    const reads = vi.mocked(shelfApi.list).mock.calls.length;
    await act(async () => callbacks.get("shelf:changed")!());
    expect(shelfApi.list).toHaveBeenCalledTimes(reads);
  });
});
