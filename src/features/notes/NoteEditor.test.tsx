import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoteEditor } from "./NoteEditor";
import { ConflictSheet } from "./ConflictSheet";
import { SyncState } from "./SyncState";
import { syncCopy } from "./syncCopy";
import { notesApi, type NoteEditorData } from "./api";
import { tackApi, type TackConflict, type TackSyncSnapshot } from "./tackApi";
import { useNotesStore } from "../../store/notesStore";
import type { StoredNote } from "./types";
vi.mock("./api", () => ({ notesApi: { editor: vi.fn(), saveEditor: vi.fn(), state: vi.fn() } }));
vi.mock("./TackSettings", () => ({
  TackSettings: () => <span>Local only · Saved on this device</span>,
}));
vi.mock("./tackApi", () => ({
  tackApi: { open: vi.fn(), conflicts: vi.fn(), profile: vi.fn(), resolve: vi.fn() },
}));
const card = (): StoredNote => ({
  localOnly: true,
  scope: null,
  editToken: "opened",
  value: {
    id: "note",
    revision: 4,
    assigneeId: null,
    priority: "now",
    ref: "tck-24",
    doneWhen: "",
    frontmatter: "",
    kind: "task",
    title: "Launch checklist",
    body: "Keep it useful",
    url: "",
    items: [{ id: "stable", text: "Verify DPI", checked: true, future: 42 }],
    labels: ["build"],
    attachmentIds: [],
    pinned: false,
    archived: false,
    trashedAt: null,
    completed: false,
    status: "open",
    color: "green",
    rank: "a0",
    projectId: null,
    sourceId: null,
    createdAt: "2026-11-27T00:00:00Z",
    updatedAt: "2026-11-27T00:00:00Z",
    future: { kept: true },
  },
});
const snapshot = (): NoteEditorData => ({
  note: card(),
  reminders: [],
  attachments: [],
  revisions: [],
});
const sync = (state: TackSyncSnapshot["state"]): TackSyncSnapshot => ({
  state,
  scope: { key: "workspace", epoch: 1 },
  pending: 3,
  conflicts: 1,
  referenceIssues: 0,
  lastSynced: null,
  error: null,
  nextAttemptMs: null,
});
beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  useNotesStore.setState({ scope: null, readOnly: false, cards: [card()], error: null, busy: [] });
  vi.mocked(notesApi.editor).mockResolvedValue(snapshot());
  vi.mocked(notesApi.state).mockResolvedValue({ scope: null, cards: [card()] });
  vi.mocked(notesApi.saveEditor).mockResolvedValue(card());
  vi.mocked(tackApi.profile).mockResolvedValue({
    baseUrl: null,
    username: "",
    localCount: 0,
    preferences: { showTasks: true, filterLabels: false, labels: [] },
    labels: [],
    readOnly: false,
  });
});
async function open() {
  const close = vi.fn();
  render(<NoteEditor card={card()} close={close} />);
  await waitFor(() => expect(screen.getByLabelText("Note title")).toBeEnabled());
  return { close, user: userEvent.setup(), ui: within(screen.getByRole("dialog")) };
}
describe("Notes editor", () => {
  it("submits changed fields with stable checklist IDs and original scope/token", async () => {
    const { user, close, ui } = await open();
    await user.clear(ui.getByLabelText("Checklist item 1"));
    await user.type(ui.getByLabelText("Checklist item 1"), "Record demo");
    await user.click(ui.getByRole("button", { name: "Purple colour" }));
    await user.click(ui.getByRole("button", { name: "Next" }));
    await user.click(ui.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(notesApi.saveEditor).toHaveBeenCalledWith(
      card(),
      {
        items: [{ id: "stable", text: "Record demo", checked: true, future: 42 }],
        priority: "next",
        color: "purple",
      },
      [],
    );
  });
  it("requires a decision before closing a dirty draft and preserves failed saves", async () => {
    vi.mocked(notesApi.saveEditor).mockRejectedValueOnce(new Error("untrusted db detail"));
    const { user, close, ui } = await open();
    await user.type(ui.getByLabelText("Note body"), " and my draft");
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(ui.getByRole("alert")).toHaveTextContent("Save your changes");
    expect(close).not.toHaveBeenCalled();
    await user.click(ui.getByRole("button", { name: "Keep editing" }));
    await user.click(ui.getByRole("button", { name: "Save note" }));
    expect(await ui.findByRole("alert")).toHaveTextContent("Your draft is still here");
    expect(ui.getByLabelText("Note body")).toHaveValue("Keep it useful and my draft");
    expect(ui.getByRole("alert")).not.toHaveTextContent("untrusted db detail");
    await user.click(ui.getByRole("button", { name: "Close editor" }));
    await user.click(ui.getByRole("button", { name: "Close without saving" }));
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("saves reminders with all unedited fields and optimistic tokens", async () => {
    const data = snapshot();
    data.reminders = [
      {
        editToken: "reminder-opened",
        value: {
          id: "reminder",
          revision: 9,
          entityId: "note",
          entityType: "card",
          at: "2026-12-01T09:00:00.000Z",
          timeZone: "UTC",
          repeat: "daily",
          anchorDay: 1,
          snoozedUntil: null,
          lastCompletedAt: null,
          enabled: true,
          future: "retained",
        },
      },
    ];
    vi.mocked(notesApi.editor).mockResolvedValue(data);
    const { user, ui } = await open();
    await user.click(ui.getByRole("button", { name: "Edit reminders" }));
    await user.selectOptions(ui.getByLabelText("Reminder 1 repeat"), "weekdays");
    await user.click(ui.getByRole("button", { name: "Save note" }));
    expect(notesApi.saveEditor).toHaveBeenCalledWith(data.note, { title: "Launch checklist" }, [
      {
        id: "reminder",
        expectedToken: "reminder-opened",
        value: { ...data.reminders[0].value, repeat: "weekdays", revision: 10 },
      },
    ]);
  });
  it("blocks a draft after a workspace switch without overwriting its text", async () => {
    const { user, ui } = await open();
    await user.type(ui.getByLabelText("Note body"), " preserved");
    act(() => useNotesStore.setState({ scope: { key: "other", epoch: 2 } }));
    await waitFor(() => expect(ui.getByRole("button", { name: "Save note" })).toBeDisabled());
    expect(ui.getByLabelText("Note body")).toHaveValue("Keep it useful preserved");
    expect(notesApi.saveEditor).not.toHaveBeenCalled();
  });
  it("shows attachment and conflict history text safely and supports task completion", async () => {
    const data = snapshot();
    data.note.value.attachmentIds = ["image"];
    data.attachments = [
      { id: "image", name: "A picture", mime: "image/png", data: "iVBORw0KGgo=" },
    ];
    data.revisions = [
      {
        value: { body: "<img src=x onerror=alert(1)>" },
        reason: "used-tack-version",
        savedAt: "2026-11-27T00:00:00Z",
      },
    ];
    vi.mocked(notesApi.editor).mockResolvedValue(data);
    const { user, ui } = await open();
    expect(ui.getByRole("img", { name: "A picture" })).toHaveAttribute(
      "src",
      "data:image/png;base64,iVBORw0KGgo=",
    );
    await user.click(ui.getByRole("button", { name: "History" }));
    expect(ui.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
    await user.click(ui.getByRole("button", { name: "Task properties" }));
    await user.selectOptions(ui.getByLabelText("Task status"), "done");
    await user.click(ui.getByRole("button", { name: "Save note" }));
    expect(notesApi.saveEditor).toHaveBeenCalledWith(
      data.note,
      { completed: true, status: "done" },
      [],
    );
  });
});
describe("Conflict decisions and sync states", () => {
  const conflict = (): TackConflict => ({
    scope: { key: "workspace", epoch: 1 },
    table: "cards",
    id: "note",
    token: "frozen-local",
    local: { title: "Local", body: "This PC text" },
    remote: {
      table: "cards",
      id: "note",
      version: 7,
      value: { title: "Remote", body: "Tack text" },
    },
  });
  it.each(["keepLocal", "useRemote"] as const)(
    "uses the frozen conflict guards for %s",
    async (choice) => {
      const current = conflict();
      vi.mocked(tackApi.conflicts).mockResolvedValueOnce([current]).mockResolvedValue([]);
      vi.mocked(tackApi.resolve).mockResolvedValue();
      render(<ConflictSheet scope={current.scope} close={vi.fn()} />);
      await screen.findByText("This PC text");
      expect(screen.getByText("Tack text")).toBeVisible();
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", {
          name: choice === "keepLocal" ? "Keep this PC’s" : "Use Tack version",
        }),
      );
      await waitFor(() => expect(tackApi.resolve).toHaveBeenCalledWith(current, choice));
      expect(await screen.findByText("No unresolved conflicts in this workspace.")).toBeVisible();
    },
  );
  it("does not submit another choice after a stale conflict until reloaded", async () => {
    const current = conflict();
    vi.mocked(tackApi.conflicts).mockResolvedValue([current]);
    vi.mocked(tackApi.resolve).mockRejectedValue(new Error("stale"));
    render(<ConflictSheet scope={current.scope} close={vi.fn()} />);
    await screen.findByText("This PC text");
    await userEvent.click(screen.getByRole("button", { name: "Use Tack version" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Both versions are preserved");
    expect(screen.getByRole("button", { name: "Keep this PC’s" })).toBeDisabled();
  });
  it("covers all protocol states and never claims unsent changes are synced", () => {
    for (const state of [
      "localOnly",
      "upToDate",
      "syncing",
      "offline",
      "signedOut",
      "workspaceChanged",
      "storageFull",
      "recoveryPending",
      "rateLimited",
      "conflict",
    ] as const) {
      const copy = syncCopy(sync(state), "Personal");
      expect(copy.title).toBeTruthy();
      expect(copy.detail).toBeTruthy();
    }
    expect(syncCopy(sync("upToDate")).title).toBe("Changes queued");
    const awaiting = sync("upToDate");
    awaiting.pending = 0;
    expect(syncCopy(awaiting).title).toBe("Ready to sync");
    const action = vi.fn();
    render(<SyncState snapshot={sync("conflict")} act={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Review conflicts" }));
    expect(action).toHaveBeenCalledTimes(1);
  });
});
