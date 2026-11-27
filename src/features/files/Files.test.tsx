import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { filesApi, type Operation, type Pin } from "./api";
import { MoveTo } from "./MoveTo";
import { Pins, PinPreview } from "./Pins";
import { routeDrop } from "../../lib/islandDrop";
import DownloadDonePeek from "./DownloadDonePeek";
import { toolsApi } from "../tools/api";
vi.mock("../tools/api", async (original) => {
  const api = await original<typeof import("../tools/api")>();
  return { ...api, toolsApi: { ...api.toolsApi, catalog: vi.fn() } };
});
vi.mock("./api", async (original) => ({
  ...(await original<object>()),
  filesApi: {
    pins: vi.fn(),
    suggestions: vi.fn(),
    plan: vi.fn(),
    execute: vi.fn(),
    undo: vi.fn(),
    history: vi.fn(),
    peek: vi.fn(),
    recent: vi.fn(),
    closePeek: vi.fn(),
    action: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    capabilities: vi.fn(),
    choose: vi.fn(),
    downloadInfo: vi.fn(),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const pin: Pin = {
  id: "folder",
  kind: "folder",
  path: "D:\\Owned\\Invoices",
  label: "Invoices",
  slot: 1,
  alwaysMove: false,
  available: true,
  network: false,
  cloud: false,
};
const operation: Operation = {
  id: "move",
  destination: { path: pin.path },
  entries: [
    {
      source: { path: "D:\\Owned\\file.pdf" },
      verb: "move",
      output: null,
      fingerprint: null,
      undone: false,
    },
  ],
  reasons: [],
  bytes: 1200,
  status: "prepared",
  error: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(filesApi.pins).mockResolvedValue([pin]);
  vi.mocked(filesApi.suggestions).mockResolvedValue([]);
  vi.mocked(filesApi.capabilities).mockResolvedValue({ folders: [], terminal: false, code: false });
  vi.mocked(filesApi.plan).mockImplementation(async () => structuredClone(operation));
  vi.mocked(filesApi.execute).mockImplementation(async () => ({
    ...operation,
    status: "completed",
    entries: [
      { ...operation.entries[0], output: "D:\\Owned\\Invoices\\file.pdf", fingerprint: {} },
    ],
  }));
  vi.mocked(listen).mockResolvedValue(vi.fn());
  vi.mocked(filesApi.recent).mockResolvedValue([]);
  vi.mocked(filesApi.remove).mockResolvedValue(undefined);
  vi.mocked(filesApi.closePeek).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("only plans and executes after an explicit destination choice", async () => {
  render(<MoveTo paths={["D:\\Owned\\file.pdf"]} close={vi.fn()} />);
  const destination = await screen.findByRole("button", { name: "Invoices" });
  expect(filesApi.plan).not.toHaveBeenCalled();
  expect(filesApi.execute).not.toHaveBeenCalled();
  fireEvent.click(destination);
  await waitFor(() => expect(filesApi.execute).toHaveBeenCalledWith("move", false));
  expect(await screen.findByRole("status")).toHaveTextContent("1 files filed");
});
it("requires confirmation for a prepared network/cloud/large operation", async () => {
  vi.mocked(filesApi.plan).mockResolvedValue({
    ...operation,
    reasons: ["The destination is on a network."],
  });
  render(<MoveTo paths={["D:\\Owned\\file.pdf"]} close={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Invoices" }));
  const confirm = await screen.findByRole("button", { name: "Confirm move" });
  expect(filesApi.execute).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  await waitFor(() => expect(filesApi.execute).toHaveBeenCalledWith("move", true));
});
it("a pin drop dispatches exactly once under StrictMode and retains Ctrl/Shift", async () => {
  render(
    <StrictMode>
      <MoveTo
        paths={["D:\\Owned\\file.pdf"]}
        initialPin="folder"
        modifiers={{ shift: true, ctrl: true }}
        close={vi.fn()}
      />
    </StrictMode>,
  );
  await waitFor(() => expect(filesApi.execute).toHaveBeenCalledTimes(1));
  expect(filesApi.plan).toHaveBeenCalledTimes(1);
  expect(filesApi.plan).toHaveBeenCalledWith(
    ["D:\\Owned\\file.pdf"],
    null,
    "folder",
    { shift: true, ctrl: true },
    null,
  );
});
it("a destination plan that arrives after close cannot execute", async () => {
  let resolve!: (op: Operation) => void;
  vi.mocked(filesApi.plan).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(<MoveTo paths={["D:\\Owned\\file.pdf"]} close={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Invoices" }));
  view.unmount();
  await act(async () => resolve(operation));
  expect(filesApi.execute).not.toHaveBeenCalled();
});
it("shows eight pins initially and searches later file/folder pins", async () => {
  vi.mocked(filesApi.pins).mockResolvedValue(
    Array.from({ length: 11 }, (_, index) => ({
      ...pin,
      id: `pin-${index}`,
      label: `Folder ${index}`,
      slot: index < 9 ? index + 1 : null,
    })),
  );
  render(<Pins />);
  await screen.findByRole("button", { name: /^Folder 0 / });
  expect(screen.queryByRole("button", { name: /^Folder 10 / })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a pin" }), {
    target: { value: "Folder 10" },
  });
  expect(screen.getByRole("button", { name: /^Folder 10 / })).toBeInTheDocument();
  expect(filesApi.peek).not.toHaveBeenCalled();
});
it("removing a pin invokes only the pin mutation", async () => {
  render(<Pins />);
  fireEvent.click(await screen.findByRole("button", { name: "Actions for Invoices" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove pin" }));
  await waitFor(() => expect(filesApi.remove).toHaveBeenCalledWith("folder"));
  expect(filesApi.execute).not.toHaveBeenCalled();
  expect(filesApi.action).not.toHaveBeenCalled();
});
it("closes a late folder watch when its preview has already unmounted", async () => {
  let resolve!: (value: { token: string; path: string; items: []; watching: boolean }) => void;
  vi.mocked(filesApi.peek).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(<PinPreview pin={pin} close={vi.fn()} hold={vi.fn()} />);
  await waitFor(() => expect(filesApi.peek).toHaveBeenCalledWith("folder"));
  view.unmount();
  await act(async () =>
    resolve({ token: "late-owned-watch", path: pin.path, items: [], watching: true }),
  );
  expect(filesApi.closePeek).toHaveBeenCalledWith("late-owned-watch");
});
it("accepts files on pin/move/tool destinations while rejecting text there", () => {
  for (const zone of ["pin:folder", "move", "tool:to-jpg"] as const) {
    expect(routeDrop({ files: ["D:\\Owned\\image.png"] }, zone).message).toBe("Ready for review");
    expect(routeDrop({ text: "private text" }, zone).message).toBe("Can't use this here");
  }
});
it("download actions hand the current stored path to expanded review without executing", async () => {
  const review = vi.fn();
  vi.mocked(toolsApi.catalog).mockResolvedValue([]);
  vi.mocked(filesApi.downloadInfo).mockResolvedValue({
    path: "D:\\Owned\\Lecture.mkv",
    bytes: 1234,
    site: "example.invalid",
  });
  vi.mocked(filesApi.suggestions).mockResolvedValue(["D:\\Owned\\Courses"]);
  render(<DownloadDonePeek path="D:\\Old\\Lecture.mkv" jobId="download" review={review} />);
  fireEvent.click(await screen.findByRole("button", { name: "Move to Courses" }));
  expect(review).toHaveBeenCalledWith({
    path: "D:\\Owned\\Lecture.mkv",
    destination: "D:\\Owned\\Courses",
    site: "example.invalid",
  });
  fireEvent.click(screen.getByRole("button", { name: "Move to…" }));
  expect(review).toHaveBeenLastCalledWith({
    path: "D:\\Owned\\Lecture.mkv",
    site: "example.invalid",
  });
  expect(filesApi.plan).not.toHaveBeenCalled();
  expect(filesApi.execute).not.toHaveBeenCalled();
});
it("an explicit suggested destination executes once under StrictMode", async () => {
  render(
    <StrictMode>
      <MoveTo
        paths={["D:\\Owned\\file.pdf"]}
        initialDestination={pin.path}
        site="example.invalid"
        close={vi.fn()}
      />
    </StrictMode>,
  );
  await waitFor(() => expect(filesApi.execute).toHaveBeenCalledTimes(1));
  expect(filesApi.plan).toHaveBeenCalledWith(
    ["D:\\Owned\\file.pdf"],
    pin.path,
    null,
    { shift: false, ctrl: false },
    "example.invalid",
  );
});
