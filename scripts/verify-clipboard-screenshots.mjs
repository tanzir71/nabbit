import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { clipboardFixture } from "./screenshots/clipboard-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const pins = JSON.parse(
  await readFile(new URL("../progress/v2/M10/v51-assets.json", import.meta.url), "utf8"),
).assets;
for (const pin of pins) {
  const bytes = await readFile(new URL(`../${pin.file}`, import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.sha256);
  assert.equal(bytes.length, pin.bytes);
}
const modes = [
  "all",
  "Text",
  "Links",
  "Images",
  "Files",
  "Pinned",
  "empty",
  "error",
  "scroll",
  "context",
];
const cases = modes
  .filter((m) => !process.argv[3] || process.argv[3] === m)
  .map((mode) => ({
    name: `clipboard-${mode.toLowerCase()}`,
    suite: "clipboard",
    entry: "island.html",
    surface: "island",
    label: "island",
    figmaNode: "9:330",
    viewport: { width: 720, height: 460 },
    transparent: true,
    selector: ".island-morph",
    font: ".island-clipboard-footer",
    caret: "initial",
    fixture: () => clipboardFixture(mode),
    async ready(page) {
      const tab = page
        .getByRole("navigation", { name: "Island modules" })
        .getByRole("button", { name: "Clipboard", exact: true });
      await tab.click();
      const grid = page.getByRole("grid", { name: "Clipboard history" });
      await grid.waitFor();
      await page.waitForFunction(
        () =>
          globalThis.document
            .querySelector('[aria-label="Clipboard history"]')
            ?.getAttribute("aria-busy") === "false",
      );
      if (["Text", "Links", "Images", "Files", "Pinned"].includes(mode))
        await page
          .getByRole("group", { name: "Clipboard filters" })
          .getByRole("button", { name: mode, exact: true })
          .click();
      if (mode === "empty") await page.getByText("Your clipboard history is empty.").waitFor();
      else if (mode === "error") await page.getByRole("alert").waitFor();
      else {
        await grid.locator("[data-clipboard-id]").first().waitFor();
        if (mode === "scroll") {
          await page.getByRole("combobox", { name: "Search clipboard" }).focus();
          await page.keyboard.press("End");
          assert.equal(
            await grid.locator('[aria-selected="true"]').getAttribute("data-clipboard-id"),
            "extra-79",
          );
          assert(await grid.evaluate((e) => e.scrollTop > 0));
        }
      }
      await tab.focus();
      await page.mouse.move(0, 0);
      await page.addScriptTag({ content: axe });
      const accessibility = await page.evaluate(async () => {
        const result = await globalThis.axe.run();
        const summarize = (rows) =>
          rows.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => ({ target: n.target, detail: n.failureSummary })),
          }));
        return {
          violations: summarize(result.violations),
          incomplete: summarize(result.incomplete),
        };
      });
      assert.deepEqual(accessibility, { violations: [], incomplete: [] });
      const geometry = await page.evaluate(() => {
        const box = (selector) => {
          const e = globalThis.document.querySelector(selector);
          const b = e.getBoundingClientRect();
          const css = globalThis.getComputedStyle(e);
          return {
            width: b.width,
            height: b.height,
            radius: css.borderRadius,
            padding: css.padding,
            gap: css.gap,
          };
        };
        return {
          overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
          morph: box(".island-morph"),
          search: box(".island-clipboard-field"),
          controls: box(".island-clipboard-controls"),
          list: box(".island-clipboard-results"),
          assets: [...globalThis.document.querySelectorAll('[data-asset-slot^="9:330/"]')].map(
            (e) => ({
              slot: e.dataset.assetSlot,
              width: e.getBoundingClientRect().width,
              height: e.getBoundingClientRect().height,
              loaded: e.complete && e.naturalWidth > 0,
            }),
          ),
        };
      });
      assert.equal(geometry.overflow, false);
      assert.equal(geometry.morph.width, 680);
      assert(geometry.morph.height <= 420);
      assert.equal(geometry.search.width, 240);
      assert.equal(geometry.search.height, 32);
      for (const asset of geometry.assets) {
        const pin = pins.find((p) => p.slot === asset.slot);
        assert(pin, asset.slot);
        assert(asset.loaded);
        assert.equal(asset.width, pin.width);
        assert.equal(asset.height, pin.height);
      }
      return { mode, accessibility, geometry, osClipboardUsed: false };
    },
  }));
const report = await captureSuite(
  root,
  { milestone: "M10", prefix: process.argv[2] ?? "v51-clipboard", suite: "all", repeatCheck: true },
  cases,
);
globalThis.console.log(`Verified ${report.captures.length} Clipboard captures.`);
