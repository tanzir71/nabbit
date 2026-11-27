import { StrictMode } from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { BookmarkImportSheet } from "./BookmarkImportSheet";
import { linksApi, type BookmarkCatalog, type BookmarkPreview } from "./linksApi";
import { tackApi, type TackConnection, type TackProfile } from "./tackApi";
import { listen } from "@tauri-apps/api/event";
vi.mock("./linksApi", () => ({
  linksApi: {
    discover: vi.fn(),
    pickHtml: vi.fn(),
    preview: vi.fn(),
    commit: vi.fn(),
    history: vi.fn(),
    undo: vi.fn(),
    release: vi.fn(),
  },
}));
vi.mock("./tackApi", () => ({ tackApi: { snapshot: vi.fn(), profile: vi.fn() } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const scope = { key: "fixture-scope", epoch: 1 };
const initial: TackConnection = {
  checked: false,
  baseUrl: null,
  user: null,
  workspace: null,
  workspaces: [],
  requiresLogin: true,
  recoveryPending: false,
  ready: false,
  error: null,
};
const profile: TackProfile = {
  baseUrl: null,
  username: "",
  localCount: 0,
  preferences: { showTasks: true, filterLabels: false, labels: [] },
  labels: [],
  readOnly: false,
};
const catalog = (sessionId = "read-session"): BookmarkCatalog => ({
  sessionId,
  readFiles: ["C:\\Fixture\\Chrome\\Local State", "C:\\Fixture\\Chrome\\Bookmarks"],
  sources: [
    {
      id: "chrome",
      name: "Chrome · Personal",
      browser: "Chrome",
      links: 56,
      folders: 2,
      skipped: 1,
      error: null,
      files: ["C:\\Fixture\\Chrome\\Bookmarks"],
    },
    {
      id: "firefox",
      name: "Firefox · fixture",
      browser: "Firefox",
      links: 2,
      folders: 1,
      skipped: 0,
      error: null,
      files: ["C:\\Fixture\\Firefox\\places.sqlite", "C:\\Fixture\\Firefox\\places.sqlite-wal"],
    },
  ],
});
const preview = (planId = "plan-one"): BookmarkPreview => ({
  planId,
  eligible: 54,
  duplicates: 2,
  skipped: 1,
  total: 56,
  files: ["C:\\Fixture\\Chrome\\Bookmarks"],
  scope,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  vi.mocked(linksApi.discover).mockResolvedValue(catalog());
  vi.mocked(linksApi.release).mockResolvedValue();
  vi.mocked(linksApi.preview).mockResolvedValue(preview());
  vi.mocked(linksApi.history).mockResolvedValue([]);
  vi.mocked(linksApi.commit).mockResolvedValue({
    id: "plan-one",
    imported: 54,
    duplicates: 2,
    skipped: 1,
    undoAvailable: true,
    firstCardId: "new-card",
  });
  vi.mocked(linksApi.undo).mockResolvedValue(54);
  vi.mocked(tackApi.snapshot).mockResolvedValue(initial);
  vi.mocked(tackApi.profile).mockResolvedValue(profile);
  vi.mocked(listen).mockResolvedValue(vi.fn());
});
describe("Bookmark import sheet", () => {
  it("previews only selected sources, defaults to Later and exposes exactly the files read", async () => {
    const user = userEvent.setup();
    render(<BookmarkImportSheet scope={scope} close={vi.fn()} changed={vi.fn(async () => {})} />);
    expect(await screen.findByRole("checkbox", { name: "Chrome · Personal" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Firefox · fixture" })).not.toBeChecked();
    const commit = await screen.findByRole("button", { name: "Import 54 links" });
    await waitFor(() => expect(commit).toBeEnabled());
    expect(linksApi.preview).toHaveBeenLastCalledWith("read-session", ["chrome"], scope, {
      foldersAsLabels: true,
      skipDuplicates: true,
      priority: "later",
    });
    await user.click(screen.getByText("Files read on this PC"));
    expect(screen.getByText("C:\\Fixture\\Chrome\\Local State")).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: "Firefox · fixture" }));
    await waitFor(() =>
      expect(linksApi.preview).toHaveBeenLastCalledWith(
        "read-session",
        ["chrome", "firefox"],
        scope,
        expect.objectContaining({ priority: "later" }),
      ),
    );
    await waitFor(() => expect(commit).toBeEnabled());
    await user.click(screen.getByRole("switch", { name: "Folders become labels" }));
    await waitFor(() =>
      expect(linksApi.preview).toHaveBeenLastCalledWith(
        "read-session",
        ["chrome", "firefox"],
        scope,
        expect.objectContaining({ foldersAsLabels: false }),
      ),
    );
  });
  it("does not commit an old preview after the workspace changes; Rescan recovers", async () => {
    const held = deferred<BookmarkPreview>();
    vi.mocked(linksApi.preview).mockReturnValueOnce(held.promise);
    const user = userEvent.setup(),
      close = vi.fn(),
      changed = vi.fn(async () => {});
    const view = render(<BookmarkImportSheet scope={scope} close={close} changed={changed} />);
    await waitFor(() => expect(linksApi.preview).toHaveBeenCalledTimes(1));
    const next = { key: "other-scope", epoch: 2 };
    view.rerender(<BookmarkImportSheet scope={next} close={close} changed={changed} />);
    held.resolve(preview("stale-plan"));
    expect(await screen.findByText(/workspace changed/)).toBeVisible();
    expect(screen.getByRole("button", { name: /Import 0 links/ })).toBeDisabled();
    expect(linksApi.commit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Rescan sources" }));
    await waitFor(() =>
      expect(linksApi.preview).toHaveBeenLastCalledWith(
        "read-session",
        ["chrome"],
        next,
        expect.anything(),
      ),
    );
    expect(await screen.findByRole("button", { name: "Import 54 links" })).toBeEnabled();
  });
  it("retries the frozen plan after a lost acknowledgement and keeps one undo group", async () => {
    vi.mocked(linksApi.commit).mockRejectedValueOnce(new Error("lost acknowledgement"));
    const user = userEvent.setup(),
      changed = vi.fn(async () => {});
    render(<BookmarkImportSheet scope={scope} close={vi.fn()} changed={changed} />);
    const button = await screen.findByRole("button", { name: "Import 54 links" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("Retry this import");
    await user.click(button);
    expect(await screen.findByRole("heading", { name: "Imported 54 links" })).toBeVisible();
    expect(linksApi.commit).toHaveBeenNthCalledWith(1, "plan-one", scope);
    expect(linksApi.commit).toHaveBeenNthCalledWith(2, "plan-one", scope);
    expect(linksApi.discover).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Undo import" }));
    await waitFor(() => expect(linksApi.undo).toHaveBeenCalledWith("plan-one", scope));
    expect(await screen.findByText("Import undone. Its links are in Trash.")).toBeVisible();
  });
  it("blocks duplicate submissions and dismissal while a commit is pending", async () => {
    const held = deferred<Awaited<ReturnType<typeof linksApi.commit>>>();
    vi.mocked(linksApi.commit).mockReturnValue(held.promise);
    const user = userEvent.setup(),
      close = vi.fn();
    render(<BookmarkImportSheet scope={scope} close={close} changed={vi.fn(async () => {})} />);
    const button = await screen.findByRole("button", { name: "Import 54 links" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.dblClick(button);
    expect(linksApi.commit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Close bookmark import" })).toBeDisabled();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(close).not.toHaveBeenCalled();
    held.resolve({
      id: "plan-one",
      imported: 54,
      duplicates: 2,
      skipped: 1,
      undoAvailable: true,
      firstCardId: "card",
    });
    await screen.findByRole("heading", { name: "Imported 54 links" });
  });
  it("keeps a private session usable through StrictMode and releases late resources", async () => {
    vi.mocked(linksApi.discover)
      .mockResolvedValueOnce(catalog("discarded"))
      .mockResolvedValueOnce(catalog("active"));
    const stop = vi.fn();
    vi.mocked(listen).mockResolvedValue(stop);
    const view = render(
      <StrictMode>
        <BookmarkImportSheet scope={null} close={vi.fn()} changed={vi.fn(async () => {})} />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(linksApi.preview).toHaveBeenCalledWith("active", ["chrome"], null, expect.anything()),
    );
    expect(linksApi.release).toHaveBeenCalledWith("discarded");
    view.unmount();
    await waitFor(() => expect(linksApi.release).toHaveBeenCalledWith("active"));
    expect(stop).toHaveBeenCalledTimes(2);
  });
  it("never imports into a read-only workspace", async () => {
    render(
      <BookmarkImportSheet
        scope={scope}
        readOnly
        close={vi.fn()}
        changed={vi.fn(async () => {})}
      />,
    );
    await screen.findByRole("checkbox", { name: "Chrome · Personal" });
    expect(screen.getByRole("button", { name: "Import 0 links" })).toBeDisabled();
    expect(linksApi.preview).not.toHaveBeenCalled();
    expect(linksApi.commit).not.toHaveBeenCalled();
  });
});
