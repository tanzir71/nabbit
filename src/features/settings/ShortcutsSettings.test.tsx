import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { api } from "../../lib/ipc";
import type { AppSettings, SettingsPatch } from "../../lib/types";
import { SettingsContext } from "./context";
import { ShortcutsSettings } from "./ShortcutsSettings";
import {
  recordedShortcut,
  serializeRecordings,
  shortcutActions,
  shortcutsApi,
  shortcutValue,
  type ShortcutsSnapshot,
} from "./shortcuts";

let initial: AppSettings;
let statuses: ShortcutsSnapshot;
let write: ReturnType<typeof vi.fn<(change: SettingsPatch) => Promise<boolean>>>;
beforeEach(async () => {
  initial = {
    ...(await api.getSettings()),
    islandShortcut: "Alt+Space",
    clipboardSearchShortcut: "Ctrl+Alt+V",
  };
  statuses = {
    rows: shortcutActions.map((a) => ({
      id: a.id,
      shortcut: shortcutValue(initial, a),
      activeShortcut: shortcutValue(initial, a),
      problem: null,
    })),
    recording: false,
    cleanupError: null,
    injected: true,
  };
  write = vi.fn().mockResolvedValue(true);
  vi.spyOn(shortcutsApi, "snapshot").mockImplementation(async () => structuredClone(statuses));
  vi.spyOn(shortcutsApi, "recording").mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());
function Harness() {
  const [settings, setSettings] = useState(initial);
  return (
    <SettingsContext.Provider
      value={{
        settings,
        busy: false,
        patch: async (change) => {
          const saved = await write(change);
          if (saved) setSettings((previous) => ({ ...previous, ...change }) as AppSettings);
          return saved;
        },
      }}
    >
      <ShortcutsSettings />
    </SettingsContext.Provider>
  );
}
async function edit(title = "Open or close the island") {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: `Change ${title}` }));
  const field = screen.getByRole("textbox", { name: "Shortcut combination" });
  await waitFor(() => expect(field).toHaveFocus());
  return { user, field };
}
it("shows every configurable action, and records a chord without saving until explicitly confirmed", async () => {
  render(<Harness />);
  for (const action of shortcutActions)
    expect(screen.getByRole("button", { name: `Change ${action.title}` })).toBeVisible();
  const { user, field } = await edit();
  fireEvent.keyDown(field, { key: "F9", code: "F9", ctrlKey: true, altKey: true });
  expect(field).toHaveValue("Ctrl+Alt+F9");
  expect(write).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Save shortcut" }));
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Shortcut combination" })).not.toBeInTheDocument(),
  );
  expect(write).toHaveBeenCalledExactlyOnceWith({ islandShortcut: "Ctrl+Alt+F9" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Change Open or close the island" })).toHaveFocus(),
  );
  expect(shortcutsApi.recording).toHaveBeenLastCalledWith(expect.any(String), false);
});
it("cancels with Escape, ignores modifier-only/IME/repeated events and preserves the saved binding", async () => {
  render(<Harness />);
  const { field } = await edit();
  for (const event of [
    { key: "Control", code: "ControlLeft", ctrlKey: true },
    { key: "F9", code: "F9", ctrlKey: true, isComposing: true },
    { key: "F9", code: "F9", ctrlKey: true, repeat: true },
  ])
    fireEvent.keyDown(field, event);
  expect(field).toHaveValue("Alt+Space");
  fireEvent.keyDown(field, { key: "Escape" });
  expect(write).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
});
it("supports explicit disable and a typed combination for keys another app consumes", async () => {
  render(<Harness />);
  let editor = await edit("Quick note");
  fireEvent.keyDown(editor.field, { key: "Delete", code: "Delete" });
  expect(editor.field).toHaveValue("");
  expect(screen.getByRole("status")).toHaveTextContent("will be disabled");
  await editor.user.click(screen.getByRole("button", { name: "Save shortcut" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith({ quickNoteShortcut: "" }));
  editor = await edit("Quick note");
  await editor.user.click(screen.getByRole("button", { name: "Type instead" }));
  await editor.user.type(editor.field, "Ctrl+Alt+F8");
  await editor.user.click(screen.getByRole("button", { name: "Save shortcut" }));
  await waitFor(() => expect(write).toHaveBeenLastCalledWith({ quickNoteShortcut: "Ctrl+Alt+F8" }));
});
it("shows a startup Conflict badge and keeps a rejected draft available for retry", async () => {
  statuses.rows.find((row) => row.id === "hideIsland")!.problem = {
    shortcut: "Ctrl+Alt+H",
    message: "Also used by another app.",
    conflict: true,
  };
  statuses.rows.find((row) => row.id === "hideIsland")!.activeShortcut = null;
  render(<Harness />);
  expect(await screen.findByText("Conflict")).toBeVisible();
  expect(screen.getByText(/Nabbit skips this shortcut/)).toBeVisible();
  const { user, field } = await edit("Hide island for an hour");
  fireEvent.keyDown(field, { key: "F9", code: "F9", altKey: true, ctrlKey: true });
  write.mockResolvedValueOnce(false);
  statuses.rows.find((row) => row.id === "hideIsland")!.problem = {
    shortcut: "Ctrl+Alt+F9",
    message: "Shortcut conflict: already registered",
    conflict: true,
  };
  await user.click(screen.getByRole("button", { name: "Save shortcut" }));
  await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
  expect(field).toHaveValue("Ctrl+Alt+F9");
  statuses.rows.find((row) => row.id === "hideIsland")!.problem = null;
  await user.click(screen.getByRole("button", { name: "Save shortcut" }));
  await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
  expect(write).toHaveBeenCalledTimes(2);
});
it("suppresses duplicate saves while the first request is in flight and retains the focused control", async () => {
  let finish!: (value: boolean) => void;
  write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<Harness />);
  const { field } = await edit("Start or stop focus timer");
  fireEvent.keyDown(field, { key: "F7", code: "F7", altKey: true, ctrlKey: true });
  const save = screen.getByRole("button", { name: "Save shortcut" });
  save.focus();
  fireEvent.click(save);
  fireEvent.click(save);
  expect(write).toHaveBeenCalledOnce();
  expect(save).toHaveFocus();
  expect(save).toHaveAttribute("aria-disabled", "true");
  await act(async () => finish(true));
});
it("reports unavailable status and allows a retry without resetting settings", async () => {
  vi.mocked(shortcutsApi.snapshot).mockRejectedValueOnce(new Error("Owned status failure"));
  render(<Harness />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Owned status failure");
  await userEvent.click(screen.getByRole("button", { name: "Retry status" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(write).not.toHaveBeenCalled();
});
it("maps punctuation, numpad and non-Latin layout keys using supported native key names", () => {
  const base = {
    key: "=",
    code: "Equal",
    ctrlKey: true,
    altKey: false,
    shiftKey: true,
    metaKey: false,
    isComposing: false,
    keyCode: 0,
    repeat: false,
  };
  expect(recordedShortcut(base)).toBe("Ctrl+Shift+Equal");
  expect(recordedShortcut({ ...base, key: "й", code: "KeyQ" })).toBe("Ctrl+Shift+KeyQ");
  expect(recordedShortcut({ ...base, key: "1", code: "Numpad1" })).toBe("Ctrl+Shift+Numpad1");
  expect(
    recordedShortcut({ ...base, key: "a", code: "KeyA", ctrlKey: false, shiftKey: false }),
  ).toBeNull();
});
it("orders recorder starts and stops when the previous native request finishes late", async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const send = serializeRecordings(async (token, active) => {
    calls.push(`${token}:${active}`);
    if (calls.length === 1)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
  });
  const first = send("old", true);
  const canceled = send("old", false);
  const next = send("new", true);
  await Promise.resolve();
  expect(calls).toEqual(["old:true"]);
  finish();
  await Promise.all([first, canceled, next]);
  expect(calls).toEqual(["old:true", "old:false", "new:true"]);
});
it("lets a new recording start after an earlier request failed", async () => {
  const backend = vi
    .fn()
    .mockRejectedValueOnce(new Error("Owned IPC failure"))
    .mockResolvedValue(undefined);
  const send = serializeRecordings(backend);
  await expect(send("old", true)).rejects.toThrow("Owned IPC failure");
  await expect(send("new", true)).resolves.toBeUndefined();
  expect(backend).toHaveBeenLastCalledWith("new", true);
});
it("pauses recording on window blur and reacquires it before accepting more keys", async () => {
  render(<Harness />);
  const { field } = await edit();
  fireEvent.blur(window);
  expect(field).toBeDisabled();
  expect(shortcutsApi.recording).toHaveBeenLastCalledWith(expect.any(String), false);
  fireEvent.focus(window);
  await waitFor(() => expect(field).toBeEnabled());
  expect(field).toHaveFocus();
  expect(shortcutsApi.recording).toHaveBeenLastCalledWith(expect.any(String), true);
  expect(write).not.toHaveBeenCalled();
});
