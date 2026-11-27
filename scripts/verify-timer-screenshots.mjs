import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { timerFixture } from "./screenshots/timer-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8"),
  slots = JSON.parse(
    await readFile(new URL("../src/assets/island/slots.json", import.meta.url), "utf8"),
  );
const modes = [
  "running",
  "peek",
  "compact",
  "paused",
  "ending",
  "ended",
  "break",
  "idle",
  "custom",
  "unavailable",
];
const cases = modes
  .filter((mode) => !process.argv[3] || mode === process.argv[3])
  .map((mode) => ({
    name: `timer-${mode}`,
    suite: "timer",
    entry: "island.html",
    surface: "island",
    label: "island",
    timer: true,
    figmaNode: mode === "compact" ? "7:103" : mode === "peek" ? "8:119" : "10:433",
    viewport: { width: 720, height: 460 },
    transparent: true,
    selector: ".island-morph",
    font: mode === "compact" ? null : mode === "peek" ? ".focus-titles strong" : ".focus-titles h2",
    fixture: () => timerFixture(mode),
    async ready(page) {
      if (!["peek", "compact"].includes(mode))
        await page
          .getByRole("navigation", { name: "Island modules" })
          .getByRole("button", { name: "Timer", exact: true })
          .click();
      if (mode !== "compact") await page.locator(".focus-titles").waitFor();
      if (mode === "custom") {
        await page.getByRole("button", { name: "Custom", exact: true }).click();
        await page.getByRole("form", { name: "Custom timer" }).waitFor();
      }
      await page.mouse.move(0, 0);
      await page.evaluate(async () => {
        await globalThis.document.fonts.ready;
        await Promise.all([...globalThis.document.images].map((img) => img.decode()));
        await new Promise((resolve) =>
          globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)),
        );
      });
      await page.addScriptTag({ content: axe });
      const accessibility = await page.evaluate(async () => {
        const r = await globalThis.axe.run();
        const summary = (rows) =>
          rows.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => ({ target: n.target, detail: n.failureSummary })),
          }));
        return { violations: summary(r.violations), incomplete: summary(r.incomplete) };
      });
      assert.deepEqual(accessibility, { violations: [], incomplete: [] });
      const geometry = await page.evaluate(() => {
        const box = (sel) => {
          const e = globalThis.document.querySelector(sel);
          if (!e) return null;
          const b = e.getBoundingClientRect(),
            c = globalThis.getComputedStyle(e);
          return {
            width: b.width,
            height: b.height,
            font: c.font,
            radius: c.borderRadius,
            gap: c.gap,
          };
        };
        return {
          morph: box(".island-morph"),
          ring: box(".focus-ring"),
          digits: box(".focus-digits,.focus-peek-digits"),
          title: box(".focus-titles h2,.focus-titles strong"),
          chip: box(".focus-presets .n-preset"),
          button: box(".focus-controls .focus-button"),
          header: box(".focus-peek-header"),
          overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
          assets: [...globalThis.document.querySelectorAll("[data-asset-slot]")]
            .filter((e) => e.getBoundingClientRect().width > 0)
            .map((e) => ({
              slot: e.dataset.assetSlot,
              width: e.getBoundingClientRect().width,
              height: e.getBoundingClientRect().height,
              loaded: e.complete && e.naturalWidth > 0,
            })),
        };
      });
      assert(!geometry.overflow);
      assert.equal(geometry.morph.width, mode === "compact" ? 240 : mode === "peek" ? 400 : 680);
      assert(geometry.morph.height <= 420);
      if (geometry.ring) {
        assert.equal(geometry.ring.width, 120);
        assert.equal(geometry.ring.height, 120);
        assert(geometry.digits.font.includes("26px"));
        assert(geometry.title.font.includes("600 14px"));
        assert(geometry.chip.font.includes("500 13px"));
        assert.equal(geometry.button.height, 28);
        if (mode !== "custom") assert.equal(geometry.morph.height, 192);
      }
      if (mode === "peek") {
        assert.equal(geometry.morph.height, 72);
        assert.equal(geometry.header.gap, "12px");
        assert(geometry.digits.font.includes("22px"));
      }
      for (const asset of geometry.assets) {
        const [group, name] = asset.slot.split("/");
        const file = slots[group][name];
        assert(file && asset.loaded, asset.slot);
        const svg = await readFile(
          new URL(`../src/assets/island/${file}`, import.meta.url),
          "utf8",
        );
        const width = Number(svg.match(/\bwidth="([\d.]+)"/)[1]),
          height = Number(svg.match(/\bheight="([\d.]+)"/)[1]);
        // Chromium quantizes each fractional edge to 1/64 px. SVG roots stay unchanged.
        if (Number.isInteger(width) && Number.isInteger(height)) {
          assert.equal(asset.width, width, asset.slot);
          assert.equal(asset.height, height, asset.slot);
        } else {
          assert(
            Math.abs(asset.width - width) <= 2 / 64,
            `${asset.slot}: width ${asset.width} vs ${width}`,
          );
          assert(
            Math.abs(asset.height - height) <= 2 / 64,
            `${asset.slot}: height ${asset.height} vs ${height}`,
          );
        }
      }
      return { mode, accessibility, geometry, noOsClockOrPowerChange: true };
    },
  }));
const report = await captureSuite(
  root,
  { milestone: "M10", prefix: process.argv[2] ?? "v54-timer", suite: "all", repeatCheck: true },
  cases,
);
globalThis.console.log(`Verified ${report.captures.length} Focus timer captures.`);
