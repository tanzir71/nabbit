import { create } from "zustand";
import { api } from "../lib/ipc";
import type {
  AppSettings,
  ClipboardEntry,
  DownloadJob,
  DownloadMetadata,
  DownloadRequest,
  EngineStatus,
  StorageStats,
} from "../lib/types";

interface AppStore {
  settings: AppSettings | null;
  clipboardEntries: ClipboardEntry[];
  downloads: DownloadJob[];
  stagedUrl: string;
  metadata: DownloadMetadata | null;
  engine: EngineStatus | null;
  stats: StorageStats | null;
  loading: boolean;
  error: string | null;
  loadInitialData: () => Promise<void>;
  loadSettingsData: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  acknowledgeFirstRun: () => Promise<void>;
  setLastTab: (lastTab: AppSettings["lastTab"]) => Promise<void>;
  refreshClipboard: () => Promise<void>;
  addClipboardText: (content: string) => Promise<void>;
  copyEntry: (id: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  stageUrl: (url: string) => Promise<void>;
  acceptCapturedLink: (metadata: DownloadMetadata) => void;
  clearStagedUrl: () => void;
  startDownload: (request: DownloadRequest) => Promise<void>;
  refreshDownloads: () => Promise<void>;
  cancelDownload: (id: string) => Promise<void>;
  pauseDownload: (id: string) => Promise<void>;
  resumeDownload: (id: string) => Promise<void>;
  retryDownload: (id: string) => Promise<void>;
  repairEngine: () => Promise<void>;
}

let settingsLoad: Promise<void> | null = null;
let captureRevision = 0;

export const useAppStore = create<AppStore>((set, get) => ({
  settings: null,
  clipboardEntries: [],
  downloads: [],
  stagedUrl: "",
  metadata: null,
  engine: null,
  stats: null,
  loading: true,
  error: null,
  loadSettingsData: () => {
    if (settingsLoad) return settingsLoad;
    set({ loading: true, error: null });
    const pending = Promise.resolve().then(async () => {
      try {
        const [settings, engine, stats] = await Promise.all([
          api.getSettings(),
          api.getEngineStatus(),
          api.getStorageStats(),
        ]);
        set({ settings, engine, stats, loading: false });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error), loading: false });
      }
    });
    settingsLoad = pending;
    void pending.finally(() => {
      settingsLoad = null;
    });
    return pending;
  },
  loadInitialData: async () => {
    const revision = captureRevision;
    set({ loading: true, error: null });
    try {
      const [settings, clipboardEntries, downloads, engine, stats, metadata] = await Promise.all([
        api.getSettings(),
        api.listClipboard(),
        api.listDownloads(),
        api.getEngineStatus(),
        api.getStorageStats(),
        api.getCapturedLink(),
      ]);
      set({
        settings,
        clipboardEntries,
        downloads,
        engine,
        stats,
        ...(revision === captureRevision
          ? { stagedUrl: metadata?.normalizedUrl ?? "", metadata }
          : {}),
        loading: false,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false });
    }
  },
  saveSettings: async (settings) => {
    const saved = await api.saveSettings(settings);
    set({ settings: saved });
  },
  acknowledgeFirstRun: async () => {
    const settings = await api.acknowledgeFirstRun();
    set({ settings });
  },
  setLastTab: async (lastTab) => {
    const settings = get().settings;
    if (!settings || settings.lastTab === lastTab) return;
    await get().saveSettings({ ...settings, lastTab });
  },
  refreshClipboard: async () => {
    set({ clipboardEntries: await api.listClipboard(), stats: await api.getStorageStats() });
  },
  addClipboardText: async (content) => {
    await api.addClipboardText(content);
    await get().refreshClipboard();
  },
  copyEntry: async (id) => {
    await api.copyClipboardEntry(id);
    await get().refreshClipboard();
  },
  togglePin: async (id) => {
    const entry = await api.togglePinClipboardEntry(id);
    set((state) => ({
      clipboardEntries: state.clipboardEntries.map((item) => (item.id === id ? entry : item)),
    }));
  },
  deleteEntry: async (id) => {
    await api.deleteClipboardEntry(id);
    set((state) => ({
      clipboardEntries: state.clipboardEntries.filter((item) => item.id !== id),
    }));
  },
  clearHistory: async () => {
    await api.clearClipboardHistory();
    set({ clipboardEntries: [], stats: await api.getStorageStats() });
  },
  stageUrl: async (url) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const revision = ++captureRevision;
    set({ stagedUrl: trimmed, metadata: null, error: null });
    try {
      const metadata = await api.captureUrl(trimmed);
      if (revision === captureRevision) set({ metadata, stagedUrl: metadata.normalizedUrl });
    } catch (error) {
      if (revision === captureRevision)
        set({
          metadata: null,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  },
  acceptCapturedLink: (metadata) => {
    ++captureRevision;
    set({ metadata, stagedUrl: metadata.normalizedUrl, error: null });
  },
  clearStagedUrl: () => {
    ++captureRevision;
    void api.clearStagedUrl();
    set({ stagedUrl: "", metadata: null });
  },
  startDownload: async (request) => {
    const job = await api.startDownload(request);
    const current = get().stagedUrl;
    const clear = current === job.url || current === request.url;
    if (clear) ++captureRevision;
    set((state) => ({
      downloads: [job, ...state.downloads.filter((item) => item.id !== job.id)],
      ...(clear ? { stagedUrl: "", metadata: null } : {}),
    }));
  },
  refreshDownloads: async () => {
    set({ downloads: await api.listDownloads(), stats: await api.getStorageStats() });
  },
  cancelDownload: async (id) => {
    await api.cancelDownload(id);
    await get().refreshDownloads();
  },
  pauseDownload: async (id) => {
    await api.pauseDownload(id);
    await get().refreshDownloads();
  },
  resumeDownload: async (id) => {
    await api.resumeDownload(id);
    await get().refreshDownloads();
  },
  retryDownload: async (id) => {
    const job = await api.retryDownload(id);
    set((state) => ({
      downloads: [job, ...state.downloads.filter((item) => item.id !== id)],
    }));
  },
  repairEngine: async () => {
    const engine = await api.repairEngine();
    set({ engine });
  },
}));
