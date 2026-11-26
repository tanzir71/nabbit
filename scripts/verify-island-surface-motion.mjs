import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { chromium } from "playwright";
import { preview } from "vite";
import { fixtureData } from "./screenshots/fixtures.mjs";
import { installMockIpc } from "./screenshots/mock-ipc.mjs";
import process from "node:process";

const root = fileURLToPath(new URL("../", import.meta.url));
const results = [];
let browser, server;
try {
  server = await preview({ root, logLevel: "error", preview: { host: "127.0.0.1", port: 0 } });
  browser = await chromium.launch({ headless: true });
  for (const reduced of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: 720, height: 460 },
      reducedMotion: reduced ? "reduce" : "no-preference",
      serviceWorkers: "block",
    });
    const data = fixtureData("surface-motion");
    const snapshot = {
      revision: 1,
      preferences: {
        order: ["link"],
        maxBubbles: 1,
        durations: {},
      },
      syncState: "localOnly",
      views: [
        {
          label: "island",
          gate: "visible",
          primary: {
            id: "motion-link",
            category: "link",
            alert: false,
            bubbleOnly: false,
            event: {
              kind: "linkDetected",
              url: "https://example.invalid/video",
              site: "Fixture",
              title: "Motion fixture",
            },
          },
          bubble: null,
          queue: [],
          fullscreen: false,
          userHidden: false,
          focusMode: false,
        },
      ],
    };
    const seed = {
      data,
      label: "island",
      theme: "dark",
      responses: {
        get_activity_snapshot: snapshot,
        get_island_surface: {
          label: "island",
          generation: 1,
          state: "live",
          owner: "native",
          shape: "island",
          reducedMotion: reduced,
          width: 336,
          height: 32,
          snapshot,
        },
      },
    };
    await context.addInitScript(installMockIpc, seed);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/island.html`);
    await page.waitForFunction(
      () => globalThis.document.querySelector("main")?.dataset.islandState === "live",
    );
    const request = (state) =>
      page.evaluate(
        (state) => globalThis.__TAURI_INTERNALS__.invoke("island_surface_request", { state }),
        state,
      );
    const style = () =>
      page.locator(".island-morph").evaluate((element) => {
        const value = globalThis.getComputedStyle(element);
        const content = globalThis.getComputedStyle(element.querySelector(".island-content"));
        const exit = globalThis.getComputedStyle(element.querySelector(".island-outgoing"));
        return {
          duration: value.transitionDuration,
          delay: value.transitionDelay,
          easing: value.transitionTimingFunction,
          contentDuration: content.animationDuration,
          contentDelay: content.animationDelay,
          exitDuration: exit.animationDuration,
          exitInert: element.querySelector(".island-outgoing").inert,
        };
      });
    await page.waitForTimeout(400);
    const live = await style();
    assert.equal(live.contentDuration, "0.12s");
    assert.equal(live.contentDelay, reduced ? "0s" : "0.06s");
    await request("peek");
    await page.waitForFunction(
      () => globalThis.document.querySelector("main").dataset.islandState === "peek",
    );
    const peek = await style();
    assert.equal(peek.duration, reduced ? "0s" : "0.32s");
    await page.waitForTimeout(400);
    assert.equal((await page.locator(".island-morph").boundingBox()).width, 400);
    await request("expanded");
    await page.getByRole("navigation", { name: "Island modules" }).waitFor();
    const expanded = await style();
    assert.equal(expanded.duration, reduced ? "0s" : "0.38s");
    const tabDelays = await page
      .locator(".island-module-tab")
      .evaluateAll((tabs) => tabs.map((tab) => globalThis.getComputedStyle(tab).animationDelay));
    assert.deepEqual(
      tabDelays,
      reduced ? Array(6).fill("0s") : ["0s", "0.02s", "0.04s", "0.06s", "0.08s", "0.1s"],
    );
    await page.waitForTimeout(450);
    assert.equal((await page.locator(".island-morph").boundingBox()).width, 680);
    await request("live");
    await page.waitForFunction(
      () => globalThis.document.querySelector("main").dataset.islandState === "live",
    );
    const collapse = await style();
    assert.equal(collapse.duration, reduced ? "0s" : "0.22s");
    assert.equal(collapse.delay, reduced ? "0s" : "0.08s");
    assert.equal(collapse.exitDuration, reduced ? "0.12s" : "0.08s");
    assert(collapse.exitInert);
    await page.waitForTimeout(400);
    assert.equal(await page.locator(".island-outgoing > *").count(), 0);
    assert.equal((await page.locator(".island-morph").boundingBox()).width, 336);
    await page.evaluate(() => {
      const frames = globalThis.requestAnimationFrame,
        timeout = globalThis.setTimeout,
        interval = globalThis.setInterval;
      const counts = { frames: 0, timeouts: 0, intervals: 0 };
      globalThis.__idleCounts = counts;
      globalThis.requestAnimationFrame = (...args) => {
        counts.frames++;
        return frames(...args);
      };
      globalThis.setTimeout = (...args) => {
        counts.timeouts++;
        return timeout(...args);
      };
      globalThis.setInterval = (...args) => {
        counts.intervals++;
        return interval(...args);
      };
    });
    await page.waitForTimeout(550);
    const idle = await page.evaluate(() => globalThis.__idleCounts);
    assert.deepEqual(idle, { frames: 0, timeouts: 0, intervals: 0 });
    const ipc = await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot());
    assert.deepEqual(errors, []);
    assert.deepEqual(ipc.unsupported, []);
    assert(!ipc.calls.some(({ command }) => command === "start_download"));
    const coldContext = await browser.newContext({
      viewport: { width: 720, height: 460 },
      reducedMotion: reduced ? "reduce" : "no-preference",
    });
    const coldSeed = globalThis.structuredClone(seed);
    coldSeed.responses.get_island_surface.state = "peek";
    coldSeed.responses.get_island_surface.width = 336;
    await coldContext.addInitScript(installMockIpc, coldSeed);
    const cold = await coldContext.newPage();
    await cold.goto(`http://127.0.0.1:${server.httpServer.address().port}/island.html`, {
      waitUntil: "domcontentloaded",
    });
    await cold.waitForFunction(
      () => globalThis.document.querySelector("main")?.dataset.islandState === "peek",
    );
    const opening = await cold.locator(".island-morph").evaluate((element) => {
      const animation = element.getAnimations().find((a) => a.transitionProperty === "width");
      return animation?.effect.getKeyframes().map((frame) => frame.width) ?? [];
    });
    assert.deepEqual(
      opening,
      reduced ? [] : ["336px", "400px"],
      "Cold WebView must start from the native compact width",
    );
    await coldContext.close();
    results.push({ reduced, live, peek, expanded, tabDelays, collapse, idle, opening, errors });
    await context.close();
  }
  await writeFile(
    new URL(`../progress/v2/M5/${process.argv[2] ?? "v25-motion"}.json`, import.meta.url),
    JSON.stringify({ browser: browser.version(), results }, null, 2) + "\n",
    { flag: "wx" },
  );
  globalThis.console.log(
    "Passed normal/reduced morph timings, inert exit cleanup and zero collapsed JS scheduling.",
  );
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((done) => server.httpServer.close(done));
}
