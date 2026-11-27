import assert from "node:assert/strict";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { captureSuite } from "./screenshots/harness.mjs";
import { fixtureData } from "./screenshots/fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const cases = ["offline", "conflict", "signedOut"].map((state) => {
  const snapshot = {
    revision: 1,
    views: [
      {
        label: "island",
        gate: "visible",
        primary: null,
        bubble: null,
        queue: [],
        fullscreen: false,
        userHidden: false,
        focusMode: false,
      },
    ],
    preferences: {
      order: [],
      disabled: [],
      showAlertsOverFullscreen: false,
      focusMode: false,
      hiddenUntilMs: null,
    },
    syncState: state,
  };
  return {
    name: `island-notes-${state.toLowerCase()}`,
    suite: "surfaces",
    entry: "island.html",
    surface: "island",
    notesSync: true,
    label: "island",
    viewport: { width: 720, height: 460 },
    transparent: true,
    selector: ".island-morph",
    font: ".island-notes-sync strong",
    figmaNode: "19:346",
    fixture: () => ({
      data: fixtureData("island-idle"),
      responses: {
        get_activity_snapshot: snapshot,
        get_island_surface: {
          label: "island",
          generation: 1,
          state: "expanded",
          owner: "webview",
          shape: "island",
          reducedMotion: true,
          width: 680,
          height: 297,
          snapshot,
        },
        get_island_drop: null,
        list_island_pins: [],
        tack_sync_snapshot: {
          state,
          scope: { key: "fixture", epoch: 1 },
          pending: 3,
          conflicts: state === "conflict" ? 1 : 0,
          referenceIssues: 0,
          lastSynced: null,
          error: null,
          nextAttemptMs: null,
        },
      },
    }),
    async ready(page) {
      await page
        .getByRole("navigation", { name: "Island modules" })
        .getByRole("button", { name: "Notes", exact: true })
        .click();
      await page.locator(`.island-notes-sync [data-sync-state="${state}"]`).waitFor();
      const samples = await page
        .locator(".island-notes-sync img[data-asset]")
        .evaluateAll((images) =>
          images.map((img) => ({
            file: img.dataset.asset,
            width: img.getBoundingClientRect().width,
            height: img.getBoundingClientRect().height,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
          })),
        );
      assert.equal(samples.length, 1);
      for (const image of samples) {
        assert.equal(image.width, image.naturalWidth);
        assert.equal(image.height, image.naturalHeight);
        assert(
          (await readFile(new URL(`../src/assets/${image.file}`, import.meta.url))).length > 0,
        );
      }
      await page.addScriptTag({ content: axe });
      const accessibility = await page.evaluate(async () => {
        const r = await globalThis.axe.run(globalThis.document, {
          resultTypes: ["violations", "incomplete"],
        });
        return {
          violations: r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
          incomplete: r.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
        };
      });
      assert.deepEqual(accessibility.violations, [], JSON.stringify(accessibility.violations));
      assert.deepEqual(accessibility.incomplete, [], JSON.stringify(accessibility.incomplete));
      return {
        state,
        assets: samples,
        accessibility,
        expandedOnly: true,
        jsPolling: false,
        action: "Open full Nabbit",
        fixture: "Protocol snapshot; behavior tested by component races and separate Rust flow",
      };
    },
  };
});
const report = await captureSuite(
  root,
  { milestone: "M9", prefix: process.argv[2] ?? "v45-island", suite: "all", repeatCheck: true },
  cases,
);
globalThis.console.log(
  `Verified ${report.captures.length} expanded island Notes sync captures with exact repeats and default axe.`,
);
