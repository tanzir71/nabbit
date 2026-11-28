import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Buffer } from "node:buffer";

export const themes = ["light", "dark"];
export const scales = [1, 1.5];
export const pngBudget = 300 * 1024;
// Chrome's tooling guidance: finish compositor work before readback so rounded
// edge coverage is stable. Only owned screenshot browsers/WebViews opt in.
// https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md#rendering--gpu
export const deterministicRenderingFlags = Object.freeze([
  "--run-all-compositor-stages-before-draw",
  "--disable-new-content-rendering-timeout",
  "--disable-threaded-animation",
  "--disable-threaded-scrolling",
  "--disable-checker-imaging",
  "--disable-image-animation-resync",
  "--disable-partial-raster",
]);

export function outputOptions(root, { milestone, prefix, suite = "all" }) {
  assert(/^M(?:[0-9]|1[0-2])$/.test(milestone ?? ""), "Use --milestone M0 through M12");
  assert(
    /^[a-z][a-z0-9-]{0,63}$/.test(prefix ?? ""),
    "Use a unique lowercase --prefix (letters, numbers, hyphens)",
  );
  assert(["all", "surfaces", "foundations"].includes(suite), "Unknown screenshot suite");
  return { milestone, prefix, suite, folder: resolve(root, "progress/v2", milestone) };
}

export function pngInfo(bytes, expectedWidth, expectedHeight) {
  assert(
    bytes.length > 24 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "Expected PNG bytes",
  );
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  assert.deepEqual(
    [width, height],
    [expectedWidth, expectedHeight],
    "PNG must retain device-pixel dimensions",
  );
  assert(bytes.length <= pngBudget, "PNG exceeds the 300 KiB evidence limit");
  return { width, height, bytes: bytes.length };
}
