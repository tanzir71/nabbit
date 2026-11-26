import type { ErrorKind } from "./activity";

export type Quality =
  "best" | "2160p" | "1440p" | "1080p" | "720p" | "480p" | "audio_mp3" | "audio_m4a" | "audio_opus";

export type ClipboardContentType = "text" | "url" | "image" | "file";

export interface ClipboardEntry {
  id: string;
  contentType: ClipboardContentType;
  content: string;
  preview: string;
  hash: string;
  sourceApp?: string | null;
  pinned: boolean;
  createdAt: string;
  lastUsedAt: string;
  blobPath?: string | null;
}

export interface DownloadMetadata {
  url: string;
  normalizedUrl: string;
  title: string;
  channel?: string | null;
  duration?: number | null;
  thumbnail?: string | null;
  isPlaylist: boolean;
  playlistCount?: number | null;
  extractor?: string | null;
  qualities?: Array<{ height: number; estimatedBytes: number | null }>;
}

export type DownloadStatus =
  "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";

export interface DownloadJob {
  id: string;
  url: string;
  title: string;
  thumbnail?: string | null;
  status: DownloadStatus;
  progress: number;
  speed?: string | null;
  eta?: string | null;
  outputPath?: string | null;
  error?: string | null;
  quality: string;
  options?: DownloadOptions | null;
  playlistMode: "video" | "playlist";
  playlistRange?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  islandActivity?: import("./activity").ActivityPreferences;
  island: IslandPreferences;
  theme: import("./theme").ThemePreference;
  retentionDays: 30 | 60 | 90;
  captureImages: boolean;
  imageSizeCapMb: number;
  pasteOnSelect: boolean;
  sensitiveHeuristics: boolean;
  autoDetectLinks: boolean;
  showDetectNotification: boolean;
  pauseAutoDetect: boolean;
  launchAtLogin: boolean;
  startHidden: boolean;
  showDockIcon: boolean;
  togglePopoverShortcut: string;
  islandShortcut?: string;
  quickDownloadShortcut: string;
  clipboardSearchShortcut: string;
  defaultQuality: Quality;
  outputDir: string;
  filenameTemplate: string;
  maxConcurrentDownloads: number;
  revealAfterDownload: boolean;
  engineAutoUpdate: boolean;
  firstRunAcknowledged: boolean;
  lastTab: "download" | "clipboard";
}

export interface IslandPreferences {
  enabled: boolean;
  shape: "island" | "notch";
  size: "small" | "standard" | "large";
  monitorMode: "primary" | "followMouse" | "all" | "specific";
  monitorId: string | null;
}
export interface IslandSnapshot {
  supported: boolean;
  desktop: { monitors: Array<{ id: string; name: string; primary: boolean; scaleFactor: number }> };
  lastError: string | null;
}

export interface StorageStats {
  clipboardCount: number;
  downloadCount: number;
  dbSizeBytes: number;
}

export type DownloadFormat = "mp4" | "mkv" | "webm" | "mp3" | "m4a" | "opus";
export type DownloadBrowser = "chrome" | "edge" | "firefox" | "brave";
export interface DownloadOptions {
  format?: DownloadFormat;
  height?: number | null;
  subtitles?: { languages: string[]; embed: boolean } | null;
  chapters?: "off" | "keep" | "split";
  sponsorBlock?: "off" | "mark" | "cut";
  embedThumbnail?: boolean;
  embedMetadata?: boolean;
  filenameTemplate?: string | null;
  outputDir?: string | null;
  sections?: Array<{ startMs: number; endMs: number }>;
  preciseCuts?: boolean;
  playlistMode?: "video" | "playlist";
  playlistItems?: string | null;
  speedLimit?: string | null;
}
export interface DownloadPreset {
  id: "mp4_1080" | "mp4_720" | "mp3_320" | "m4a" | "custom";
  label: string;
  options: DownloadOptions;
}
export interface DownloadRequest {
  url: string;
  quality?: Quality;
  playlistMode?: "video" | "playlist";
  playlistRange?: string;
  options?: DownloadOptions;
  rememberForSite?: boolean;
  cookiesFromBrowser?: DownloadBrowser;
}

export interface EngineStatus {
  denoPath?: string | null;
  denoVersion?: string | null;
  ffmpegVersion?: string | null;
  checkedAt?: string | null;
  updatedAt?: string | null;
  channel?: "stable" | "nightly";
  extraction?: { result: string; checkedAt?: string | null; detail?: string | null };
  failure?: ErrorKind | null;
  updateError?: string | null;
  busy?: boolean;
  ytdlpPath?: string | null;
  ffmpegPath?: string | null;
  ytdlpVersion?: string | null;
  lastUpdateCheck?: string | null;
  missing: string[];
}

export interface AppUpdateStatus {
  available: boolean;
  currentVersion?: string | null;
  version?: string | null;
  date?: string | null;
  body?: string | null;
  url?: string | null;
  error?: string | null;
}
