import assert from "node:assert/strict";
import { fileURLToPath, URL } from "node:url";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { fixtureData } from "./screenshots/fixtures.mjs";
import { auditFont } from "./font-audit.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const metadata = {
  url: "https://www.youtube.com/watch?v=fixture",
  normalizedUrl: "https://www.youtube.com/watch?v=fixture",
  title: "Tiny tray app in Rust, full walkthrough",
  channel: "Ferris Builds",
  duration: 768,
  thumbnail: null,
  isPlaylist: false,
  playlistCount: null,
  extractor: "youtube",
  qualities: [
    { height: 1080, estimatedBytes: 420000000 },
    { height: 720, estimatedBytes: null },
  ],
};
const preset = {
  id: "mp4_1080",
  label: "MP4 · 1080p",
  options: { format: "mp4", height: 1080, sections: [], subtitles: null, playlistMode: "video" },
};
const job = (id, status, title) => ({
  id,
  url: metadata.url,
  title,
  status,
  progress: 62,
  speed: "3.1 MB/s",
  eta: "0:48",
  quality: "720p",
  playlistMode: "video",
  createdAt: "2026-11-26T08:40:00Z",
  updatedAt: "2026-11-26T08:50:00Z",
  outputPath: status === "completed" ? "C:\\Fixture\\short-film.mp4" : null,
  error: status === "failed" ? "This video needs you to be signed in" : null,
});
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
function fixture(kind) {
  const data = fixtureData("tray-downloads");
  data.metadata = kind === "empty" ? null : metadata;
  data.stagedUrl = data.metadata?.normalizedUrl ?? null;
  data.settings.outputDir = "C:\\Users\\Fixture\\Downloads\\Nabbit";
  data.engine = {
    missing: [],
    ytdlpVersion: "2026.11.20",
    denoVersion: "2.5",
    ffmpegVersion: "8.0",
  };
  data.jobs =
    kind === "empty"
      ? []
      : [
          job(
            "run",
            kind === "paused" ? "paused" : "running",
            "Lofi beats to code to (2 hour mix)",
          ),
          job("done", "completed", "Creative Commons short film, part 1"),
          job("fail", "failed", "Members-only livestream replay"),
        ];
  if (kind === "island")
    data.jobs = [
      {
        ...job("run", "running", "Lofi beats to code to (2 hour mix)"),
        quality: "audio_mp3",
        options: { format: "mp3", height: null },
      },
      {
        ...job("playlist", "queued", "Creative Commons short films, playlist 1–5"),
        playlistMode: "playlist",
        playlistRange: "1-5",
      },
    ];
  return data;
}
const cases = ["tray", "paused", "empty", "island"].map((kind) => {
  const island = kind === "island",
    data = fixture(kind);
  const link = {
    id: "link",
    category: "link",
    event: {
      kind: "linkDetected",
      url: metadata.url,
      title: metadata.title,
      duration: metadata.duration,
      site: "youtube.com",
    },
    alert: false,
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
        primary: link,
        bubble: null,
        queue: [],
        fullscreen: false,
        userHidden: false,
        focusMode: false,
      },
    ],
  };
  return {
    name: `nab-${kind}`,
    suite: "surfaces",
    entry: island ? "island.html" : "index.html",
    surface: island ? "island" : "tray",
    label: island ? "island" : "main",
    viewport: { width: island ? 720 : 460, height: island ? 460 : 680 },
    transparent: island,
    selector: island ? ".island-morph" : undefined,
    font: island ? ".nab-details h2" : "header h1",
    figmaNode: island ? "9:78" : "13:2",
    fixture: () => ({
      data,
      responses: {
        resolve_download_preset: preset,
        ...(island
          ? {
              get_activity_snapshot: snapshot,
              get_island_drop: null,
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
            }
          : {}),
      },
    }),
    async ready(page) {
      if (kind === "empty") {
        await page.getByText("Your queue is empty.", { exact: true }).waitFor();
        assert.equal(await page.getByRole("button", { name: "Download", exact: true }).count(), 0);
      } else {
        await page.getByRole("heading", { name: metadata.title, exact: true }).waitFor();
        await page
          .getByRole("button", { name: island ? "Nab it Enter" : "Download", exact: true })
          .waitFor();
        await page.waitForFunction(
          () => !globalThis.document.querySelector(".nab-start")?.disabled,
        );
      }
      if (island) {
        await page
          .getByRole("heading", { name: "Lofi beats to code to (2 hour mix)", exact: true })
          .waitFor();
        assert.equal(await page.locator(".nab-queue-row").count(), 2);
      }
      if (kind === "tray") {
        await page.getByRole("button", { name: "Use Chrome sign-in", exact: true }).waitFor();
        assert.equal(await page.locator(".nab-queue-row").count(), 3);
      }
      if (kind === "paused") {
        await page
          .getByRole("button", { name: "Resume: Lofi beats to code to (2 hour mix)", exact: true })
          .waitFor();
      }
      if (kind === "tray" || island) {
        const push = async (progress) => {
          await page.evaluate((progress) => {
            const f = globalThis.__NABBIT_CAPTURE__;
            const jobs = f.snapshot().state.jobs;
            jobs[0].progress = progress;
            f.patch({ jobs });
            f.emit("download:updated", jobs[0]);
          }, progress);
          await page.waitForFunction(
            (progress) =>
              globalThis.document
                .querySelector(".nab-job-progress,.nab-job-summary")
                ?.textContent.includes(`${progress}%`),
            progress,
          );
        };
        await push(68);
        await push(62);
      }
      await page.evaluate(async () => {
        await globalThis.document.fonts.ready;
        await Promise.all([...globalThis.document.images].map((i) => i.decode()));
      });
      const mono =
        kind === "empty"
          ? null
          : await auditFont(page, ".nab-presets .n-preset-meta", "Geist Mono");
      const typography =
        kind === "empty"
          ? null
          : await page.locator(".nab-details h2").evaluate((el) => {
              const s = globalThis.getComputedStyle(el);
              return { weight: s.fontWeight, size: s.fontSize, lineHeight: s.lineHeight };
            });
      if (typography)
        assert.deepEqual(typography, { weight: "600", size: "14px", lineHeight: "20px" });
      const assets = await page
        .locator("img[data-asset],img[data-asset-slot]")
        .evaluateAll((nodes) =>
          nodes
            .filter((img) => img.getBoundingClientRect().width > 0)
            .map((img) => ({
              slot: img.dataset.asset ?? img.dataset.assetSlot,
              natural: [img.naturalWidth, img.naturalHeight],
              rendered: [img.getBoundingClientRect().width, img.getBoundingClientRect().height],
              parent: [
                img.parentElement.getBoundingClientRect().width,
                img.parentElement.getBoundingClientRect().height,
              ],
              local: !img.src.includes("figma.com"),
            })),
        );
      assert(assets.length > 0);
      assert(
        assets.every((a) => a.local && a.natural.every((n, i) => n > 0 && n === a.rendered[i])),
        JSON.stringify(assets),
      );
      const geometry = await page.locator(island ? ".island-morph" : ".tray-popover").boundingBox();
      assert.equal(geometry.width, island ? 680 : 460);
      assert.equal(geometry.height, island ? 297 : 680);
      await page.addScriptTag({ content: axe });
      const accessibility = await page.evaluate(async () => {
        const r = await globalThis.axe.run(
          globalThis.document.querySelector(".nab-review")?.parentElement ??
            globalThis.document.body,
          { rules: { region: { enabled: false } } },
        );
        return {
          violations: r.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
          })),
          incomplete: r.incomplete.map((v) => v.id),
        };
      });
      assert.deepEqual(accessibility.violations, [], JSON.stringify(accessibility.violations));
      return {
        geometry,
        typography,
        mono,
        assets,
        accessibility,
        source: "captured metadata and persisted job fixtures",
        explicitStarts: 0,
      };
    },
  };
});
const report = await captureSuite(
  root,
  {
    milestone: process.argv[3] ?? "M6",
    prefix: process.argv[2] ?? "v34-nab",
    suite: "all",
    repeatCheck: true,
  },
  cases,
);
globalThis.console.log(`Verified ${report.captures.length} Nab view captures.`);
