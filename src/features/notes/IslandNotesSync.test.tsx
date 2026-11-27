import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { IslandNotesSync } from "./IslandNotesSync";
import { tackApi, type TackSyncSnapshot } from "./tackApi";
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./tackApi", () => ({ tackApi: { syncSnapshot: vi.fn() } }));
const snapshot = (state: TackSyncSnapshot["state"]): TackSyncSnapshot => ({
  state,
  scope: { key: "w", epoch: 1 },
  pending: 2,
  conflicts: 1,
  referenceIssues: 0,
  lastSynced: null,
  error: null,
  nextAttemptMs: null,
});
beforeEach(() => vi.clearAllMocks());
it("keeps a pushed state when the initial snapshot arrives late and cleans up on collapse", async () => {
  let emit!: (event: { payload: TackSyncSnapshot }) => void,
    finish!: (value: TackSyncSnapshot) => void;
  const stop = vi.fn();
  vi.mocked(listen).mockImplementation(async (_event, handler) => {
    emit = handler as typeof emit;
    return stop;
  });
  vi.mocked(tackApi.syncSnapshot).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const open = vi.fn();
  const view = render(<IslandNotesSync open={open} />);
  await waitFor(() => expect(tackApi.syncSnapshot).toHaveBeenCalledTimes(1));
  act(() => emit({ payload: snapshot("conflict") }));
  await act(async () => finish(snapshot("offline")));
  expect(screen.getByText("Conflict")).toBeVisible();
  act(() => screen.getByRole("button", { name: "Open Nabbit" }).click());
  expect(open).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(stop).toHaveBeenCalledTimes(1);
});
it("removes a listener that registers after the expanded surface was destroyed", async () => {
  let finish!: (value: () => void) => void;
  const stop = vi.fn();
  vi.mocked(listen).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<IslandNotesSync open={vi.fn()} />);
  view.unmount();
  await act(async () => finish(stop));
  expect(stop).toHaveBeenCalledTimes(1);
  expect(tackApi.syncSnapshot).not.toHaveBeenCalled();
});
