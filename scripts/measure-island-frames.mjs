import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { selectFrameEvidence, summarizeFrames } from "./island-frame-metrics.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("playwright", { paths: [root, resolve(root, ".tools/site-qa")] }),
);
const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
const endpoint = argument("--cdp");
const refreshHz = Number(argument("--refresh-hz"));
assert(endpoint?.startsWith("http://127.0.0.1:"), "Use the isolated loopback endpoint");
assert(refreshHz > 1);
const output = resolve(root, "progress/v2/M1");
await mkdir(output, { recursive: true });
let browser, session;
const events = [],
  errors = [],
  morphs = [];
try {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      browser = await chromium.connectOverCDP(endpoint);
      break;
    } catch {
      await setTimeout(200);
    }
  }
  assert(browser, "The release WebView2 CDP endpoint did not start");
  let page;
  for (let attempt = 0; attempt < 100; attempt++) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().includes("spikes/island/index.html"));
    if (page) break;
    await setTimeout(200);
  }
  assert(page, "The native island page was not created");
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => globalThis.nabbitIslandSpike?.ready);
  await page.waitForTimeout(1000);
  const environment = await page.evaluate(() => ({
    host: [globalThis.innerWidth, globalThis.innerHeight],
    scaling: globalThis.devicePixelRatio,
    visibility: globalThis.document.visibilityState,
    hidden: globalThis.document.querySelector("main").dataset.hidden,
    reducedMotion: globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches,
    native: "__TAURI_INTERNALS__" in globalThis,
  }));
  assert.deepEqual(environment.host, [720, 460]);
  assert(
    environment.native && environment.visibility === "visible" && environment.hidden === "false",
  );
  assert.equal(
    environment.reducedMotion,
    false,
    "This machine requests reduced motion; record that before interpreting a morph gate",
  );
  session = await page.context().newCDPSession(page);
  const { frameTree } = await session.send("Page.getFrameTree");
  const version = await session.send("Browser.getVersion");
  session.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  await session.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      recordMode: "recordUntilFull",
      traceBufferSizeInKb: 65536,
      enableSampling: false,
      includedCategories: [
        "blink.user_timing",
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.frame",
      ],
    },
  });
  const states = ["idle", "live", "peek", "expanded"];
  const sizes = { idle: [112, 26], live: [320, 32], peek: [400, 74], expanded: [680, 297] };
  for (let round = 1; round <= 3; round++)
    for (const from of states)
      for (const to of states) {
        if (from === to) continue;
        await page.evaluate((state) => globalThis.nabbitIslandSpike.setState(state), from);
        await page.waitForTimeout(650);
        const id = `nabbit:motion:${round}:${from}:${to}`;
        const result = await page.evaluate(
          ({ id, to }) =>
            new Promise((resolve, reject) => {
              const pill = globalThis.document.querySelector(".spike-pill");
              const began = globalThis.performance.now();
              const timeout = globalThis.setTimeout(() => {
                pill.removeEventListener("transitionend", ended);
                reject(new Error(`No width transition end for ${id}`));
              }, 2000);
              function ended(event) {
                if (event.target !== pill || event.propertyName !== "width") return;
                globalThis.performance.mark(`${id}:end`);
                globalThis.clearTimeout(timeout);
                pill.removeEventListener("transitionend", ended);
                const box = pill.getBoundingClientRect();
                resolve({
                  elapsedMs: globalThis.performance.now() - began,
                  size: [box.width, box.height],
                  host: [globalThis.innerWidth, globalThis.innerHeight],
                });
              }
              pill.addEventListener("transitionend", ended);
              globalThis.performance.mark(`${id}:start`);
              globalThis.nabbitIslandSpike.setState(to);
            }),
          { id, to },
        );
        assert.deepEqual(result.host, [720, 460]);
        assert.deepEqual(result.size, sizes[to]);
        morphs.push({ id, round, from, to, observedTransition: result });
        await page.waitForTimeout(100);
      }
  const complete = new Promise((resolve) => session.once("Tracing.tracingComplete", resolve));
  await session.send("Tracing.end");
  const completion = await complete;
  if (process.argv.includes("--raw-output"))
    await writeFile(argument("--raw-output"), JSON.stringify({ traceEvents: events }));
  assert.notEqual(completion.dataLossOccurred, true, "The trace buffer lost data");
  assert.deepEqual(errors, []);
  const results = summarizeFrames(events, frameTree.frame.id, morphs, refreshHz);
  const timing = selectFrameEvidence(events, frameTree.frame.id, results);
  await writeFile(
    resolve(output, "v03-compositor-trace.json"),
    JSON.stringify({ targetFrameId: frameTree.frame.id, traceEvents: timing }, null, 2) + "\n",
  );
  const report = {
    surface: "Unsigned release Tauri WebView2",
    version,
    environment,
    refreshHz,
    traceDataLoss: completion.dataLossOccurred ?? false,
    traceEventCount: events.length,
    method:
      "Target renderer/layer-tree BeginFrame, DrawFrame and explicit DroppedFrame sequence IDs from CDP tracing; all 12 directed morphs, three rounds. Partial drops count. One refresh around the user-timing marks includes the start/final draw. Draw gaps are descriptive, not inferred drops. Missing mappings/frames fail collection.",
    sources: [
      "https://chromedevtools.github.io/devtools-protocol/tot/Tracing/",
      "https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/trace/handlers/FramesHandler.ts",
    ],
    results,
    maxDroppedFrames: Math.max(...results.map((result) => result.droppedFrames)),
    gateDecision: "Pending V0.4",
    runtimeErrors: errors,
  };
  await writeFile(
    resolve(output, "v03-frame-timings.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  globalThis.console.log(
    `Measured ${results.length} native release morphs; maximum ${report.maxDroppedFrames} explicit dropped frames.`,
  );
} finally {
  if (session) await session.detach();
  if (browser) await browser.close();
}
