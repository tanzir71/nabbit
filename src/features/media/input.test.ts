import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { mediaApi } from "./api";
import { connectMediaInput } from "./input";
import { createIslandStore } from "../../store/islandStore";
vi.mock("./api", () => ({ mediaApi: { action: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(mediaApi.action).mockResolvedValue();
  vi.mocked(invoke).mockResolvedValue(undefined);
});
function setup() {
  const pill = document.createElement("div"),
    button = document.createElement("button");
  pill.append(button);
  document.body.append(pill);
  const store = createIslandStore("island", {
    tab: "media",
    filters: {},
    searchText: "",
    scroll: {},
  });
  store.setState({ state: "live", gate: "visible" });
  const stop = connectMediaInput(pill, store, vi.fn());
  return {
    pill,
    button,
    store,
    stop: () => {
      stop();
      pill.remove();
    },
  };
}
it("accumulates precision wheel input and preserves the 2/1 percent direction contract", () => {
  const { pill, stop } = setup();
  const wheel = (deltaY: number, shiftKey = false, deltaMode = 0) =>
    pill.dispatchEvent(new WheelEvent("wheel", { deltaY, shiftKey, deltaMode, cancelable: true }));
  wheel(-50);
  expect(mediaApi.action).not.toHaveBeenCalled();
  expect(wheel(-50)).toBe(false);
  wheel(100, true);
  wheel(-3, false, 1);
  expect(vi.mocked(mediaApi.action).mock.calls.map(([a]) => a)).toEqual([
    { kind: "volumeStep", direction: 1, fine: false },
    { kind: "volumeStep", direction: -1, fine: true },
    { kind: "volumeStep", direction: 1, fine: false },
  ]);
  stop();
  wheel(100);
  expect(mediaApi.action).toHaveBeenCalledTimes(3);
});
it("leaves editors, controls, non-media expanded lists and hidden/drop surfaces alone", () => {
  const { pill, button, store, stop } = setup();
  button.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
  for (const state of [
    { state: "expanded" as const, tab: "files" as const },
    { gate: "hidden" as const },
    { state: "drop" as const, gate: "visible" as const },
  ]) {
    store.setState(state);
    pill.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true }));
  }
  expect(mediaApi.action).not.toHaveBeenCalled();
  stop();
});
it("middle-click prevents autoscroll and toggles the backend-selected session without reading it", async () => {
  const { pill, stop } = setup();
  expect(pill.dispatchEvent(new MouseEvent("mousedown", { button: 1, cancelable: true }))).toBe(
    false,
  );
  expect(pill.dispatchEvent(new MouseEvent("auxclick", { button: 1, cancelable: true }))).toBe(
    false,
  );
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith("media_toggle"));
  stop();
});
