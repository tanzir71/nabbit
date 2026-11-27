import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { MediaPlayer } from "./MediaPlayer";
import { mediaApi, type MediaSnapshot } from "./api";
import fixture from "../../../tests/fixtures/media/sessions.json";
vi.mock("./api", () => ({ mediaApi: { snapshot: vi.fn(), select: vi.fn(), action: vi.fn() } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
let data: MediaSnapshot, push: (s: MediaSnapshot) => void, stops: Array<ReturnType<typeof vi.fn>>;
beforeEach(() => {
  vi.resetAllMocks();
  data = structuredClone(fixture);
  stops = [];
  vi.mocked(listen).mockImplementation(async (_event, handler) => {
    const stop = vi.fn();
    stops.push(stop);
    push = (payload) => handler({ event: "nabbit://media", id: 1, payload });
    return stop;
  });
  vi.mocked(mediaApi.snapshot).mockImplementation(async () => data);
  vi.mocked(mediaApi.select).mockResolvedValue();
  vi.mocked(mediaApi.action).mockResolvedValue();
});
it("renders recorded metadata, timeline and supported controls and sends exact typed actions", async () => {
  const user = userEvent.setup();
  render(<MediaPlayer />);
  await screen.findByText("Night Drive");
  expect(screen.getByText("Kiln · Media Player")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Pause playback" }));
  await user.click(screen.getByRole("button", { name: "Previous track" }));
  await user.click(screen.getByRole("button", { name: "Next track" }));
  fireEvent.change(screen.getByRole("slider", { name: "Playback position" }), {
    target: { value: "120" },
  });
  fireEvent.change(screen.getByRole("slider", { name: "System volume" }), {
    target: { value: "72" },
  });
  await user.click(screen.getByRole("button", { name: "Mute" }));
  expect(vi.mocked(mediaApi.action).mock.calls.map(([a]) => a)).toEqual([
    { kind: "toggle", id: "player" },
    { kind: "previous", id: "player" },
    { kind: "next", id: "player" },
    { kind: "seek", id: "player", positionS: 120 },
    { kind: "volume", percent: 72 },
    { kind: "mute", muted: true },
  ]);
});
it("switches with session chips, renders paused/no timeline and disables unsupported controls", async () => {
  const user = userEvent.setup();
  const view = render(<MediaPlayer />);
  await screen.findByText("Night Drive");
  await user.click(screen.getByRole("button", { name: "Browser" }));
  expect(mediaApi.select).toHaveBeenCalledWith("browser");
  data = { ...data, revision: 2, selected: "browser" };
  act(() => push(data));
  expect(screen.getByText("Live radio")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Play playback" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Next track" })).toBeDisabled();
  expect(view.container.querySelector("[data-media-timeline]")).toBeNull();
  view.rerender(<MediaPlayer peek />);
  expect(view.container.querySelector(".media-peek")).toBeInTheDocument();
  act(() => push({ ...data, revision: 3, sessions: [], selected: null, volume: null }));
  expect(screen.getByText("Nothing playing")).toBeInTheDocument();
});
it("subscribes before snapshot, ignores stale snapshot completion and revokes StrictMode listeners", async () => {
  let resolve!: (s: MediaSnapshot) => void;
  vi.mocked(mediaApi.snapshot).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(
    <StrictMode>
      <MediaPlayer />
    </StrictMode>,
  );
  await waitFor(() => expect(mediaApi.snapshot).toHaveBeenCalledTimes(1));
  act(() =>
    push({ ...data, revision: 10, sessions: [{ ...data.sessions[0], title: "Pushed first" }] }),
  );
  await act(async () => resolve({ ...data, revision: 2 }));
  expect(screen.getByText("Pushed first")).toBeInTheDocument();
  view.unmount();
  expect(stops).toHaveLength(2);
  expect(stops.every((s) => s.mock.calls.length === 1)).toBe(true);
});
it("reports player errors and does not call IPC again during idle time", async () => {
  vi.mocked(mediaApi.action).mockRejectedValue(new Error("Player declined"));
  render(<MediaPlayer />);
  await screen.findByText("Night Drive");
  fireEvent.click(screen.getByRole("button", { name: "Pause playback" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Player declined");
  expect(mediaApi.snapshot).toHaveBeenCalledTimes(1);
  expect(listen).toHaveBeenCalledTimes(1);
});
