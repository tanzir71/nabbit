import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotesView } from "./NotesView";
import { useNotesStore } from "../store/notesStore";
import { notesApi } from "../features/notes/api";
import { blankCapture, prepareCapture } from "../features/notes/captureDraft";
import { visibleNotes, type CardValue, type StoredNote } from "../features/notes/types";

vi.mock("../features/notes/api", () => ({
  notesApi: {
    list: vi.fn(),
    state: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    editor: vi.fn(),
    saveEditor: vi.fn(),
  },
}));
vi.mock("../features/notes/TackSettings", () => ({
  TackSettings: () => <span>Local only · Saved on this device</span>,
}));
function card(patch: Partial<CardValue> = {}): StoredNote {
  return {
    localOnly: true,
    value: {
      id: "note-one",
      revision: 0,
      assigneeId: null,
      priority: "inbox",
      ref: "",
      doneWhen: "",
      frontmatter: "",
      kind: "note",
      title: "My note",
      body: "Kept on this device",
      url: "",
      labels: [],
      items: [],
      attachmentIds: [],
      pinned: false,
      archived: false,
      trashedAt: null,
      completed: false,
      color: "default",
      rank: "a0",
      projectId: null,
      createdAt: "2026-11-27T04:00:00.000Z",
      updatedAt: "2026-11-27T04:00:00.000Z",
      sourceId: null,
      ...patch,
    },
  };
}
let rows: StoredNote[];
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  vi.clearAllMocks();
  localStorage.clear();
  rows = [card()];
  useNotesStore.setState({ cards: [], scope: null, loading: true, error: null, busy: [] });
  vi.mocked(notesApi.list).mockImplementation(async () => structuredClone(rows));
  vi.mocked(notesApi.state).mockImplementation(async () => ({
    cards: await notesApi.list(),
    scope: null,
  }));
  vi.mocked(notesApi.update).mockImplementation(async (id, revision, patch) => {
    const note = rows.find((n) => n.value.id === id)!;
    if (note.value.revision !== revision)
      throw new Error("This note changed in another window. Your draft is still here.");
    note.value = { ...note.value, ...patch, revision: revision + 1 };
    return structuredClone(note);
  });
  vi.mocked(notesApi.editor).mockImplementation(async (id) => ({
    note: structuredClone(rows.find((row) => row.value.id === id)!),
    reminders: [],
    attachments: [],
    revisions: [],
  }));
  vi.mocked(notesApi.saveEditor).mockImplementation((card, patch) =>
    notesApi.update(card.value.id, card.value.revision, patch),
  );
  vi.mocked(notesApi.create).mockImplementation(async (draft) => {
    const saved = card({
      ...draft,
      id: "created",
      items: (draft.items ?? []).map((text, index) => ({
        id: `item-${index}`,
        text,
        checked: false,
      })),
    });
    rows.unshift(saved);
    return structuredClone(saved);
  });
});

describe("local Notes view", () => {
  it("consumes a navigation draft without creating or reading a persisted card", async () => {
    const request = prepareCapture({
      ...blankCapture(null),
      text: "Unsaved island draft #nabbit !next",
    });
    render(<NotesView navigation={{ id: "navigation", intent: { kind: "new", request } }} />);
    const editor = await screen.findByRole("dialog", {}, { timeout: 10000 });
    expect(within(editor).getByRole("textbox", { name: "Note title" })).toHaveValue(
      "Unsaved island draft",
    );
    expect(notesApi.create).not.toHaveBeenCalled();
    expect(notesApi.editor).not.toHaveBeenCalled();
  });
  it("dismisses menus with Escape or outside focus and restores the summary focus", async () => {
    const user = userEvent.setup();
    render(<NotesView />);
    await screen.findByText("My note");
    const summary = screen.getByLabelText("Actions for My note");
    await user.click(summary);
    expect(summary.parentElement).toHaveAttribute("open");
    await user.keyboard("{Escape}");
    expect(summary.parentElement).not.toHaveAttribute("open");
    expect(summary).toHaveFocus();
    const views = screen.getByLabelText("Notes view and labels");
    await user.click(views);
    expect(views.parentElement).toHaveAttribute("open");
    await user.click(screen.getByRole("textbox", { name: "Note title" }));
    expect(views.parentElement).not.toHaveAttribute("open");
  });
  it("groups pinned cards and filters by priority, label and search across all card content", async () => {
    rows = [
      card({
        id: "pin",
        title: "Pinned list",
        kind: "checklist",
        items: [{ id: "item", text: "Hidden searchable step", checked: false }],
        pinned: true,
        priority: "now",
        labels: ["Build"],
      }),
      card({ id: "other", title: "Later note", priority: "later" }),
      card({ id: "archived", title: "Archived", archived: true }),
      card({ id: "trash", title: "Trashed", trashedAt: "2026-11-27T04:00:00Z" }),
    ];
    const user = userEvent.setup();
    render(<NotesView />);
    await screen.findByRole("button", { name: "Pinned list" });
    expect(
      within(screen.getByRole("region", { name: "Pinned" })).getByText("Pinned list"),
    ).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Others" })).getByText("Later note"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Now" }));
    expect(screen.queryByText("Later note")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Notes view and labels"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by label" }), "Build");
    fireEvent(window, new CustomEvent("nabbit:focus-notes-search"));
    await user.type(
      await screen.findByRole("searchbox", { name: "Search notes" }),
      "Hidden searchable step",
    );
    expect(screen.getByRole("button", { name: "Pinned list" })).toBeVisible();
    await user.type(screen.getByRole("searchbox", { name: "Search notes" }), " missing");
    expect(screen.getByText("No matching notes")).toBeVisible();
  });
  it("checks an item with its stable ID, revision and unknown fields intact", async () => {
    rows = [
      card({
        kind: "checklist",
        items: [{ id: "keep-id", text: "Do it", checked: false, future: { preserve: true } }],
      }),
    ];
    const user = userEvent.setup();
    render(<NotesView />);
    const checkbox = await screen.findByRole("checkbox", { name: "Do it" });
    await user.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(notesApi.update).toHaveBeenCalledWith("note-one", 0, {
      items: [{ id: "keep-id", text: "Do it", checked: true, future: { preserve: true } }],
    });
    expect(screen.getByText("Local only · Saved on this device")).toBeVisible();
  });
  it("removing one checklist row does not reassign another row's ID or checked state", async () => {
    rows = [
      card({
        kind: "checklist",
        items: [
          { id: "first", text: "Remove me", checked: false },
          { id: "second", text: "Keep me", checked: true, future: 42 },
        ],
      }),
    ];
    const user = userEvent.setup();
    render(<NotesView />);
    await user.click(await screen.findByRole("button", { name: "My note" }));
    await user.click(await screen.findByRole("button", { name: "Remove item 1" }));
    await user.clear(screen.getByRole("textbox", { name: "Checklist item 1" }));
    await user.type(screen.getByRole("textbox", { name: "Checklist item 1" }), "Edited second row");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(rows[0].value.revision).toBe(1));
    expect(rows[0].value.items).toEqual([
      { id: "second", text: "Edited second row", checked: true, future: 42 },
    ]);
  });
  it("archives and trashes softly and restores through the view menu", async () => {
    const user = userEvent.setup();
    render(<NotesView />);
    await screen.findByText("My note");
    await user.click(screen.getByLabelText("Actions for My note"));
    await user.click(
      within(screen.getByLabelText("Actions for My note").parentElement!).getByRole("button", {
        name: "Archive",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("article")).not.toBeInTheDocument());
    await user.click(screen.getByLabelText("Notes view and labels"));
    await user.click(
      within(screen.getByLabelText("Notes view and labels").parentElement!).getByRole("button", {
        name: "Archive",
      }),
    );
    await screen.findByText("My note");
    await user.click(screen.getByLabelText("Actions for My note"));
    await user.click(screen.getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(rows[0].value.trashedAt).not.toBeNull());
    expect(rows).toHaveLength(1);
    await user.click(screen.getByLabelText("Notes view and labels"));
    await user.click(screen.getByRole("button", { name: "Trash" }));
    await screen.findByText("My note");
    await user.click(screen.getByLabelText("Actions for My note"));
    await user.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(rows[0].value.trashedAt).toBeNull());
    expect(rows[0].value.archived).toBe(true);
  });
});

describe("Notes state races and filtering", () => {
  it("keeps the workspace context paired with the latest atomic card snapshot", async () => {
    const oldScope = { key: "old", epoch: 1 },
      newScope = { key: "new", epoch: 2 };
    let finish!: (state: { cards: StoredNote[]; scope: typeof oldScope }) => void;
    vi.mocked(notesApi.state).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = useNotesStore.getState().refresh();
    vi.mocked(notesApi.state).mockResolvedValueOnce({
      cards: [card({ title: "New workspace" })],
      scope: newScope,
    });
    await useNotesStore.getState().refresh();
    finish({ cards: [card({ title: "Old workspace" })], scope: oldScope });
    await first;
    expect(useNotesStore.getState().scope).toEqual(newScope);
    expect(useNotesStore.getState().cards[0].value.title).toBe("New workspace");
  });
  it("submits the editor's scope and edit token even after another workspace becomes active", async () => {
    const oldScope = { key: "old", epoch: 1 },
      newScope = { key: "new", epoch: 2 };
    const opened = { ...card(), localOnly: false, scope: oldScope, editToken: "opened-version" };
    useNotesStore.setState({ scope: newScope, cards: [card({ title: "Current workspace" })] });
    vi.mocked(notesApi.update).mockRejectedValueOnce(
      new Error("Workspace changed. Your draft is preserved."),
    );
    vi.mocked(notesApi.state).mockResolvedValueOnce({
      cards: [card({ title: "Current workspace" })],
      scope: newScope,
    });
    expect(await useNotesStore.getState().updateNote(opened, { body: "old draft" })).toBeNull();
    expect(notesApi.update).toHaveBeenCalledWith(
      "note-one",
      0,
      { body: "old draft" },
      oldScope,
      "opened-version",
    );
    expect(useNotesStore.getState().scope).toEqual(newScope);
    expect(useNotesStore.getState().cards[0].value.title).toBe("Current workspace");
    expect(useNotesStore.getState().error).toContain("draft is preserved");
  });
  it("captures creation scope before awaiting IPC and refreshes the current workspace", async () => {
    const oldScope = { key: "old", epoch: 1 },
      newScope = { key: "new", epoch: 2 };
    useNotesStore.setState({ scope: oldScope });
    let finish!: (card: StoredNote) => void;
    vi.mocked(notesApi.create).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = useNotesStore.getState().createNote({ title: "saved in old scope" });
    useNotesStore.setState({ scope: newScope });
    vi.mocked(notesApi.state).mockResolvedValueOnce({
      cards: [card({ title: "New scope" })],
      scope: newScope,
    });
    finish({ ...card(), scope: oldScope });
    await pending;
    expect(notesApi.create).toHaveBeenCalledWith({ title: "saved in old scope" }, oldScope);
    expect(useNotesStore.getState().scope).toEqual(newScope);
    expect(useNotesStore.getState().cards[0].value.title).toBe("New scope");
  });
  it("a late list cannot overwrite a newer snapshot", async () => {
    let oldResolve!: (value: StoredNote[]) => void;
    vi.mocked(notesApi.list).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldResolve = resolve;
        }),
    );
    const first = useNotesStore.getState().refresh();
    rows = [card({ title: "Newest" })];
    await useNotesStore.getState().refresh();
    oldResolve([card({ title: "Stale" })]);
    await first;
    expect(useNotesStore.getState().cards[0].value.title).toBe("Newest");
  });
  it("a duplicate pending mutation does not issue a stale second write", async () => {
    let finish!: (value: StoredNote) => void;
    vi.mocked(notesApi.update).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = useNotesStore.getState().updateNote(rows[0], { pinned: true });
    expect(await useNotesStore.getState().updateNote(rows[0], { pinned: false })).toBeNull();
    finish(rows[0]);
    await first;
    expect(notesApi.update).toHaveBeenCalledTimes(1);
    expect(useNotesStore.getState().busy).toEqual([]);
  });
  it("task and bookmark content stays searchable while archive/trash stay separate", () => {
    const values = [
      card({
        id: "task",
        kind: "task",
        priority: "now",
        items: [{ id: "step", text: "Ship this", checked: true }],
        labels: ["Build"],
      }),
      card({ id: "url", kind: "bookmark", url: "https://example.test/documentation" }),
      card({ id: "trash", trashedAt: "today" }),
      card({ id: "archive", archived: true }),
    ];
    expect(visibleNotes(values, "notes", "now", "Build", "SHIP").map((c) => c.value.id)).toEqual([
      "task",
    ]);
    expect(
      visibleNotes(values, "notes", "all", "", "documentation").map((c) => c.value.id),
    ).toEqual(["url"]);
    expect(visibleNotes(values, "trash", "all", "", "").map((c) => c.value.id)).toEqual(["trash"]);
  });
});
