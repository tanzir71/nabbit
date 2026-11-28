import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { mediaToolsFixture } from "./screenshots/media-tools-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const modes = [
  "fit",
  "fast",
  "no-gpu",
  "custom",
  "advanced",
  "audio-fit",
  "mp4",
  "trim",
  "audio",
  "gif",
  "webp",
  "strip",
  "choose",
  "error",
  "running",
];
const report = await captureSuite(
  root,
  { milestone: "M10", prefix: process.argv[2] ?? "v59-media-a", suite: "all", repeatCheck: true },
  modes.map((mode) => ({
    name: `media-tools-${mode}`,
    suite: "surfaces",
    entry: mode === "running" ? "island.html" : "index.html",
    query: mode === "running" ? undefined : "?media-sheet",
    surface: mode === "running" ? "island" : "media-sheet",
    label: mode === "running" ? "island" : "media-sheet",
    tools: true,
    selector: mode === "running" ? ".island-morph" : ".media-review",
    font: mode === "running" ? ".island-compact .island-muted" : ".media-header h1",
    viewport: { width: 640, height: 840 },
    pageClip: true,
    cdpCapture: true,
    captureBeyondViewport: false,
    caret: "initial",
    naturalMotion: true,
    transparent: true,
    retainFailures: true,
    figmaNode: mode === "running" ? "33:535" : "45:282",
    fixture: () => mediaToolsFixture(mode),
    async ready(page) {
      if (mode === "running") await page.locator(".island-compact").waitFor();
      else {
        await page.locator(".media-header h1").waitFor();
        if (!["choose", "error"].includes(mode))
          await page.waitForFunction(() =>
            globalThis.document.querySelector(".media-header p")?.textContent.includes("42.0 MB"),
          );
        if (mode === "error") await page.getByRole("alert").waitFor();
        if (mode === "fast")
          await page.getByRole("button", { name: "Fast · GPU (h264_qsv)" }).click();
        if (mode === "custom") {
          await page.getByRole("button", { name: "Custom…" }).click();
          await page.getByLabel("Maximum size (MB)").fill("18");
        }
        if (["advanced", "gif", "audio"].includes(mode))
          await page.locator(".media-advanced summary").click();
        if (mode === "advanced") {
          await page.getByRole("switch", { name: "Use a section" }).click();
          await page.getByLabel("Start", { exact: true }).fill("0:10.0");
          await page.getByLabel("End", { exact: true }).fill("1:10.0");
        }
      }
      await page.mouse.move(630, 830);
      await page.evaluate(async () => {
        globalThis.document.activeElement?.blur();
        await globalThis.document.fonts.ready;
        await Promise.all([...globalThis.document.images].map((i) => i.decode()));
      });
      await page.addScriptTag({ content: axe });
      await page.waitForTimeout(1200);
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.document
              .getAnimations()
              .filter((a) => a.playState === "running" || a.pending).length,
        ),
        0,
      );
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
      const assets = await page.locator("[data-asset]").evaluateAll((nodes) =>
        nodes
          .filter((n) => n.getBoundingClientRect().width > 0)
          .map((n) => ({
            file: n.dataset.asset,
            loaded: n.complete && n.naturalWidth > 0,
            width: n.getBoundingClientRect().width,
            height: n.getBoundingClientRect().height,
          })),
      );
      for (const a of assets) {
        assert(a.loaded);
        const svg = await readFile(
          new URL(
            `../src/assets/${a.file.includes("/") ? a.file : `components/${a.file}`}`,
            import.meta.url,
          ),
          "utf8",
        );
        assert.equal(a.width, Number(svg.match(/\bwidth="([\d.]+)"/)[1]));
        assert.equal(a.height, Number(svg.match(/\bheight="([\d.]+)"/)[1]));
      }
      const geometry = await page
        .locator(mode === "running" ? ".island-morph" : ".media-review")
        .boundingBox();
      assert.equal(geometry.width, mode === "running" ? 300 : 440);
      if (mode === "running") assert.equal(geometry.height, 32);
      const calls = await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot().calls);
      assert(
        !calls.some((c) =>
          ["tool_start", "tool_save_preset", "tool_pick_input", "tool_open_media_sheet"].includes(
            c.command,
          ),
        ),
      );
      assert.equal(
        calls.filter((c) => c.command === "tool_media_capabilities" && c.args.probeGpu).length,
        0,
        "Capture uses a probed fixture; no hidden synthetic encode",
      );
      return { mode, accessibility, assets, geometry, noJobStarted: true };
    },
  })),
);
globalThis.console.log(`Verified ${report.captures.length} media tool captures.`);
