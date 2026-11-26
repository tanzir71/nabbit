import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { IslandShortcutField } from "./IslandShortcutField";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue({}) }));
it("edits a shortcut without saving intermediate strings and reports a rejected remap", async () => {
  const save = vi.fn().mockRejectedValue(new Error("Shortcut is already in use"));
  render(<IslandShortcutField value="Alt+Space" save={save} />);
  const input = screen.getByRole("textbox", { name: "Island shortcut" });
  fireEvent.change(input, { target: { value: "Ctrl+Alt+F9" } });
  expect(save).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));
  expect(save).toHaveBeenCalledWith("Ctrl+Alt+F9");
  expect(screen.getByText("Error: Shortcut is already in use")).toBeVisible();
});
it("supports an empty binding without treating IME Enter as a save", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<IslandShortcutField value="Alt+Space" save={save} />);
  const input = screen.getByRole("textbox", { name: "Island shortcut" });
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(save).not.toHaveBeenCalled();
  fireEvent.blur(input);
  await waitFor(() => expect(save).toHaveBeenCalledWith(""));
});
it("does not clear a rejected remap when an older startup status arrives late", async () => {
  let resolveStatus!: (value: unknown) => void;
  vi.mocked(invoke).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveStatus = resolve;
    }),
  );
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  try {
    render(<IslandShortcutField value="Alt+Space" save={vi.fn().mockRejectedValue("Conflict")} />);
    const input = screen.getByRole("textbox", { name: "Island shortcut" });
    fireEvent.change(input, { target: { value: "Ctrl+Alt+F9" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Conflict");
    await act(async () => resolveStatus({ keyboard: { shortcutError: null } }));
    expect(screen.getByText("Conflict")).toBeVisible();
  } finally {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
});
