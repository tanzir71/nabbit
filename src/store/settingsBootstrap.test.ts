import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/ipc";
import { useAppStore } from "./useAppStore";

afterEach(() => vi.restoreAllMocks());
describe("standalone settings bootstrap", () => {
  it("keeps a newer pushed preference when an earlier save reply arrives late", async () => {
    const initial = await api.getSettings();
    useAppStore.setState({ settings: initial });
    let release!: (settings: typeof initial) => void;
    vi.spyOn(api, "patchSettings").mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = useAppStore.getState().patchSettings({ theme: "dark" });
    await Promise.resolve();
    const newer = { ...initial, theme: "dark" as const, retentionDays: 90 as const };
    useAppStore.getState().acceptSettings(newer);
    release({ ...initial, theme: "dark" });
    await pending;
    expect(useAppStore.getState().settings).toEqual(newer);
  });
  it("coalesces concurrent mounts and reads settings, engine and counts only", async () => {
    const settings = await api.getSettings();
    let release!: (value: typeof settings) => void;
    const pending = new Promise<typeof settings>((resolve) => {
      release = resolve;
    });
    const get = vi.spyOn(api, "getSettings").mockReturnValue(pending);
    vi.spyOn(api, "getEngineStatus").mockResolvedValue({ missing: [] });
    vi.spyOn(api, "getStorageStats").mockResolvedValue({
      clipboardCount: 3,
      downloadCount: 2,
      dbSizeBytes: 123,
    });
    const clipboard = vi.spyOn(api, "listClipboard"),
      downloads = vi.spyOn(api, "listDownloads"),
      staged = vi.spyOn(api, "getStagedUrl"),
      probe = vi.spyOn(api, "probeUrl");
    useAppStore.setState({ settings: null, loading: true, error: null });
    const first = useAppStore.getState().loadSettingsData();
    const second = useAppStore.getState().loadSettingsData();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(get).toHaveBeenCalledOnce();
    release(settings);
    await first;
    expect(useAppStore.getState().settings).toEqual(settings);
    expect(useAppStore.getState().stats?.clipboardCount).toBe(3);
    expect(useAppStore.getState().loading).toBe(false);
    for (const read of [clipboard, downloads, staged, probe]) expect(read).not.toHaveBeenCalled();
  });
  it("exposes a failed read and allows retry without a stuck in-flight promise", async () => {
    const settings = await api.getSettings();
    vi.spyOn(api, "getSettings")
      .mockRejectedValueOnce(new Error("Database busy"))
      .mockResolvedValue(settings);
    vi.spyOn(api, "getEngineStatus").mockResolvedValue({ missing: [] });
    vi.spyOn(api, "getStorageStats").mockResolvedValue({
      clipboardCount: 0,
      downloadCount: 0,
      dbSizeBytes: 0,
    });
    useAppStore.setState({ settings: null, loading: true, error: null });
    await useAppStore.getState().loadSettingsData();
    expect(useAppStore.getState().error).toBe("Database busy");
    expect(useAppStore.getState().loading).toBe(false);
    await useAppStore.getState().loadSettingsData();
    expect(useAppStore.getState().error).toBeNull();
    expect(useAppStore.getState().settings).toEqual(settings);
  });
});
