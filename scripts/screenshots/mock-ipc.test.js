import { afterEach, describe, expect, it } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { fixtureData } from "./fixtures.mjs";
import { installMockIpc } from "./mock-ipc.mjs";

afterEach(() => {
  delete globalThis.isTauri;
  delete globalThis.__TAURI_INTERNALS__;
  delete globalThis.__TAURI_EVENT_PLUGIN_INTERNALS__;
  delete globalThis.__NABBIT_CAPTURE__;
  globalThis.localStorage.clear();
});
const install = (extra = {}) =>
  installMockIpc({ theme: "dark", label: "settings", data: fixtureData("settings"), ...extra });

describe("screenshot IPC through the actual Tauri JS client", () => {
  it("logs stable recorder labels while retaining real session matching in the fixture", async () => {
    install();
    await invoke("shortcuts_recording", { token: "owned-first", active: true });
    await invoke("shortcuts_recording", { token: "owned-second", active: true });
    await invoke("shortcuts_recording", { token: "owned-first", active: false });
    expect((await invoke("shortcuts_snapshot")).recording).toBe(true);
    await invoke("shortcuts_recording", { token: "owned-second", active: false });
    expect((await invoke("shortcuts_snapshot")).recording).toBe(false);
    const calls = globalThis.__NABBIT_CAPTURE__
      .snapshot()
      .calls.filter(({ command }) => command === "shortcuts_recording");
    expect(calls.map(({ args }) => args.token)).toEqual([
      "recording-1",
      "recording-2",
      "recording-1",
      "recording-2",
    ]);
  });
  it("clones backend responses and saves settings only in the isolated fixture", async () => {
    install();
    expect(isTauri()).toBe(true);
    const settings = await invoke("get_settings");
    settings.retentionDays = 90;
    expect((await invoke("get_settings")).retentionDays).toBe(30);
    await invoke("save_settings", { settings });
    expect((await invoke("get_settings")).retentionDays).toBe(90);
    install();
    expect((await invoke("get_settings")).retentionDays).toBe(30);
  });

  it("implements window labels, native theme events and listener cleanup", async () => {
    install();
    const current = getCurrentWindow();
    expect(current.label).toBe("settings");
    expect(await current.theme()).toBe("dark");
    const received = [];
    const stop = await current.onThemeChanged(({ payload }) => received.push(payload));
    await emit("tauri://theme-changed", "light");
    expect(received).toEqual(["light"]);
    await stop();
    await emit("tauri://theme-changed", "dark");
    expect(received).toEqual(["light"]);
    expect(globalThis.__NABBIT_CAPTURE__.snapshot().listenerCount).toBe(0);
    await current.hide();
    expect(await current.isVisible()).toBe(false);
  });

  it("pushes cloned domain payloads and records reads without touching a clipboard", async () => {
    install();
    const received = [];
    const stop = await listen("download:updated", ({ payload }) => received.push(payload));
    const job = { id: "sample", progress: 68 };
    globalThis.__NABBIT_CAPTURE__.emit("download:updated", job);
    job.progress = 1;
    expect(received).toEqual([{ id: "sample", progress: 68 }]);
    await invoke("copy_clipboard_entry", { id: "clip-text" });
    expect(globalThis.__NABBIT_CAPTURE__.snapshot().calls.at(-1)).toEqual({
      command: "copy_clipboard_entry",
      args: { id: "clip-text" },
    });
    await stop();
  });

  it("rejects unknown commands and unexpected downloads instead of masking missing fixtures", async () => {
    install();
    await expect(invoke("start_download")).rejects.toThrow("no IPC response");
    await expect(invoke("new_command")).rejects.toThrow("no IPC response");
    expect(globalThis.__NABBIT_CAPTURE__.snapshot().unsupported).toEqual([
      "start_download",
      "new_command",
    ]);
  });

  it("supports deliberate backend failure and response fixtures", async () => {
    install({
      failures: { get_settings: "Fixture database unavailable" },
      responses: { app_health: "fixture-ready" },
    });
    await expect(invoke("get_settings")).rejects.toThrow("Fixture database unavailable");
    expect(await invoke("app_health")).toBe("fixture-ready");
  });
});
