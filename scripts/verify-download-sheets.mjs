import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
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
    { height: 2160, fps: 60, estimatedBytes: 1900000000 },
    { height: 1440, fps: 60, estimatedBytes: 1100000000 },
    { height: 1080, fps: 60, estimatedBytes: 420000000 },
    { height: 720, estimatedBytes: 210000000 },
  ],
  details: {
    chapters: [
      { title: "Intro", startMs: 0, endMs: 192000 },
      { title: "Tray icon", startMs: 192000, endMs: 340000 },
      { title: "Popover", startMs: 340000, endMs: 478500 },
      { title: "Packaging", startMs: 478500, endMs: 680000 },
      { title: "Wrap-up", startMs: 680000, endMs: 768000 },
    ],
    thumbnails: [],
    entries: [],
    truncated: false,
  },
};
const titles = [
  "A walk in autumn",
  "Paper boats",
  "Night market sketches",
  "Tiny robot repairs",
  "The last tram",
  "Coastline, slowly",
  "Windmills",
  "Rooftop garden",
  "Ice on the lake",
];
const seconds = [222, 310, 451, 245, 378, 542, 178, 284, 200];
const firstSizes = [100000000, 160000000, 180000000, 90000000, 110000000];
const entries = Array.from({ length: 18 }, (_, i) => ({
  index: i + 1,
  url: `https://example.invalid/film-${i + 1}`,
  title: titles[i] ?? `Creative Commons short film ${i + 1}`,
  duration: seconds[i] ?? 300,
  thumbnail: null,
  qualities: [{ height: 720, estimatedBytes: firstSizes[i] ?? (i === 17 ? 124000000 : 128000000) }],
}));
const options = {
  format: "mp4",
  height: 1080,
  subtitles: { languages: ["en"], embed: true },
  chapters: "keep",
  sponsorBlock: "off",
  embedThumbnail: true,
  embedMetadata: true,
  filenameTemplate: null,
  outputDir: null,
  sections: [],
  preciseCuts: false,
  playlistMode: "video",
  playlistItems: null,
  speedLimit: null,
};
const cases = ["options", "options-advanced", "trim", "playlist"].map((kind) => {
  const mode = kind === "options-advanced" ? "options" : kind;
  const media = globalThis.structuredClone(metadata),
    draft = {
      kind: mode,
      url: media.normalizedUrl,
      options: globalThis.structuredClone(options),
      remember: true,
    };
  if (mode === "trim") draft.options.sections = [{ startMs: 192000, endMs: 478500 }];
  if (mode === "playlist") {
    Object.assign(media, {
      url: "https://www.youtube.com/playlist?list=fixture",
      normalizedUrl: "https://www.youtube.com/playlist?list=fixture",
      title: "Creative Commons short films",
      isPlaylist: true,
      playlistCount: 18,
    });
    media.details.entries = entries;
    Object.assign(draft, { url: media.normalizedUrl });
    Object.assign(draft.options, { height: 720, playlistMode: "playlist", playlistItems: "1-5" });
  }
  const data = fixtureData();
  data.settings.firstRunAcknowledged = true;
  data.settings.outputDir = "C:\\Users\\tanzir\\Downloads\\Nabbit";
  return {
    name: `sheet-${kind}`,
    suite: "surfaces",
    entry: "index.html",
    query: "?download-sheet",
    surface: "download-sheet",
    caret: "initial",
    label: "download-sheet",
    viewport: { width: 460, height: 680 },
    font: ".sheet-header h1",
    figmaNode: mode === "options" ? "17:137" : mode === "trim" ? "17:270" : "18:160",
    fixture: () => ({
      data,
      responses: {
        get_download_sheet: { id: `fixture-${kind}`, draft, metadata: media },
        download_sheet_ready: null,
      },
    }),
    async ready(page) {
      await page.locator(`[data-sheet="${mode}"]`).waitFor();
      await page.evaluate(async () => {
        await globalThis.document.fonts.ready;
        await Promise.all([...globalThis.document.images].map((i) => i.decode()));
      });
      if (kind === "options-advanced") {
        await page.getByText("Advanced", { exact: true }).click();
        await page.getByLabel("Signed-in videos", { exact: true }).selectOption("chrome");
        await page.getByLabel("Speed limit", { exact: true }).fill("2M");
        await page.locator(".sheet-body").evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
      }
      if (mode === "trim") {
        await page.getByLabel("Trim start handle").focus();
        await page.keyboard.press("ArrowRight");
        assert.equal(
          await page.getByLabel("Start", { exact: true }).inputValue(),
          "03:12.0",
          "Handle snaps within one second of chapter boundary",
        );
        await page.getByRole("dialog").focus();
        await page.keyboard.press("Shift+Tab");
        assert.equal(
          await page.evaluate(() =>
            globalThis.document.activeElement?.hasAttribute("data-sheet-primary"),
          ),
          true,
          "Modal Shift+Tab wraps to primary",
        );
        await page.keyboard.press("Tab");
        assert.equal(
          await page
            .getByRole("button", { name: "Close download sheet" })
            .evaluate((el) => el === globalThis.document.activeElement),
          true,
          "Modal Tab wraps to Close",
        );
      }
      if (mode === "playlist") {
        await page.getByLabel("Range", { exact: true }).fill("1,3-5");
        assert.equal(
          await page.getByRole("button", { name: "Download 4", exact: true }).count(),
          1,
        );
        await page.getByLabel("Range", { exact: true }).fill("1–5");
        assert.equal(
          await page.getByRole("button", { name: "Download 5", exact: true }).count(),
          1,
        );
      }
      await page.getByRole("dialog").focus();
      const geometry = await page.locator(".download-sheet").boundingBox();
      assert.equal(geometry.width, 460);
      assert.equal(geometry.height, 680);
      const mono = await auditFont(
        page,
        mode === "trim"
          ? ".sheet-length code"
          : mode === "playlist"
            ? ".playlist-index"
            : ".sheet-folder code",
        "Geist Mono",
      );
      const typography = await page.locator(".sheet-header h1").evaluate((el) => {
        const s = globalThis.getComputedStyle(el);
        return { weight: s.fontWeight, size: s.fontSize, lineHeight: s.lineHeight };
      });
      assert.deepEqual(typography, { weight: "600", size: "14px", lineHeight: "20px" });
      const assets = await page.locator("img[data-asset]").evaluateAll((nodes) =>
        nodes
          .filter((img) => img.getBoundingClientRect().width > 0)
          .map((img) => ({
            file: img.dataset.asset,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            width: img.getBoundingClientRect().width,
            height: img.getBoundingClientRect().height,
            src: img.getAttribute("src"),
          })),
      );
      for (const a of assets) {
        assert(a.src && !a.src.includes("figma.com"));
        assert.equal(a.naturalWidth, a.width, a.file);
        assert.equal(a.naturalHeight, a.height, a.file);
      }
      await page.addScriptTag({ content: axe });
      const accessibility = await page.evaluate(async () => {
        const r = await globalThis.axe.run(globalThis.document.querySelector(".download-sheet"));
        return {
          violations: r.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
          })),
          incomplete: r.incomplete.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
          })),
        };
      });
      assert.deepEqual(accessibility.violations, [], JSON.stringify(accessibility.violations));
      assert.deepEqual(accessibility.incomplete, [], JSON.stringify(accessibility.incomplete));
      return {
        geometry,
        mono,
        typography,
        assets,
        accessibility,
        explicitStarts: 0,
        behavior:
          mode === "trim"
            ? "Real browser range keyboard snapping and modal focus wrap"
            : mode === "playlist"
              ? "Sparse/range selection updates; no enqueue"
              : "Options are draft-only until explicit primary activation",
      };
    },
  };
});
const report = await captureSuite(
  root,
  { milestone: "M7", prefix: process.argv[2] ?? "v35-sheets", suite: "all", repeatCheck: true },
  cases,
);
globalThis.console.log(`Verified ${report.captures.length} download sheet captures.`);
