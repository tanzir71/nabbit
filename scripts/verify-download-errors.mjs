import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { fixtureData } from "./screenshots/fixtures.mjs";
import { auditFont } from "./font-audit.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const raw = JSON.parse(
  await readFile(
    new URL("../src-tauri/src/download/fixtures/errors.json", import.meta.url),
    "utf8",
  ),
);
const fixtures = raw.filter(
  (fixture, index) => raw.findIndex((other) => other.kind === fixture.kind) === index,
);
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const preferences = {
  order: [
    "privacy",
    "timerEnding",
    "download",
    "tool",
    "link",
    "result",
    "media",
    "timer",
    "power",
  ],
  disabled: [],
  showAlertsOverFullscreen: false,
  focusMode: false,
  hiddenUntilMs: null,
};
const compactTitle = {
  SignInRequired: "YouTube wants you signed in",
  SiteChanged: "YouTube changed something",
  MissingJsRuntime: "The engine needs its helper",
  FormatUnavailable: "That quality isn’t offered",
  Drm: "This media is protected",
  Disk: "Check the download folder",
  Offline: "You’re offline",
  Live: "This is still live",
  Unknown: "Download failed",
};
const cases = fixtures.flatMap((fixture) =>
  [false, true].map((island) => {
    const data = fixtureData("tray-downloads");
    data.metadata = null;
    data.stagedUrl = null;
    data.engine = {
      missing: [],
      ytdlpVersion: "2026.11.23",
      ffmpegVersion: "8.0",
      denoVersion: "2.5",
    };
    data.jobs = [
      {
        id: "failed-fixture",
        url: "https://www.youtube.com/watch?v=fixture",
        title: "Fixture media",
        status: "failed",
        progress: 0,
        quality: "1080p",
        playlistMode: "video",
        options: { format: "mp4", height: 1080, outputDir: "D:\\Videos" },
        error: fixture.stderr,
        failure: fixture.failure,
        createdAt: "2026-11-26T09:00:00Z",
        updatedAt: "2026-11-26T09:01:00Z",
      },
    ];
    const item = {
      id: "downloadFailed:failed-fixture",
      category: "download",
      event: { kind: "downloadFailed", jobId: "failed-fixture", error: fixture.kind },
      alert: true,
      bubbleOnly: false,
    };
    const snapshot = {
      revision: 1,
      preferences,
      syncState: "localOnly",
      views: [
        {
          label: "island",
          gate: "visible",
          primary: item,
          bubble: null,
          queue: [],
          fullscreen: false,
          userHidden: false,
          focusMode: false,
        },
      ],
    };
    return {
      name: `error-${island ? "compact" : "tray"}-${fixture.kind.toLowerCase()}`,
      suite: "surfaces",
      entry: island ? "island.html" : "index.html",
      surface: island ? "island" : "tray",
      label: island ? "island" : "main",
      viewport: { width: island ? 720 : 460, height: island ? 460 : 680 },
      transparent: island,
      selector: island ? ".island-morph" : ".nab-queue-row",
      font: island ? ".island-compact .island-ellipsis" : ".download-failure-message h4",
      figmaNode: "18:330",
      fixture: () => ({
        data,
        responses: island
          ? {
              get_activity_snapshot: snapshot,
              get_island_drop: null,
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
            }
          : {},
      }),
      async ready(page) {
        if (island) {
          await page.getByText(compactTitle[fixture.kind], { exact: true }).waitFor();
          await page.getByRole("button", { name: "Fix", exact: true }).waitFor();
          await page.waitForFunction(
            () =>
              Math.abs(
                globalThis.document.querySelector(".island-morph").getBoundingClientRect().width -
                  348,
              ) < 0.1,
          );
        } else {
          await page.getByRole("heading", { name: fixture.failure.title, exact: true }).waitFor();
          assert.equal(
            await page.locator(".download-failure-actions button").count(),
            fixture.failure.actions.length,
          );
          assert.equal(
            await page.getByText(fixture.failure.description, { exact: true }).count(),
            1,
          );
          if (fixture.kind === "SignInRequired") {
            const chooser = page.getByRole("combobox", { name: "Browser sign-in" });
            await chooser.selectOption("edge");
            await page.getByRole("button", { name: "Use Edge sign-in", exact: true }).waitFor();
            await chooser.selectOption("chrome");
            await chooser.blur();
          }
        }
        await page.evaluate(async () => {
          await globalThis.document.fonts.ready;
          await Promise.all([...globalThis.document.images].map((image) => image.decode()));
        });
        const selector = island ? ".island-morph" : ".nab-queue-row";
        const geometry = await page.locator(selector).boundingBox();
        assert(geometry);
        if (island) {
          assert.equal(geometry.width, 348);
          assert.equal(geometry.height, 32);
        } else {
          assert.equal(geometry.width, 426);
          assert(geometry.height < 500);
        }
        assert(!/ERROR:|Traceback|fixture\.py/.test(await page.locator(selector).innerText()));
        const assets = await page
          .locator(`${selector} img[data-asset],${selector} img[data-asset-slot]`)
          .evaluateAll((images) =>
            images.map((img) => ({
              file: img.dataset.asset ?? img.dataset.assetSlot,
              natural: [img.naturalWidth, img.naturalHeight],
              rendered: [img.getBoundingClientRect().width, img.getBoundingClientRect().height],
              local: !img.currentSrc.includes("figma.com"),
            })),
          );
        assert(assets.length >= 2);
        assert(
          assets.every(
            (asset) =>
              asset.local && asset.natural.every((v, i) => v > 0 && v === asset.rendered[i]),
          ),
        );
        const typography = await page
          .locator(island ? ".island-compact .island-ellipsis" : ".download-failure-message h4")
          .evaluate((el) => {
            const s = globalThis.getComputedStyle(el);
            return { weight: s.fontWeight, size: s.fontSize, lineHeight: s.lineHeight };
          });
        if (!island)
          assert.deepEqual(typography, { weight: "500", size: "13px", lineHeight: "18px" });
        const fonts = await auditFont(
          page,
          island ? ".island-compact .island-ellipsis" : ".download-failure-message p",
          "Geist",
        );
        await page.addScriptTag({ content: axe });
        const accessibility = await page.evaluate(async (selector) => {
          const r = await globalThis.axe.run(globalThis.document.querySelector(selector), {
            rules: { region: { enabled: false } },
          });
          return {
            violations: r.violations.map((v) => ({
              id: v.id,
              nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
            })),
            incomplete: r.incomplete.map((v) => v.id),
          };
        }, selector);
        assert.deepEqual(accessibility.violations, [], JSON.stringify(accessibility));
        return {
          geometry,
          assets,
          typography,
          fonts,
          accessibility,
          errorKind: fixture.kind,
          rawLogVisible: false,
          explicitStarts: 0,
        };
      },
    };
  }),
);
const drmTray = cases.find((scenario) => scenario.name === "error-tray-drm");
cases.push({
  ...drmTray,
  name: "error-acknowledged",
  font: ".download-failure-dismissed span",
  fixture: () => ({ ...drmTray.fixture(), responses: { island_activity_action: null } }),
  async ready(page) {
    await drmTray.ready(page);
    await page.getByRole("button", { name: "OK", exact: true }).click();
    await page.getByRole("button", { name: "Show fix", exact: true }).click();
    await page.getByRole("button", { name: "OK", exact: true }).click();
    await page.getByRole("button", { name: "Show fix", exact: true }).waitFor();
    const geometry = await page.locator(".nab-queue-row").boundingBox();
    assert.equal(geometry.width, 426);
    assert.equal(await page.locator(".download-failure-dismissed button").count(), 1);
    assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
    const assets = await page
      .locator(".nab-queue-row img[data-asset]")
      .evaluateAll((images) =>
        images.map((img) => ({
          file: img.dataset.asset,
          natural: [img.naturalWidth, img.naturalHeight],
          rendered: [img.getBoundingClientRect().width, img.getBoundingClientRect().height],
        })),
      );
    assert(
      assets.length > 0 &&
        assets.every((asset) =>
          asset.natural.every((value, index) => value > 0 && value === asset.rendered[index]),
        ),
    );
    const accessibility = await page.evaluate(async () => {
      const result = await globalThis.axe.run(globalThis.document.querySelector(".nab-queue-row"), {
        rules: { region: { enabled: false } },
      });
      return {
        violations: result.violations.map((value) => value.id),
        incomplete: result.incomplete.map((value) => value.id),
      };
    });
    assert.deepEqual(accessibility.violations, []);
    return {
      geometry,
      assets,
      accessibility,
      errorKind: "Drm",
      acknowledged: true,
      reopenedAndAcknowledged: true,
      rawLogVisible: false,
      explicitStarts: 0,
    };
  },
});
const report = await captureSuite(
  root,
  { milestone: "M7", prefix: process.argv[2] ?? "v36-errors", suite: "all", repeatCheck: true },
  cases,
);
globalThis.console.log(`Verified ${report.captures.length} download error captures.`);
