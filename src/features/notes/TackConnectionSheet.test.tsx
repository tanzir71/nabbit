import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { TackConnectionSheet } from "./TackConnectionSheet";
import { TackSettings } from "./TackSettings";
import { tackApi, type TackConnection, type TackProfile } from "./tackApi";
import { visibleNotes, type CardValue, type StoredNote } from "./types";
import { StrictMode } from "react";
import { api } from "../../lib/ipc";
import { tackError } from "./tackErrors";
vi.mock("./tackApi", () => ({
  tackApi: {
    snapshot: vi.fn(),
    profile: vi.fn(),
    syncSnapshot: vi.fn(),
    workspaceProfile: vi.fn(),
    status: vi.fn(),
    login: vi.fn(),
    confirmRecovery: vi.fn(),
    start: vi.fn(),
    localMode: vi.fn(),
    copyRecovery: vi.fn(),
    open: vi.fn(),
    logout: vi.fn(),
  },
}));
vi.mock("../../lib/ipc", () => ({ api: { onEvent: vi.fn(async () => () => {}) } }));
const preferences = { showTasks: true, filterLabels: false, labels: [] };
const workspaces = [
  {
    id: "personal",
    name: "Personal",
    role: "owner",
    displayName: "",
    userId: "user",
    sessionEpoch: 1,
  },
  { id: "team", name: "Studio", role: "member", displayName: "", userId: "user", sessionEpoch: 1 },
  {
    id: "guest",
    name: "Client project",
    role: "guest",
    displayName: "",
    userId: "user",
    sessionEpoch: 1,
  },
];
const initial = (): TackConnection => ({
  checked: false,
  baseUrl: null,
  user: null,
  workspace: null,
  workspaces: [],
  requiresLogin: true,
  recoveryPending: false,
  ready: false,
  error: null,
});
const ready = (): TackConnection => ({
  ...initial(),
  checked: true,
  baseUrl: "https://fixture.invalid/tack/",
  user: { id: "user", username: "fixture" },
  workspace: workspaces[0],
  workspaces,
  requiresLogin: false,
  ready: true,
});
const profile = (): TackProfile => ({
  baseUrl: null,
  username: "fixture",
  localCount: 2,
  preferences: { ...preferences },
  labels: ["Ideas", "Build"],
  readOnly: false,
});
const showModal = HTMLDialogElement.prototype.showModal;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
});
afterAll(() => {
  HTMLDialogElement.prototype.showModal = showModal;
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.onEvent).mockResolvedValue(() => {});
  vi.mocked(tackApi.status).mockResolvedValue({
    ...initial(),
    checked: true,
    baseUrl: "https://fixture.invalid/tack/",
  });
  vi.mocked(tackApi.login).mockResolvedValue({ connection: ready(), recoveryCode: null });
  vi.mocked(tackApi.workspaceProfile).mockResolvedValue(profile());
  vi.mocked(tackApi.start).mockResolvedValue(ready());
  vi.mocked(tackApi.confirmRecovery).mockResolvedValue(ready());
  vi.mocked(tackApi.copyRecovery).mockResolvedValue();
  vi.mocked(tackApi.snapshot).mockResolvedValue(initial());
  vi.mocked(tackApi.profile).mockResolvedValue(profile());
  vi.mocked(tackApi.syncSnapshot).mockResolvedValue({
    state: "localOnly",
    scope: null,
    pending: 0,
    conflicts: 0,
    referenceIssues: 0,
    lastSynced: null,
    error: null,
    nextAttemptMs: null,
  });
});
function sheet(connection = initial()) {
  const close = vi.fn(),
    complete = vi.fn();
  return {
    ...render(
      <TackConnectionSheet
        initial={connection}
        profile={profile()}
        close={close}
        complete={complete}
      />,
    ),
    close,
    complete,
  };
}
async function server() {
  await userEvent.type(
    screen.getByLabelText("Tack address", { exact: true }),
    "https://fixture.invalid/tack/",
  );
  await userEvent.click(screen.getByRole("button", { name: "Check server" }));
  await screen.findByLabelText("Password", { exact: true });
}
describe("Tack connection", () => {
  it("requires HTTPS and workspace confirmation, clears the password before awaiting, and uploads only by choice", async () => {
    const current = sheet();
    await userEvent.type(
      screen.getByLabelText("Tack address", { exact: true }),
      "http://fixture.invalid/tack/",
    );
    await userEvent.click(screen.getByRole("button", { name: "Check server" }));
    expect(tackApi.status).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("HTTPS");
    await userEvent.clear(screen.getByLabelText("Tack address", { exact: true }));
    await server();
    let finish!: (value: Awaited<ReturnType<typeof tackApi.login>>) => void;
    vi.mocked(tackApi.login).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await userEvent.type(
      screen.getByLabelText("Password", { exact: true }),
      "synthetic-passphrase",
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByLabelText<HTMLInputElement>("Password", { exact: true }).value).toBe("");
    expect(tackApi.login).toHaveBeenCalledTimes(1);
    expect(tackApi.start).not.toHaveBeenCalled();
    finish({ connection: ready(), recoveryCode: null });
    await screen.findByRole("heading", { name: "Choose what to sync" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start syncing" })).not.toBeDisabled(),
    );
    expect(screen.getByRole("checkbox", { name: /Upload 2 local notes/ })).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Start syncing" }));
    expect(tackApi.start).toHaveBeenCalledWith(ready(), "personal", preferences, false);
    expect(current.complete).toHaveBeenCalledOnce();
  });
  it("requires saved recovery confirmation and keeps the code confined to the mounted dialog", async () => {
    const connection = { ...initial(), checked: true, baseUrl: "https://fixture.invalid/tack/" };
    vi.mocked(tackApi.login).mockResolvedValueOnce({
      connection: { ...ready(), ready: false, recoveryPending: true },
      recoveryCode: "synthetic-recovery-value",
    });
    const view = sheet(connection);
    await userEvent.type(
      screen.getByLabelText("Password", { exact: true }),
      "synthetic-passphrase",
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { name: "Save your recovery code" });
    expect(screen.getByRole("button", { name: "I saved it — continue" })).toBeDisabled();
    expect(tackApi.confirmRecovery).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Copy recovery code" }));
    expect(tackApi.copyRecovery).toHaveBeenCalledWith("synthetic-recovery-value");
    await userEvent.click(screen.getByRole("checkbox", { name: "I saved my recovery code" }));
    await userEvent.click(screen.getByRole("button", { name: "I saved it — continue" }));
    await screen.findByRole("heading", { name: "Choose what to sync" });
    expect(tackApi.confirmRecovery).toHaveBeenCalledWith("synthetic-recovery-value");
    expect(screen.queryByLabelText("Recovery code")).not.toBeInTheDocument();
    view.unmount();
    expect(document.body.textContent).not.toContain("synthetic-recovery-value");
    expect(JSON.stringify(localStorage)).not.toContain("synthetic-recovery-value");
  });
  it("ignores late workspace preferences and preserves comma-separated label input", async () => {
    sheet(ready());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start syncing" })).not.toBeDisabled(),
    );
    let old!: (value: TackProfile) => void;
    vi.mocked(tackApi.workspaceProfile)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          old = resolve;
        }),
      )
      .mockResolvedValueOnce({
        ...profile(),
        preferences: { showTasks: false, filterLabels: true, labels: ["Build"] },
      });
    await userEvent.click(screen.getByRole("radio", { name: /Studio/ }));
    await userEvent.click(screen.getByRole("radio", { name: /Personal/ }));
    await screen.findByLabelText("Labels to show", { exact: true });
    old({
      ...profile(),
      preferences: { showTasks: true, filterLabels: false, labels: ["Wrong workspace"] },
    });
    await userEvent.clear(screen.getByLabelText("Labels to show", { exact: true }));
    await userEvent.type(screen.getByLabelText("Labels to show", { exact: true }), "Build, Ideas");
    expect(screen.getByLabelText<HTMLInputElement>("Labels to show", { exact: true }).value).toBe(
      "Build, Ideas",
    );
    await userEvent.click(screen.getByRole("button", { name: "Start syncing" }));
    expect(tackApi.start).toHaveBeenCalledWith(
      ready(),
      "personal",
      { showTasks: false, filterLabels: true, labels: ["Build", "Ideas"] },
      false,
    );
  });
  it("prevents local uploads to a read-only workspace and labels v2.1 options", async () => {
    sheet(ready());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start syncing" })).not.toBeDisabled(),
    );
    await userEvent.click(screen.getByRole("radio", { name: /Client project/ }));
    await screen.findByText(/This workspace is read only/);
    expect(screen.getByRole("checkbox", { name: /Upload 2 local notes/ })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Log focus timers as Tack time" })).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "Pinned cards on the desktop board" }),
    ).toBeDisabled();
  });
  it("sanitizes untrusted errors and disables repeated actions during Retry-After", async () => {
    expect(tackError({ code: "constructor", message: "untrusted value" }).message).toBe(
      "The Tack action could not be completed. Try again.",
    );
    const view = sheet({ ...initial(), checked: true, baseUrl: "https://fixture.invalid/tack/" });
    vi.mocked(tackApi.login).mockRejectedValueOnce({
      code: "rateLimited",
      retryAfterMs: 60000,
      body: "untrusted secret server details",
    });
    await userEvent.type(
      screen.getByLabelText("Password", { exact: true }),
      "synthetic-passphrase",
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("limited attempts");
    expect(document.body.textContent).not.toContain("untrusted secret");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    view.unmount();
  });
  it("keeps a pending login inside the dialog until it completes", async () => {
    const view = sheet({ ...initial(), checked: true, baseUrl: "https://fixture.invalid/tack/" });
    let finish!: (value: Awaited<ReturnType<typeof tackApi.login>>) => void;
    vi.mocked(tackApi.login).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await userEvent.type(
      screen.getByLabelText("Password", { exact: true }),
      "synthetic-passphrase",
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("button", { name: "Close Tack connection" })).toBeDisabled();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(view.close).not.toHaveBeenCalled();
    finish({ connection: ready(), recoveryCode: null });
    await screen.findByRole("heading", { name: "Choose what to sync" });
  });
  it("loads only local snapshots when the settings section opens", async () => {
    render(<TackSettings />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Connect Tack" })).not.toBeDisabled(),
    );
    expect(tackApi.snapshot).toHaveBeenCalledOnce();
    expect(tackApi.status).not.toHaveBeenCalled();
    expect(tackApi.login).not.toHaveBeenCalled();
  });
  it("applies display scope without dropping local-only notes or mutating the cached cards", () => {
    const base: CardValue = {
      id: "base",
      kind: "note",
      labels: [],
      revision: 0,
      assigneeId: null,
      doneWhen: "",
      frontmatter: "",
      attachmentIds: [],
      pinned: false,
      completed: false,
      color: "default",
      projectId: null,
      createdAt: "2026-11-27T00:00:00.000Z",
      updatedAt: "2026-11-27T00:00:00.000Z",
      sourceId: null,
      rank: "a0",
      priority: "inbox",
      archived: false,
      trashedAt: null,
      title: "",
      body: "",
      url: "",
      ref: "",
      items: [],
    };
    const cards: StoredNote[] = [
      { localOnly: false, value: { ...base, id: "visible", kind: "note", labels: ["Build"] } },
      { localOnly: false, value: { ...base, id: "task", kind: "task", labels: ["Build"] } },
      { localOnly: false, value: { ...base, id: "other", kind: "note", labels: ["Ideas"] } },
      { localOnly: true, value: { ...base, id: "local", kind: "task", labels: [] } },
    ];
    expect(
      visibleNotes(cards, "notes", "all", "", "", {
        showTasks: false,
        filterLabels: true,
        labels: ["Build"],
      }).map((c) => c.value.id),
    ).toEqual(["local", "visible"]);
    expect(cards).toHaveLength(4);
  });
  it("disposes late event registrations across StrictMode cleanup and unmount", async () => {
    const stops = Array.from({ length: 4 }, () => vi.fn());
    const registrations: Array<() => void> = [];
    for (const stop of stops)
      vi.mocked(api.onEvent).mockImplementationOnce(
        () => new Promise((resolve) => registrations.push(() => resolve(stop))),
      );
    const view = render(
      <StrictMode>
        <TackSettings />
      </StrictMode>,
    );
    expect(registrations).toHaveLength(4);
    registrations.forEach((finish) => finish());
    await waitFor(() => expect(stops[0]).toHaveBeenCalledOnce());
    expect(stops[1]).toHaveBeenCalledOnce();
    expect(stops[2]).not.toHaveBeenCalled();
    expect(stops[3]).not.toHaveBeenCalled();
    view.unmount();
    for (const stop of stops) expect(stop).toHaveBeenCalledOnce();
  });
  it("clears a stale recovery code and returns to a password-free sign-in form", async () => {
    vi.mocked(tackApi.login).mockResolvedValueOnce({
      connection: { ...ready(), ready: false, recoveryPending: true },
      recoveryCode: "synthetic-stale-code",
    });
    vi.mocked(tackApi.confirmRecovery).mockRejectedValueOnce({ code: "conflict" });
    sheet({ ...initial(), checked: true, baseUrl: "https://fixture.invalid/tack/" });
    await userEvent.type(
      screen.getByLabelText("Password", { exact: true }),
      "synthetic-passphrase",
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { name: "Save your recovery code" });
    await userEvent.click(screen.getByRole("checkbox", { name: "I saved my recovery code" }));
    await userEvent.click(screen.getByRole("button", { name: "I saved it — continue" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("changed or expired");
    expect(screen.getByLabelText<HTMLInputElement>("Password", { exact: true }).value).toBe("");
    expect(screen.queryByLabelText("Recovery code")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("synthetic-stale-code");
    expect(tackApi.start).not.toHaveBeenCalled();
  });
});
