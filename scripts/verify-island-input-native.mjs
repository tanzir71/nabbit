import assert from "node:assert/strict";
import { writeFile, rename, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers/promises";
import { resolve } from "node:path";
import process from "node:process";
import { chromium } from "playwright";
const [endpoint, cursorPath, folder, prefix] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(endpoint);
try {
  const wait = async (predicate, label) => {
    for (let i = 0; i < 120; i++) {
      const value = await predicate();
      if (value) return value;
      await setTimeout(50);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const page = await wait(
    () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().includes("island.html")),
    "input surface navigation",
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await wait(() => page.locator('script[type="module"]').count(), "entry document");
  const entryAsset = await page.evaluate(async () => {
    const url = globalThis.document.querySelector('script[type="module"]').src;
    const response = await globalThis.fetch(url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      file: new globalThis.URL(url).pathname.split("/").pop(),
      base64: globalThis.btoa(String.fromCharCode(...bytes)),
    };
  });
  const entrySha256 = createHash("sha256")
    .update(Buffer.from(entryAsset.base64, "base64"))
    .digest("hex");
  assert.equal(
    entrySha256,
    createHash("sha256")
      .update(await readFile(resolve("dist/assets", entryAsset.file)))
      .digest("hex"),
    "Release serves stale island JavaScript",
  );
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  const snapshot = () => invoke("get_island_snapshot");
  const native = await wait(async () => {
    const value = await snapshot();
    return value.input[0]?.source === "web" && value;
  }, "ResizeObserver → native hit rectangle");
  assert.deepEqual(native.input[0].hitrect, { x: 296, y: 0, w: 128, h: 40 });
  const placement = native.hosts[0].placement;
  const cursor = async (x, y, leftDown = false) => {
    await writeFile(
      `${cursorPath}.node`,
      JSON.stringify({
        x: placement.bounds.x + x * placement.renderScale,
        y: placement.bounds.y + y * placement.renderScale,
        leftDown,
      }),
    );
    await rename(`${cursorPath}.node`, cursorPath);
  };
  const interactive = async (expected) =>
    wait(async () => {
      const value = await snapshot();
      return value.input[0].interactive === expected && value;
    }, `interactive ${expected}`);
  const records = [];
  await cursor(600, 200);
  await interactive(false);
  await page.locator(".island-idle").evaluate((element) => {
    element.style.width = "680px";
    element.style.height = "297px";
  });
  const expanded = await wait(async () => {
    const value = await snapshot();
    return value.input[0].hitrect.w === 696 && value.input[0].interactive && value;
  }, "changed web layout");
  records.push({ case: "layout-update", snapshot: expanded });
  await page.locator(".island-idle").evaluate((element) => {
    element.style.width = "112px";
    element.style.height = "26px";
  });
  await wait(async () => {
    const value = await snapshot();
    return value.input[0].hitrect.w === 128 && !value.input[0].interactive;
  }, "collapsed web layout");
  await cursor(80, 100);
  await interactive(false);
  const subscriptions = await page.evaluate(async () => {
    globalThis.__inputEvents = [];
    const internal = globalThis.__TAURI_INTERNALS__;
    const values = [];
    for (const event of ["island:drag-enter", "island:drag-leave"]) {
      const handler = internal.transformCallback((message) =>
        globalThis.__inputEvents.push({ event, payload: message.payload }),
      );
      const eventId = await internal.invoke("plugin:event|listen", {
        event,
        target: { kind: "Any" },
        handler,
      });
      values.push({ event, eventId, handler });
    }
    return values;
  });
  for (const type of ["text/uri-list", "Files", "text/plain"]) {
    await page.locator(".island-host").evaluate((element, type) => {
      const dataTransfer = new globalThis.DataTransfer();
      if (type === "Files")
        dataTransfer.items.add(
          new globalThis.File(["isolated fixture"], "fixture.txt", { type: "text/plain" }),
        );
      else
        dataTransfer.setData(
          type,
          type === "text/uri-list" ? "https://example.invalid/drop" : "fixture text",
        );
      element.dispatchEvent(new globalThis.DragEvent("dragenter", { bubbles: true, dataTransfer }));
    }, type);
    const entered = await wait(async () => {
      const value = await snapshot();
      return value.input[0].decision.dragging && value.input[0].interactive && value;
    }, `${type} drag enter`);
    await page.locator(".island-host").evaluate((element) =>
      element.dispatchEvent(
        new globalThis.DragEvent("drop", {
          bubbles: true,
          dataTransfer: new globalThis.DataTransfer(),
        }),
      ),
    );
    await wait(async () => {
      const value = await snapshot();
      return !value.input[0].decision.dragging && !value.input[0].interactive;
    }, `${type} drag end`);
    records.push({ case: "html5-drag-lifetime", type, entered: entered.input });
  }
  const events = await wait(async () => {
    const values = await page.evaluate(() => globalThis.__inputEvents);
    return values.length >= 6 && values;
  }, "typed drag events");
  assert.equal(events.filter((entry) => entry.event === "island:drag-enter").length, 3);
  assert.equal(events.filter((entry) => entry.event === "island:drag-leave").length, 3);
  for (const rect of [
    { x: 0, y: 0, w: 0, h: 20 },
    { x: 800, y: 0, w: 20, h: 20 },
    { x: 0, y: 0, w: -1, h: 20 },
  ]) {
    await assert.rejects(invoke("island_set_hitrect", { rect }));
  }
  const tray = await wait(
    () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate !== page && candidate.url().includes("tauri.localhost")),
    "tray navigation",
  );
  for (const [command, args] of [
    ["island_set_hitrect", { rect: { x: 0, y: 0, w: 720, h: 460 } }],
    ["island_set_drag", { active: true }],
    ["island_clear_hitrect", {}],
  ]) {
    const rejected = await tray.evaluate(
      async ({ command, args }) => {
        try {
          await globalThis.__TAURI_INTERNALS__.invoke(command, args);
          return false;
        } catch {
          return true;
        }
      },
      { command, args },
    );
    assert(rejected, `${command} accepted a non-island caller`);
  }
  await cursor(80, 400);
  await interactive(false);
  await setTimeout(550);
  const farBefore = await snapshot();
  await setTimeout(1100);
  const farAfter = await snapshot();
  const farSamples = farAfter.inputWatcher.cursorSamples - farBefore.inputWatcher.cursorSamples;
  const farWakeups =
    farAfter.inputWatcher.foregroundEvents - farBefore.inputWatcher.foregroundEvents;
  assert(
    farSamples >= 1 && farSamples <= 3 + farWakeups,
    `Far polling exceeded 2Hz plus foreground wakes: ${farSamples}`,
  );
  await cursor(360, 12);
  await interactive(true);
  await setTimeout(80);
  const nearBefore = await snapshot();
  await setTimeout(1100);
  const nearAfter = await snapshot();
  const nearSamples = nearAfter.inputWatcher.cursorSamples - nearBefore.inputWatcher.cursorSamples;
  assert(
    nearSamples >= 33 && nearSamples <= 66,
    `Near polling out of 30–60Hz range: ${nearSamples}`,
  );
  assert.equal(
    nearAfter.hosts[0].commits,
    farBefore.hosts[0].commits,
    "Cursor sampling repainted native idle",
  );
  assert.deepEqual(
    nearAfter.hosts[0].placement.bounds,
    farBefore.hosts[0].placement.bounds,
    "Input resized the host",
  );
  await page.evaluate(async (subscriptions) => {
    for (const { event, eventId, handler } of subscriptions) {
      globalThis.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId);
      await globalThis.__TAURI_INTERNALS__.invoke("plugin:event|unlisten", { event, eventId });
      globalThis.__TAURI_INTERNALS__.unregisterCallback(handler);
    }
  }, subscriptions);
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(folder, `${prefix}-web-input-checks.json`),
    JSON.stringify(
      {
        records,
        events,
        farSamples,
        nearSamples,
        sampleDurationMs: 1100,
        nativeCommitsStable: true,
        boundsStable: true,
        invalidRectanglesRejected: true,
        nonIslandCallersRejected: true,
        foregroundHookInstalled: nearAfter.inputWatcher.hookInstalled,
        farForegroundWakeups: farWakeups,
        entryAsset: entryAsset.file,
        entrySha256,
        runtimeErrors: errors,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Passed actual WebView2 input bridge, caller validation, drag lifetimes, and ${farSamples} far / ${nearSamples} near samples per 1100ms.\n`,
  );
} finally {
  await browser.close();
}
