import type { ClipboardEntry } from "../../lib/types";
import { filterClipboardEntries } from "../../lib/search";
export const clipboardFilters = ["All", "Text", "Links", "Images", "Files", "Pinned"] as const;
export type ClipboardFilter = (typeof clipboardFilters)[number];
export function clipboardRows(entries: ClipboardEntry[], query: string, filter: string) {
  const types: Partial<Record<string, ClipboardEntry["contentType"]>> = {
    Text: "text",
    Links: "url",
    Images: "image",
    Files: "file",
  };
  const type = types[filter];
  return filterClipboardEntries(
    entries.filter((entry) =>
      filter === "Pinned" ? entry.pinned : !type || entry.contentType === type,
    ),
    query,
  );
}
export function clipboardThumbnail(entry: ClipboardEntry): string | undefined {
  const source = entry.blobPath;
  return entry.contentType === "image" &&
    source &&
    source.length < 200000 &&
    /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(source)
    ? source
    : undefined;
}
export function clipboardTitle(entry: ClipboardEntry) {
  const text = entry.preview || entry.content;
  return entry.contentType === "url" ? text.replace(/^https?:\/\//i, "") : text;
}
