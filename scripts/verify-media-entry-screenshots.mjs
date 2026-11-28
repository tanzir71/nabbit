import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { filesFixture } from "./screenshots/files-fixtures.mjs";
import { mediaTools, mediaPresets } from "./screenshots/media-tools-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const path = "C:\\Fixture\\launch-clip.mp4";
const report = await captureSuite(
  root,
  { milestone: "M10", prefix: process.argv[2] ?? "v59-entry-a", suite: "all", repeatCheck: true },
  ["drop-fit", "shelf-media"].map((mode) => ({
    name: `media-entry-${mode}`,
    suite: "files",
    entry: "island.html",
    surface: "island",
    label: "island",
    shelf: true,
    files: true,
    tools: true,
    viewport: { width: 720, height: 640 },
    selector: ".island-morph",
    font: mode === "drop-fit" ? ".island-drop-content strong" : ".tool-actions button",
    pageClip: true,
    cdpCapture: true,
    captureBeyondViewport: false,
    caret: "initial",
    naturalMotion: true,
    transparent: true,
    retainFailures: true,
    figmaNode: mode === "drop-fit" ? "43:692" : "34:897",
    fixture: () => {
      const seed = filesFixture("files-top");
      seed.responses.tool_catalog = mediaTools;
      seed.responses.tool_presets = mediaPresets;
      seed.responses.tool_suggest = "fit-size";
      seed.data.shelf = [
        {
          id: "video",
          path,
          name: "launch-clip.mp4",
          kind: "file",
          size: 42000000,
          available: true,
          preview: null,
        },
      ];
      return seed;
    },
    async ready(page) {
      await page.locator('[data-island-tab="files"]').click();
      if (mode === "drop-fit") {
        await page.evaluate(
          (path) =>
            globalThis.__NABBIT_CAPTURE__.emit("nabbit://native-drop", {
              kind: "enter",
              payload: { files: [path] },
              x: 0,
              y: 0,
              shift: false,
              ctrl: false,
            }),
          path,
        );
        await page.locator('[data-drop-zone="tool:fit-size"]').waitFor();
        assert(
          await page
            .locator('[data-drop-zone="tool:fit-size"]')
            .evaluate((n) => n.classList.contains("is-over")),
        );
        assert.equal(
          await page.locator('[data-drop-zone="tool:fit-size"] strong').textContent(),
          "Fit for Discord",
        );
      } else {
        await page.getByRole("button", { name: /Select launch-clip.mp4/ }).click();
        const group = page.getByRole("group", { name: "File tools" });
        await group.getByRole("button", { name: "Fit under a size", exact: true }).waitFor();
        assert.equal(await group.getByRole("button").count(), 8);
        await group.scrollIntoViewIfNeeded();
      }
      await page.mouse.move(0, 630);
      await page.evaluate(async () => {
        globalThis.document.activeElement?.blur();
        await globalThis.document.fonts.ready;
        await Promise.all([...globalThis.document.images].map((i) => i.decode()));
      });
      await page.waitForTimeout(1200);
      await page.addScriptTag({ content: axe });
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
      const calls = await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot().calls);
      assert(
        !calls.some((c) =>
          ["tool_start", "tool_open_media_sheet", "files_plan", "files_execute"].includes(
            c.command,
          ),
        ),
      );
      return { mode, accessibility, noJobOrTransferStarted: true };
    },
  })),
);
globalThis.console.log(`Verified ${report.captures.length} media entry captures.`);
