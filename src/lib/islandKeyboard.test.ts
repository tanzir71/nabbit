import { expect, it, vi } from "vitest";
import { connectIslandKeyboard, keyboardIntent, type KeyInput } from "./islandKeyboard";
import { createIslandStore } from "../store/islandStore";
const key = (key: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  ...extra,
});
it("routes expanded tab and pin slots only for their exact modifiers", () => {
  for (let n = 1; n <= 6; n++)
    expect(
      keyboardIntent(key(String(n), { ctrlKey: true }), "expanded", true, false),
    ).toMatchObject({ type: "tab" });
  for (let n = 1; n <= 9; n++)
    expect(keyboardIntent(key(String(n), { altKey: true }), "expanded", true, false)).toEqual({
      type: "pin",
      slot: n,
    });
  expect(
    keyboardIntent(key("1", { altKey: true, ctrlKey: true }), "expanded", false, false),
  ).toBeNull();
  expect(keyboardIntent(key("7", { ctrlKey: true }), "expanded", false, false)).toBeNull();
  expect(keyboardIntent(key("1", { altKey: true }), "peek", false, false)).toBeNull();
  expect(
    keyboardIntent(key("1", { altKey: true, repeat: true }), "expanded", false, false),
  ).toBeNull();
});
it("preserves editing, IME, AltGraph and the Space action on buttons", () => {
  expect(keyboardIntent(key("p"), "expanded", false, false)).toEqual({ type: "search", text: "p" });
  expect(keyboardIntent(key("😀"), "expanded", false, false)).toEqual({
    type: "search",
    text: "😀",
  });
  expect(keyboardIntent(key("p"), "expanded", true, false)).toBeNull();
  expect(keyboardIntent(key(" "), "expanded", false, true)).toBeNull();
  expect(keyboardIntent(key("Dead"), "expanded", false, false)).toBeNull();
  expect(keyboardIntent(key("Escape", { isComposing: true }), "expanded", true, false)).toBeNull();
  expect(
    keyboardIntent(
      key("1", { altKey: true, getModifierState: () => true }),
      "expanded",
      false,
      false,
    ),
  ).toEqual({ type: "search", text: "1" });
});
it("supports toggle, collapse and both Tab directions without waking hidden surfaces", () => {
  expect(keyboardIntent(key(" ", { altKey: true }), "faded", false, false)).toEqual({
    type: "toggle",
  });
  expect(keyboardIntent(key("Escape"), "expanded", true, false)).toEqual({ type: "escape" });
  expect(keyboardIntent(key("Tab", { shiftKey: true }), "expanded", false, false)).toEqual({
    type: "cycle",
    backwards: true,
  });
  expect(keyboardIntent(key("p"), "hidden", false, false)).toBeNull();
});
it("keeps a fast first word while lazy Search mounts and cancels its observer on teardown", async () => {
  const root = document.createElement("main");
  document.body.append(root);
  const store = createIslandStore("island");
  store.setState({ state: "expanded", gate: "visible" });
  const binding = connectIslandKeyboard(root, store, { toggle: vi.fn(), pin: vi.fn() });
  for (const key of "pdf")
    root.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  expect(store.getState().searchText).toBe("pdf");
  const input = document.createElement("input");
  input.setAttribute("aria-label", "Search island");
  input.getClientRects = () => [{ width: 200, height: 30 }] as unknown as DOMRectList;
  root.append(input);
  await Promise.resolve();
  expect(document.activeElement).toBe(input);
  binding.dispose();
  root.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
  expect(store.getState().searchText).toBe("pdf");
  root.remove();
});
