import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { FocusTimer } from "./FocusTimer";
import { timerApi, type TimerSnapshot } from "./api";
import { notesApi } from "../notes/api";
import type { NotesState } from "../notes/types";
import fixture from "../../../tests/fixtures/timer/running.json";
vi.mock("./api", () => ({ timerApi: { snapshot: vi.fn(), action: vi.fn(), view: vi.fn() } }));
vi.mock("../notes/api", () => ({ notesApi: { state: vi.fn(), open: vi.fn() } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
let data: TimerSnapshot,
  callbacks: Map<string, (payload: unknown) => void>,
  stops: Array<ReturnType<typeof vi.fn>>;
beforeEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  data = structuredClone(fixture) as TimerSnapshot;
  callbacks = new Map();
  stops = [];
  vi.mocked(timerApi.snapshot).mockImplementation(async () => data);
  vi.mocked(timerApi.view).mockResolvedValue();
  vi.mocked(timerApi.action).mockImplementation(async () => data);
  vi.mocked(notesApi.open).mockResolvedValue();
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    const stop = vi.fn();
    stops.push(stop);
    callbacks.set(name, (payload) => handler({ event: name, id: 1, payload }));
    return stop;
  });
});
it("renders actual remaining time and round/link data with functioning Pause/Stop and deferred logging", async () => {
  const user = userEvent.setup();
  render(<FocusTimer />);
  await screen.findByRole("heading", { name: "Focus · round 2 of 4" });
  expect(screen.getByRole("progressbar", { name: "Focus time remaining" })).toHaveAttribute(
    "aria-valuenow",
    "1453",
  );
  expect(screen.getByText("24:13")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Pause" }));
  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(timerApi.action).toHaveBeenNthCalledWith(1, 4, { kind: "pause" });
  expect(timerApi.action).toHaveBeenNthCalledWith(2, 4, { kind: "stop" });
  expect(screen.getByRole("switch", { name: "Log time to Tack (v2.1)" })).toBeDisabled();
  expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
});
it("selecting presets explicitly prepares the next timer and never starts one", async () => {
  const user = userEvent.setup();
  render(<FocusTimer />);
  await screen.findByText("24:13");
  await user.click(screen.getByRole("button", { name: "50 / 10" }));
  expect(timerApi.action).toHaveBeenCalledWith(4, {
    kind: "configure",
    config: { ...data.config, preset: "50/10", focusS: 3000, breakS: 600, rounds: 4 },
  });
  expect(vi.mocked(timerApi.action).mock.calls.some(([, a]) => a.kind === "start")).toBe(false);
});
it("custom form preserves empty numeric input and a rejected draft", async () => {
  const user = userEvent.setup();
  render(<FocusTimer />);
  await screen.findByText("24:13");
  await user.click(screen.getByRole("button", { name: "Custom" }));
  const focus = screen.getByRole("spinbutton", { name: "Focus minutes" });
  await user.clear(focus);
  expect(focus).toHaveValue(null);
  await user.type(focus, "37");
  await user.clear(screen.getByRole("spinbutton", { name: "Break minutes" }));
  await user.type(screen.getByRole("spinbutton", { name: "Break minutes" }), "7");
  vi.mocked(timerApi.action).mockRejectedValueOnce(new Error("The timer changed"));
  await user.click(screen.getByRole("button", { name: "Use custom timer" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("timer changed");
  expect(focus).toHaveValue(37);
  await user.click(screen.getByRole("button", { name: "Use custom timer" }));
  expect(vi.mocked(timerApi.action).mock.lastCall).toEqual([
    4,
    { kind: "configure", config: { ...data.config, preset: "custom", focusS: 2220, breakS: 420 } },
  ]);
  await waitFor(() => expect(screen.queryByRole("form", { name: "Custom timer" })).toBeNull());
});
it("uses pushed state for paused/ended peek variants without any renderer clock", async () => {
  const view = render(<FocusTimer peek />);
  await screen.findByText("24:13");
  vi.useFakeTimers();
  act(() => vi.advanceTimersByTime(7_200_000));
  expect(timerApi.snapshot).toHaveBeenCalledTimes(1);
  expect(screen.getByText("24:13")).toBeInTheDocument();
  act(() =>
    callbacks.get("nabbit://timer")!({
      ...data,
      revision: 2,
      session: { ...data.session!, status: "paused" },
    }),
  );
  expect(screen.getByRole("button", { name: "Resume timer" })).toBeEnabled();
  act(() =>
    callbacks.get("nabbit://timer")!({
      ...data,
      revision: 3,
      session: { ...data.session!, status: "ended", remainingS: 0 },
    }),
  );
  expect(screen.getByRole("button", { name: "Start break timer" })).toBeEnabled();
  expect(screen.getByText("0:00")).toBeInTheDocument();
  view.unmount();
  vi.useRealTimers();
});
it("links and opens a card with its actual ref and workspace guard, preserving a failed selection", async () => {
  const user = userEvent.setup();
  vi.mocked(notesApi.state).mockResolvedValue({
    cards: [
      {
        value: {
          id: "choice",
          ref: "tck-31",
          title: "Another card",
          archived: false,
          trashedAt: null,
        },
        scope: { key: "fixture-workspace", epoch: 1 },
      },
    ],
  } as NotesState);
  render(<FocusTimer />);
  await screen.findByText("24:13");
  await user.click(screen.getByRole("button", { name: /tck-24.*Island window spike/ }));
  await screen.findByRole("button", { name: /tck-31.*Another card/ });
  await user.click(screen.getByRole("button", { name: "Open linked card" }));
  expect(notesApi.open).toHaveBeenCalledWith({
    kind: "card",
    id: "timer-card",
    expectedScope: { key: "fixture-workspace", epoch: 1 },
  });
  vi.mocked(timerApi.action).mockRejectedValueOnce(new Error("Workspace changed"));
  await user.click(screen.getByRole("button", { name: /tck-31.*Another card/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Workspace changed");
  expect(screen.getByRole("group", { name: "Link a card" })).toBeInTheDocument();
  expect(timerApi.action).toHaveBeenLastCalledWith(4, {
    kind: "link",
    card: { id: "choice", expectedScope: { key: "fixture-workspace", epoch: 1 } },
  });
});
it("subscribes before reading, rejects stale reads and revokes distinct StrictMode leases", async () => {
  let resolve!: (s: TimerSnapshot) => void;
  vi.mocked(timerApi.snapshot).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(
    <StrictMode>
      <FocusTimer />
    </StrictMode>,
  );
  await waitFor(() => expect(timerApi.snapshot).toHaveBeenCalledTimes(1));
  act(() =>
    callbacks.get("nabbit://timer")!({
      ...data,
      revision: 10,
      config: { ...data.config, label: "Pushed focus" },
    }),
  );
  await act(async () => resolve({ ...data, revision: 2 }));
  expect(screen.getByRole("heading", { name: /Pushed focus/ })).toBeInTheDocument();
  view.unmount();
  await waitFor(() => expect(timerApi.view).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(timerApi.view).mock.calls;
  expect(calls[0]).toEqual([calls[1][0], true]);
  expect(calls[1][1]).toBe(false);
  expect(stops.every((s) => s.mock.calls.length === 1)).toBe(true);
});
it("blocks overlapping mutations and sends the latest generation after a pushed acknowledgement", async () => {
  const user = userEvent.setup();
  let resolve!: (s: TimerSnapshot) => void;
  vi.mocked(timerApi.action).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<FocusTimer />);
  await screen.findByText("24:13");
  await user.click(screen.getByRole("button", { name: "Pause" }));
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  const paused = {
    ...data,
    revision: 2,
    generation: 5,
    session: { ...data.session!, status: "paused" as const },
  };
  act(() => callbacks.get("nabbit://timer")!(paused));
  expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
  await act(async () => resolve(paused));
  vi.mocked(timerApi.action).mockResolvedValue({
    ...paused,
    revision: 3,
    generation: 6,
    session: { ...paused.session, status: "running" },
  });
  await user.click(screen.getByRole("button", { name: "Resume" }));
  expect(timerApi.action).toHaveBeenLastCalledWith(5, { kind: "resume" });
});
