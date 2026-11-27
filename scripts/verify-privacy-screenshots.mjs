import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { privacyFixture } from "./screenshots/privacy-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const modes = ["mic", "camera", "both", "long", "split", "peek", "off"];
const report = await captureSuite(
  root,
  { milestone: "M10", prefix: process.argv[2] ?? "v55-privacy", suite: "all", repeatCheck: true },
  modes.map((mode) => ({
    name: `privacy-${mode}`,
    suite: "privacy",
    entry: "island.html",
    surface: "island",
    label: "island",
    figmaNode: "7:40",
    viewport: { width: 720, height: 460 },
    transparent: true,
    selector: ".island-morph",
    font:
      mode === "off"
        ? null
        : mode === "peek"
          ? ".island-text-stack strong"
          : ".island-compact .island-muted",
    fixture: () => privacyFixture(mode),
    async ready(page) {
      if (mode !== "off")
        await page
          .getByText(
            mode === "long"
              ? "An application with a very long descriptive name, Recorder"
              : mode === "peek"
                ? "Microphone and camera in use"
                : mode === "both"
                  ? "Teams, Virtual Camera Host"
                  : mode === "camera"
                    ? "Virtual Camera Host"
                    : "Teams",
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
            bg: c.backgroundColor,
            mask: c.maskImage,
            title: e.title,
            scrollWidth: e.scrollWidth,
          };
        };
        return {
          morph: box(".island-morph"),
          compact: box(".island-compact"),
          label: box(".island-compact .island-muted"),
          dot: box(".island-privacy-dot"),
          camera: box(".island-camera-dot"),
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
        mode === "off" ? 112 : mode === "peek" ? 400 : mode === "split" ? 298 : 232,
      );
      assert.equal(geometry.morph.height, mode === "off" ? 26 : mode === "peek" ? 78 : 32);
      if (!["off", "peek"].includes(mode)) {
        assert.equal(geometry.compact.width, mode === "split" ? 260 : 232);
        assert.equal(geometry.compact.gap, "8px");
        assert(geometry.label.font.includes("12px"));
        assert.equal(geometry.dot.width, 8);
        assert.equal(geometry.dot.height, 8);
      }
      if (["camera", "both"].includes(mode)) {
        assert.equal(geometry.camera.bg, "rgb(198, 242, 78)");
        assert(geometry.camera.mask.includes("url("));
      }
      if (mode === "long")
        assert(
          geometry.label.scrollWidth > geometry.label.width &&
            geometry.label.title.includes("Recorder"),
        );
      const slots = JSON.parse(
        await readFile(new URL("../src/assets/island/slots.json", import.meta.url), "utf8"),
      );
      for (const asset of geometry.assets) {
        const [group, name] = asset.slot.split("/");
        const svg = await readFile(
          new URL(`../src/assets/island/${slots[group][name]}`, import.meta.url),
          "utf8",
        );
        assert(asset.loaded);
        assert.equal(asset.width, Number(svg.match(/\bwidth="([\d.]+)"/)[1]));
        assert.equal(asset.height, Number(svg.match(/\bheight="([\d.]+)"/)[1]));
      }
      return { mode, accessibility, geometry, noDevicesOrRealRegistry: true };
    },
  })),
);
globalThis.console.log(`Verified ${report.captures.length} mic/camera captures.`);
