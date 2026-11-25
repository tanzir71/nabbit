import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new globalThis.URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("playwright", { paths: [root, resolve(root, ".tools/site-qa")] }),
);
const output = resolve(root, "progress/v2/M1");
await mkdir(output, { recursive: true });
const native = globalThis.process.argv[2] === "--cdp";
let browser, server;
const errors = [];
async function capture(page, name) {
  const path = resolve(output, `v02-${name}.png`);
  await page.screenshot({ path, omitBackground: native, animations: "disabled" });
  assert((await stat(path)).size <= 300 * 1024);
}
async function connect(endpoint) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch {
      await setTimeout(200);
    }
  }
  throw new Error("Isolated WebView2 CDP endpoint did not start");
}
async function nativeStep(page, step) {
  const expected = {
    far: [false, false, false, 500],
    near: [false, false, false, 25],
    inside: [false, false, true, 25],
    edge: [false, false, true, 25],
    outside: [false, false, false, 500],
    arm: [false, false, false, 500],
    band: [false, true, true, 25],
    target: [false, true, true, 25],
    cancel: [false, false, false, 500],
    drops: [false, false, false, 500],
    fullscreen: [true, false, false, 500],
    resume: [false, false, true, 25],
    otherMonitor: [false, false, false, 500],
    borderless: [true, false, false, 500],
    own: [false, false, true, 25],
    shell: [false, false, true, 25],
  }[step];
  assert(expected, `Unknown scenario ${step}`);
  if (step === "fullscreen")
    await page.evaluate(() => globalThis.nabbitIslandSpike.setState("expanded"));
  let drops;
  if (step === "drops") {
    const fixture = resolve(root, ".tools", "island-drop-sample.mp4");
    await writeFile(fixture, "Synthetic acceptance fixture; no media job.");
    await page.evaluate(() => {
      const input = globalThis.document.createElement("input");
      input.type = "file";
      input.id = "acceptance-file";
      input.hidden = true;
      globalThis.document.body.append(input);
    });
    // Playwright's upload adapter creates a memory File. CDP supplies a disk-backed
    // File, which WebView2 requires for native AdditionalObjects path resolution.
    const session = await page.context().newCDPSession(page);
    const { root: documentRoot } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", {
      nodeId: documentRoot.nodeId,
      selector: "#acceptance-file",
    });
    await session.send("DOM.setFileInputFiles", { nodeId, files: [fixture] });
    await session.detach();
    drops = [];
    for (const [kind, zone] of [
      ["link", "download"],
      ["files", "shelf"],
      ["text", "note"],
    ]) {
      await page.evaluate((kind) => {
        const transfer = new globalThis.DataTransfer();
        if (kind === "files")
          transfer.items.add(globalThis.document.querySelector("#acceptance-file").files[0]);
        else
          transfer.setData(
            kind === "link" ? "text/uri-list" : "text/plain",
            kind === "link" ? "https://example.org/video" : "A native quick note",
          );
        globalThis.spikeTransfer = transfer;
        globalThis.document.querySelector("main").dispatchEvent(
          new globalThis.DragEvent("dragenter", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
            clientX: 80,
            clientY: 100,
          }),
        );
      }, kind);
      try {
        await page.waitForFunction(
          () => globalThis.document.querySelector(".spike-pill").dataset.state === "drop",
        );
        await page.waitForTimeout(500);
        assert.equal(await page.locator(".drop-zone").first().getAttribute("data-drop-zone"), zone);
        const box = await page.locator(`[data-drop-zone="${zone}"]`).boundingBox();
        await page.evaluate(
          ({ zone, x, y }) =>
            globalThis.document.querySelector(`[data-drop-zone="${zone}"]`).dispatchEvent(
              new globalThis.DragEvent("drop", {
                bubbles: true,
                cancelable: true,
                dataTransfer: globalThis.spikeTransfer,
                clientX: x,
                clientY: y,
              }),
            ),
          { zone, x: box.x + box.width / 2, y: box.y + box.height / 2 },
        );
        await page.waitForFunction(
          ({ kind, zone }) =>
            globalThis.document.querySelector("[role=status]")?.textContent ===
            `Ready for review · ${kind} · ${zone}`,
          { kind, zone },
        );
      } catch (error) {
        const diagnostic = await page.evaluate(() => ({
          state: globalThis.document.querySelector(".spike-pill").dataset.state,
          receipt: globalThis.document.querySelector("[role=status]")?.textContent,
          files: globalThis.nabbitIslandSpike.receivedFiles(),
        }));
        globalThis.console.error({ kind, zone, diagnostic, errors });
        throw error;
      }
      await page.waitForFunction(
        () => globalThis.document.querySelector(".spike-pill").dataset.state === "idle",
      );
      drops.push({ kind, zone, readyForReview: true });
    }
    const paths = await page.evaluate(() => globalThis.nabbitIslandSpike.receivedFiles());
    assert.deepEqual(
      paths.map((path) => resolve(path)),
      [fixture],
      "File paths must round-trip through WebView2 and onDragDropEvent",
    );
    await page.evaluate(() => {
      const transfer = new globalThis.DataTransfer();
      transfer.items.add(new globalThis.File(["virtual"], "virtual.mp4"));
      globalThis.document.querySelector("main").dispatchEvent(
        new globalThis.DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: 80,
          clientY: 100,
        }),
      );
    });
    await page.waitForFunction(() =>
      globalThis.document
        .querySelector("[role=status]")
        ?.textContent.includes("Can't use this here"),
    );
    drops.push({
      kind: "virtual-file",
      nativePathUnavailable: true,
      rejectedWithoutRuntimeError: true,
    });
    await page.locator("#acceptance-file").evaluate((el) => el.remove());
  }
  const before = await page.evaluate(() => globalThis.nabbitIslandSpike.nativeSnapshot());
  await page.evaluate(() => globalThis.nabbitIslandSpike.nativeSnapshot(true));
  await page.waitForFunction(
    async ({ expected, samples }) => {
      const report = await globalThis.nabbitIslandSpike.nativeSnapshot();
      const d = report.decision;
      return (
        report.cursorSamples > samples &&
        JSON.stringify([d.hidden, d.dragging, d.interactive, d.pollMs]) === JSON.stringify(expected)
      );
    },
    { expected, samples: before.cursorSamples },
  );
  await page.waitForTimeout(650);
  const report = await page.evaluate(() => globalThis.nabbitIslandSpike.nativeSnapshot());
  assert(report.hookInstalled, "The foreground WinEvent hook must be installed");
  const ui = await page.evaluate(() => ({
    hidden: globalThis.document.querySelector("main").dataset.hidden,
    opacity: globalThis.getComputedStyle(globalThis.document.querySelector("main")).opacity,
    state: globalThis.document.querySelector(".spike-pill").dataset.state,
    rect: globalThis.nabbitIslandSpike.hitrect(),
    host: [globalThis.innerWidth, globalThis.innerHeight],
  }));
  assert.equal(ui.hidden, String(expected[0]));
  assert.equal(ui.opacity, expected[0] ? "0" : "1");
  assert.deepEqual(ui.host, [720, 460]);
  assert.equal(
    ui.state,
    expected[1]
      ? "drop"
      : ["fullscreen", "resume", "otherMonitor", "borderless", "own", "shell"].includes(step)
        ? "expanded"
        : "idle",
  );
  assert(Math.abs(ui.rect.w - (expected[1] ? 656 : ui.state === "expanded" ? 696 : 128)) < 0.05);
  let sampling;
  if (step === "far" || step === "near") {
    const start = await page.evaluate(() => globalThis.nabbitIslandSpike.nativeSnapshot());
    const began = globalThis.performance.now();
    await setTimeout(1100);
    const end = await page.evaluate(() => globalThis.nabbitIslandSpike.nativeSnapshot());
    sampling = {
      elapsedMs: globalThis.performance.now() - began,
      samples: end.cursorSamples - start.cursorSamples,
      foregroundEvents: end.foregroundEvents - start.foregroundEvents,
    };
    if (step === "far")
      assert(sampling.samples <= 3 + sampling.foregroundEvents, JSON.stringify(sampling));
    else
      assert(
        sampling.samples >= 20 && sampling.samples <= 50 + sampling.foregroundEvents,
        JSON.stringify(sampling),
      );
  }
  if (["band", "fullscreen", "resume"].includes(step)) await capture(page, `native-${step}`);
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, `v02-native-${step}.json`),
    JSON.stringify({ step, report, ui, sampling, drops, runtimeErrors: errors }, null, 2) + "\n",
  );
  globalThis.console.log(`Passed native ${step}: ${JSON.stringify(report.decision)}`);
}
async function preview(page, name) {
  await page.waitForFunction(() => globalThis.nabbitIslandSpike?.ready);
  await page.waitForTimeout(100);
  const idle = await page.evaluate(() => globalThis.nabbitIslandSpike.hitrect());
  assert.deepEqual(idle, { x: 296, y: -2, w: 128, h: 42 });
  const results = [];
  for (const [kind, zone] of [
    ["link", "download"],
    ["files", "shelf"],
    ["text", "note"],
  ]) {
    await page.evaluate((kind) => {
      const transfer = new globalThis.DataTransfer();
      if (kind === "files")
        transfer.items.add(new globalThis.File(["fixture"], "sample.mp4", { type: "video/mp4" }));
      else
        transfer.setData(
          kind === "link" ? "text/uri-list" : "text/plain",
          kind === "link" ? "https://example.org/video" : "A quick note",
        );
      globalThis.spikeTransfer = transfer;
      globalThis.document.querySelector("main").dispatchEvent(
        new globalThis.DragEvent("dragenter", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    }, kind);
    await page.waitForTimeout(550);
    const box = await page.locator(".spike-pill").boundingBox();
    assert.deepEqual([box.x, box.y, box.width, box.height], [40, 6, 640, 150]);
    assert.equal(await page.locator(".drop-zone").first().getAttribute("data-drop-zone"), zone);
    const visuals = await page.locator(".drop-zone.over").evaluate((element) => ({
      border: globalThis.getComputedStyle(element).borderTopStyle,
      icon: [
        element.querySelector("img").getBoundingClientRect().width,
        element.querySelector("img").getBoundingClientRect().height,
      ],
      radius: globalThis.getComputedStyle(globalThis.document.querySelector(".spike-pill"))
        .borderRadius,
    }));
    assert.deepEqual(visuals, { border: "solid", icon: [20, 20], radius: "24px" });
    assert.equal(
      await page
        .locator(".drop-zone:not(.over)")
        .first()
        .evaluate((el) => globalThis.getComputedStyle(el).borderTopStyle),
      "dashed",
    );
    await capture(page, `${name}-drop-${kind}`);
    await page.evaluate(
      (zone) =>
        globalThis.document.querySelector(`[data-drop-zone="${zone}"]`).dispatchEvent(
          new globalThis.DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: globalThis.spikeTransfer,
          }),
        ),
      zone,
    );
    await page.waitForTimeout(550);
    assert.equal(await page.locator(".spike-pill").getAttribute("data-state"), "idle");
    assert.match(
      await page.locator("[role=status]").innerText(),
      new RegExp(`Ready for review · ${kind} · ${zone}`),
    );
    results.push({ kind, zone, box, visuals });
  }
  await page.evaluate(() => {
    const transfer = new globalThis.DataTransfer();
    transfer.setData("text/uri-list", "javascript:alert(1)");
    globalThis.document.querySelector("main").dispatchEvent(
      new globalThis.DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  assert.match(await page.locator("[role=status]").innerText(), /Can't use this here/);
  await page.evaluate(() => globalThis.nabbitIslandSpike.setState("expanded"));
  await page.waitForTimeout(550);
  const expanded = await page.evaluate(() => globalThis.nabbitIslandSpike.hitrect());
  assert.deepEqual(expanded, { x: 12, y: -2, w: 696, h: 313 });
  await page.evaluate(() =>
    globalThis.nabbitIslandSpike.receiveInteraction({ hidden: true, dragging: false, revision: 2 }),
  );
  await page.waitForTimeout(150);
  assert.equal(
    await page.locator("main").evaluate((el) => globalThis.getComputedStyle(el).opacity),
    "0",
  );
  await page.evaluate(() =>
    globalThis.nabbitIslandSpike.receiveInteraction({
      hidden: false,
      dragging: false,
      revision: 1,
    }),
  );
  assert.equal(
    await page.locator("main").getAttribute("data-hidden"),
    "true",
    "Stale visibility events cannot restore the surface",
  );
  await page.evaluate(() =>
    globalThis.nabbitIslandSpike.receiveInteraction({
      hidden: false,
      dragging: false,
      revision: 3,
    }),
  );
  assert.equal(await page.locator(".spike-pill").getAttribute("data-state"), "expanded");
  assert.deepEqual(errors, []);
  return {
    name,
    idle,
    expanded,
    drops: results,
    fullscreenStatePreserved: true,
    staleEventIgnored: true,
  };
}
try {
  if (native) {
    browser = await connect(globalThis.process.argv[3]);
    let page;
    for (let attempt = 0; attempt < 100; attempt++) {
      page = browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("spikes/island/index.html"));
      if (page) break;
      await setTimeout(200);
    }
    assert(page);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.waitForFunction(() => globalThis.nabbitIslandSpike?.ready);
    await nativeStep(page, globalThis.process.argv[5]);
  } else {
    const base = "http://127.0.0.1:1442";
    server = spawn(
      globalThis.process.execPath,
      [
        resolve(root, "node_modules/vite/bin/vite.js"),
        "preview",
        "--port",
        "1442",
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
        /* starting */
      }
      if (ready) break;
      await setTimeout(100);
    }
    assert(ready, "Build the spike before the preview");
    browser = await chromium.launch({ headless: true });
    const reports = [];
    for (const colorScheme of ["light", "dark"])
      for (const deviceScaleFactor of [1, 1.5]) {
        const context = await browser.newContext({
          viewport: { width: 720, height: 460 },
          colorScheme,
          deviceScaleFactor,
        });
        const page = await context.newPage();
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(`${base}/spikes/island/index.html?preview=1`, { waitUntil: "networkidle" });
        reports.push(await preview(page, `${colorScheme}@${deviceScaleFactor}x`));
        await context.close();
      }
    await writeFile(
      resolve(output, "v02-preview-checks.json"),
      JSON.stringify({ reports, runtimeErrors: errors }, null, 2) + "\n",
    );
    globalThis.console.log(
      "Passed synthetic URL/file/text drops, original drop geometry, hit-rect reporting and fullscreen restoration in four preview contexts.",
    );
  }
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
