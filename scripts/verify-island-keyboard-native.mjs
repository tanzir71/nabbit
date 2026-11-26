import assert from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
const [endpoint, cursorPath, control, folder, prefix, ownerProcessId] = process.argv.slice(2);
let browser = await chromium.connectOverCDP(endpoint),
  page;
const checks = [],
  captures = [],
  opens = [],
  errors = [];
const hash = (b) => createHash("sha256").update(b).digest("hex");
async function wait(run, label) {
  for (let i = 0; i < 240; i++) {
    const value = await run();
    if (value) return value;
    await setTimeout(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function request(fields = {}) {
  const id = randomUUID(),
    path = resolve(control, "island-request.json");
  await writeFile(`${path}.keyboard`, JSON.stringify({ id, ...fields }));
  await rename(`${path}.keyboard`, path);
  return wait(async () => {
    try {
      const value = JSON.parse(await readFile(resolve(control, "island-response.json"), "utf8"));
      if (value.id !== id) return false;
      assert.equal(value.error, null);
      assert.equal(value.snapshot.lastError, null);
      return value;
    } catch (e) {
      if (e.code === "ENOENT" || e instanceof SyntaxError) return false;
      throw e;
    }
  }, "native request");
}
const snapshot = async () => (await request()).snapshot;
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
async function selectPage(label = "island") {
  await wait(async () => {
    if (!browser.isConnected()) {
      try {
        browser = await chromium.connectOverCDP(endpoint, { timeout: 1000 });
      } catch {
        return false;
      }
    }
    for (const candidate of browser
      .contexts()
      .flatMap((c) => c.pages())
      .filter((p) => p.url().includes("island.html"))) {
      if (
        (await candidate
          .evaluate(() => globalThis.__TAURI_INTERNALS__?.metadata.currentWindow.label)
          .catch(() => null)) === label
      ) {
        page = candidate;
        return true;
      }
    }
    return false;
  }, "owned island page");
  page.on("pageerror", (e) => errors.push(e.message));
  await page.exposeFunction("__nabbitPinReceipt", (receipt) => {
    assert.equal(receipt.injected, true);
    opens.push(receipt.pin);
  });
  await page.evaluate(async () => {
    const handler = globalThis.__TAURI_INTERNALS__.transformCallback(({ payload }) =>
      globalThis.__nabbitPinReceipt(payload),
    );
    await globalThis.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
      event: "nabbit://pin-opened",
      target: { kind: "Any" },
      handler,
    });
  });
  await page.waitForFunction(
    () => globalThis.document.querySelector("main")?.dataset.islandState === "expanded",
  );
}
async function record(name) {
  const s = await snapshot();
  assert(s.keyboard.injectedFocus);
  assert.equal(s.inputWatcher.ownForegroundEvents, 0);
  checks.push({ name, snapshot: s });
  return s;
}
async function closed(label = "island") {
  return wait(async () => {
    const s = await snapshot();
    return s.webviews === 0 && !s.surfaces[label]?.webAllocated && s;
  }, "destroyed compact WebView");
}
async function open(shortcut = "Alt+Space", label = "island") {
  await request({ shortcut });
  await selectPage(label);
  await wait(async () => {
    const s = await snapshot();
    return s.surfaces[label]?.webOwner && s.keyboard.lease?.active;
  }, "keyboard ownership");
}
const tab = (name) =>
  page
    .getByRole("navigation", { name: "Island modules" })
    .getByRole("button", { name, exact: true });
async function capture(name) {
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready;
    await Promise.all([...globalThis.document.images].map((i) => i.decode()));
    for (let i = 0; i < 5; i++) {
      const active = globalThis.document
        .getAnimations()
        .filter((a) => a.playState === "running" || a.pending);
      await Promise.all(active.map((a) => a.finished.catch(() => {})));
      await new Promise(globalThis.requestAnimationFrame);
      if (!globalThis.document.getAnimations().some((a) => a.playState === "running" || a.pending))
        break;
    }
  });
  const shape = await page.evaluate(() => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
    scale: globalThis.devicePixelRatio,
    opacity: globalThis.getComputedStyle(globalThis.document.querySelector(".island-content"))
      .opacity,
  }));
  assert.equal(shape.opacity, "1");
  const session = await page.context().newCDPSession(page);
  let bytes;
  try {
    await session.send("Emulation.setDefaultBackgroundColorOverride", {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
    const shot = await session.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: shape.width * shape.scale,
        height: shape.height * shape.scale,
        scale: 1,
      },
    });
    bytes = Buffer.from(shot.data, "base64");
  } finally {
    await session.send("Emulation.setDefaultBackgroundColorOverride", {});
    await session.detach();
  }
  assert.equal(bytes.readUInt32BE(16), Math.round(shape.width * shape.scale));
  assert.equal(bytes.readUInt32BE(20), Math.round(shape.height * shape.scale));
  assert(bytes.length <= 300000);
  const file = `${prefix}-${name}.png`;
  await writeFile(resolve(folder, file), bytes, { flag: "wx" });
  captures.push({ file, bytes: bytes.length, sha256: hash(bytes), ...shape });
}
try {
  await selectPage();
  const initial = await record("global-shortcut-opens-from-native"),
    desktop = initial.desktop,
    preferences = initial.preferences;
  await wait(
    async () =>
      page.evaluate(
        () => globalThis.document.activeElement?.getAttribute("data-island-tab") === "nab",
      ),
    "initial tab focus",
  );
  const served = await page.evaluate(async () => {
    const url = globalThis.document.querySelector("script[type=module]").src;
    return {
      file: new globalThis.URL(url).pathname.split("/").pop(),
      bytes: Array.from(new Uint8Array(await (await globalThis.fetch(url)).arrayBuffer())),
    };
  });
  const servedEntry = { file: served.file, sha256: hash(Buffer.from(served.bytes)) };
  assert.equal(servedEntry.sha256, hash(await readFile(resolve("dist/assets", served.file))));
  await invoke("island_keyboard_ready", { request: 999999 });
  await request({
    activity: [
      {
        kind: "downloadProgress",
        jobId: "keyboard-live",
        title: "Keyboard fixture",
        percent: 42,
        speed: null,
        eta: null,
      },
    ],
  });
  let s = await record("background-update-and-stale-ready-do-not-reactivate");
  assert.equal(s.keyboard.acquired, initial.keyboard.acquired);
  assert.equal(s.keyboard.requests, initial.keyboard.requests);
  for (let i = 1; i <= 6; i++) {
    const name = ["Nab", "Notes", "Clipboard", "Files", "Media", "Timer"][i - 1];
    await page.keyboard.press(`Control+${i}`);
    await wait(
      async () => (await tab(name).getAttribute("aria-pressed")) === "true",
      `${name} selection`,
    );
    assert(await tab(name).evaluate((e) => e === globalThis.document.activeElement));
  }
  await capture("tabs");
  await record("six-tab-shortcuts-and-focus");
  await page.keyboard.press("Control+1");
  await page.getByRole("textbox", { name: "Video URL", exact: true }).waitFor();
  await tab("Nab").focus();
  await page.keyboard.press("Shift+Tab");
  assert(
    await page
      .getByRole("button", { name: "Download details", exact: true })
      .evaluate((e) => e === globalThis.document.activeElement),
  );
  await page.keyboard.press("Tab");
  assert(await tab("Nab").evaluate((e) => e === globalThis.document.activeElement));
  await page.keyboard.type("pdf");
  const search = page.getByRole("combobox", { name: "Search island", exact: true });
  await search.waitFor();
  assert.equal(await search.inputValue(), "pdf");
  await wait(async () => (await page.getByRole("option").count()) === 9, "nine real pin rows");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.getByRole("option").nth(1).getAttribute("aria-selected"), "true");
  await capture("search");
  await record("type-search-arrow-selection-and-tab-wrap");
  await search.evaluate((input) =>
    input.dispatchEvent(
      new globalThis.KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert.equal(opens.length, 0);
  await page.keyboard.press("Escape");
  s = await closed();
  assert.equal(s.keyboard.restored, 1);
  assert.equal(s.keyboard.request, null);
  await record("escape-restores-and-destroys");
  await open();
  assert.equal(await page.getByRole("combobox").inputValue(), "pdf");
  assert(await page.getByRole("combobox").evaluate((e) => e === globalThis.document.activeElement));
  await record("reopen-keeps-query-and-focus");
  await page.keyboard.press("Control+1");
  const input = page.getByRole("textbox", { name: "Video URL", exact: true });
  await input.fill("https://example.invalid/draft");
  await page.keyboard.type("-text");
  assert.equal(await page.getByRole("combobox").count(), 0);
  await capture("editing");
  const original = await invoke("get_settings");
  await assert.rejects(
    invoke("save_settings", {
      settings: {
        ...original,
        islandShortcut:
          original.togglePopoverShortcut || original.quickDownloadShortcut || "invalid shortcut",
      },
    }),
  );
  const configured = "Ctrl+Alt+Shift+F9";
  await invoke("save_settings", { settings: { ...original, islandShortcut: configured } });
  assert.equal((await invoke("get_settings")).islandShortcut, configured);
  for (const key of ["togglePopoverShortcut", "quickDownloadShortcut", "clipboardSearchShortcut"])
    assert.equal((await invoke("get_settings"))[key], original[key]);
  await page.keyboard.press("Escape");
  await closed();
  await request({ shortcut: "Alt+Space" });
  await setTimeout(350);
  assert.equal((await snapshot()).webviews, 0);
  await record("remap-keeps-legacy-and-releases-old-binding");
  for (let slot = 1; slot <= 9; slot++) {
    await open(configured);
    await page.keyboard.press(`Alt+${slot}`);
    await wait(async () => opens.some((pin) => pin.slot === slot), `pin slot ${slot}`);
    await closed();
  }
  assert.deepEqual(
    opens.map((p) => p.slot),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  await record("nine-pin-shortcuts-use-real-database-and-injected-shell");
  await open(configured);
  await page.keyboard.press("Control+1");
  await tab("Nab").focus();
  await page.keyboard.type("pdf");
  await page.getByRole("combobox").waitFor();
  await wait(async () => (await page.getByRole("option").count()) === 9, "pin search after remap");
  await page.keyboard.press("Enter");
  await wait(async () => opens.length === 10, "search result launch");
  assert.equal(opens[9].slot, 1);
  await closed();
  // Fixture monitor/DPI routing; no display settings or real cursor changes.
  const multi = {
    monitors: [
      {
        id: "primary",
        name: "Primary fixture",
        primary: true,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1032 },
        scaleFactor: 1,
      },
      {
        id: "secondary",
        name: "Secondary fixture",
        primary: false,
        bounds: { x: 1920, y: 0, width: 1280, height: 900 },
        workArea: { x: 1920, y: 0, width: 1280, height: 852 },
        scaleFactor: 1.5,
      },
    ],
    cursor: { x: 2300, y: 700 },
  };
  await writeFile(`${cursorPath}.keyboard`, JSON.stringify({ x: 2300, y: 700, leftDown: false }));
  await rename(`${cursorPath}.keyboard`, cursorPath);
  await request({ desktop: multi, preferences: { ...preferences, monitorMode: "all" } });
  s = await wait(async () => {
    const value = await snapshot();
    return value.hosts.length === 2 && value.desktop.cursor.x === 2300 && value;
  }, "two-monitor fixture");
  const label = s.hosts.find((h) => h.placement.monitorId === "secondary").placement.label;
  await open(configured, label);
  s = await record("shortcut-targets-cursor-monitor");
  assert.equal(s.keyboard.lease.label, label);
  assert.equal(Object.values(s.surfaces).filter((v) => v.webAllocated).length, 1);
  await capture("secondary-monitor");
  const restores = s.keyboard.restored;
  await request({ keyboardForeground: 9999 });
  s = await closed(label);
  assert.equal(s.keyboard.restored, restores);
  assert(s.keyboard.lost >= 1);
  await record("external-focus-switch-closes-without-stealing-back");
  const monitor = multi.monitors[1].bounds;
  await request({
    activity: [{ kind: "dismissed", id: "download:keyboard-live" }],
    foreground: {
      windowId: 7000,
      rect: { ...monitor, height: 800 },
      monitor,
      maximised: true,
      minimised: false,
      visible: true,
      cloaked: false,
      ownProcess: false,
      desktop: false,
      notificationState: 1,
    },
  });
  await wait(
    async () => (await snapshot()).surfaces[label]?.state === "faded",
    "maximised target faded",
  );
  await open(configured, label);
  await setTimeout(550);
  s = await record("shortcut-wakes-faded-monitor-and-stays-open");
  assert.equal(s.surfaces[label].state, "expanded");
  assert.equal(s.visibility.find((v) => v.label === label).mode, "visible");
  await page.keyboard.press("Escape");
  await closed(label);
  await wait(
    async () => (await snapshot()).surfaces[label]?.state === "faded",
    "collapse restores fade",
  );
  await request({
    foreground: {
      windowId: 9999,
      rect: monitor,
      monitor,
      maximised: false,
      minimised: false,
      visible: true,
      cloaked: false,
      ownProcess: false,
      desktop: false,
      notificationState: 2,
    },
  });
  await wait(async () => {
    const value = await snapshot();
    return value.surfaces[label]?.state === "hidden";
  }, "fullscreen target hidden");
  const before = (await snapshot()).keyboard.requests;
  await request({ shortcut: configured });
  await setTimeout(300);
  s = await snapshot();
  assert.equal(s.webviews, 0);
  assert.equal(s.keyboard.requests, before);
  await record("fullscreen-does-not-open-or-activate");
  await writeFile(`${cursorPath}.keyboard`, JSON.stringify({ x: 1500, y: 900, leftDown: false }));
  await rename(`${cursorPath}.keyboard`, cursorPath);
  await request({ foreground: { windowId: 0, visible: false }, desktop, preferences });
  await wait(async () => {
    const value = await snapshot();
    return value.hosts.length === 1 && value.surfaces.island?.state === "idle";
  }, "original fixture restore");
  await request({ activity: [{ kind: "dismissed", id: "download:keyboard-live" }] });
  await closed();
  await wait(async () => (await snapshot()).surfaces.island?.state === "idle", "idle restore");
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(folder, `${prefix}-keyboard.json`),
    JSON.stringify(
      {
        ownerProcessId: Number(ownerProcessId),
        servedEntry,
        checks,
        captures,
        opens,
        errors,
        configuredShortcut: configured,
        focusAndShellInjected: true,
        realCursorUntouched: true,
        osShortcutsNotRegistered: true,
        noDownloadsStarted: true,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  globalThis.console.log(
    `Verified ${checks.length} native keyboard/focus checks and ${opens.length} explicit pin intents.`,
  );
} catch (error) {
  const detail =
    page && !page.isClosed()
      ? await page
          .evaluate(() => ({
            state: globalThis.document.querySelector("main")?.dataset.islandState,
            notice: globalThis.document.querySelector(".island-notice")?.textContent,
            active: globalThis.document.activeElement?.outerHTML,
          }))
          .catch(() => null)
      : null;
  await writeFile(
    resolve(folder, `${prefix}-keyboard-failure.json`),
    JSON.stringify({ error: error.message, detail, checks, opens, errors }, null, 2) + "\n",
    { flag: "wx" },
  );
  throw error;
} finally {
  await browser.close();
}
