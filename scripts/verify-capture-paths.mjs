import assert from "node:assert/strict";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { fixtureData } from "./screenshots/fixtures.mjs";

const url = "https://example.invalid/video";
const title = "Tiny tray app in Rust, full walkthrough";
const event = { kind: "linkDetected", url, title, duration: 768, site: "example.invalid" };
function snapshot(link) {
  return {
    revision: 1,
    preferences: {
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
    },
    syncState: "localOnly",
    views: [
      {
        label: "island",
        gate: "visible",
        primary: link
          ? { id: "link", category: "link", event: link, alert: false, bubbleOnly: false }
          : null,
        bubble: null,
        queue: [],
        fullscreen: false,
        userHidden: false,
        focusMode: false,
      },
    ],
  };
}
const scenarios = ["pending", "compact", "peek", "drop", "drag-review"].map((name) => {
  const state = name === "peek" ? "peek" : ["drop", "drag-review"].includes(name) ? "drop" : "live";
  const link =
    name === "pending"
      ? { ...event, title: null, duration: null }
      : state === "drop"
        ? null
        : event;
  const activity = snapshot(link);
  return {
    name: `capture-${name}`,
    suite: "surfaces",
    entry: "island.html",
    surface: "island",
    label: "island",
    viewport: { width: 720, height: 460 },
    transparent: true,
    selector: ".island-morph",
    figmaNode: state === "peek" ? "8:38" : state === "drop" ? "8:192" : "7:4",
    fixture: () => ({
      responses: {
        get_activity_snapshot: activity,
        get_island_drop: null,
        get_island_surface: {
          label: "island",
          generation: 1,
          state,
          owner: state === "live" ? "native" : "webview",
          shape: "island",
          reducedMotion: true,
          width: state === "peek" ? 400 : state === "drop" ? 640 : 336,
          height: 32,
          snapshot: activity,
        },
      },
    }),
    async ready(page) {
      await page.waitForFunction(
        (state) => globalThis.document.querySelector("main")?.dataset.islandState === state,
        state,
      );
      if (state === "drop") {
        const order = await page
          .locator("[data-drop-zone]")
          .evaluateAll((nodes) => nodes.map((n) => n.dataset.dropZone));
        assert.equal(order[0], "download");
      }
      if (name === "drag-review") {
        await page.locator('[data-drop-zone="download"]').evaluate((target, url) => {
          const transfer = new globalThis.DataTransfer();
          transfer.setData("text/uri-list", `# browser tab\r\n${url}`);
          target.dispatchEvent(
            new globalThis.DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
            }),
          );
        }, url);
        await page.getByRole("heading", { name: new URL(url).hostname, exact: true }).waitFor();
        const fixture = await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot());
        assert(fixture.calls.some((c) => c.command === "island_review_url" && c.args.url === url));
        assert.equal(fixture.state.jobs.length, fixtureData("tray-downloads").jobs.length);
      } else if (name === "pending") {
        await page
          .locator(".island-morph strong")
          .getByText("example.invalid", { exact: true })
          .waitFor();
      } else if (name === "peek") {
        await page.getByText(title, { exact: true }).waitFor();
        assert(await page.getByText("example.invalid · 12:48", { exact: true }).isVisible());
      } else if (name === "compact") {
        await page.getByText("Video link copied", { exact: true }).waitFor();
        assert(await page.getByText("12:48", { exact: true }).isVisible());
      }
      const assets = await page.locator("img[data-asset-slot]").evaluateAll((nodes) =>
        nodes
          .filter((img) => img.getBoundingClientRect().width > 0)
          .map((img) => ({
            slot: img.dataset.assetSlot,
            natural: [img.naturalWidth, img.naturalHeight],
            rendered: [img.getBoundingClientRect().width, img.getBoundingClientRect().height],
            local: !img.src.includes("figma.com"),
          })),
      );
      assert(
        assets.every((a) => a.local && a.natural.every((n, i) => n > 0 && n === a.rendered[i])),
      );
      return { passive: true, assets };
    },
  };
});
scenarios.push({
  name: "capture-tray-push",
  suite: "surfaces",
  entry: "index.html",
  surface: "tray",
  label: "main",
  viewport: { width: 460, height: 680 },
  font: "h1",
  figmaNode: "17:5",
  fixture: () => ({ data: fixtureData("tray-downloads") }),
  async ready(page) {
    await page.getByRole("heading", { name: "Creative Commons sample", exact: true }).waitFor();
    await page.waitForFunction(() => globalThis.__NABBIT_CAPTURE__.snapshot().listenerCount >= 6);
    await page.evaluate(
      ({ url, title }) => {
        globalThis.__NABBIT_CAPTURE__.emit("url:detected", {
          url,
          normalizedUrl: url,
          title,
          channel: "Fixture channel",
          duration: 768,
          thumbnail: null,
          isPlaylist: false,
          playlistCount: null,
          extractor: "fixture",
          qualities: [],
        });
      },
      { url, title },
    );
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
    const fixture = await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot());
    assert(!fixture.calls.some((c) => c.command === "probe_url"));
    return { pushedMetadata: true, extraProbe: false, jobs: fixture.state.jobs.length };
  },
});
const report = await captureSuite(
  fileURLToPath(new URL("../", import.meta.url)),
  { milestone: "M6", prefix: process.argv[2] ?? "v33-capture", suite: "all", repeatCheck: true },
  scenarios,
);
globalThis.console.log(`Verified ${report.captures.length} capture-path PNGs.`);
