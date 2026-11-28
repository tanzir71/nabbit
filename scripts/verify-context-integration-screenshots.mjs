import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { fixtureData } from "./screenshots/fixtures.mjs";
import { filesFixture } from "./screenshots/files-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const cases = ["batch", "batch-error", "preferences-off", "preferences-on"].map((mode) => {
  const settings = mode.startsWith("preferences");
  return {
    name: `context-${mode}`,
    suite: "surfaces",
    entry: settings ? "settings.html" : "island.html",
    surface: settings ? "settings" : "island",
    label: settings ? "settings" : "island",
    shelf: !settings,
    files: !settings,
    tools: !settings,
    viewport: { width: settings ? 560 : 720, height: 760 },
    selector: settings ? '[aria-label="Explorer and selected text settings"]' : ".island-morph",
    font: settings ? '[aria-label="Explorer and selected text settings"] h3' : ".shelf-heading",
    caret: "initial",
    naturalMotion: true,
    retainFailures: true,
    transparent: !settings,
    pageClip: !settings,
    cdpCapture: !settings,
    fixture: () => {
      if (settings)
        return {
          data: fixtureData("settings"),
          responses: {
            tool_presets: [],
            context_preferences: {
              sendTo: mode.endsWith("on"),
              contextMenu: mode.endsWith("on"),
              selectionCopyFallback: false,
            },
          },
        };
      const seed = filesFixture("files-top");
      const paths = ["C:\\Fixture\\one.png", "C:\\Fixture\\two.png"];
      seed.responses.context_batch =
        mode === "batch-error"
          ? {
              batch: null,
              error: "An incoming file is no longer available. The Shelf is unchanged.",
            }
          : {
              batch: {
                id: "fixture-explorer-batch",
                paths,
                reviews: [{ target: { kind: "tool", toolId: "to-jpg", presetId: "jpg" }, paths }],
              },
              error: null,
            };
      return seed;
    },
    async ready(page) {
      if (settings) {
        const group = page.getByRole("region", { name: "Explorer and selected text settings" });
        await group.getByRole("button", { name: "Save integration options" }).waitFor();
        await group.scrollIntoViewIfNeeded();
        assert.equal(
          await group
            .getByRole("switch", { name: "Show Nabbit in Send To", exact: true })
            .getAttribute("aria-checked"),
          String(mode.endsWith("on")),
        );
        assert.equal(
          await group
            .getByRole("switch", { name: "Allow clipboard fallback for selected text" })
            .getAttribute("aria-checked"),
          "false",
        );
      } else {
        await page
          .getByRole("navigation", { name: "Island modules" })
          .getByRole("button", { name: "Files", exact: true })
          .click();
        if (mode === "batch")
          await page.getByRole("button", { name: "Review To JPG", exact: true }).waitFor();
        else await page.getByRole("alert").filter({ hasText: "incoming file" }).waitFor();
        await page.getByRole("button", { name: "Files", exact: true }).focus();
      }
      await page.mouse.move(settings ? 550 : 710, 750);
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
          [
            "save_context_preferences",
            "tool_start",
            "tool_open_media_sheet",
            "shelf_remove",
          ].includes(c.command),
        ),
      );
      return { mode, accessibility, noRegistrationOrJob: true };
    },
  };
});
const report = await captureSuite(
  root,
  {
    milestone: "M10",
    prefix: process.argv[2] ?? "v511-integration-a",
    suite: "all",
    repeatCheck: true,
  },
  cases,
);
globalThis.console.log(`Verified ${report.captures.length} context integration captures.`);
