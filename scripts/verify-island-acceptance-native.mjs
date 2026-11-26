import assert from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
import { summarizeFrames, selectFrameEvidence } from "./island-frame-metrics.mjs";

const [endpoint, cursorPath, control, folder, prefix, owner, refresh, executableSha256] =
  process.argv.slice(2);
assert(/^[a-f0-9]{64}$/.test(executableSha256));
let servedEntry;
const refreshHz = Number(refresh);
assert(refreshHz > 1);
const browser = await chromium.connectOverCDP(endpoint);
const trace = await browser.newBrowserCDPSession();
const events = [],
  morphs = [],
  checks = [],
  problems = [],
  receipts = new Map();
const wait = async (fn, label) => {
  for (let i = 0; i < 300; i++) {
    const value = await fn();
    if (value) return value;
    await setTimeout(50);
  }
  throw new Error(`Timed out: ${label}`);
};
async function request(fields = {}) {
  const id = randomUUID(),
    path = resolve(control, "island-request.json");
  await writeFile(`${path}.acceptance`, JSON.stringify({ id, ...fields }));
  await rename(`${path}.acceptance`, path);
  return wait(async () => {
    try {
      const response = JSON.parse(await readFile(resolve(control, "island-response.json"), "utf8"));
      if (response.id !== id) return false;
      assert.equal(response.error, null);
      assert.equal(response.snapshot.lastError, null);
      if (response.snapshot.windowOrder)
        assert(
          response.snapshot.windowOrder.every((entry) => entry.webAboveNative !== false),
          "A native host occludes its WebView",
        );
      return response.snapshot;
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  }, "native acceptance response");
}
const surface = (state, label = "island") => request({ surface: { label, state } });
async function selectPage(label = "island") {
  return wait(async () => {
    for (const p of browser
      .contexts()
      .flatMap((c) => c.pages())
      .filter((p) => p.url().includes("island.html")))
      if (
        (await p
          .evaluate(() => globalThis.__TAURI_INTERNALS__?.metadata.currentWindow.label)
          .catch(() => null)) === label
      )
        return p;
    return false;
  }, "owned island page");
}
async function settled(state, label = "island") {
  return wait(async () => {
    const s = await request();
    return s.surfaces[label]?.state === state && s.surfaces[label].webOwner && s;
  }, `${state} paint ownership`);
}
async function closed(label = "island") {
  return wait(async () => {
    const s = await request();
    return !s.surfaces[label]?.webAllocated && s;
  }, "native compact ownership");
}
async function check(name) {
  const snapshot = await request();
  assert.equal(snapshot.inputWatcher.ownForegroundEvents, 0);
  checks.push({ name, snapshot });
  return snapshot;
}
const link = {
  kind: "downloadProgress",
  jobId: "acceptance-motion",
  title: "Island acceptance fixture",
  percent: 38,
  speed: "4.2 MB/s",
  eta: "1:12",
};
const install = () => {
  const arm = (id, cold = false) => {
    globalThis.__nabbitMeasuredMorph = { id, cold, started: false, done: false };
  };
  globalThis.__nabbitArmMorph = arm;
  arm(`nabbit:motion:cold:${globalThis.performance.timeOrigin}`, true);
  globalThis.addEventListener("transitionrun", (event) => {
    const m = globalThis.__nabbitMeasuredMorph;
    const host = globalThis.document.querySelector("main");
    if (
      m.cold &&
      (!host ||
        !["peek", "expanded", "drop"].includes(host.dataset.islandState) ||
        globalThis.getComputedStyle(event.target).visibility !== "visible")
    )
      return;
    if (
      event.target?.classList.contains("island-morph") &&
      event.propertyName === "width" &&
      !m.started
    ) {
      m.started = true;
      m.stateStart = host.dataset.islandState;
      m.visibilityStart = globalThis.document.visibilityState;
      m.opacityStart = globalThis.getComputedStyle(
        globalThis.document.querySelector("main"),
      ).opacity;
      m.nativeOpacity = host.style.getPropertyValue("--native-island-opacity");
      m.inlineOpacity = host.style.opacity;
      m.visibilityMode = host.dataset.islandVisibility;
      globalThis.performance.mark(`${m.id}:start`);
    }
  });
  globalThis.addEventListener("transitionend", (event) => {
    const m = globalThis.__nabbitMeasuredMorph;
    if (
      event.target?.classList.contains("island-morph") &&
      event.propertyName === "width" &&
      m.started &&
      !m.done
    ) {
      globalThis.performance.mark(`${m.id}:end`);
      m.done = true;
      const r = event.target.getBoundingClientRect();
      void globalThis.__nabbitMorphEnd({
        id: m.id,
        stateStart: m.stateStart,
        stateEnd: globalThis.document.querySelector("main").dataset.islandState,
        visibilityStart: m.visibilityStart,
        visibilityEnd: globalThis.document.visibilityState,
        opacityStart: m.opacityStart,
        nativeOpacity: m.nativeOpacity,
        inlineOpacity: m.inlineOpacity,
        visibilityMode: m.visibilityMode,
        compactPrepared: globalThis.document.querySelector("main").dataset.compactPrepared,
        preparationMs: globalThis.performance.getEntriesByName("nabbit:surface-preparation")[0]
          ?.duration,
        opacityEnd: globalThis.getComputedStyle(globalThis.document.querySelector("main")).opacity,
        width: r.width,
        height: r.height,
        scale: globalThis.devicePixelRatio,
      });
    }
  });
};
let tracing = false;
try {
  for (const context of browser.contexts()) {
    await context.exposeBinding("__nabbitMorphEnd", ({ page }, data) => {
      receipts.set(data.id, data);
      receipts.set(page, data);
    });
    await context.addInitScript(install);
  }
  const initial = await request(),
    desktop = initial.desktop,
    preferences = initial.preferences;
  await request({ activity: [link] });
  await wait(async () => (await request()).surfaces.island.state === "live", "native live");
  const version = await trace.send("Browser.getVersion");
  trace.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  await trace.send("Tracing.start", {
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
  tracing = true;
  await surface("expanded");
  {
    const page = await selectPage();
    const session = await page.context().newCDPSession(page);
    const { frameTree } = await session.send("Page.getFrameTree");
    await session.detach();
    const receipt = await wait(() => receipts.get(page), "first-use Expanded width transition");
    assert.equal(receipt.stateEnd, "expanded");
    assert.equal(receipt.compactPrepared, "true");
    assert(Math.abs(receipt.width - 680) < 0.05);
    await settled("expanded");
    const served = await page.evaluate(async () => {
      const url = globalThis.document.querySelector('script[type="module"]').src;
      return {
        file: new globalThis.URL(url).pathname.split("/").pop(),
        bytes: Array.from(new Uint8Array(await (await globalThis.fetch(url)).arrayBuffer())),
      };
    });
    servedEntry = {
      file: served.file,
      sha256: createHash("sha256").update(new Uint8Array(served.bytes)).digest("hex"),
    };
    assert.equal(
      servedEntry.sha256,
      createHash("sha256")
        .update(await readFile(resolve("dist/assets", served.file)))
        .digest("hex"),
      "Native release serves stale JavaScript",
    );
    morphs.push({
      id: receipt.id,
      round: 0,
      from: "native-live-first-use",
      to: "expanded",
      targetFrameId: frameTree.frame.id,
      observedTransition: receipt,
    });
  }
  // Keep the injected pointer inside Peek. A programmatic Peek still obeys
  // the real 300ms leave timer; a far pointer would close it during collection.
  const placement = (await request()).hosts[0].placement;
  await writeFile(
    `${cursorPath}.acceptance`,
    JSON.stringify({
      x: placement.bounds.x + 360 * placement.renderScale,
      y: placement.bounds.y + 20 * placement.renderScale,
      leftDown: false,
    }),
  );
  await rename(`${cursorPath}.acceptance`, cursorPath);
  await request({ wake: "island" });
  await wait(
    async () => (await request()).input[0].interactive,
    "injected pointer inside owned surface",
  );
  for (let round = 1; round <= 3; round++) {
    globalThis.console.log(`Collecting production morph round ${round}.`);
    for (const to of ["peek", "expanded"]) {
      await surface("live");
      await closed();
      await surface(to);
      const page = await selectPage();
      const session = await page.context().newCDPSession(page);
      const { frameTree } = await session.send("Page.getFrameTree");
      await session.detach();
      const receipt = await wait(() => receipts.get(page), `cold ${to} width transition`);
      assert.equal(receipt.stateEnd, to);
      assert.equal(receipt.compactPrepared, "true");
      assert(Math.abs(receipt.width - (to === "peek" ? 400 : 680)) < 0.05);
      await settled(to);
      morphs.push({
        id: receipt.id,
        round,
        from: "native-live",
        to,
        targetFrameId: frameTree.frame.id,
        observedTransition: receipt,
      });
    }
    for (const from of ["peek", "expanded"]) {
      for (const to of ["peek", "expanded", "live"]) {
        if (from === to) continue;
        await surface(from);
        await settled(from);
        const page = await selectPage();
        const session = await page.context().newCDPSession(page);
        const { frameTree } = await session.send("Page.getFrameTree");
        await session.detach();
        const id = `nabbit:motion:${round}:${from}:${to}`;
        await page.evaluate((id) => globalThis.__nabbitArmMorph(id), id);
        await surface(to);
        const receipt = await wait(() => receipts.get(id), `${from} to ${to} width transition`);
        if (to === "live") await closed();
        else await settled(to);
        morphs.push({
          id,
          round,
          from,
          to,
          targetFrameId: frameTree.frame.id,
          observedTransition: receipt,
        });
      }
    }
    // Real production drag policy: enter Drop, then cancel back to its owner.
    for (const from of ["peek", "expanded", "live"]) {
      await surface(from);
      if (from === "live") await closed();
      else await settled(from);
      let page, frameTree;
      const enterId = `nabbit:motion:${round}:${from}:drop`;
      if (from === "live") {
        const cursor = async (y, leftDown) => {
          await writeFile(
            `${cursorPath}.acceptance`,
            JSON.stringify({
              x: placement.bounds.x + 360 * placement.renderScale,
              y: placement.bounds.y + y * placement.renderScale,
              leftDown,
            }),
          );
          await rename(`${cursorPath}.acceptance`, cursorPath);
          await request({ wake: "island" });
        };
        await cursor(80, true);
        await wait(
          async () => !(await request()).input[0].decision.dragging,
          "held button outside band",
        );
        await cursor(20, true);
        page = await selectPage();
      } else {
        page = await selectPage();
        await page.evaluate((id) => globalThis.__nabbitArmMorph(id), enterId);
        await page.evaluate(() =>
          globalThis.__TAURI_INTERNALS__.invoke("island_set_drag", { active: true }),
        );
      }
      const session = await page.context().newCDPSession(page);
      ({ frameTree } = await session.send("Page.getFrameTree"));
      await session.detach();
      const entered = await wait(
        () => (from === "live" ? receipts.get(page) : receipts.get(enterId)),
        `${from} to Drop`,
      );
      assert.equal(entered.stateEnd, "drop");
      assert(Math.abs(entered.width - 640) < 0.05);
      await settled("drop");
      morphs.push({
        id: entered.id,
        round,
        from: from === "live" ? "native-live" : from,
        to: "drop",
        targetFrameId: frameTree.frame.id,
        observedTransition: entered,
      });
      const returnId = `nabbit:motion:${round}:drop:${from}`;
      await page.evaluate((id) => globalThis.__nabbitArmMorph(id), returnId);
      if (from === "live") {
        await writeFile(
          `${cursorPath}.acceptance`,
          JSON.stringify({
            x: placement.bounds.x + 360 * placement.renderScale,
            y: placement.bounds.y + 20 * placement.renderScale,
            leftDown: false,
          }),
        );
        await rename(`${cursorPath}.acceptance`, cursorPath);
        await request({ wake: "island" });
      } else
        await page.evaluate(() =>
          globalThis.__TAURI_INTERNALS__.invoke("island_set_drag", { active: false }),
        );
      const returned = await wait(() => receipts.get(returnId), `Drop restores ${from}`);
      if (from === "live") await closed();
      else await settled(from);
      morphs.push({
        id: returnId,
        round,
        from: "drop",
        to: from,
        targetFrameId: frameTree.frame.id,
        observedTransition: returned,
      });
    }
  }
  // Idle has a different native seed width and no primary activity.
  const active = await request();
  const activeIds = [
    ...new Set(
      active.activity.views
        .flatMap((v) => [v.primary, v.bubble, ...v.queue])
        .filter(Boolean)
        .map((a) => a.id),
    ),
  ];
  await request({ activity: activeIds.map((id) => ({ kind: "dismissed", id })) });
  await surface("idle");
  await closed();
  const idleCursor = async (y, leftDown) => {
    await writeFile(
      `${cursorPath}.acceptance`,
      JSON.stringify({
        x: placement.bounds.x + 360 * placement.renderScale,
        y: placement.bounds.y + y * placement.renderScale,
        leftDown,
      }),
    );
    await rename(`${cursorPath}.acceptance`, cursorPath);
    await request({ wake: "island" });
  };
  for (let round = 1; round <= 3; round++) {
    for (const to of ["expanded", "drop"]) {
      if (to === "drop") {
        await idleCursor(80, true);
        await wait(
          async () => !(await request()).input[0].decision.dragging,
          "idle held button outside band",
        );
        await idleCursor(20, true);
      } else await surface("expanded");
      const page = await selectPage();
      const session = await page.context().newCDPSession(page);
      const { frameTree } = await session.send("Page.getFrameTree");
      await session.detach();
      const receipt = await wait(() => receipts.get(page), `native idle to ${to}`);
      assert.equal(receipt.stateEnd, to);
      assert.equal(receipt.compactPrepared, "true");
      assert(Math.abs(receipt.width - (to === "drop" ? 640 : 680)) < 0.05);
      await settled(to);
      morphs.push({
        id: receipt.id,
        round,
        from: "native-idle",
        to,
        targetFrameId: frameTree.frame.id,
        observedTransition: receipt,
      });
      const id = `nabbit:motion:${round}:${to}:idle`;
      await page.evaluate((id) => globalThis.__nabbitArmMorph(id), id);
      if (to === "drop") await idleCursor(20, false);
      else await surface("idle");
      const returned = await wait(() => receipts.get(id), `${to} to native idle`);
      await closed();
      morphs.push({
        id,
        round,
        from: to,
        to: "idle",
        targetFrameId: frameTree.frame.id,
        observedTransition: returned,
      });
    }
  }
  await request({ activity: [{ ...link, jobId: "acceptance-motion-dpi" }] });
  await wait(
    async () => (await request()).surfaces.island.state === "live",
    "restored live for DPI fixtures",
  );
  const complete = new Promise((resolve) => trace.once("Tracing.tracingComplete", resolve));
  await trace.send("Tracing.end");
  const completion = await complete;
  tracing = false;
  assert.notEqual(completion.dataLossOccurred, true);
  await writeFile(
    resolve(".tools", `${prefix}-full-trace.json`),
    JSON.stringify({ traceEvents: events }),
    { flag: "wx" },
  );
  const results = [],
    evidence = new Map();
  for (const morph of morphs) {
    try {
      const [result] = summarizeFrames(events, morph.targetFrameId, [morph], refreshHz);
      results.push(result);
      for (const event of selectFrameEvidence(events, morph.targetFrameId, [result]))
        evidence.set(JSON.stringify(event), event);
    } catch (error) {
      problems.push({ id: morph.id, reason: error.message });
    }
  }
  await writeFile(
    resolve(folder, `${prefix}-frame-timings.json`),
    JSON.stringify(
      {
        version,
        executableSha256,
        servedEntry,
        refreshHz,
        ownerProcessId: Number(owner),
        morphs,
        results,
        collectionProblems: problems,
        maxDroppedFrames: results.length ? Math.max(...results.map((r) => r.droppedFrames)) : null,
        withinV0TwoDropBudget:
          problems.length === 0 && results.every((r) => r.withinTwoDroppedFrames),
        traceEventCount: events.length,
        traceDataLoss: completion.dataLossOccurred ?? false,
        method:
          "Actual production WebView2 target renderer/layer-tree BeginFrame/DrawFrame/explicit DroppedFrame IDs. First-use Expanded, cold native-to-Peek/Expanded allocation, both directed web morphs and both returns to native, and Drop enter/cancel from native Live, Peek and Expanded, three rounds, plus native Idle to/from Expanded and Drop in three rounds. Partial drops count; draw gaps do not infer drops.",
        nativeCompactScope:
          "Idle/live geometry uses DirectComposition with no WebView. Its compositor frames cannot be attributed through CDP; native motion unit tests and owned-window smokes cover geometry/ownership, not an unmeasured zero-drop claim.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(
    resolve(folder, `${prefix}-compositor-trace.json`),
    JSON.stringify({ traceEvents: [...evidence.values()] }, null, 2) + "\n",
    { flag: "wx" },
  );
  await check("first-use-and-three-rounds-of-production-web-morphs");
  // Reconfigure while a real Expanded window is opening, preserving its HWND.
  await surface("live");
  await closed();
  await surface("peek");
  await settled("peek");
  const page = await selectPage();
  const before = await request();
  const nativeHwnd = before.hosts[0].hwnd;
  await surface("expanded");
  const animatingBeforeDpiChange = await page.evaluate(() =>
    globalThis.document
      .querySelector(".island-morph")
      .getAnimations()
      .some((animation) => animation.playState === "running"),
  );
  assert(animatingBeforeDpiChange, "DPI fixture must change during a running morph");
  const resized = globalThis.structuredClone(desktop);
  const targetScale = desktop.monitors[0].scaleFactor === 1.5 ? 1 : 1.5;
  resized.monitors[0].scaleFactor = targetScale;
  await request({ desktop: resized });
  let s = await settled("expanded");
  assert.equal(s.hosts[0].hwnd, nativeHwnd);
  assert.equal(s.hosts[0].placement.bounds.width, Math.round(720 * targetScale));
  assert.equal(s.surfaces.island.webHwnd, before.surfaces.island.webHwnd);
  assert.equal(s.surfaces.island.state, "expanded");
  await page.waitForFunction(() => globalThis.document.querySelector(".island-tabbar"));
  await check("dpi-change-during-expanded-opening-preserves-host-and-state");
  // Add/remove the expanded target monitor under All mode; no real displays change.
  const multi = globalThis.structuredClone(desktop);
  multi.monitors.push({
    ...globalThis.structuredClone(multi.monitors[0]),
    id: "removed",
    name: "Removed fixture",
    primary: false,
    bounds: { x: 1920, y: 0, width: 1280, height: 900 },
    workArea: { x: 1920, y: 0, width: 1280, height: 852 },
    scaleFactor: 1.5,
  });
  await request({ desktop: multi, preferences: { ...preferences, monitorMode: "all" } });
  s = await wait(async () => {
    const v = await request();
    return v.hosts.length === 2 && v;
  }, "two fixture hosts");
  const removed = s.hosts.find((h) => h.placement.monitorId === "removed").placement.label;
  await surface("expanded", removed);
  await settled("expanded", removed);
  await request({ desktop });
  s = await wait(async () => {
    const v = await request();
    return v.hosts.length === 1 && !v.surfaces[removed] && v;
  }, "expanded monitor removal");
  assert(!s.keyboard.request || s.keyboard.request.label !== removed);
  assert(!s.keyboard.lease || s.keyboard.lease.label !== removed);
  await check("remove-expanded-monitor-destroys-web-and-focus-state");
  await request({
    preferences,
    desktop,
    activity: [{ kind: "dismissed", id: "link:https://example.invalid/acceptance" }],
  });
  // Dismiss using actual bus IDs rather than relying on an event ID convention.
  s = await request();
  const ids = [
    ...new Set(
      s.activity.views
        .flatMap((v) => [v.primary, v.bubble, ...v.queue])
        .filter(Boolean)
        .map((a) => a.id),
    ),
  ];
  await request({ activity: ids.map((id) => ({ kind: "dismissed", id })) });
  await surface("idle");
  await closed();
  await check("restored-original-idle-fixture");
  await writeFile(
    resolve(folder, `${prefix}-acceptance.json`),
    JSON.stringify(
      {
        checks,
        focusInjected: true,
        monitorsAndDpiInjected: true,
        realCursorUntouched: true,
        displaySettingsUntouched: true,
        nativeCompactFrameAttribution: "not available through CDP",
        framesWithinV0Budget:
          problems.length === 0 && results.every((r) => r.withinTwoDroppedFrames),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  assert.deepEqual(problems, [], "Missing compositor evidence is not a zero-drop pass");
  // �6.7 requires measurement and comparison. V0.4 already selected the
  // native compact fallback when the all-WebView budget failed; preserve
  // the larger-WebView result without turning it into a passing budget.
  globalThis.console.log(
    `V0 <=2-drop comparison: ${results.every((r) => r.withinTwoDroppedFrames) ? "within budget" : "exceeded; native compact fallback retained"}`,
  );
  globalThis.console.log(
    `Measured ${results.length} production WebView morphs and ${checks.length} native acceptance checks.`,
  );
} finally {
  if (tracing) await trace.send("Tracing.end").catch(() => {});
  await trace.detach().catch(() => {});
  await browser.close();
}
