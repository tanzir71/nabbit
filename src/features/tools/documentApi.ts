import { invoke } from "@tauri-apps/api/core";
import type { ToolJob } from "./api";
export interface DocumentOptions {
  inputs: string[];
  pages: number[];
}
export const documentApi = {
  pages: (path: string) => invoke<number>("tool_pdf_pages", { path }),
  start: (
    requestId: string,
    toolId: string,
    input: string,
    presetId: string,
    documentOptions: DocumentOptions,
  ) =>
    invoke<ToolJob>("tool_start", {
      request: { requestId, toolId, input, presetId, documentOptions },
    }),
};
/** Comma-separated ranges become separate PDFs; PNG rendering uses individual pages. */
export function pageGroups(value: string, count: number, every: boolean): number[][] {
  if (!Number.isInteger(count) || count < 1 || count > 1000)
    throw new Error("Choose a PDF with 1–1000 pages");
  if (every) return Array.from({ length: count }, (_, i) => [i + 1]);
  const used = new Set<number>();
  return value.split(",").map((part) => {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!match) throw new Error("Use page numbers or ranges, such as 1-3, 5-7");
    const start = Number(match[1]),
      end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > count) throw new Error("Page range is outside this PDF");
    const pages = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    for (const page of pages) {
      if (used.has(page)) throw new Error("Page ranges overlap");
      used.add(page);
    }
    return pages;
  });
}
