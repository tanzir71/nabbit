import type { DownloadOptions, DownloadPreset } from "./types";

// Browser preview data only. The desktop's validation and SQLite are authoritative.
export function defaultDownloadOptions(): Required<DownloadOptions> {
  return {
    format: "mp4",
    height: 1080,
    subtitles: null,
    chapters: "off",
    sponsorBlock: "off",
    embedThumbnail: false,
    embedMetadata: false,
    filenameTemplate: null,
    outputDir: null,
    sections: [],
    preciseCuts: false,
    playlistMode: "video",
    playlistItems: null,
    speedLimit: null,
    waitForVideo: false,
  };
}
export function defaultDownloadPresets(): DownloadPreset[] {
  return [
    { id: "mp4_1080", label: "MP4 · 1080p", options: defaultDownloadOptions() },
    { id: "mp4_720", label: "MP4 · 720p", options: { ...defaultDownloadOptions(), height: 720 } },
    {
      id: "mp3_320",
      label: "MP3 · 320",
      options: { ...defaultDownloadOptions(), format: "mp3", height: null },
    },
    {
      id: "m4a",
      label: "M4A",
      options: { ...defaultDownloadOptions(), format: "m4a", height: null },
    },
    { id: "custom", label: "Custom…", options: defaultDownloadOptions() },
  ];
}
export function previewPreset(options: DownloadOptions): DownloadPreset {
  const reusable = {
    ...defaultDownloadOptions(),
    ...structuredClone(options),
    sections: [],
    preciseCuts: false,
    playlistMode: "video" as const,
    playlistItems: null,
    outputDir: null,
    waitForVideo: false,
  };
  if (!["mp4", "mkv", "webm"].includes(reusable.format)) reusable.height = null;
  if (reusable.filenameTemplate === "%(title)s [%(id)s].%(ext)s") reusable.filenameTemplate = null;
  const keys = Object.keys(defaultDownloadOptions()) as Array<keyof DownloadOptions>;
  return (
    defaultDownloadPresets().find(
      (p) =>
        p.id !== "custom" &&
        keys.every((k) => JSON.stringify(p.options[k]) === JSON.stringify(reusable[k])),
    ) ?? { id: "custom", label: "Custom…", options: reusable }
  );
}
export function previewSite(url: string): string {
  const value = new URL(url);
  if (!["http:", "https:"].includes(value.protocol))
    throw new Error("Use an HTTP or HTTPS video URL.");
  const host = value.hostname.replace(/\.$/, "").replace(/^www\./, "");
  return [
    "youtu.be",
    "youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
  ].includes(host)
    ? "youtube.com"
    : host;
}

export function previewTimecode(value: string): number {
  const fields = value.trim().split(":");
  if (
    fields.length > 3 ||
    fields.some(
      (f, i) =>
        !(i === fields.length - 1 ? /^\d+(?:\.\d{1,3})?$/ : /^\d+$/).test(f) ||
        (i > 0 && Number(f) >= 60),
    )
  )
    throw new Error("Use mm:ss or mm:ss.f for a time.");
  const milliseconds = Math.round(
    fields.reduce((total, field) => total * 60 + Number(field), 0) * 1000,
  );
  if (!Number.isSafeInteger(milliseconds)) throw new Error("Time is too large.");
  return milliseconds;
}
