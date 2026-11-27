import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { shelfFixture } from "./screenshots/shelf-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const pins = JSON.parse(
  await readFile(new URL("../progress/v2/M10/v52-assets.json", import.meta.url), "utf8"),
).assets;
for (const pin of pins) {
  const bytes = await readFile(new URL(`../${pin.file}`, import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.sha256);
  assert.equal(bytes.length, pin.bytes);
}
const modes = ["files", "selected", "missing", "empty", "error", "many", "no-preview"];
const cases = modes
  .filter((mode) => !process.argv[3] || mode === process.argv[3])
  .map((mode) => ({
    name: `shelf-${mode}`,
    suite: "shelf",
    entry: "island.html",
    surface: "island",
    label: "island",
    shelf: true,
    figmaNode: mode === "selected" ? "34:897" : "10:249",
    viewport: { width: 720, height: 460 },
    transparent: true,
    selector: ".island-morph",
    font: ".shelf-footer",
    caret: "initial",
    fixture: () => shelfFixture(mode),
    async ready(page) {
      const tab = page
        .getByRole("navigation", { name: "Island modules" })
        .getByRole("button", { name: "Files", exact: true });
      await tab.click();
      const list = page.getByRole("list", { name: "Shelf files" });
      await list.waitFor();
      await page.waitForFunction(
        () =>
          globalThis.document
            .querySelector('[aria-label="Shelf files"]')
            ?.getAttribute("aria-busy") === "false",
      );
      if (mode === "error") await page.getByRole("alert").waitFor();
      else if (mode !== "empty") {
        await list.locator("[data-shelf-id]").first().waitFor();
        if (!["no-preview", "selected"].includes(mode))
          await list.locator("img.shelf-thumbnail").waitFor();
        if (mode === "selected") {
          await list.getByRole("button", { name: /^Select IMG_4821/ }).click();
          await list.getByRole("button", { name: /^Select IMG_4822/ }).click();
          await list.getByRole("button", { name: /^Select receipt/ }).click();
          await page.getByText("3 selected").waitFor();
        }
        if (mode === "many")
          await list.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
        if (mode === "missing")
          await page
            .getByRole("button", { name: "Remove NABBIT_V2_HANDOFF.md", exact: true })
            .waitFor();
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
          const element = globalThis.document.querySelector(selector),
            b = element.getBoundingClientRect(),
            css = globalThis.getComputedStyle(element);
          return { width: b.width, height: b.height, radius: css.borderRadius, gap: css.gap };
        };
        return {
          overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
          morph: box(".island-morph"),
          grid: box(".shelf-grid"),
          assets: [
            ...globalThis.document.querySelectorAll(
              ".island-tabbar [data-asset-slot],.island-shelf [data-asset-slot]",
            ),
          ].map((e) => ({
            slot: e.dataset.assetSlot,
            width: e.getBoundingClientRect().width,
            height: e.getBoundingClientRect().height,
            loaded: e.complete && e.naturalWidth > 0,
          })),
          preview: globalThis.document.querySelector(".shelf-preview")
            ? box(".shelf-preview")
            : null,
          titleFont: globalThis.document.querySelector(".shelf-name > span")
            ? globalThis.getComputedStyle(globalThis.document.querySelector(".shelf-name > span"))
                .font
            : null,
          actionFont: globalThis.getComputedStyle(
            globalThis.document.querySelector(".shelf-footer button"),
          ).font,
        };
      });
      assert.equal(geometry.overflow, false);
      assert.equal(geometry.morph.width, 680);
      assert(geometry.morph.height <= 420);
      if (geometry.preview) assert.equal(geometry.preview.height, mode === "selected" ? 56 : 72);
      if (geometry.titleFont)
        assert(
          geometry.titleFont.startsWith("12px") || geometry.titleFont.startsWith("400 12px"),
          geometry.titleFont,
        );
      assert(
        geometry.actionFont.startsWith("12px") || geometry.actionFont.startsWith("400 12px"),
        geometry.actionFont,
      );
      for (const asset of geometry.assets) {
        const pin = pins.find((p) => p.slot === asset.slot);
        assert(pin, asset.slot);
        assert(asset.loaded);
        assert.equal(asset.width, pin.width);
        assert.equal(asset.height, pin.height);
      }
      return { mode, accessibility, geometry, noOsClipboardOrDrag: true };
    },
  }));
const report = await captureSuite(
  root,
  { milestone: "M10", prefix: process.argv[2] ?? "v52-shelf", suite: "all", repeatCheck: true },
  cases,
);
globalThis.console.log(`Verified ${report.captures.length} Shelf captures.`);
