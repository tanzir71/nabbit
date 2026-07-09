import { describe, expect, it } from "vitest";
import { clampIndex, filterClipboardEntries, formatRelativeTime } from "./search";
import type { ClipboardEntry } from "./types";

const entry = (id: string, content: string): ClipboardEntry => ({
  id,
  content,
  contentType: content.startsWith("http") ? "url" : "text",
  preview: content,
  hash: id,
  sourceApp: "Test",
  pinned: false,
  createdAt: "2026-07-09T00:00:00Z",
  lastUsedAt: "2026-07-09T00:00:00Z",
});

describe("clipboard search helpers", () => {
  it("filters entries fuzzily", () => {
    const results = filterClipboardEntries(
      [entry("1", "quarterly planning notes"), entry("2", "youtube research link")],
      "plan",
    );
    expect(results.map((item) => item.id)).toEqual(["1"]);
  });

  it("formats relative time tersely", () => {
    expect(formatRelativeTime("2026-07-09T11:59:20Z", new Date("2026-07-09T12:00:00Z"))).toBe("now");
    expect(formatRelativeTime("2026-07-09T11:50:00Z", new Date("2026-07-09T12:00:00Z"))).toBe("10m");
  });

  it("clamps keyboard navigation indexes", () => {
    expect(clampIndex(-1, 4)).toBe(0);
    expect(clampIndex(7, 4)).toBe(3);
    expect(clampIndex(0, 0)).toBe(-1);
  });
});
