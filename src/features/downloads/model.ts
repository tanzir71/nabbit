import type { DownloadJob, DownloadMetadata, DownloadOptions } from "../../lib/types";
export const terminal = (job: DownloadJob) => ["completed", "cancelled"].includes(job.status);
export function formatLabel(job: Pick<DownloadJob, "quality" | "options">): string {
  const format =
    job.options?.format ?? (job.quality.startsWith("audio_") ? job.quality.slice(6) : "mp4");
  const height =
    job.options?.height ?? (/^\d+p$/.test(job.quality) ? Number.parseInt(job.quality) : null);
  return [
    format.toUpperCase(),
    ["mp4", "mkv", "webm"].includes(format)
      ? height
        ? `${height}p`
        : "Best"
      : format === "mp3"
        ? "320"
        : "",
  ]
    .filter(Boolean)
    .join(" ");
}
export function estimatedBytes(
  metadata: DownloadMetadata,
  options: DownloadOptions,
): number | null {
  if (!["mp4", "mkv", "webm"].includes(options.format ?? "mp4")) return null;
  const choices = (metadata.qualities ?? [])
    .filter((q) => options.height == null || q.height <= options.height)
    .sort((a, b) => b.height - a.height);
  return choices[0]?.estimatedBytes ?? null;
}
export const sizeLabel = (value: number) =>
  value >= 1e9 ? `${Number((value / 1e9).toFixed(1))} GB` : `${Math.round(value / 1e6)} MB`;
export function jobSummary(job: DownloadJob): string {
  const format = formatLabel(job);
  if (job.status === "running")
    return [
      `${Math.round(Math.max(0, Math.min(100, job.progress)))}%`,
      job.speed,
      job.eta && `${job.eta} left`,
    ]
      .filter(Boolean)
      .join(" · ");
  const range = job.playlistMode === "playlist" ? job.playlistRange?.match(/^(\d+)-(\d+)$/) : null;
  const count = range ? Number(range[2]) - Number(range[1]) + 1 : 0;
  return [
    (
      {
        completed: "Saved",
        queued: "Queued",
        paused: "Paused",
        interrupted: "Interrupted",
        cancelled: "Cancelled",
        failed: "Failed",
      } as const
    )[job.status],
    count > 0 && count <= 1000 ? `${count} items` : null,
    format,
  ]
    .filter(Boolean)
    .join(" · ");
}
export function siteLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "this site";
  }
}
