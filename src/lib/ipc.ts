import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppSettings,
  ClipboardEntry,
  DownloadJob,
  DownloadMetadata,
  DownloadRequest,
  EngineStatus,
  StorageStats,
} from "./types";

const hasTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const mockSettings: AppSettings = {
  retentionDays: 30,
  captureImages: true,
  imageSizeCapMb: 10,
  pasteOnSelect: false,
  sensitiveHeuristics: false,
  autoDetectLinks: true,
  showDetectNotification: true,
  pauseAutoDetect: false,
  launchAtLogin: false,
  startHidden: true,
  showDockIcon: false,
  togglePopoverShortcut: "CmdOrCtrl+Shift+V",
  quickDownloadShortcut: "CmdOrCtrl+Shift+D",
  clipboardSearchShortcut: "CmdOrCtrl+Shift+C",
  defaultQuality: "1080p",
  outputDir: "",
  filenameTemplate: "%(title)s [%(id)s].%(ext)s",
  maxConcurrentDownloads: 2,
  revealAfterDownload: false,
  engineAutoUpdate: true,
  firstRunAcknowledged: false,
  lastTab: "download",
};

let browserSettings = { ...mockSettings };
let browserEntries: ClipboardEntry[] = [];
let browserJobs: DownloadJob[] = [];

async function call<T>(command: string, args?: Record<string, unknown>, fallback?: () => T): Promise<T> {
  if (hasTauri()) return invoke<T>(command, args);
  if (fallback) return fallback();
  throw new Error(`Tauri command unavailable in browser: ${command}`);
}

export const api = {
  getSettings: () => call<AppSettings>("get_settings", undefined, () => browserSettings),
  saveSettings: (settings: AppSettings) =>
    call<AppSettings>("save_settings", { settings }, () => {
      browserSettings = { ...settings };
      return browserSettings;
    }),
  acknowledgeFirstRun: () =>
    call<AppSettings>("acknowledge_first_run", undefined, () => {
      browserSettings.firstRunAcknowledged = true;
      return browserSettings;
    }),
  getStorageStats: () =>
    call<StorageStats>("get_storage_stats", undefined, () => ({
      clipboardCount: browserEntries.length,
      downloadCount: browserJobs.length,
      dbSizeBytes: 0,
    })),
  listClipboard: (query = "") =>
    call<ClipboardEntry[]>("list_clipboard_entries", { query }, () =>
      browserEntries.filter((entry) =>
        `${entry.preview} ${entry.content}`.toLowerCase().includes(query.toLowerCase()),
      ),
    ),
  addClipboardText: (content: string) =>
    call<ClipboardEntry | null>("add_clipboard_text", { content }, () => {
      const now = new Date().toISOString();
      const entry: ClipboardEntry = {
        id: crypto.randomUUID(),
        contentType: content.startsWith("http") ? "url" : "text",
        content,
        preview: content.slice(0, 180),
        hash: content,
        sourceApp: "Browser preview",
        pinned: false,
        createdAt: now,
        lastUsedAt: now,
      };
      browserEntries = [entry, ...browserEntries];
      return entry;
    }),
  copyClipboardEntry: (id: string) =>
    call<void>("copy_clipboard_entry", { id }, () => {
      const entry = browserEntries.find((item) => item.id === id);
      if (entry) void navigator.clipboard?.writeText(entry.content);
    }),
  togglePinClipboardEntry: (id: string) =>
    call<ClipboardEntry>("toggle_pin_clipboard_entry", { id }, () => {
      const entry = browserEntries.find((item) => item.id === id);
      if (!entry) throw new Error("Entry not found");
      entry.pinned = !entry.pinned;
      return entry;
    }),
  deleteClipboardEntry: (id: string) =>
    call<void>("delete_clipboard_entry", { id }, () => {
      browserEntries = browserEntries.filter((item) => item.id !== id);
    }),
  clearClipboardHistory: () =>
    call<void>("clear_clipboard_history", undefined, () => {
      browserEntries = [];
    }),
  runRetentionGc: () => call<number>("run_retention_gc", undefined, () => 0),
  probeUrl: (url: string) =>
    call<DownloadMetadata>("probe_url", { url }, () => ({
      url,
      normalizedUrl: url,
      title: "Preview metadata (yt-dlp runs in the desktop app)",
      channel: "Nabbit",
      duration: 0,
      thumbnail: null,
      isPlaylist: url.includes("list="),
      playlistCount: url.includes("list=") ? 12 : null,
      extractor: "browser",
    })),
  startDownload: (request: DownloadRequest) =>
    call<DownloadJob>("start_download", { request }, () => {
      const now = new Date().toISOString();
      const job: DownloadJob = {
        id: crypto.randomUUID(),
        url: request.url,
        title: "Browser preview job",
        status: "queued",
        progress: 0,
        quality: request.quality,
        playlistMode: request.playlistMode,
        playlistRange: request.playlistRange,
        createdAt: now,
        updatedAt: now,
      };
      browserJobs = [job, ...browserJobs];
      return job;
    }),
  listDownloads: () => call<DownloadJob[]>("list_downloads", undefined, () => browserJobs),
  cancelDownload: (id: string) => call<void>("cancel_download", { id }, () => undefined),
  retryDownload: (id: string) => call<DownloadJob>("retry_download", { id }, () => {
    const job = browserJobs.find((item) => item.id === id);
    if (!job) throw new Error("Job not found");
    job.status = "queued";
    job.error = null;
    return job;
  }),
  revealDownload: (id: string) => call<void>("reveal_download", { id }, () => undefined),
  openDownloadsFolder: () => call<void>("open_downloads_folder", undefined, () => undefined),
  repairEngine: () => call<EngineStatus>("repair_engine", undefined, () => ({ missing: [] })),
  getEngineStatus: () => call<EngineStatus>("get_engine_status", undefined, () => ({ missing: [] })),
  quickDownloadStaged: () => call<DownloadJob | null>("quick_download_staged", undefined, () => null),
  showMainWindow: () => call<void>("show_main_window", undefined, () => undefined),
  hideMainWindow: () => call<void>("hide_main_window", undefined, () => undefined),
  onEvent: async <T>(event: string, handler: (payload: T) => void) => {
    if (!hasTauri()) return () => undefined;
    return listen<T>(event, (message) => handler(message.payload));
  },
};
