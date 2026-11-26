import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../lib/ipc";
import type { IslandSnapshot } from "../lib/types";
import { useAppStore } from "../store/useAppStore";
import { IslandSettings } from "./IslandSettings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function Panel() {
  const settings = useAppStore((state) => state.settings);
  return settings && <IslandSettings value={settings.island} />;
}
async function setup() {
  const settings = {
    ...(await api.getSettings()),
    island: {
      enabled: true,
      shape: "island" as const,
      size: "standard" as const,
      monitorMode: "followMouse" as const,
      monitorId: null,
    },
  };
  useAppStore.setState({ settings });
  const snapshot: IslandSnapshot = {
    supported: true,
    lastError: null,
    desktop: {
      monitors: [
        { id: "left", name: "Left display", primary: false, scaleFactor: 1 },
        { id: "primary", name: "Main display", primary: true, scaleFactor: 1.5 },
      ],
    },
  };
  vi.spyOn(api, "getIslandSnapshot").mockResolvedValue(snapshot);
  const stop = vi.fn();
  let event!: (value: IslandSnapshot) => void;
  vi.spyOn(api, "onEvent").mockImplementation(async (_name, handler) => {
    event = handler as typeof event;
    return stop;
  });
  const save = vi
    .spyOn(api, "saveIslandPreferences")
    .mockImplementation(async (island) => ({ ...settings, island }));
  render(<Panel />);
  await waitFor(() => expect(api.getIslandSnapshot).toHaveBeenCalledOnce());
  return {
    user: userEvent.setup(),
    save,
    stop,
    snapshot,
    emit: (next: IslandSnapshot) => act(() => event(next)),
  };
}
it("persists independent shape, size, monitor and enabled changes without overwriting other settings", async () => {
  const { user, save } = await setup();
  await user.click(screen.getByRole("button", { name: "Notch" }));
  await user.click(screen.getByRole("button", { name: "Large" }));
  await user.selectOptions(screen.getByLabelText("Monitor", { exact: true }), "specific");
  await user.selectOptions(screen.getByLabelText("Specific monitor", { exact: true }), "left");
  await user.click(screen.getByRole("switch", { name: "Show island" }));
  expect(save).toHaveBeenLastCalledWith({
    enabled: false,
    shape: "notch",
    size: "large",
    monitorMode: "specific",
    monitorId: "left",
  });
  expect(screen.getByRole("button", { name: "Notch" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Large" })).toHaveAttribute("aria-pressed", "true");
});
it("keeps the chosen monitor when disconnected and cleans up the event subscription", async () => {
  const { user, snapshot, emit, stop } = await setup();
  await user.selectOptions(screen.getByLabelText("Monitor", { exact: true }), "specific");
  await user.selectOptions(screen.getByLabelText("Specific monitor", { exact: true }), "left");
  emit({ ...snapshot, desktop: { monitors: [snapshot.desktop.monitors[1]] } });
  expect(
    screen.getByText("Disconnected. Using the primary display until it returns."),
  ).toBeVisible();
  expect(screen.getByLabelText("Specific monitor", { exact: true })).toHaveValue("left");
  emit(snapshot);
  expect(screen.queryByText(/Disconnected\./)).toBeNull();
  expect(screen.getByLabelText("Specific monitor", { exact: true })).toHaveValue("left");
  cleanup();
  await waitFor(() => expect(stop).toHaveBeenCalledOnce());
});
it("reports save failures and prevents overlapping preference writes", async () => {
  const { user, save } = await setup();
  let reject!: (error: Error) => void;
  save.mockImplementationOnce(
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  await user.click(screen.getByRole("button", { name: "Notch" }));
  await user.click(screen.getByRole("button", { name: "Large" }));
  expect(save).toHaveBeenCalledOnce();
  await act(async () => reject(new Error("Database busy")));
  expect(screen.getByRole("alert")).toHaveTextContent("Database busy");
  expect(screen.getByRole("button", { name: "Floating island" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await user.click(screen.getByRole("button", { name: "Large" }));
  expect(save).toHaveBeenCalledTimes(2);
});
