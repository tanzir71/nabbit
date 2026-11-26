export type Quality =
  "best" | "2160p" | "1440p" | "1080p" | "720p" | "480p" | "audio_mp3" | "audio_m4a";

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
  quality: Quality;
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

export interface DownloadRequest {
  url: string;
  quality: Quality;
  playlistMode: "video" | "playlist";
  playlistRange?: string;
}

export interface EngineStatus {
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
