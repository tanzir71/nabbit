import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { powerFixture } from "./screenshots/power-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8"),
  slots = JSON.parse(
    await readFile(new URL("../src/assets/island/slots.json", import.meta.url), "utf8"),
  );
const modes = ["charging", "unplugged", "low", "full", "unknown", "peek", "idle", "split"];
const report = await captureSuite(
  root,
  { milestone: "M10", prefix: process.argv[2] ?? "v56-power", suite: "all", repeatCheck: true },
  modes.map((mode) => ({
    name: `power-${mode}`,
    suite: "power",
    entry: "island.html",
    surface: "island",
    label: "island",
    figmaNode: "7:48",
    viewport: { width: 720, height: 460 },
    transparent: true,
    selector: ".island-morph",
    font:
      mode === "idle"
        ? null
        : mode === "peek"
          ? ".island-text-stack strong"
          : ".island-compact .island-muted",
    fixture: () => powerFixture(mode),
    async ready(page) {
      if (mode !== "idle")
        await page
          .getByText(
            mode === "unplugged"
              ? "On battery"
              : mode === "low"
                ? "Battery low"
                : mode === "full"
                  ? "Plugged in"
                  : "Charging",
            { exact: true },
          )
          .waitFor();
      await page.mouse.move(0, 0);
      await page.evaluate(async () => {
        await globalThis.document.fonts.ready;
        await Promise.all([...globalThis.document.images].map((i) => i.decode()));
      });
      await page.addScriptTag({ content: axe });
      const accessibility = await page.evaluate(async () => {
        const r = await globalThis.axe.run();
        const summarize = (rows) =>
          rows.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => ({ target: n.target, detail: n.failureSummary })),
          }));
        return { violations: summarize(r.violations), incomplete: summarize(r.incomplete) };
      });
      assert.deepEqual(accessibility, { violations: [], incomplete: [] });
      const geometry = await page.evaluate(() => {
        const box = (s) => {
          const e = globalThis.document.querySelector(s);
          if (!e) return null;
          const b = e.getBoundingClientRect(),
            c = globalThis.getComputedStyle(e);
          return {
            width: b.width,
            height: b.height,
            font: c.font,
            gap: c.gap,
            padding: c.padding,
            text: e.textContent,
            title: e.title,
          };
        };
        return {
          morph: box(".island-morph"),
          compact: box(".island-compact"),
          label: box(".island-compact .island-muted"),
          digits: box(".island-compact .island-mono"),
          assets: [...globalThis.document.querySelectorAll("[data-asset-slot]")]
            .filter((e) => e.getBoundingClientRect().width > 0)
            .map((e) => ({
              slot: e.dataset.assetSlot,
              width: e.getBoundingClientRect().width,
              height: e.getBoundingClientRect().height,
              loaded: e.complete && e.naturalWidth > 0,
            })),
          overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
        };
      });
      assert(!geometry.overflow);
      assert.equal(
        geometry.morph.width,
        mode === "idle" ? 112 : mode === "peek" ? 400 : mode === "split" ? 298 : 232,
      );
      assert.equal(geometry.morph.height, mode === "idle" ? 26 : mode === "peek" ? 60 : 32);
      if (!["idle", "peek"].includes(mode)) {
        assert.equal(geometry.compact.width, mode === "split" ? 260 : 232);
        assert.equal(geometry.compact.gap, "8px");
        assert(geometry.label.font.includes("12px"));
        assert(geometry.digits.font.includes("500 12px"));
        assert.equal(
          geometry.digits.text,
          mode === "unknown" ? "—" : mode === "low" ? "20%" : mode === "full" ? "100%" : "82%",
        );
      }
      for (const a of geometry.assets) {
        const [group, name] = a.slot.split("/");
        const svg = await readFile(
          new URL(`../src/assets/island/${slots[group][name]}`, import.meta.url),
          "utf8",
        );
        assert(a.loaded);
        assert.equal(a.width, Number(svg.match(/\bwidth="([\d.]+)"/)[1]));
        assert.equal(a.height, Number(svg.match(/\bheight="([\d.]+)"/)[1]));
      }
      return { mode, accessibility, geometry, noRealPowerChange: true };
    },
  })),
);
globalThis.console.log(`Verified ${report.captures.length} battery/charging captures.`);
