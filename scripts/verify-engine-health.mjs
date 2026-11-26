import assert from "node:assert/strict";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { captureSuite } from "./screenshots/harness.mjs";
import { auditFont } from "./font-audit.mjs";
import { fixtureData } from "./screenshots/fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const good = {
  missing: [],
  channel: "stable",
  ytdlpVersion: "2026.11.20",
  denoVersion: "2.5.4",
  ffmpegVersion: "8.0",
  checkedAt: "2026-11-26T06:00:00Z",
  updatedAt: "2026-11-24T09:00:00Z",
  extraction: { result: "passed", checkedAt: "2026-11-26T06:00:00Z" },
};
const states = {
  healthy: good,
  missing: {
    ...good,
    missing: ["deno"],
    denoVersion: null,
    failure: "MissingJsRuntime",
    extraction: { result: "skipped", detail: "Repair the missing engine components first." },
  },
  offline: {
    ...good,
    extraction: {
      result: "skipped",
      detail: "The 3-second test timed out; checked local engine versions.",
    },
  },
};
const cases = Object.entries(states).map(([name, status]) => ({
  name: `engine-${name}`,
  suite: "surfaces",
  entry: "settings.html",
  surface: "settings",
  label: "settings",
  viewport: { width: 460, height: 680 },
  font: ".engine-health h3",
  selector: ".engine-health",
  figmaNode: "18:260",
  fixture(theme) {
    const data = fixtureData("engine-health");
    data.engine = status;
    return { data, theme, responses: { check_engine: good, repair_engine: good } };
  },
  async ready(page) {
    const card = page.getByRole("region", { name: "Download engine health" });
    await card.waitFor();
    await page
      .getByText(
        name === "healthy" ? "Healthy" : name === "missing" ? "Needs attention" : "Ready",
        { exact: true },
      )
      .waitFor();
    await card.scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () =>
        globalThis.document.documentElement.dataset.theme ===
        (globalThis.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    );
    await page.evaluate(() => globalThis.document.fonts.ready);
    const mono = await auditFont(page, ".engine-health-version", "Geist Mono");
    await page.addScriptTag({ content: axe });
    const audit = await page.evaluate(async () => {
      const result = await globalThis.axe.run(globalThis.document.querySelector(".engine-health"));
      return {
        violations: result.violations,
        incomplete: result.incomplete,
        passes: result.passes.map((r) => r.id),
      };
    });
    assert.deepEqual(audit.violations, []);
    assert.deepEqual(audit.incomplete, []);
    const geometry = await card.evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      height: el.getBoundingClientRect().height,
      assets: [...el.querySelectorAll("img")].map((img) => ({
        src: new URL(img.src).pathname,
        natural: [img.naturalWidth, img.naturalHeight],
        rendered: [img.width, img.height],
      })),
    }));
    assert.equal(geometry.width, 420);
    assert(geometry.assets.length >= 2);
    for (const asset of geometry.assets) assert.deepEqual(asset.rendered, asset.natural);
    return { audit, geometry, mono };
  },
}));
const engineItem = {
  id: "downloadFailed:engine-health",
  category: "download",
  alert: true,
  bubbleOnly: false,
  event: { kind: "downloadFailed", jobId: "engine-health", error: "MissingJsRuntime" },
};
const snapshot = {
  revision: 1,
  preferences: {
    order: ["download"],
    disabled: [],
    showAlertsOverFullscreen: false,
    focusMode: false,
    hiddenUntilMs: null,
  },
  syncState: "localOnly",
  views: [
    {
      label: "island",
      gate: "visible",
      primary: engineItem,
      bubble: null,
      queue: [],
      fullscreen: false,
      userHidden: false,
      focusMode: false,
    },
  ],
};
cases.push({
  name: "engine-island-error",
  suite: "surfaces",
  entry: "island.html",
  surface: "island",
  label: "island",
  viewport: { width: 720, height: 460 },
  transparent: true,
  figmaNode: "7:103",
  fixture() {
    return {
      responses: {
        get_activity_snapshot: snapshot,
        get_island_surface: {
          label: "island",
          generation: 1,
          state: "live",
          owner: "native",
          shape: "island",
          reducedMotion: true,
          width: 348,
          height: 32,
          snapshot,
        },
      },
    };
  },
  async ready(page) {
    await page.getByText("Download engine needs an update", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Fix", exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        Math.abs(
          globalThis.document.querySelector(".island-morph").getBoundingClientRect().width - 348,
        ) < 0.1,
    );
    return { engineErrorCopy: true, fixVisible: true };
  },
});
await captureSuite(
  root,
  {
    milestone: "M6",
    prefix: process.argv[2] ?? "v31-health",
    suite: "surfaces",
    repeatCheck: true,
  },
  cases,
);
