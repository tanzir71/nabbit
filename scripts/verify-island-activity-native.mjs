import assert from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";
import { chromium } from "playwright";
const [endpoint, cursorPath, control, folder, prefix, ownerProcessId] = process.argv.slice(2);
const execute = promisify(execFile),
  browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().includes("island.html"));
  assert(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  const snapshot = () => invoke("get_island_snapshot");
  const wait = async (predicate, label, attempts = 160) => {
    for (let i = 0; i < attempts; i++) {
      const result = await predicate();
      if (result) return result;
      await setTimeout(50);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const request = async (fields) => {
    const id = randomUUID(),
      path = resolve(control, "island-request.json");
    await writeFile(`${path}.activity`, JSON.stringify({ id, ...fields }));
    await rename(`${path}.activity`, path);
    const response = await wait(async () => {
      try {
        const value = JSON.parse(await readFile(resolve(control, "island-response.json"), "utf8"));
        return value.id === id && value;
      } catch {
        return false;
      }
    }, "fixture request");
    assert.equal(response.error, null);
    return response;
  };
  const initial = await snapshot(),
    placement = initial.hosts[0].placement,
    monitor = initial.desktop.monitors.find((value) => value.id === placement.monitorId).bounds;
  const foreground = (maximised = false, full = false) => ({
    windowId: 44,
    visible: true,
    maximised,
    notificationState: 5,
    monitor,
    rect: full ? monitor : { x: 20, y: 20, width: 900, height: 700 },
  });
  const cursor = async (x, y, leftDown = false) => {
    await writeFile(
      `${cursorPath}.activity`,
      JSON.stringify({
        x: placement.bounds.x + x * placement.renderScale,
        y: placement.bounds.y + y * placement.renderScale,
        leftDown,
      }),
    );
    await rename(`${cursorPath}.activity`, cursorPath);
  };
  const events = async (...activity) => (await request({ activity })).snapshot;
  const action = (action) => invoke("island_activity_action", { action });
  const state = async (mode) => {
    const value = await wait(async () => {
      const s = await snapshot();
      return s;
    }, "native snapshot");
    await page.waitForFunction(
      (mode) => globalThis.document.querySelector("main").dataset.islandState === mode,
      mode,
    );
    assert.equal(value.lastError, null);
    assert.equal(value.inputWatcher.ownForegroundEvents, 0);
    assert.deepEqual(value.hosts[0].placement.bounds, placement.bounds);
    return await snapshot();
  };
  const native = async (mode) =>
    wait(async () => {
      const value = await snapshot();
      return value.visibility[0].mode === mode && value;
    }, `native visibility ${mode}`);
  const flags = async (value, interactive = false) => {
    const result = await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        resolve("scripts/assert-island-activity-window.ps1"),
        "-NativeHwnd",
        String(value.hosts[0].hwnd),
        "-OwnerProcessId",
        ownerProcessId,
        "-ExpectedInteractive",
        interactive ? "1" : "0",
      ],
      { windowsHide: true },
    );
    return JSON.parse(result.stdout);
  };
  const records = [];
  const record = async (name, mode) => {
    const value = await state(mode);
    records.push({ case: name, mode, snapshot: value });
    return value;
  };
  const entry = await page.evaluate(async () => {
    const url = globalThis.document.querySelector('script[type="module"]').src;
    return {
      file: new globalThis.URL(url).pathname.split("/").pop(),
      bytes: globalThis.btoa(
        String.fromCharCode(...new Uint8Array(await (await globalThis.fetch(url)).arrayBuffer())),
      ),
    };
  });
  const entrySha256 = createHash("sha256").update(Buffer.from(entry.bytes, "base64")).digest("hex");
  assert.equal(
    entrySha256,
    createHash("sha256")
      .update(await readFile(resolve("dist/assets", entry.file)))
      .digest("hex"),
  );
  const subscription = await page.evaluate(async () => {
    globalThis.__activityEvents = [];
    const result = [];
    for (const event of ["nabbit://activity", "nabbit://island"]) {
      const handler = globalThis.__TAURI_INTERNALS__.transformCallback((message) =>
        globalThis.__activityEvents.push({ event, payload: message.payload }),
      );
      const eventId = await globalThis.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
        event,
        target: { kind: "Any" },
        handler,
      });
      result.push({ event, eventId, handler });
    }
    return result;
  });
  await cursor(80, 300);
  await request({ foreground: foreground() });
  await action({ kind: "show" });
  await record("initial-idle", "idle");
  const progress = {
    kind: "downloadProgress",
    jobId: "activity-fixture",
    title: "Fixture download",
    percent: 35,
    speed: "1 MiB/s",
    eta: "00:10",
  };
  await events(progress);
  let value = await record("download-progress", "live");
  assert.equal(value.activity.views[0].primary.event.jobId, progress.jobId);
  await events(
    { kind: "privacyChanged", mic: ["Fixture app"], camera: [] },
    { kind: "timerTick", id: "t", remainingS: 59, label: "Focus" },
  );
  value = await record("priority-and-split", "live");
  assert.deepEqual(
    [
      value.activity.views[0].primary.category,
      value.activity.views[0].bubble.category,
      value.activity.views[0].queue[0].category,
    ],
    ["privacy", "timerEnding", "download"],
  );
  await events(
    { kind: "privacyChanged", mic: [], camera: [] },
    { kind: "dismissed", id: "timer:t" },
  );
  // Fullscreen queues normal results; user hide/focus takes precedence over exceptions.
  await request({ foreground: foreground(false, true) });
  await events({ kind: "noteSaved", cardId: "queued", destination: "Local" });
  value = await record("fullscreen-queues-alerts", "hidden");
  assert.equal(value.activity.views[0].queue.length, 2);
  await setTimeout(4200);
  value = await snapshot();
  assert(value.activity.views[0].queue.some((item) => item.id === "note:queued"));
  await request({ foreground: foreground() });
  await record("fullscreen-restores-live", "live");
  await setTimeout(4200);
  value = await snapshot();
  assert(!value.activity.views[0].queue.some((item) => item.id === "note:queued"));
  assert(
    ![value.activity.views[0].primary?.id, value.activity.views[0].bubble?.id].includes(
      "note:queued",
    ),
  );
  await action({ kind: "hideOneHour" });
  value = await record("one-hour-user-hide", "hidden");
  assert(value.activity.preferences.hiddenUntilMs > Date.now() + 3_500_000);
  await native("hidden");
  records.push({ case: "user-hide-actual-flags", windows: await flags(value) });
  let capture = await request({
    capture: { label: "island", stem: `${prefix}-native-user-hidden` },
  });
  await execute(
    "python",
    [
      resolve("scripts/encode-island-visibility-capture.py"),
      resolve(control, `${prefix}-native-user-hidden.bgra`),
      String(capture.result.width),
      String(capture.result.height),
      "island",
      "1",
      "hidden",
      resolve(folder, `${prefix}-native-user-hidden.png`),
    ],
    { windowsHide: true },
  );
  await action({ kind: "show" });
  await record("explicit-show-restores-live", "live");
  await action({ kind: "focus", active: true });
  await record("focus-mode", "hidden");
  await action({ kind: "focus", active: false });
  await record("focus-exit", "live");
  await request({ foreground: foreground(false, true) });
  await events({ kind: "downloadFailed", jobId: progress.jobId, error: "Offline" });
  await record("fullscreen-error-default-queued", "hidden");
  const preferences = (await invoke("get_activity_snapshot")).preferences;
  preferences.showAlertsOverFullscreen = true;
  await action({ kind: "configure", preferences });
  value = await record("fullscreen-error-opt-in", "live");
  await cursor(360, 12);
  await native("visible");
  assert.equal(value.activity.views[0].primary.id, `downloadFailed:${progress.jobId}`);
  records.push({ case: "fullscreen-alert-actual-click-through", windows: await flags(value) });
  capture = await request({
    capture: { label: "island", stem: `${prefix}-native-permitted-alert-shell` },
  });
  await execute(
    "python",
    [
      resolve("scripts/encode-island-visibility-capture.py"),
      resolve(control, `${prefix}-native-permitted-alert-shell.bgra`),
      String(capture.result.width),
      String(capture.result.height),
      "island",
      "1",
      "visible",
      resolve(folder, `${prefix}-native-permitted-alert-shell.png`),
    ],
    { windowsHide: true },
  );
  await setTimeout(4200);
  value = await snapshot();
  assert.equal(value.activity.views[0].primary.id, `downloadFailed:${progress.jobId}`);
  await action({ kind: "focus", active: true });
  await record("focus-overrides-allowed-alert", "hidden");
  await action({ kind: "show" });
  await record("focus-show-restores-allowed-alert", "live");
  await action({ kind: "dismiss", id: `downloadFailed:${progress.jobId}` });
  await record("dismissed-error-rehides-fullscreen", "hidden");
  await events({ kind: "timerEnded", id: "finished" });
  await record("timer-end-fullscreen-exception", "live");
  await setTimeout(4200);
  await record("timer-alert-expiry-rehides-fullscreen", "hidden");
  preferences.showAlertsOverFullscreen = false;
  await cursor(80, 300);
  await action({ kind: "configure", preferences });
  await request({ foreground: foreground(true) });
  await record("idle-over-maximised", "faded");
  await events(progress);
  await record("live-activity-over-maximised", "live");
  await events({ kind: "downloadRemoved", jobId: progress.jobId });
  await record("live-end-refades-idle", "faded");
  await invoke("island_wake");
  await record("explicit-wake-over-maximised", "idle");
  await action({ kind: "hideOneHour" });
  await record("hide-cancels-wake", "hidden");
  await native("hidden");
  await action({ kind: "show" });
  await record("show-restores-faded-idle", "faded");
  await cursor(80, 300, true);
  const samples = (await snapshot()).inputWatcher.cursorSamples;
  await wait(
    async () => (await snapshot()).inputWatcher.cursorSamples >= samples + 2,
    "arm held drag",
  );
  await cursor(80, 10, true);
  value = await record("drag-wakes-faded-idle", "drop");
  await native("visible");
  assert(value.input[0].interactive);
  records.push({ case: "drop-actual-interactive-flags", windows: await flags(value, true) });
  await cursor(80, 300, false);
  await record("drag-cancel-restores-faded", "faded");
  await request({ foreground: foreground() });
  await events({
    kind: "linkDetected",
    url: "https://example.invalid/review",
    title: "Review fixture",
    duration: null,
    site: "fixture",
  });
  await record("link-eight-second-affordance", "live");
  await setTimeout(8200);
  value = await record("link-shrinks-to-bubble", "idle");
  assert.equal(value.activity.views[0].bubble.id, "link");
  await events({ kind: "clipboardChanged" });
  await record("clipboard-clears-link-bubble", "idle");
  const custom = (await invoke("get_activity_snapshot")).preferences;
  custom.order = ["power", ...custom.order.filter((kind) => kind !== "power")];
  custom.disabled = ["media"];
  await action({ kind: "configure", preferences: custom });
  await events(progress, { kind: "powerChanged", percent: 10, charging: false });
  value = await record("persisted-user-priority", "live");
  assert.equal(value.activity.views[0].primary.category, "power");
  const saved = await invoke("get_settings");
  assert.equal(saved.islandActivity.order[0], "power");
  assert.deepEqual(saved.islandActivity.disabled, ["media"]);
  await events(
    { kind: "dismissed", id: "power" },
    { kind: "downloadRemoved", jobId: progress.jobId },
  );
  await record("quiet-idle", "idle");
  await setTimeout(550);
  const before = await snapshot();
  await setTimeout(1100);
  const after = await snapshot();
  assert.equal(after.activity.revision, before.activity.revision);
  assert.equal(after.activityScheduler.wakeups, before.activityScheduler.wakeups);
  assert.equal(after.activityScheduler.nextDeadlineMs, null);
  assert.equal(after.hosts[0].commits, before.hosts[0].commits);
  await request({ foreground: foreground(false, true) });
  await record("final-fullscreen-hidden", "hidden");
  await native("hidden");
  const received = await page.evaluate(() => globalThis.__activityEvents);
  for (const channel of ["nabbit://activity", "nabbit://island"]) {
    const values = received.filter((value) => value.event === channel);
    assert(
      values.some(
        (value) =>
          value.payload.kind === "downloadProgress" && value.payload.jobId === progress.jobId,
      ),
    );
    assert(values.some((value) => value.payload.kind === "dragEnter"));
    assert(values.some((value) => value.payload.kind === "fullscreen"));
  }
  await page.evaluate(async (values) => {
    for (const { event, eventId, handler } of values) {
      globalThis.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId);
      await globalThis.__TAURI_INTERNALS__.invoke("plugin:event|unlisten", { event, eventId });
      globalThis.__TAURI_INTERNALS__.unregisterCallback(handler);
    }
  }, subscription);
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(folder, `${prefix}-activity-checks.json`),
    JSON.stringify(
      {
        records,
        events: received,
        idle: {
          durationMs: 1100,
          before: before.activityScheduler,
          after: after.activityScheduler,
          revisionStable: true,
          nativeCommitsStable: true,
        },
        entryAsset: entry.file,
        entrySha256,
        runtimeErrors: errors,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Passed ${records.length} activity/native/reducer checks and ${received.length} typed bus events; idle scheduler stayed blocked.\n`,
  );
} finally {
  await browser.close();
}
