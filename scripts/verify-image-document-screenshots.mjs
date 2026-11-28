import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { imageDocumentFixture } from "./screenshots/image-document-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const modes = [
  "convert",
  "advanced",
  "smaller",
  "fit",
  "codec",
  "choose",
  "merge",
  "split",
  "render",
  "pdf",
  "ocr",
  "decode",
  "encode",
];
const report = await captureSuite(
  root,
  {
    milestone: "M10",
    prefix: process.argv[2] ?? "v510-image-doc-a",
    suite: "all",
    repeatCheck: true,
  },
  modes.map((mode) => ({
    name: `file-tools-${mode}`,
    suite: "surfaces",
    entry: "index.html",
    query: "?media-sheet",
    surface: "media-sheet",
    label: "media-sheet",
    tools: true,
    selector: ".media-review",
    font: ".media-header h1",
    viewport: { width: 640, height: 840 },
    pageClip: true,
    cdpCapture: true,
    captureBeyondViewport: false,
    caret: "initial",
    naturalMotion: true,
    transparent: true,
    retainFailures: true,
    figmaNode: ["convert", "advanced", "smaller", "fit", "codec", "choose"].includes(mode)
      ? "36:410"
      : null,
    fixture: () => imageDocumentFixture(mode),
    async ready(page) {
      await page.locator(".media-header h1").waitFor();
      if (["convert", "advanced", "smaller", "fit"].includes(mode))
        await page.waitForFunction(() =>
          globalThis.document.querySelector(".image-inputs")?.textContent.includes("2.4 MB"),
        );
      if (mode === "advanced") await page.locator("details summary").click();
      if (["split", "render"].includes(mode)) {
        await page.getByText("7 pages", { exact: true }).waitFor();
        await page.getByLabel("Page ranges", { exact: true }).check();
        await page.getByLabel("Ranges", { exact: true }).fill("1-3, 5-7");
      }
      if (mode === "codec")
        await page.getByRole("button", { name: "Get HEIF extension" }).waitFor();
      await page.mouse.move(630, 830);
      await page.evaluate(async () => {
        globalThis.document.activeElement?.blur();
        await globalThis.document.fonts.ready;
        await Promise.all([...globalThis.document.images].map((i) => i.decode()));
      });
      await page.addScriptTag({ content: axe });
      await page.waitForTimeout(1200);
      const accessibility = await page.evaluate(async () => {
        const r = await globalThis.axe.run();
        const compact = (rows) =>
          rows.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
          }));
        return { violations: compact(r.violations), incomplete: compact(r.incomplete) };
      });
      assert.deepEqual(accessibility, { violations: [], incomplete: [] });
      if (["convert", "advanced", "smaller", "fit"].includes(mode)) {
        const thumb = await page
          .locator(".image-quality input")
          .evaluate((input) =>
            globalThis.getComputedStyle(input).getPropertyValue("--image-thumb"),
          );
        assert(thumb.includes("svg"), "Original SVG range thumb must resolve in CSS");
      }
      const geometry = await page.locator(".media-review").boundingBox();
      assert.equal(
        geometry.width,
        ["convert", "advanced", "smaller", "fit", "codec", "choose"].includes(mode) ? 460 : 440,
      );
      const calls = await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot().calls);
      assert(
        !calls.some((c) =>
          ["tool_start", "tool_image_codec", "tool_pick_input"].includes(c.command),
        ),
      );
      return { mode, accessibility, geometry, noJobStarted: true };
    },
  })),
);
globalThis.console.log(`Verified ${report.captures.length} image/document captures.`);
