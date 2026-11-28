import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsPanel } from "../../views/SettingsPanel";
import { api } from "../../lib/ipc";
import { useAppStore } from "../../store/useAppStore";

vi.mock("../notes/TackSettings", () => ({
  TackSettings: () => <p>Tack connection and bookmark import</p>,
}));
vi.mock("../tools/FilesSettings", () => ({
  default: () => <p>File presets and Explorer integration</p>,
}));
vi.mock("../files/Pins", () => ({ Pins: () => <p>Pinned files and folders</p> }));
vi.mock("../tools/Licenses", () => ({ default: () => <p>Third party licences</p> }));
vi.mock("../../views/EngineHealthCard", () => ({ EngineHealthCard: () => <p>Engine health</p> }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function setup() {
  const initial = {
    ...(await api.getSettings()),
    retentionDays: 30 as const,
    theme: "system" as const,
    islandActivity: {
      order: [
        "privacy",
        "timerEnding",
        "download",
        "tool",
        "link",
        "result",
        "media",
        "timer",
        "power",
      ] as import("../../lib/activity").ActivityKind[],
      disabled: [],
      showAlertsOverFullscreen: false,
      focusMode: false,
      hiddenUntilMs: null,
    },
  };
  useAppStore.setState({ settings: initial, loading: false });
  const save = vi.spyOn(api, "patchSettings").mockImplementation(async (change) => {
    const current = useAppStore.getState().settings!;
    return {
      ...current,
      ...change,
      island: { ...current.island, ...change.island },
      islandActivity: { ...current.islandActivity!, ...change.islandActivity },
    };
  });
  vi.spyOn(api, "getIslandSnapshot").mockResolvedValue({
    supported: true,
    desktop: { monitors: [] },
    lastError: null,
  });
  vi.spyOn(api, "onEvent").mockResolvedValue(() => {});
  const close = vi.fn();
  render(<SettingsPanel onClose={close} />);
  return { user: userEvent.setup(), save, close };
}
it("navigates all nine sections and returns keyboard focus to the page heading", async () => {
  const { user, close } = await setup();
  const nav = within(screen.getByRole("navigation", { name: "Settings sections" }));
  for (const label of [
    "Island",
    "Widgets",
    "Downloads",
    "Notes & Tack",
    "Clipboard",
    "Files",
    "Shortcuts",
    "Privacy & about",
    "General",
  ]) {
    await user.click(nav.getByRole("button", { name: label }));
    expect(screen.getByRole("heading", { level: 1, name: label })).toHaveFocus();
    expect(nav.getByRole("button", { name: label })).toHaveAttribute("aria-current", "page");
  }
  await user.click(screen.getByRole("button", { name: "Close settings" }));
  expect(close).toHaveBeenCalledOnce();
});
it("keeps keyboard focus on a mode choice while saving and ignores another activation until it completes", async () => {
  const { user, save } = await setup();
  const previous = useAppStore.getState().settings!;
  let finish!: () => void;
  save.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { ...previous, displayMode: "trayOnly" };
  });
  const choice = screen.getByRole("button", { name: /^Tray only/ });
  choice.focus();
  await user.keyboard("[Space]");
  await waitFor(() => expect(choice).toHaveAttribute("aria-disabled", "true"));
  expect(choice).toHaveFocus();
  await user.keyboard("[Space]");
  expect(save).toHaveBeenCalledOnce();
  await act(async () => {
    finish();
  });
  await waitFor(() => expect(choice).toHaveAttribute("aria-pressed", "true"));
  expect(choice).toHaveFocus();
  expect(save).toHaveBeenCalledWith({ displayMode: "trayOnly" });
});
it("sends only changed fields and exposes a failed save before a successful retry", async () => {
  const { user, save } = await setup();
  save.mockRejectedValueOnce(new Error("Owned database busy"));
  await user.click(screen.getByRole("button", { name: "Dark" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Owned database busy");
  expect(useAppStore.getState().settings?.theme).toBe("system");
  await user.click(screen.getByRole("button", { name: "Dark" }));
  await waitFor(() => expect(useAppStore.getState().settings?.theme).toBe("dark"));
  expect(save).toHaveBeenLastCalledWith({ theme: "dark" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("edits a complete path before saving and preserves an unrelated concurrent preference", async () => {
  const { user, save } = await setup();
  await user.click(screen.getByRole("button", { name: "Downloads" }));
  const input = screen.getByRole("textbox", { name: "Output folder" });
  await user.clear(input);
  await user.type(input, "D:\\Owned fixtures\\Downloads");
  expect(save).not.toHaveBeenCalled();
  act(() => {
    useAppStore.setState((s) => ({ settings: { ...s.settings!, retentionDays: 90 } }));
  });
  await user.tab();
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({ outputDir: "D:\\Owned fixtures\\Downloads" }),
  );
  expect(useAppStore.getState().settings?.retentionDays).toBe(90);
});
it("reorders and disables activities through independent nested patches", async () => {
  const { user, save } = await setup();
  await user.click(screen.getByRole("button", { name: "Island" }));
  await user.click(screen.getByRole("button", { name: "Live activities" }));
  await user.click(screen.getByRole("button", { name: "Move Downloads up" }));
  await waitFor(() =>
    expect(useAppStore.getState().settings?.islandActivity?.order[1]).toBe("download"),
  );
  await user.click(screen.getByRole("switch", { name: "Now playing" }));
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith({ islandActivity: { disabled: ["media"] } }),
  );
  expect(useAppStore.getState().settings?.islandActivity?.order[1]).toBe("download");
});
it("cancels a dirty field with Escape and keeps a failed edit available for retry", async () => {
  const { user, save } = await setup();
  await user.click(screen.getByRole("button", { name: "Downloads" }));
  const input = screen.getByRole("textbox", { name: "Output folder" });
  const original = (input as HTMLInputElement).value;
  await user.clear(input);
  await user.type(input, "D:\\Owned fixtures\\Cancelled");
  await user.keyboard("{Escape}");
  expect(save).not.toHaveBeenCalled();
  expect(input).toHaveValue(original);
  await user.clear(input);
  await user.type(input, "D:\\Owned fixtures\\Retry");
  save.mockRejectedValueOnce(new Error("Owned database busy"));
  await user.tab();
  await screen.findByRole("alert");
  expect(input).toHaveValue("D:\\Owned fixtures\\Retry");
  await user.click(input);
  await user.tab();
  await waitFor(() =>
    expect(useAppStore.getState().settings?.outputDir).toBe("D:\\Owned fixtures\\Retry"),
  );
});
it("requires an explicit confirmation before clearing clipboard history", async () => {
  const { user } = await setup();
  const clear = vi.spyOn(useAppStore.getState(), "clearHistory").mockResolvedValue();
  await user.click(screen.getByRole("button", { name: "Clipboard" }));
  await user.click(screen.getByRole("button", { name: "Clear clipboard history" }));
  expect(clear).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(clear).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Clear clipboard history" }));
  await user.click(screen.getByRole("button", { name: "Clear history" }));
  expect(clear).toHaveBeenCalledOnce();
});
