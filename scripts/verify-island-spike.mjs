import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("playwright", { paths: [root, resolve(root, ".tools/site-qa")] }),
);
const output = resolve(root, "progress/v2/M1");
await mkdir(output, { recursive: true });
const native = process.argv[2] === "--cdp";
let server;
let browser;
const reports = [];
const geometry = {
  idle: [112, 26, 13],
  live: [320, 32, 16],
  peek: [400, 74, 24],
  expanded: [680, 297, 28],
};

async function verify(page, name, capture = true) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => globalThis.nabbitIslandSpike?.ready);
  const initialHost = await page.evaluate(() => [
    globalThis.innerWidth,
    globalThis.innerHeight,
    globalThis.outerWidth,
    globalThis.outerHeight,
  ]);
  assert.deepEqual(initialHost.slice(0, 2), [720, 460]);
  const results = [];
  for (const [state, [width, height, radius]] of Object.entries(geometry)) {
    await page.evaluate((state) => globalThis.nabbitIslandSpike.setState(state), state);
    await page.waitForTimeout(550);
    const box = await page.locator(".spike-pill").boundingBox();
    assert(Math.abs(box.width - width) < 0.05, `${state}: width ${box.width}`);
    assert(Math.abs(box.height - height) < 0.05, `${state}: height ${box.height}`);
    assert.equal(box.y, 6);
    assert.equal(box.x, (720 - width) / 2);
    const computed = await page.locator(".spike-pill").evaluate((element) => ({
      radius: globalThis.getComputedStyle(element).borderRadius,
      background: globalThis.getComputedStyle(element).backgroundColor,
    }));
    assert.equal(computed.radius, `${radius}px`);
    assert.equal(computed.background, "rgb(5, 5, 6)");
    assert.deepEqual(
      await page.evaluate(() => [
        globalThis.innerWidth,
        globalThis.innerHeight,
        globalThis.outerWidth,
        globalThis.outerHeight,
      ]),
      initialHost,
      "The host window must not resize for a morph",
    );
    const images = await page.locator(".spike-layer.active img").evaluateAll((images) =>
      images.map((image) => ({
        loaded: image.complete,
        natural: [image.naturalWidth, image.naturalHeight],
        rendered: [image.getBoundingClientRect().width, image.getBoundingClientRect().height],
      })),
    );
    for (const image of images) {
      assert(image.loaded);
      assert.deepEqual(
        image.rendered,
        image.natural,
        "Keep each original Figma asset at its intrinsic dimensions",
      );
    }
    if (capture) {
      const filename = `v01-${name}-${state}.png`;
      await page.screenshot({
        path: resolve(output, filename),
        omitBackground: native,
        animations: "disabled",
      });
      assert((await stat(resolve(output, filename))).size <= 300 * 1024);
    }
    results.push({ state, width: box.width, height: box.height, radius, host: initialHost });
  }
  await page.evaluate(() => globalThis.nabbitIslandSpike.setState("idle"));
  await page.waitForTimeout(550);
  const motion = await page.evaluate(() => {
    const pill = globalThis.document.querySelector(".spike-pill");
    const reducedMotion = globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
    pill.getBoundingClientRect();
    globalThis.nabbitIslandSpike.setState("live");
    const transition = pill
      .getAnimations()
      .find((animation) => animation.transitionProperty === "width");
    if (transition) {
      transition.pause();
      transition.currentTime = 130;
    }
    const midpointWidth = pill.getBoundingClientRect().width;
    for (const animation of pill.getAnimations()) animation.finish();
    return { reducedMotion, cssWidthTransition: Boolean(transition), midpointWidth };
  });
  assert.equal(motion.cssWidthTransition, !motion.reducedMotion);
  if (!motion.reducedMotion)
    assert(
      motion.midpointWidth > 112 && motion.midpointWidth < 320,
      "CSS must interpolate the morph rather than jump to its final shape",
    );
  await page.evaluate(() => globalThis.nabbitIslandSpike.setState("idle"));
  await page.waitForTimeout(550);
  await page.evaluate(() => {
    const counters = { interval: 0, timeout: 0, frame: 0 };
    const original = {
      interval: globalThis.setInterval,
      timeout: globalThis.setTimeout,
      frame: globalThis.requestAnimationFrame,
    };
    globalThis.spikeIdleCounters = counters;
    globalThis.setInterval = (...args) => {
      counters.interval++;
      return original.interval(...args);
    };
    globalThis.setTimeout = (...args) => {
      counters.timeout++;
      return original.timeout(...args);
    };
    globalThis.requestAnimationFrame = (...args) => {
      counters.frame++;
      return original.frame(...args);
    };
    globalThis.restoreSpikeTimers = () => {
      globalThis.setInterval = original.interval;
      globalThis.setTimeout = original.timeout;
      globalThis.requestAnimationFrame = original.frame;
    };
  });
  await setTimeout(300);
  const idleScheduling = await page.evaluate(() => {
    const result = globalThis.spikeIdleCounters;
    globalThis.restoreSpikeTimers();
    return result;
  });
  assert.deepEqual(
    idleScheduling,
    { interval: 0, timeout: 0, frame: 0 },
    "The collapsed app must not schedule JS polling",
  );
  assert.deepEqual(errors, []);
  reports.push({ name, states: results, motion, idleScheduling, runtimeErrors: errors });
}

try {
  if (native) {
    const endpoint = process.argv[3] ?? "http://127.0.0.1:9239";
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        browser = await chromium.connectOverCDP(endpoint);
        break;
      } catch {
        await setTimeout(200);
      }
    }
    assert(browser, "The isolated WebView2 CDP endpoint did not start");
    let page;
    for (let attempt = 0; attempt < 100; attempt++) {
      page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url().includes("spikes/island/index.html"));
      if (page) break;
      await setTimeout(200);
    }
    assert(page, "The actual Tauri spike page was not created");
    assert.equal(
      await page
        .locator("html")
        .evaluate((element) => globalThis.getComputedStyle(element).backgroundColor),
      "rgba(0, 0, 0, 0)",
    );
    await verify(page, "native");
  } else {
    const base = "http://127.0.0.1:1441";
    server = spawn(
      process.execPath,
      [
        resolve(root, "node_modules/vite/bin/vite.js"),
        "preview",
        "--port",
        "1441",
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      { cwd: root, stdio: "ignore", windowsHide: true },
    );
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ready = (await globalThis.fetch(`${base}/spikes/island/index.html`)).ok;
      } catch {
        /* Preview is starting. */
      }
      if (ready) break;
      await setTimeout(100);
    }
    assert(ready, "Build the spike before starting its preview");
    browser = await chromium.launch({ headless: true });
    for (const colorScheme of ["light", "dark"])
      for (const deviceScaleFactor of [1, 1.5]) {
        const context = await browser.newContext({
          viewport: { width: 720, height: 460 },
          colorScheme,
          deviceScaleFactor,
        });
        const page = await context.newPage();
        const external = [];
        await page.route("**/*", (route) => {
          if (!route.request().url().startsWith(`${base}/`)) {
            external.push(route.request().url());
            return route.abort();
          }
          return route.continue();
        });
        await page.goto(`${base}/spikes/island/index.html?preview=1`, { waitUntil: "networkidle" });
        assert.equal(
          await page
            .locator(".spike-pill")
            .evaluate((element) =>
              globalThis.getComputedStyle(element).transitionTimingFunction.startsWith("linear("),
            ),
          true,
        );
        await verify(page, `${colorScheme}@${deviceScaleFactor}x`);
        assert.deepEqual(external, []);
        await context.close();
      }
    const reduced = await browser.newContext({
      viewport: { width: 720, height: 460 },
      reducedMotion: "reduce",
    });
    const page = await reduced.newPage();
    await page.goto(`${base}/spikes/island/index.html?preview=1`, { waitUntil: "networkidle" });
    assert.equal(
      await page
        .locator(".spike-pill")
        .evaluate((element) => globalThis.getComputedStyle(element).transitionProperty),
      "opacity",
    );
    assert.equal(
      await page
        .locator(".spike-pill")
        .evaluate((element) => globalThis.getComputedStyle(element).transitionDuration),
      "0.12s",
    );
    await verify(page, "reduced-motion", false);
    await reduced.close();
  }
  await writeFile(
    resolve(output, `v01-${native ? "webview" : "preview"}-checks.json`),
    JSON.stringify(
      { surface: native ? "Tauri WebView2" : "Vite preview", hostLogicalSize: [720, 460], reports },
      null,
      2,
    ) + "\n",
  );
  globalThis.console.log(
    `Verified ${reports.length} ${native ? "native" : "preview"} contexts, four morph states, fixed host, original assets and zero idle JS scheduling.`,
  );
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
