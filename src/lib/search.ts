import Fuse from "fuse.js";
import type { ClipboardEntry } from "./types";

export function filterClipboardEntries(entries: ClipboardEntry[], query: string): ClipboardEntry[] {
  const trimmed = query.trim();
  if (!trimmed) return entries;

  const fuse = new Fuse(entries, {
    keys: ["preview", "content", "sourceApp"],
    threshold: 0.34,
    ignoreLocation: true,
    minMatchCharLength: 1,
  });

  return fuse.search(trimmed).map((result) => result.item);
}

export function formatRelativeTime(value: string, now = new Date()): string {
  const date = new Date(value);
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  return Math.max(0, Math.min(index, length - 1));
}
