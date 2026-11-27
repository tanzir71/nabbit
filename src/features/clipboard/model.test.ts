import { expect, it } from "vitest";
import type { ClipboardEntry } from "../../lib/types";
import { clipboardThumbnail } from "./model";
const image = (blobPath: string) => ({ contentType: "image", blobPath }) as ClipboardEntry;
it("renders only bounded raster data previews, never local files, SVG or remote image URLs", () => {
  for (const path of [
    "C:\\Users\\Fixture\\private.png",
    "file:///C:/Fixture/private.png",
    "https://example.invalid/private.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,invalid!",
    "data:image/png;base64," + "A".repeat(200000),
  ])
    expect(clipboardThumbnail(image(path))).toBeUndefined();
  const preview = "data:image/png;base64,AAAA";
  expect(clipboardThumbnail(image(preview))).toBe(preview);
  expect(clipboardThumbnail({ ...image(preview), contentType: "text" })).toBeUndefined();
});
