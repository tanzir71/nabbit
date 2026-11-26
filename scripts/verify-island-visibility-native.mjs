import assert from "node:assert/strict";
import { writeFile, rename, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers/promises";
import { resolve } from "node:path";
import process from "node:process";
import { chromium } from "playwright";
const [endpoint, cursorPath, control, folder, prefix] = process.argv.slice(2);
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
    "island navigation",
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(
    () => globalThis.document.querySelector("main")?.dataset.islandVisibility === "visible",
  );
  const entryAsset = await page.evaluate(async () => {
    const url = globalThis.document.querySelector('script[type="module"]').src;
    const bytes = new Uint8Array(await (await globalThis.fetch(url)).arrayBuffer());
    return {
      file: new globalThis.URL(url).pathname.split("/").pop(),
      base64: globalThis.btoa(String.fromCharCode(...bytes)),
    };
  });
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const entrySha256 = hash(Buffer.from(entryAsset.base64, "base64"));
  assert.equal(
    entrySha256,
    hash(await readFile(resolve("dist/assets", entryAsset.file))),
    "Release serves stale island JavaScript",
  );
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  const snapshot = () => invoke("get_island_snapshot");
  const original = await snapshot(),
    placement = original.hosts[0].placement;
  const monitor = original.desktop.monitors.find(
    (monitor) => monitor.id === placement.monitorId,
  ).bounds;
  const foreground = (maximised = false, notificationState = 5, full = false) => ({
    windowId: 43,
    visible: true,
    maximised,
    notificationState,
    monitor,
    rect: full ? monitor : { x: monitor.x + 20, y: monitor.y + 20, width: 900, height: 700 },
  });
  const command = async (fields) => {
    const id = randomUUID(),
      file = resolve(control, "island-request.json");
    await writeFile(`${file}.node`, JSON.stringify({ id, ...fields }));
    await rename(`${file}.node`, file);
    const result = await wait(async () => {
      try {
        const value = JSON.parse(await readFile(resolve(control, "island-response.json"), "utf8"));
        return value.id === id && value;
      } catch {
        return false;
      }
    }, "fixture response");
    assert.equal(result.error, null);
    assert.equal(result.snapshot.lastError, null);
    return result.snapshot;
  };
  const cursor = async (x, y) => {
    await writeFile(
      `${cursorPath}.node`,
      JSON.stringify({
        x: placement.bounds.x + x * placement.renderScale,
        y: placement.bounds.y + y * placement.renderScale,
        leftDown: false,
      }),
    );
    await rename(`${cursorPath}.node`, cursorPath);
  };
  const state = async (mode) => {
    const value = await wait(async () => {
      const s = await snapshot();
      return s.visibility[0].mode === mode && s;
    }, `native ${mode}`);
    await page.waitForFunction(
      (mode) => globalThis.document.querySelector("main").dataset.islandVisibility === mode,
      mode,
    );
    const actual = await page.locator("main").evaluate((host) => {
      const style = globalThis.getComputedStyle(host),
        box = host.getBoundingClientRect();
      return {
        opacity: style.opacity,
        pointer: style.pointerEvents,
        display: style.display,
        width: box.width,
        height: box.height,
        hidden: host.getAttribute("aria-hidden"),
      };
    });
    assert.equal(actual.opacity, mode === "hidden" ? "0" : mode === "faded" ? "0.35" : "1");
    assert.equal(actual.pointer, mode === "visible" ? "auto" : "none");
    assert.deepEqual([actual.width, actual.height], [720, 460]);
    assert.notEqual(actual.display, "none");
    assert.equal(actual.hidden, String(mode === "hidden"));
    assert.deepEqual(value.hosts[0].placement.bounds, placement.bounds);
    if (mode !== "visible") assert.equal(value.input[0].interactive, false);
    return { mode, actual, snapshot: value };
  };
  const subscription = await page.evaluate(async () => {
    globalThis.__visibilityEvents = [];
    const event = "nabbit://island-visibility",
      internal = globalThis.__TAURI_INTERNALS__;
    const handler = internal.transformCallback((message) =>
      globalThis.__visibilityEvents.push(message.payload),
    );
    const eventId = await internal.invoke("plugin:event|listen", {
      event,
      target: { kind: "Any" },
      handler,
    });
    return { event, eventId, handler };
  });
  const records = [];
  await cursor(80, 300);
  await command({ foreground: foreground(true) });
  records.push(await state("faded"));
  await invoke("island_wake");
  records.push(await state("visible"));
  await command({ foreground: foreground(true, 3) });
  records.push(await state("hidden"));
  await invoke("island_wake");
  await cursor(360, 12);
  await setTimeout(650);
  records.push(await state("hidden"));
  await cursor(80, 300);
  await command({ foreground: foreground(true) });
  records.push(await state("faded"));
  await cursor(360, 12);
  await setTimeout(150);
  records.push(await state("faded"));
  records.push(await state("visible"));
  await cursor(80, 300);
  records.push(await state("faded"));
  // The full top band wakes, even more than 120px from the compact pill.
  await cursor(80, 12);
  await wait(async () => {
    const value = await snapshot();
    return value.visibility[0].mode === "faded" && value.input[0].decision.pollMs === 25;
  }, "far top-band intent sampling");
  records.push(await state("visible"));
  assert.equal(
    (await snapshot()).input[0].interactive,
    false,
    "Wake must not expand the hit rectangle",
  );
  await cursor(80, 300);
  records.push(await state("faded"));
  await command({ foreground: foreground() });
  records.push(await state("visible"));
  await setTimeout(550);
  const before = await snapshot();
  await setTimeout(1100);
  const after = await snapshot();
  const systemSamples = after.inputWatcher.systemSamples - before.inputWatcher.systemSamples;
  assert(
    systemSamples >= 1 && systemSamples <= 4,
    `Foreground fallback polling unexpected: ${systemSamples}`,
  );
  assert.equal(
    after.hosts[0].commits,
    before.hosts[0].commits,
    "Unchanged foreground repainted the scene",
  );
  const tray = await wait(
    () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate !== page && candidate.url().includes("tauri.localhost")),
    "tray navigation",
  );
  const rejected = await tray.evaluate(async () => {
    try {
      await globalThis.__TAURI_INTERNALS__.invoke("island_wake");
      return false;
    } catch {
      return true;
    }
  });
  assert(rejected, "Wake accepted a non-island caller");
  await command({ foreground: foreground(false, 5, true) });
  records.push(await state("hidden"));
  const events = await page.evaluate(() => globalThis.__visibilityEvents);
  assert(
    events.some((value) => value.mode === "hidden") &&
      events.some((value) => value.mode === "faded") &&
      events.some((value) => value.mode === "visible"),
  );
  for (let i = 1; i < events.length; i++)
    assert(events[i].revision > events[i - 1].revision, "Visibility revisions must increase");
  await page.evaluate(async ({ event, eventId, handler }) => {
    globalThis.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId);
    await globalThis.__TAURI_INTERNALS__.invoke("plugin:event|unlisten", { event, eventId });
    globalThis.__TAURI_INTERNALS__.unregisterCallback(handler);
  }, subscription);
  assert.equal(after.inputWatcher.ownForegroundEvents, 0);
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(folder, `${prefix}-web-visibility-checks.json`),
    JSON.stringify(
      {
        records,
        events,
        systemSamples,
        sampleDurationMs: 1100,
        nativeCommitsStable: true,
        boundsStable: true,
        nonIslandWakeRejected: true,
        entryAsset: entryAsset.file,
        entrySha256,
        runtimeErrors: errors,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Passed actual WebView2 visibility, typed events, hover/explicit wake, caller scope and ${systemSamples} foreground fallback samples per 1100ms.\n`,
  );
} finally {
  await browser.close();
}
