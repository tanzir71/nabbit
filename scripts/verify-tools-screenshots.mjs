import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { toolsFixture } from "./screenshots/tools-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8"),
  slots = JSON.parse(
    await readFile(new URL("../src/assets/island/slots.json", import.meta.url), "utf8"),
  );
const modes = [
  "result-compact",
  "running-compact",
  "result-peek",
  "failed-peek",
  "search-pdf",
  "search-tool",
  "tool-sheet",
  "queue-completed",
  "queue-cancelled",
];
const report = await captureSuite(
  root,
  { milestone: "M10", prefix: process.argv[2] ?? "v57-tools", suite: "all", repeatCheck: true },
  modes.map((mode) => ({
    name: `tools-${mode}`,
    suite: "tools",
    entry: "island.html",
    surface: "island",
    label: "island",
    tools: true,
    pageClip: true,
    cdpCapture: true,
    caret: "initial",
    naturalMotion: true,
    retainFailures: true,
    shelf: true,
    figmaNode:
      mode.includes("compact") || mode.includes("peek")
        ? mode.startsWith("result")
          ? "33:528"
          : "33:535"
        : "34:777",
    viewport: { width: 720, height: 520 },
    transparent: true,
    selector: ".island-morph",
    font: mode.endsWith("compact")
      ? ".island-compact .island-muted"
      : mode.endsWith("peek")
        ? ".island-peek-content strong"
        : mode.startsWith("search")
          ? ".island-search input"
          : mode === "tool-sheet"
            ? ".tool-sheet h2"
            : ".tool-queue h2",
    fixture: () => toolsFixture(mode),
    async ready(page) {
      if (mode.startsWith("search") || mode === "tool-sheet") {
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await page.getByRole("combobox").fill(mode === "search-pdf" ? "pdf" : "mp4");
        await page.getByRole("option").first().waitFor();
        if (mode === "tool-sheet") {
          await page.getByRole("option", { name: /To MP4/ }).click();
          await page.getByLabel("File path").fill("C:\\Fixture\\clip.mov");
          await page.getByRole("button", { name: "To MP4", exact: true }).waitFor();
        }
      } else if (mode.startsWith("queue")) {
        await page
          .getByRole("button", { name: "Files (Ctrl+4)" })
          .count()
          .then(async (n) => {
            if (n) await page.getByRole("button", { name: "Files (Ctrl+4)" }).click();
            else await page.locator('[data-island-tab="files"]').click();
          });
        await page.getByRole("region", { name: "Tool jobs" }).waitFor();
        await page
          .getByRole("button", { name: mode === "queue-cancelled" ? "Retry" : "Undo", exact: true })
          .waitFor();
      } else if (mode.endsWith("peek"))
        await page
          .getByRole("region", { name: mode === "result-peek" ? "Tool result" : "Tool job" })
          .waitFor();
      else await page.locator(".island-compact").waitFor();
      await page.mouse.move(
        mode.endsWith("compact") || mode.endsWith("peek") ? 0 : 350,
        mode.endsWith("compact") || mode.endsWith("peek") ? 0 : 22,
      );
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
        "Capture only naturally settled animations",
      );
      const accessibility = await page.evaluate(async () => {
        const r = await globalThis.axe.run();
        return {
          violations: r.violations.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
          })),
          incomplete: r.incomplete.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
          })),
        };
      });
      assert.deepEqual(accessibility, { violations: [], incomplete: [] });
      const assets = await page.locator("[data-asset-slot]").evaluateAll((nodes) =>
        nodes
          .filter((n) => n.getBoundingClientRect().width > 0)
          .map((n) => ({
            slot: n.dataset.assetSlot,
            loaded: n.complete && n.naturalWidth > 0,
            width: n.getBoundingClientRect().width,
            height: n.getBoundingClientRect().height,
          })),
      );
      for (const asset of assets) {
        const [group, name] = asset.slot.split("/");
        const svg = await readFile(
          new URL(`../src/assets/island/${slots[group][name]}`, import.meta.url),
          "utf8",
        );
        assert(asset.loaded);
        assert.equal(asset.width, Number(svg.match(/\bwidth="([\d.]+)"/)[1]));
        assert.equal(asset.height, Number(svg.match(/\bheight="([\d.]+)"/)[1]));
      }
      const geometry = await page.locator(".island-morph").boundingBox();
      assert(geometry.width <= 680);
      if (mode === "result-compact") {
        assert.equal(geometry.width, 340);
        assert.equal(geometry.height, 32);
      }
      if (mode === "running-compact") {
        assert.equal(geometry.width, 300);
        assert.equal(geometry.height, 32);
      }
      return { mode, accessibility, geometry, assets, noSideEffects: true };
    },
  })),
);
globalThis.console.log(`Verified ${report.captures.length} tool/search/result captures.`);
