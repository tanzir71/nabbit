import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { stickyApi, type StickySnapshot } from "./stickyApi";
import { tackApi } from "./tackApi";
import { useStickyDraft } from "./useStickyDraft";
import type { StoredNote } from "./types";
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./stickyApi", () => ({
  stickyApi: {
    snapshot: vi.fn(),
    checkpoint: vi.fn(),
    clear: vi.fn(),
    save: vi.fn(),
    close: vi.fn(),
    leave: vi.fn(),
    reload: vi.fn(),
    copy: vi.fn(),
  },
}));
vi.mock("./tackApi", () => ({ tackApi: { syncSnapshot: vi.fn() } }));
const note = (): StoredNote => ({
  scope: null,
  localOnly: true,
  editToken: "first",
  value: {
    id: "card",
    revision: 0,
    ref: "",
    title: "Launch checklist",
    body: "Keep it",
    kind: "checklist",
    url: "",
    items: [{ id: "stable", text: "Verify", checked: false, future: 42 }],
    labels: [],
    priority: "now",
    color: "green",
    pinned: false,
    archived: false,
    trashedAt: null,
    completed: false,
    status: "open",
    rank: "a0",
    doneWhen: "",
    frontmatter: "",
    attachmentIds: [],
    assigneeId: null,
    projectId: null,
    sourceId: null,
    createdAt: "2026-11-27T00:00:00Z",
    updatedAt: "2026-11-27T00:00:00Z",
    future: { kept: true },
  },
});
let current: StickySnapshot;
const events = new Map<string, (event: { payload: unknown }) => void>();
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  events.clear();
  current = {
    binding: { instance: "window-1", cardId: "card", scope: null },
    profile: { monitor: "m1", x: 32, y: 64, width: 280, height: 200, pinned: true, opacity: 100 },
    nativeOpacity: true,
    theme: "light",
    monitors: [],
    content: {
      status: "ready",
      note: note(),
      checkpoint: null,
      currentScope: null,
      readOnly: false,
    },
  };
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    events.set(event as string, handler as (e: { payload: unknown }) => void);
    return () => events.delete(event as string);
  });
  vi.mocked(stickyApi.snapshot).mockImplementation(async () => structuredClone(current));
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
  vi.mocked(stickyApi.checkpoint).mockResolvedValue();
  vi.mocked(stickyApi.clear).mockResolvedValue();
  vi.mocked(stickyApi.close).mockResolvedValue();
  vi.mocked(stickyApi.save).mockImplementation(async (_binding, _sequence, base, patch) => {
    const saved = { ...base, editToken: `saved-${_sequence}`, value: { ...base.value, ...patch } };
    current.content.note = saved;
    return saved;
  });
});
afterEach(() => vi.useRealTimers());
async function open() {
  const hook = renderHook(() => useStickyDraft());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}
async function emit(name: string, payload: unknown = null) {
  await act(async () => {
    events.get(name)?.({ payload });
  });
}
describe("sticky draft lifecycle", () => {
  it.each(["reload", "copy"] as const)(
    "ignores a late %s reply after another mount owns the cache",
    async (operation) => {
      const { result, unmount } = await open();
      act(() => result.current.update("body", "Original mount draft"));
      const reloadGate = deferred<StickySnapshot>(),
        copyGate = deferred<string>();
      vi.mocked(stickyApi.reload).mockReturnValueOnce(reloadGate.promise);
      vi.mocked(stickyApi.copy).mockReturnValueOnce(copyGate.promise);
      let pending!: Promise<void>;
      act(() => {
        pending = result.current[operation]();
      });
      await waitFor(() => expect(stickyApi[operation]).toHaveBeenCalledOnce());
      unmount();
      const key = "nabbit.sticky.draft.v1.local.card";
      localStorage.setItem(key, "A new mount's draft");
      await act(async () => {
        reloadGate.resolve(structuredClone(current));
        copyGate.resolve("new-window");
        await pending;
      });
      expect(localStorage.getItem(key)).toBe("A new mount's draft");
      expect(stickyApi.close).not.toHaveBeenCalled();
    },
  );
  it("locks edits and close while an explicit reload replaces the draft", async () => {
    const { result } = await open();
    act(() => result.current.update("body", "Discard this draft"));
    const gate = deferred<StickySnapshot>();
    vi.mocked(stickyApi.reload).mockReturnValueOnce(gate.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.reload();
    });
    act(() => result.current.update("body", "Must not be lost to the pending reply"));
    expect(result.current.session?.value.body).toBe("Discard this draft");
    await act(async () => result.current.close());
    expect(stickyApi.close).not.toHaveBeenCalled();
    await act(async () => {
      gate.resolve(structuredClone(current));
      await pending;
    });
    expect(result.current.session?.value.body).toBe("Keep it");
    expect(result.current.locked).toBe(false);
  });
  it("clears an older checkpoint when the user undoes all edits", async () => {
    const { result } = await open();
    vi.useFakeTimers();
    act(() => result.current.update("body", "Temporary edit"));
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(stickyApi.checkpoint).toHaveBeenCalledOnce();
    act(() => result.current.update("body", "Keep it"));
    expect(result.current.dirty).toBe(false);
    expect(stickyApi.clear).toHaveBeenCalledWith(current.binding, 3);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(stickyApi.save).not.toHaveBeenCalled();
  });
  it("can close a failed initial load without discarding the native recovery journal", async () => {
    vi.mocked(stickyApi.snapshot).mockRejectedValue(new Error("load failed"));
    vi.mocked(stickyApi.leave).mockResolvedValue();
    const { result } = await open();
    expect(result.current.session).toBeNull();
    await act(async () => result.current.close());
    expect(stickyApi.leave).toHaveBeenCalledOnce();
    expect(stickyApi.close).not.toHaveBeenCalled();
  });
  it("blocks edits during Save as new and keeps its frozen packet on failure", async () => {
    const { result } = await open();
    act(() => result.current.update("body", "Draft to copy"));
    current.content.status = "gone";
    await emit("notes:updated");
    const gate = deferred<string>();
    vi.mocked(stickyApi.copy).mockReturnValueOnce(gate.promise);
    let copying!: Promise<void>;
    act(() => {
      copying = result.current.copy();
    });
    await waitFor(() => expect(stickyApi.copy).toHaveBeenCalledOnce());
    expect(vi.mocked(stickyApi.checkpoint).mock.calls.at(-1)?.[1]).toBe(3);
    act(() => result.current.update("body", "Must not replace the submitted draft"));
    expect(result.current.session?.value.body).toBe("Draft to copy");
    await act(async () => {
      gate.resolve("new-window");
      await copying;
    });
    expect(stickyApi.close).toHaveBeenCalledWith(current.binding, true);
  });
  it("does not overwrite the recovery cache from a late save after unmount", async () => {
    const { result, unmount } = await open();
    const gate = deferred<StoredNote>();
    vi.mocked(stickyApi.save).mockReturnValueOnce(gate.promise);
    act(() => result.current.update("body", "In flight"));
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.flush();
    });
    await waitFor(() => expect(stickyApi.save).toHaveBeenCalledOnce());
    unmount();
    const key = "nabbit.sticky.draft.v1.local.card";
    localStorage.setItem(key, "new window owns this cache");
    await act(async () => {
      gate.resolve(note());
      await pending;
    });
    expect(localStorage.getItem(key)).toBe("new window owns this cache");
  });
  it("single-flights checkpoint, blur and close while preserving typing during a save", async () => {
    const { result } = await open();
    const gate = deferred<void>();
    vi.mocked(stickyApi.checkpoint).mockReturnValueOnce(gate.promise);
    act(() => result.current.update("body", "First edit"));
    let first!: Promise<boolean>, second!: Promise<boolean>;
    act(() => {
      first = result.current.flush();
      second = result.current.flush();
    });
    expect(stickyApi.checkpoint).toHaveBeenCalledTimes(1);
    expect(stickyApi.save).not.toHaveBeenCalled();
    act(() => result.current.update("body", "Newer edit"));
    await act(async () => {
      gate.resolve();
      await Promise.all([first, second]);
    });
    expect(stickyApi.save).toHaveBeenCalledTimes(2);
    expect(vi.mocked(stickyApi.save).mock.calls.map((c) => c[3])).toEqual([
      { body: "First edit" },
      { body: "Newer edit" },
    ]);
    expect(result.current.session?.value.body).toBe("Newer edit");
    expect(result.current.dirty).toBe(false);
    await act(async () => result.current.close());
    expect(stickyApi.close).toHaveBeenCalledWith(current.binding);
  });
  it("checkpoints after quiet time and autosaves only title/body/items with stable checklist metadata", async () => {
    const { result } = await open();
    vi.useFakeTimers();
    act(() => result.current.update("items", [{ ...note().value.items[0], checked: true }]));
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(stickyApi.checkpoint).toHaveBeenCalledTimes(1);
    expect(stickyApi.save).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(450));
    expect(stickyApi.save).toHaveBeenCalledWith(current.binding, 2, note(), {
      items: [{ id: "stable", text: "Verify", checked: true, future: 42 }],
    });
    expect(result.current.session?.value.future).toEqual({ kept: true });
    expect(result.current.dirty).toBe(false);
  });
  it("keeps a failed draft visible and asks before discarding or closing", async () => {
    const { result } = await open();
    vi.mocked(stickyApi.save).mockRejectedValue(new Error("untrusted detail"));
    act(() => result.current.update("body", "Unsaved"));
    await act(async () => result.current.close());
    expect(result.current.closeChoice).toBe(true);
    expect(stickyApi.close).not.toHaveBeenCalled();
    expect(result.current.error).not.toContain("untrusted");
    expect(result.current.session?.value.body).toBe("Unsaved");
    await act(async () => result.current.discardClose());
    expect(stickyApi.close).toHaveBeenCalledWith(current.binding, true);
  });
  it("rehydrates a native checkpoint, rebases noneditable metadata and adopts the new instance", async () => {
    const base = note(),
      value = { ...base.value, body: "Recovered", future: { old: true } };
    current.content.note = {
      ...base,
      editToken: "server-metadata",
      value: { ...base.value, color: "blue", future: { server: true } },
    };
    current.content.checkpoint = {
      instance: "old-window",
      sequence: 19,
      draft: { base, value, copyId: "durable-copy" },
    };
    const { result } = await open();
    expect(result.current.session?.value.body).toBe("Recovered");
    expect(result.current.session?.value.color).toBe("blue");
    expect(result.current.session?.value.future).toEqual({ server: true });
    expect(stickyApi.checkpoint).toHaveBeenCalledWith(
      current.binding,
      1,
      expect.objectContaining({ copyId: "durable-copy" }),
    );
    expect(result.current.locked).toBe(false);
  });
  it("locks a dirty draft after a competing edit without silently replacing it", async () => {
    const { result } = await open();
    act(() => result.current.update("body", "My draft"));
    current.content.note = {
      ...note(),
      editToken: "elsewhere",
      value: { ...note().value, body: "Their edit" },
    };
    await emit("notes:updated");
    expect(result.current.locked).toBe(true);
    expect(result.current.session?.value.body).toBe("My draft");
    await act(async () => result.current.flush());
    expect(stickyApi.save).not.toHaveBeenCalled();
    expect(result.current.error).toContain("changed elsewhere");
  });
  it("keeps removed-card drafts and reuses a frozen capture packet after a lost reply", async () => {
    const { result } = await open();
    act(() => result.current.update("body", "Keep my draft"));
    current.content.status = "gone";
    await emit("notes:updated");
    vi.mocked(stickyApi.copy)
      .mockRejectedValueOnce(new Error("reply lost"))
      .mockResolvedValueOnce("new-window");
    await act(async () => result.current.copy());
    expect(stickyApi.close).not.toHaveBeenCalled();
    expect(result.current.session?.value.body).toBe("Keep my draft");
    await act(async () => result.current.copy());
    const calls = vi.mocked(stickyApi.copy).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0][1].draft.body).toBe("Keep my draft");
    expect(stickyApi.close).toHaveBeenCalledWith(current.binding, true);
    expect(stickyApi.save).not.toHaveBeenCalled();
  });
  it("workspace changes keep the original binding and prevent autosave; read-only forbids edits and copies", async () => {
    const { result } = await open();
    act(() => result.current.update("body", "A draft"));
    current.content.status = "scopeChanged";
    current.content.currentScope = { key: "other", epoch: 9 };
    current.content.readOnly = true;
    await emit("notes:updated");
    act(() => result.current.update("title", "Forbidden"));
    await act(async () => {
      await result.current.flush();
      await result.current.copy();
    });
    expect(result.current.session?.value.title).toBe("Launch checklist");
    expect(result.current.session?.snapshot.binding.scope).toBeNull();
    expect(stickyApi.save).not.toHaveBeenCalled();
    expect(stickyApi.copy).not.toHaveBeenCalled();
  });
  it("applies native theme/profile events and removes listeners on unmount", async () => {
    const { result, unmount } = await open();
    await emit("nabbit://theme-preference", "dark");
    await emit("sticky:profile", { ...current.profile, pinned: false, opacity: 60 });
    expect(result.current.theme).toBe("dark");
    expect(result.current.session?.snapshot.profile.opacity).toBe(60);
    expect(events.size).toBe(6);
    unmount();
    expect(events.size).toBe(0);
  });
  it("disables editing when event registration fails and cleans up late listeners", async () => {
    const late = deferred<() => void>(),
      stop = vi.fn();
    vi.mocked(listen)
      .mockReturnValueOnce(late.promise)
      .mockRejectedValueOnce(new Error("events unavailable"));
    const { unmount } = renderHook(() => useStickyDraft());
    unmount();
    await act(async () => late.resolve(stop));
    expect(stop).toHaveBeenCalledOnce();
    vi.mocked(listen).mockRejectedValue(new Error("unavailable"));
    const { result } = await open();
    expect(result.current.liveUpdates).toBe(false);
    expect(result.current.locked).toBe(true);
  });
});
