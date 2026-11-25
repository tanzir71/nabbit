import { beforeEach, describe, expect, it, vi } from "vitest";
import { cachedThemePreference, connectTheme, normalizeThemePreference, type Theme } from "./theme";

function mediaFixture(initial: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const media = {
    matches: initial,
    addEventListener: (_: string, listener: (event: { matches: boolean }) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) => {
      listeners.delete(listener);
    },
  };
  return {
    media,
    change: (matches: boolean) => listeners.forEach((fn) => fn({ matches })),
    listeners,
  };
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
};
beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
describe("event-driven appearance", () => {
  it("follows system changes, keeps an override, and resumes the current system choice", () => {
    const { media, change, listeners } = mediaFixture(false);
    const controller = connectTheme(document.documentElement, media, "system");
    expect(document.documentElement.dataset.theme).toBe("light");
    change(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    controller.setPreference("light");
    change(true);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(cachedThemePreference()).toBe("light");
    controller.setPreference("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    controller.close();
    expect(listeners.size).toBe(0);
    change(false);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
  it("uses Windows events and rejects an initial query that resolves after a newer event", async () => {
    const current = deferred<Theme | null>();
    let receive!: (theme: Theme) => void;
    const stop = vi.fn();
    const controller = connectTheme(document.documentElement, mediaFixture(false).media, "system", {
      current: () => current.promise,
      listen: async (fn) => {
        receive = fn;
        return stop;
      },
    });
    await Promise.resolve();
    receive("dark");
    current.resolve("light");
    await Promise.resolve();
    expect(document.documentElement.dataset.theme).toBe("dark");
    controller.close();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("removes a native listener that finishes subscribing after unmount", async () => {
    const subscribed = deferred<() => void>();
    const stop = vi.fn(),
      current = vi.fn();
    const controller = connectTheme(document.documentElement, mediaFixture(false).media, "system", {
      current,
      listen: () => subscribed.promise,
    });
    controller.close();
    subscribed.resolve(stop);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(current).not.toHaveBeenCalled();
  });
  it("defaults unknown preferences and unavailable Windows APIs to the browser source", async () => {
    expect(normalizeThemePreference("future")).toBe("system");
    localStorage.setItem("nabbit.theme.v1", "invalid");
    expect(cachedThemePreference()).toBe("system");
    const { media, change } = mediaFixture(true);
    const controller = connectTheme(document.documentElement, media, "system", {
      current: async () => null,
      listen: async () => {
        throw new Error("not available");
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    change(false);
    expect(document.documentElement.dataset.theme).toBe("light");
    controller.close();
  });
});
