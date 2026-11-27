import type { ShelfItem } from "./api";
export function shelfSelection(raw = ""): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === "string"))]
      : [];
  } catch {
    return [];
  }
}
export function shelfSize(item: ShelfItem) {
  if (!item.available) return "Missing file";
  if (item.size === null) return "Size unavailable";
  if (item.size >= 1_000_000) return `${(item.size / 1_000_000).toFixed(1)} MB`;
  if (item.size >= 1000) return `${Math.round(item.size / 1000)} KB`;
  return `${item.size} B`;
}
