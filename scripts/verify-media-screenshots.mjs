import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { mediaFixture } from "./screenshots/media-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const slots = JSON.parse(
  await readFile(new URL("../src/assets/island/slots.json", import.meta.url), "utf8"),
);
const modes = ["expanded", "peek", "compact", "paused", "no-timeline", "empty", "error"];
const cases = modes
  .filter((mode) => !process.argv[3] || mode === process.argv[3])
  .map((mode) => ({
    name: `media-${mode}`,
    suite: "media",
    entry: "island.html",
    surface: "island",
    label: "island",
    media: true,
    figmaNode: mode === "compact" ? "7:103" : mode === "peek" ? "8:119" : "10:341",
    viewport: { width: 720, height: 460 },
    transparent: true,
    selector: ".island-morph",
    font:
      mode === "compact"
        ? null
        : mode === "empty" || mode === "error"
          ? "h2"
          : ".media-titles strong",
    fixture: () => mediaFixture(mode),
    async ready(page) {
      if (!["compact", "peek"].includes(mode))
        await page
          .getByRole("navigation", { name: "Island modules" })
          .getByRole("button", { name: "Media", exact: true })
          .click();
      if (mode === "empty" || mode === "error")
        await page.getByText("Nothing playing", { exact: true }).waitFor();
      else if (mode !== "compact")
        await page
          .getByText(mode === "no-timeline" ? "Live radio" : "Night Drive", { exact: true })
          .waitFor();
      await page.mouse.move(0, 0);
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
          return { width: b.width, height: b.height, radius: c.borderRadius, font: c.font };
        };
        return {
          overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
          morph: box(".island-morph"),
          art: box(".island-artwork"),
          controls: box(".media-controls"),
          skip: box(".media-skip"),
          toggle: box(".media-toggle"),
          chip: box(".media-session-chips .n-preset"),
          title: box(".media-titles strong"),
          skipBackground: globalThis.document.querySelector(".media-skip")
            ? globalThis.getComputedStyle(globalThis.document.querySelector(".media-skip"))
                .backgroundColor
            : null,
          timeline: !!globalThis.document.querySelector("[data-media-timeline]"),
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
      assert.equal(geometry.morph.width, mode === "compact" ? 272 : mode === "peek" ? 400 : 680);
      assert(geometry.morph.height <= 420);
      if (geometry.art)
        assert.equal(geometry.art.width, mode === "compact" ? 20 : mode === "peek" ? 44 : 112);
      if (geometry.skip) {
        assert.equal(geometry.skip.width, mode === "peek" ? 28 : 34);
        assert.equal(geometry.skip.height, mode === "peek" ? 28 : 34);
        assert.equal(geometry.skipBackground, "rgba(0, 0, 0, 0)");
        assert.equal(geometry.toggle.width, mode === "peek" ? 32 : 40);
        assert(geometry.title.font.includes(mode === "peek" ? "13px" : "18px"));
      }
      if (geometry.chip) assert(geometry.chip.font.includes("500 13px"));
      if (["paused", "no-timeline"].includes(mode))
        await page.getByRole("button", { name: "Play playback" }).waitFor();
      if (mode === "no-timeline") assert(!geometry.timeline);
      for (const asset of geometry.assets) {
        const [group, name] = asset.slot.split("/");
        const file = slots[group][name];
        assert(file && asset.loaded, asset.slot);
        const svg = await readFile(
          new URL(`../src/assets/island/${file}`, import.meta.url),
          "utf8",
        );
        const w = Number(svg.match(/\bwidth="([\d.]+)"/)[1]),
          h = Number(svg.match(/\bheight="([\d.]+)"/)[1]);
        assert.equal(asset.width, w, asset.slot);
        assert.equal(asset.height, h, asset.slot);
      }
      return { mode, accessibility, geometry, noRealPlaybackOrVolume: true };
    },
  }));
const report = await captureSuite(
  root,
  { milestone: "M10", prefix: process.argv[2] ?? "v53-media", suite: "all", repeatCheck: true },
  cases,
);
globalThis.console.log(`Verified ${report.captures.length} Media captures.`);
