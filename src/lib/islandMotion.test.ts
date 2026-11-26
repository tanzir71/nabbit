import { afterEach, expect, it, vi } from "vitest";
import { observeIslandMotion } from "./islandMotion";
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});
it("keeps an inert exit snapshot for the content fade, without scheduling JS timers", () => {
  vi.useFakeTimers();
  const pill = document.createElement("div"),
    content = document.createElement("div"),
    exit = document.createElement("div");
  pill.append(content, exit);
  document.body.append(pill);
  content.textContent = "Expanded content";
  const control = observeIslandMotion(pill, content, exit, () => false);
  control.update("expanded");
  content.textContent = "Compact activity";
  control.update("live");
  expect(pill.dataset.motion).toBe("collapse");
  expect(exit.textContent).toBe("Expanded content");
  expect(exit.getAttribute("aria-hidden")).toBe("true");
  expect(exit.inert).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  exit.dispatchEvent(new Event("animationend"));
  expect(exit.childElementCount).toBe(0);
  control.dispose();
});
it("uses a crossfade for reduced motion and disconnects late mutations on disposal", async () => {
  const pill = document.createElement("div"),
    content = document.createElement("div"),
    exit = document.createElement("div");
  pill.append(content, exit);
  document.body.append(pill);
  const control = observeIslandMotion(pill, content, exit, () => true);
  control.update("live");
  content.textContent = "Peek";
  control.update("peek");
  expect(pill.classList.contains("is-crossfading")).toBe(true);
  control.dispose();
  content.textContent = "Late update";
  await Promise.resolve();
  expect(exit.childElementCount).toBe(0);
  expect(pill.classList.contains("is-crossfading")).toBe(false);
});
