import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { captureSuite } from "./screenshots/harness.mjs";
import { auditFont } from "./font-audit.mjs";
const events = {
  volume: { kind: "volumeChanged", percent: 64, muted: false },
  link: {
    kind: "linkDetected",
    url: "https://example.invalid/video",
    title: "Tiny tray app in Rust, full walkthrough",
    duration: 768,
    site: "Ferris Builds",
  },
  download: {
    kind: "downloadProgress",
    jobId: "capture-download",
    title: "Tiny tray app in Rust, full walkthrough",
    percent: 38,
    speed: "4.2 MB/s",
    eta: "1:12",
  },
  media: {
    kind: "mediaChanged",
    sessionId: "capture-media",
    title: "Night Drive",
    artist: "Kiln · Media Player",
    playing: true,
    timeline: { positionS: 84, durationS: 201 },
    art: null,
  },
  timer: { kind: "timerTick", id: "capture-timer", label: "Focus", remainingS: 1453 },
  privacy: { kind: "privacyChanged", mic: ["Teams"], camera: [] },
  power: { kind: "powerChanged", percent: 82, charging: true },
  done: {
    kind: "downloadDone",
    jobId: "capture-done",
    path: "C:\\Capture\\tiny-tray-app-in-rust.mp4",
  },
  error: { kind: "downloadFailed", jobId: "capture-error", error: "Unknown" },
  note: { kind: "noteSaved", cardId: "capture-note", destination: "Tack · Inbox" },
  moved: {
    kind: "filesMoved",
    opId: "capture-move",
    count: 3,
    destination: "C:\\Capture\\Invoices",
    verb: "moved",
    undoable: true,
  },
  result: {
    kind: "toolResult",
    jobId: "capture-result",
    path: "C:\\Capture\\clip.mp4",
    beforeBytes: 42000000,
    afterBytes: 19600000,
    note: "Fits Discord",
  },
  tool: {
    kind: "toolJob",
    jobId: "capture-tool",
    toolId: "fit",
    label: "Fit for Discord · try 1 of 3",
    percent: 64,
    state: "running",
  },
};
const category = {
  volume: "result",
  timer: "timer",
  privacy: "privacy",
  power: "power",
  media: "media",
  link: "link",
  download: "download",
  tool: "tool",
  done: "download",
  error: "download",
  note: "result",
  moved: "result",
  result: "result",
};
const item = (key) =>
  key
    ? {
        id: `capture-${key}`,
        category: category[key],
        event: events[key],
        alert: ["done", "error", "note", "moved", "result"].includes(key),
        bubbleOnly: false,
      }
    : null;
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
function scenario(name, state, key = null, extra = {}) {
  const primary = item(key),
    bubble = extra.bubble ? item(extra.bubble) : null;
  const snapshot = {
    revision: 1,
    views: [
      {
        label: "island",
        gate: state === "faded" ? "faded" : state === "hidden" ? "hidden" : "visible",
        primary,
        bubble,
        queue: [],
        fullscreen: state === "hidden",
        userHidden: false,
        focusMode: false,
      },
    ],
    preferences,
    syncState: "localOnly",
  };
  const expectedWidth =
    state === "expanded"
      ? 680
      : state === "peek"
        ? 400
        : state === "drop"
          ? 640
          : extra.bubble
            ? 298
            : ({
                volume: 272,
                link: 336,
                download: 320,
                media: 272,
                timer: 240,
                privacy: 232,
                power: 232,
                done: 348,
                error: 348,
                note: 272,
                moved: 312,
                result: 340,
                tool: 300,
              }[key] ?? (extra.shape === "notch" ? 168 : 112));
  return {
    name,
    suite: "surfaces",
    entry: "island.html",
    surface: "island",
    label: "island",
    viewport: { width: 720, height: 460 },
    transparent: true,
    figmaNode:
      state === "peek"
        ? "8:119"
        : state === "expanded"
          ? "10:519"
          : state === "drop"
            ? "8:192"
            : "7:103",
    fixture: () => ({
      responses: {
        get_activity_snapshot: snapshot,
        get_island_surface: {
          label: "island",
          generation: 1,
          state,
          owner: ["peek", "expanded", "drop"].includes(state) ? "webview" : "native",
          shape: extra.shape ?? "island",
          reducedMotion: true,
          width: expectedWidth,
          height: key ? 32 : 26,
          snapshot,
        },
        get_island_drop: null,
      },
    }),
    async ready(page) {
      await page.waitForFunction(
        (state) => globalThis.document.querySelector("main")?.dataset.islandState === state,
        state,
      );
      if (extra.tab)
        await page
          .getByRole("button", {
            name: extra.tab[0].toUpperCase() + extra.tab.slice(1),
            exact: true,
          })
          .click();
      await page.evaluate(async () => {
        await globalThis.document.fonts.ready;
        await Promise.all([...globalThis.document.images].map((img) => img.decode()));
      });
      if (state === "expanded")
        await page.locator(".island-module-body,.island-timer-body").first().waitFor();
      await page.waitForFunction(
        (width) =>
          Math.abs(
            globalThis.document.querySelector(".island-morph").getBoundingClientRect().width -
              width,
          ) < 0.1,
        expectedWidth,
      );
      const geometry = await page.locator(".island-morph").boundingBox();
      assert.equal(geometry.width, expectedWidth);
      assert(geometry.height <= 420);
      assert.equal(geometry.y, extra.shape === "notch" ? 0 : 6);
      const assets = await page.locator("img[data-asset-slot]").evaluateAll((images) =>
        images.map((img) => ({
          slot: img.dataset.assetSlot,
          natural: [img.naturalWidth, img.naturalHeight],
          rendered: [img.getBoundingClientRect().width, img.getBoundingClientRect().height],
          src: img.currentSrc,
        })),
      );
      assert(
        assets.every(
          (asset) =>
            asset.natural[0] > 0 &&
            asset.natural.every((v, i) => v === asset.rendered[i]) &&
            !asset.src.includes("figma.com"),
        ),
      );
      assert.equal(await page.locator(".island-notice").count(), 0);
      const fonts = [];
      for (const [selector, family] of [
        [".island-content strong", "Geist"],
        [".island-content .island-mono", "Geist Mono"],
      ]) {
        const target = page.locator(selector).first();
        if ((await target.count()) && (await target.isVisible()) && (await target.textContent()))
          fonts.push({ selector, family, faces: await auditFont(page, selector, family) });
      }
      return { geometry, assets, fonts, noNotice: true };
    },
  };
}
const cases = [
  scenario("idle", "idle"),
  scenario("faded", "faded"),
  ...Object.keys(events).map((key) => scenario(`compact-${key}`, "live", key)),
  scenario("split", "live", "download", { bubble: "timer" }),
  ...["link", "download", "media", "timer", "done"].map((key) =>
    scenario(`peek-${key}`, "peek", key),
  ),
  ...["nab", "notes", "clipboard", "files", "media", "timer"].map((tab) =>
    scenario(
      `expanded-${tab}`,
      "expanded",
      tab === "media" ? "media" : tab === "timer" ? "timer" : "link",
      { tab },
    ),
  ),
  scenario("drop", "drop"),
  scenario("notch-idle", "idle", null, { shape: "notch" }),
  scenario("notch-live", "live", "download", { shape: "notch" }),
];
const report = await captureSuite(
  fileURLToPath(new URL("../", import.meta.url)),
  {
    milestone: "M5",
    prefix: process.argv[2] ?? "v25-preview",
    suite: "surfaces",
    repeatCheck: true,
  },
  cases,
);
globalThis.console.log(
  `Captured ${report.captures.length} island surfaces with original asset geometry.`,
);
