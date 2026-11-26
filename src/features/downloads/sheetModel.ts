import { previewTimecode } from "../../lib/downloadPresets";
import type { DownloadChapter, PlaylistEntry } from "../../lib/types";
export type Section = { startMs: number; endMs: number };
export function timecode(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const rest = (seconds % 60).toFixed(3).replace(/0+$/, "").replace(/\.$/, ".0");
  return `${minutes}:${rest.padStart(rest.includes(".") ? rest.length - rest.indexOf(".") + 2 : 2, "0")}`;
}
export function union(sections: Section[]): Section[] {
  const result: Section[] = [];
  for (const range of [...sections].sort((a, b) => a.startMs - b.startMs)) {
    if (
      !Number.isSafeInteger(range.startMs) ||
      !Number.isSafeInteger(range.endMs) ||
      range.startMs < 0 ||
      range.startMs >= range.endMs
    )
      throw new Error("End must be after start.");
    const last = result.at(-1);
    if (last && last.endMs >= range.startMs) last.endMs = Math.max(last.endMs, range.endMs);
    else result.push({ startMs: range.startMs, endMs: range.endMs });
  }
  return result;
}
export function parseSection(start: string, end: string, duration: number): Section {
  const range = { startMs: previewTimecode(start), endMs: previewTimecode(end) };
  union([range]);
  if (range.endMs > duration) throw new Error("End must be within this video.");
  return range;
}
export const covers = (sections: Section[], chapter: Section) =>
  sections.some((r) => r.startMs <= chapter.startMs && r.endMs >= chapter.endMs);
export function toggleChapter(sections: Section[], chapter: DownloadChapter): Section[] {
  if (!covers(sections, chapter)) return union([...sections, chapter]);
  return sections.flatMap((r) => {
    if (r.endMs <= chapter.startMs || r.startMs >= chapter.endMs) return [r];
    return [
      r.startMs < chapter.startMs ? { startMs: r.startMs, endMs: chapter.startMs } : null,
      r.endMs > chapter.endMs ? { startMs: chapter.endMs, endMs: r.endMs } : null,
    ].filter((r): r is Section => r !== null);
  });
}
export function snap(ms: number, chapters: DownloadChapter[]): number {
  const boundaries = [...new Set(chapters.flatMap((c) => [c.startMs, c.endMs]))];
  return (
    boundaries
      .filter((t) => Math.abs(ms - t) <= 1000)
      .sort((a, b) => Math.abs(ms - a) - Math.abs(ms - b))[0] ?? ms
  );
}
export function selection(value: string, entries: PlaylistEntry[]): number[] {
  if (!value.trim()) return [];
  const available = new Set(entries.filter((e) => e.url).map((e) => e.index));
  const result = new Set<number>();
  if (value.length > 4096) throw new Error("Choose up to 1,000 videos.");
  for (const part of value.replace(/–/g, "-").replace(/\s/g, "").split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new Error("Use a range such as 1–5 or 1,3,7.");
    const start = Number(match[1]),
      end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end - start > 999 || !Number.isSafeInteger(end))
      throw new Error("Choose a valid range of up to 1,000 videos.");
    for (let i = start; i <= end; i++) {
      if (!available.has(i)) throw new Error(`Playlist video ${i} is unavailable.`);
      result.add(i);
      if (result.size > 1000) throw new Error("Choose up to 1,000 videos.");
    }
  }
  return [...result].sort((a, b) => a - b);
}
export function selectionLabel(indices: number[]): string {
  const values = [...new Set(indices)].sort((a, b) => a - b),
    parts = [];
  for (let i = 0; i < values.length; i++) {
    const start = values[i];
    let end = start;
    while (values[i + 1] === end + 1) end = values[++i];
    parts.push(start === end ? String(start) : `${start}–${end}`);
  }
  return parts.join(",");
}
export function playlistSize(entries: PlaylistEntry[], height: number | null): number | null {
  if (!entries.length) return 0;
  const sizes = entries.map(
    (e) =>
      [...e.qualities]
        .filter((q) => height == null || q.height <= height)
        .sort((a, b) => b.height - a.height)[0]?.estimatedBytes,
  );
  return sizes.every((n): n is number => n != null) ? sizes.reduce((a, b) => a + b, 0) : null;
}
