import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import goldens from "../../../progress/v2/M9/v46-parser-goldens.json";
import { parseCapture } from "./parseCapture";
import { blankCapture, captureCard, prepareCapture, restoreCapture } from "./captureDraft";
import { QuickCapture } from "./QuickCapture";
import { NoteEditor } from "./NoteEditor";
import { notesApi } from "./api";
import { useNotesStore } from "../../store/notesStore";
vi.mock("./api", () => ({ notesApi: { capture: vi.fn(), state: vi.fn(), editor: vi.fn() } }));
vi.mock("./TackSettings", () => ({ TackSettings: () => <span>Local only</span> }));
beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  useNotesStore.setState({ scope: null, readOnly: false, cards: [], loading: false });
  vi.mocked(notesApi.state).mockResolvedValue({ cards: [], scope: null });
});
describe("Tack capture parity", () => {
  it.each(goldens.cases)("$zone $clock $input", ({ input, clock, zone, expected }) => {
    expect(JSON.parse(JSON.stringify(parseCapture(input, new Date(clock), zone)))).toEqual(
      expected,
    );
  });
  it("retains unresolved references, maps repositories to links and keeps reminder identity", () => {
    const d = {
      ...blankCapture(null),
      text: "@alice +nabbit Ship tomorrow 9am #build !now",
      clock: "2026-11-27T04:00:00Z",
      zone: "Asia/Dhaka",
    };
    const request = prepareCapture(d);
    expect(request.draft).toMatchObject({
      title: "Ship @alice +nabbit",
      labels: ["build"],
      kind: "task",
      priority: "now",
    });
    expect(request.reminders[0].value).toMatchObject({
      entityId: d.id,
      anchorDay: 28,
      at: "2026-11-28T03:00:00.000Z",
    });
    expect(prepareCapture({ ...d, text: "https://github.com/a/b" }).draft.kind).toBe("bookmark");
    expect(restoreCapture(JSON.stringify(d), { key: "other", epoch: 2 })).toEqual(d);
    expect(restoreCapture("old broken draft", null).text).toBe("");
  });
});
const props = () => ({
  scope: null,
  readOnly: false,
  cards: [],
  persist: vi.fn(),
  open: vi.fn(),
  saved: vi.fn(),
});
describe("Explicit quick capture", () => {
  it("a late reply after collapse cannot overwrite a newer persisted capture", async () => {
    const p = props();
    let finish!: () => void;
    vi.mocked(notesApi.capture).mockImplementation(
      (request) =>
        new Promise((resolve) => {
          finish = () => resolve(captureCard(request));
        }),
    );
    const view = render(<QuickCapture {...p} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "First capture" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    const writes = p.persist.mock.calls.length;
    view.unmount();
    await act(async () => finish());
    expect(p.persist).toHaveBeenCalledTimes(writes);
    expect(p.saved).not.toHaveBeenCalled();
  });
  it("previews before saving, ignores IME/repeat and locks duplicate Enter until acknowledgement", async () => {
    const p = props();
    let resolve!: (v: ReturnType<typeof captureCard>) => void;
    vi.mocked(notesApi.capture).mockImplementation(
      (request) =>
        new Promise((r) => {
          resolve = () => r(captureCard(request));
        }),
    );
    render(<QuickCapture {...p} />);
    const input = screen.getByRole("textbox", { name: "Note title" });
    fireEvent.change(input, { target: { value: "Ship #build !now tomorrow 9am" } });
    expect(screen.getByLabelText("Capture preview")).toHaveTextContent("TaskNow#buildTomorrow");
    expect(notesApi.capture).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", repeat: true });
    expect(notesApi.capture).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(notesApi.capture).toHaveBeenCalledTimes(1);
    await act(async () => resolve(captureCard(prepareCapture(blankCapture(null)))));
    expect(input).toHaveValue("");
    expect(p.saved).toHaveBeenCalledTimes(1);
  });
  it("retains exact request identity on failure, restores on remount and demands explicit workspace rebinding", async () => {
    const p = props();
    vi.mocked(notesApi.capture).mockRejectedValue(new Error("offline"));
    const { rerender, unmount } = render(<QuickCapture {...p} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Remember tomorrow 9am" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("alert");
    const first = vi.mocked(notesApi.capture).mock.calls[0][0];
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(notesApi.capture).toHaveBeenCalledTimes(2));
    expect(vi.mocked(notesApi.capture).mock.calls[1][0]).toEqual(first);
    rerender(<QuickCapture {...p} scope={{ key: "new", epoch: 2 }} />);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(notesApi.capture).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Workspace changed");
    await userEvent.click(screen.getByRole("button", { name: "Use current workspace" }));
    const raw = p.persist.mock.calls.at(-1)![0];
    unmount();
    render(<QuickCapture {...p} initial={raw} scope={{ key: "new", epoch: 2 }} />);
    expect(screen.getByRole("textbox")).toHaveValue("Remember tomorrow 9am");
    const next = JSON.parse(raw);
    expect(next.scope).toEqual({ key: "new", epoch: 2 });
    expect(next.id).not.toBe(first.requestId);
  });
  it("Tab opens an unsaved parsed draft; Shift+Enter starts a checklist with a stable item", async () => {
    const p = props();
    render(<QuickCapture {...p} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Buy milk #home" } });
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => {
      input.dispatchEvent(tab);
    });
    await waitFor(() => expect(p.open).toHaveBeenCalledTimes(1));
    expect(tab.defaultPrevented).toBe(true);
    expect(notesApi.capture).not.toHaveBeenCalled();
    expect(input).toHaveValue("Buy milk #home");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(p.open).toHaveBeenCalledTimes(2));
    expect(p.open.mock.calls[1][0]).toMatchObject({
      draft: { kind: "checklist", title: "Buy milk" },
      patch: { items: [{ text: "", checked: false }] },
    });
  });
  it("retains read-only input and removes a draft only when its saved card ID is acknowledged", () => {
    const p = props(),
      draft = { ...blankCapture(null), text: "Mine" };
    const { rerender } = render(<QuickCapture {...p} initial={JSON.stringify(draft)} readOnly />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("textbox")).toHaveValue("Mine");
    rerender(<QuickCapture {...p} cards={[captureCard(prepareCapture(draft))]} />);
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
  it("opens the full editor without reading or creating a card and blocks empty Ctrl+Enter", async () => {
    const request = prepareCapture(blankCapture(null), "checklist");
    render(<NoteEditor creation={request} card={captureCard(request)} close={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    expect(notesApi.editor).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Checklist item 1" })).toHaveFocus(),
    );
    fireEvent.keyDown(dialog, { key: "Enter", ctrlKey: true });
    expect(notesApi.capture).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Checklist item 1" }), {
      target: { value: "Buy milk" },
    });
    vi.mocked(notesApi.capture).mockImplementation(async (r) => captureCard(r));
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(notesApi.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: request.requestId,
        patch: expect.objectContaining({ items: [expect.objectContaining({ text: "Buy milk" })] }),
      }),
    );
  });
});
