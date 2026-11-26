import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  defaultDownloadOptions,
  defaultDownloadPresets,
  previewPreset,
  previewSite,
  previewTimecode,
} from "./downloadPresets";
import { cachedThemePreference } from "./theme";
import type {
  AppSettings,
  AppUpdateStatus,
  ClipboardEntry,
  DownloadJob,
  DownloadMetadata,
  DownloadRequest,
  DownloadPreset,
  DownloadOptions,
  DownloadSheetDraft,
  DownloadSheetIntent,
  EngineStatus,
  StorageStats,
  IslandPreferences,
  IslandSnapshot,
} from "./types";

const hasTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const mockSettings: AppSettings = {
  island: {
    enabled: true,
    shape: "island",
    size: "standard",
    monitorMode: "followMouse",
    monitorId: null,
  },
  theme: "system",
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
  quickDownloadShortcut: "Ctrl+Alt+D",
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

let browserSettings = { ...mockSettings, theme: cachedThemePreference() };
let browserEntries: ClipboardEntry[] = [];
let browserJobs: DownloadJob[] = [];
let browserSheet: DownloadSheetIntent | null = null;

async function call<T>(
  command: string,
  args?: Record<string, unknown>,
  fallback?: () => T,
): Promise<T> {
  if (hasTauri()) return invoke<T>(command, args);
  if (fallback) return fallback();
  throw new Error(`Tauri command unavailable in browser: ${command}`);
}

const browserPresets = new Map<string, DownloadPreset>();
function previewDownload(request: DownloadRequest): DownloadJob {
  const options = { ...defaultDownloadOptions(), ...request.options };
  const now = new Date().toISOString();
  const quality = request.options
    ? ["mp4", "mkv", "webm"].includes(options.format)
      ? options.height
        ? `${options.height}p`
        : "best"
      : `audio_${options.format}`
    : (request.quality ?? "1080p");
  const job: DownloadJob = {
    id: crypto.randomUUID(),
    url: request.url,
    title: "Browser preview job",
    status: "queued",
    progress: 0,
    quality,
    options: request.options ? structuredClone(request.options) : undefined,
    playlistMode: request.options?.playlistMode ?? request.playlistMode ?? "video",
    playlistRange: request.options?.playlistItems ?? request.playlistRange,
    createdAt: now,
    updatedAt: now,
  };
  if (request.rememberForSite) browserPresets.set(previewSite(request.url), previewPreset(options));
  browserJobs = [job, ...browserJobs];
  return job;
}

export const api = {
  openDownloadSheet: (draft: DownloadSheetDraft) =>
    call<void>("open_download_sheet", { draft }, () => {
      browserSheet = { id: crypto.randomUUID(), draft, metadata: null };
      void import("../features/downloads/previewSheet").then((m) => m.mountPreviewSheet());
    }),
  getDownloadSheet: () =>
    call<DownloadSheetIntent | null>("get_download_sheet", undefined, () => browserSheet),
  downloadSheetReady: () => call<void>("download_sheet_ready", undefined, () => undefined),
  closeDownloadSheet: (id?: string) =>
    call<void>("close_download_sheet", { id }, () => {
      if (id && browserSheet?.id !== id) return;
      browserSheet = null;
      window.dispatchEvent(new Event("nabbit:close-download-sheet"));
    }),
  previewDownloadSource: (url: string, startMs: number) =>
    call<void>("preview_download_source", { url, startMs }, () => {
      previewSite(url);
      window.open(url, "_blank", "noopener,noreferrer");
    }),
  startPlaylistDownload: (request: DownloadRequest, indices: number[]) =>
    call<DownloadJob[]>("start_playlist_download", { request, indices }, () => {
      if (!indices.length) throw new Error("Choose at least one playlist video.");
      return [...new Set(indices)].map((index) =>
        previewDownload({
          ...request,
          url: `${request.url}#item=${index}`,
          options: { ...request.options, playlistMode: "video", playlistItems: null },
        }),
      );
    }),
  getIslandSnapshot: () =>
    call<IslandSnapshot>("get_island_snapshot", undefined, () => ({
      supported: false,
      desktop: { monitors: [] },
      lastError: null,
    })),
  saveIslandPreferences: (preferences: IslandPreferences) =>
    call<AppSettings>("save_island_preferences", { preferences }, () => {
      browserSettings = { ...browserSettings, island: { ...preferences } };
      return browserSettings;
    }),
  checkAppUpdate: () =>
    call<AppUpdateStatus>("check_app_update", undefined, () => ({
      available: false,
      error: "Desktop updater is available only in the packaged app.",
    })),
  getSettings: () => call<AppSettings>("get_settings", undefined, () => browserSettings),
  saveSettings: (settings: AppSettings) =>
    call<AppSettings>("save_settings", { settings }, () => {
      browserSettings = { ...settings };
      return browserSettings;
    }),
  acknowledgeFirstRun: () =>
    call<AppSettings>("acknowledge_first_run", undefined, () => {
      browserSettings = { ...browserSettings, firstRunAcknowledged: true };
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
  getStagedUrl: () => call<string | null>("get_staged_url", undefined, () => null),
  getCapturedLink: () => call<DownloadMetadata | null>("get_captured_link", undefined, () => null),
  captureUrl: (url: string) =>
    call<DownloadMetadata>("capture_url", { url }, () => ({
      url,
      normalizedUrl: url,
      title: new URL(url).hostname,
      channel: null,
      duration: null,
      thumbnail: null,
      isPlaylist: url.includes("list="),
      playlistCount: null,
      extractor: "capture",
      qualities: [],
    })),
  clearStagedUrl: () => call<void>("clear_staged_url", undefined, () => undefined),
  listDownloadPresets: () =>
    call<DownloadPreset[]>("list_download_presets", undefined, defaultDownloadPresets),
  parseDownloadTimecode: (value: string) =>
    call<number>("parse_download_timecode", { value }, () => previewTimecode(value)),
  resolveDownloadPreset: (url: string) =>
    call<DownloadPreset>("resolve_download_preset", { url }, () =>
      structuredClone(browserPresets.get(previewSite(url)) ?? defaultDownloadPresets()[0]),
    ),
  rememberDownloadPreset: (url: string, options: DownloadOptions) =>
    call<DownloadPreset>("remember_download_preset", { url, options }, () => {
      const preset = previewPreset(options);
      browserPresets.set(previewSite(url), preset);
      return structuredClone(preset);
    }),
  startDownloadWithPreset: (url: string) =>
    call<DownloadJob>("start_download_with_preset", { url }, () =>
      previewDownload({
        url,
        options:
          browserPresets.get(previewSite(url))?.options ?? defaultDownloadPresets()[0].options,
      }),
    ),
  startDownload: (request: DownloadRequest) =>
    call<DownloadJob>("start_download", { request }, () => previewDownload(request)),
  listDownloads: () => call<DownloadJob[]>("list_downloads", undefined, () => browserJobs),
  clearFinishedDownloads: () =>
    call<void>("clear_finished_downloads", undefined, () => {
      browserJobs = browserJobs.filter((job) => !["completed", "cancelled"].includes(job.status));
    }),
  openDownload: (id: string) => call<void>("open_download", { id }, () => undefined),
  cancelDownload: (id: string) =>
    call<void>("cancel_download", { id }, () => {
      const job = browserJobs.find((j) => j.id === id);
      if (job) job.status = "cancelled";
    }),
  pauseDownload: (id: string) =>
    call<void>("pause_download", { id }, () => {
      const job = browserJobs.find((j) => j.id === id);
      if (job) job.status = "paused";
    }),
  resumeDownload: (id: string) =>
    call<DownloadJob>("resume_download", { id }, () => {
      const job = browserJobs.find((item) => item.id === id);
      if (!job) throw new Error("Job not found");
      job.status = "queued";
      job.error = null;
      return job;
    }),
  retryDownload: (id: string) =>
    call<DownloadJob>("retry_download", { id }, () => {
      const job = browserJobs.find((item) => item.id === id);
      if (!job) throw new Error("Job not found");
      job.status = "queued";
      job.error = null;
      return job;
    }),
  revealDownload: (id: string) => call<void>("reveal_download", { id }, () => undefined),
  retryDownloadWithBrowser: (id: string, browser: import("./types").DownloadBrowser) =>
    call<DownloadJob>("retry_download_with_browser", { id, browser }, () => {
      const job = browserJobs.find((j) => j.id === id);
      if (!job) throw new Error("Job not found");
      job.status = "queued";
      job.error = null;
      return job;
    }),
  openDownloadsFolder: () => call<void>("open_downloads_folder", undefined, () => undefined),
  repairEngine: (channel?: "stable" | "nightly") =>
    call<EngineStatus>("repair_engine", { channel }, () => ({ missing: [] })),
  checkEngine: () => call<EngineStatus>("check_engine", undefined, () => ({ missing: [] })),
  getEngineStatus: () =>
    call<EngineStatus>("get_engine_status", undefined, () => ({ missing: [] })),
  quickDownloadStaged: () =>
    call<DownloadJob | null>("quick_download_staged", undefined, () => null),
  showMainWindow: () => call<void>("show_main_window", undefined, () => undefined),
  hideMainWindow: () => call<void>("hide_main_window", undefined, () => undefined),
  onEvent: async <T>(event: string, handler: (payload: T) => void) => {
    if (!hasTauri()) return () => undefined;
    return listen<T>(event, (message) => handler(message.payload));
  },
};
