// Owned release app, unique data/control/WebView directories and DOM input only.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { Buffer } from "node:buffer";
import process from "node:process";
import { chromium } from "playwright";
import { deterministicRenderingFlags } from "./screenshots/policy.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v63-native-a";
assert.equal(process.platform, "win32");
assert(/^[a-z0-9-]+$/.test(prefix));
const folder = resolve(root, "progress/v2/M11"),
  output = resolve(folder, `${prefix}-scene.json`),
  exe = resolve(root, "src-tauri/target/release/nabbit.exe"),
  trial = resolve(root, `.tools/${prefix}-${randomUUID()}`),
  control = resolve(trial, "control");
await stat(output).then(
  () => {
    throw Error("Evidence already exists");
  },
  (e) => assert.equal(e.code, "ENOENT"),
);
await mkdir(control, { recursive: true });
await mkdir(folder, { recursive: true });
const reservation = createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const env = {
  ...process.env,
  NABBIT_APP_DATA_DIR: resolve(trial, "profile"),
  NABBIT_DOWNLOAD_ACCEPTANCE: "1",
  NABBIT_ACCEPTANCE_FAKE_DOWNLOAD: "1",
  NABBIT_ACCEPTANCE_CLIPBOARD_PROVIDER: "1",
  NABBIT_ACCEPTANCE_FAKE_DOWNLOAD_DELAY_MS: "200",
  NABBIT_ACCEPTANCE_DOWNLOAD_FIXTURE: resolve(trial, "downloads.json"),
  NABBIT_ACCEPTANCE_COMMAND_DIR: control,
  NABBIT_ISLAND_ACCEPTANCE: "1",
  NABBIT_STICKY_ACCEPTANCE: "1",
  NABBIT_ACCEPTANCE_REDUCED_MOTION: "1",
  NABBIT_ISLAND_LAYOUT: resolve(trial, "layout.json"),
  NABBIT_ACCEPTANCE_CURSOR: resolve(trial, "cursor.json"),
  WEBVIEW2_USER_DATA_FOLDER: resolve(trial, "webview"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 ${deterministicRenderingFlags.join(" ")}`,
};
await writeFile(
  env.NABBIT_ISLAND_LAYOUT,
  JSON.stringify({
    monitors: [
      {
        id: "primary",
        name: "Owned fixture display",
        primary: true,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1032 },
        scaleFactor: 1,
      },
    ],
    cursor: { x: 1000, y: 700 },
  }),
);
await writeFile(env.NABBIT_ACCEPTANCE_CURSOR, JSON.stringify({ x: 1000, y: 700 }));
delete env.NABBIT_ISLAND_SPIKE;
let child,
  browser,
  logs = "",
  passed = false,
  failure = null;
const checks = [],
  captures = [],
  results = {};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function wait(action, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await action();
    if (value) return value;
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw Error(`Owned app exited: ${label}`);
    assert(Date.now() < deadline, `Timed out: ${label}`);
    await setTimeout(100);
  }
}
async function island(fields) {
  const id = randomUUID(),
    path = resolve(control, "island-request.json");
  await writeFile(`${path}.pending`, JSON.stringify({ id, ...fields }));
  await rename(`${path}.pending`, path);
  return wait(async () => {
    try {
      const result = JSON.parse(await readFile(resolve(control, "island-response.json"), "utf8"));
      if (result.id !== id) return null;
      assert.equal(result.error, null);
      assert.equal(result.snapshot.lastError, null);
      return result;
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }, "island control");
}
const pages = () => browser.contexts().flatMap((context) => context.pages());
const invoke = (page, command, args = {}) =>
  page.evaluate(({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
async function start() {
  child = spawn(exe, [], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (bytes) => {
    logs += bytes;
  });
  child.stderr.on("data", (bytes) => {
    logs += bytes;
  });
  await island({ gate: "visible", prepareTray: true });
  await wait(async () => {
    try {
      return (await globalThis.fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {
      return false;
    }
  }, "owned CDP");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return wait(
    () =>
      pages().find(
        (page) =>
          page.url().includes("tauri.localhost") &&
          !page.url().includes("island.html") &&
          !page.url().includes("settings.html"),
      ),
    "hidden tray",
  );
}
async function stop() {
  if (browser) {
    await browser.close();
    browser = null;
  }
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((done) => child.once("exit", done));
  }
}
function nativeWindow() {
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        resolve(root, "scripts/read-settings-window.ps1"),
        "-OwnedProcessId",
        String(child.pid),
      ],
      { windowsHide: true, encoding: "utf8", timeout: 15000 },
    ),
  );
}
async function settingsPage(heading = "General") {
  const page = await wait(
    () => pages().find((page) => page.url().includes("settings.html")),
    "settings WebView",
  );
  await page.getByRole("heading", { name: heading, level: 1, exact: true }).waitFor();
  await page.waitForFunction(() => !!globalThis.document.documentElement.dataset.settingsBackdrop);
  await page.emulateMedia({ reducedMotion: "reduce" });
  return page;
}
async function capture(page, name) {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 460,
    height: 680,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready;
    await Promise.all([...globalThis.document.images].map((image) => image.decode()));
    globalThis.document.activeElement?.blur();
    for (const animation of globalThis.document.getAnimations()) {
      const timing = animation.effect?.getComputedTiming();
      if (timing && Number.isFinite(timing.endTime)) animation.finish();
    }
    await new Promise((done) =>
      globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(done)),
    );
  });
  const assets = await page.locator("img[data-asset],img.island-asset").evaluateAll((images) =>
    images.map((image) => {
      const box = image.getBoundingClientRect();
      return {
        file: image.dataset.asset || image.dataset.assetSlot,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        width: box.width,
        height: box.height,
      };
    }),
  );
  assert(assets.length > 0, "A native capture must include original static assets");
  for (const asset of assets) {
    assert(asset.naturalWidth > 0);
    assert.equal(asset.width, asset.naturalWidth, JSON.stringify(asset));
    assert.equal(asset.height, asset.naturalHeight, JSON.stringify(asset));
  }
  await setTimeout(100);
  const options = {
    format: "png",
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: 460, height: 680, scale: 1 },
  };
  const first = Buffer.from((await session.send("Page.captureScreenshot", options)).data, "base64");
  await setTimeout(100);
  const repeat = Buffer.from(
    (await session.send("Page.captureScreenshot", options)).data,
    "base64",
  );
  await session.detach();
  if (hash(first) !== hash(repeat)) {
    await writeFile(resolve(folder, `${prefix}-${name}-failed-first.png`), first, { flag: "wx" });
    await writeFile(resolve(folder, `${prefix}-${name}-failed-repeat.png`), repeat, { flag: "wx" });
  }
  assert.equal(hash(first), hash(repeat), `Exact repeat: ${name}`);
  assert(first.length <= 300000);
  assert.equal(first.readUInt32BE(16), 920);
  assert.equal(first.readUInt32BE(20), 1360);
  const file = `${prefix}-${name}@2x.png`;
  await writeFile(resolve(folder, file), first, { flag: "wx" });
  captures.push({
    file,
    sha256: hash(first),
    bytes: first.length,
    width: 920,
    height: 1360,
    assets,
    repeatSha256: hash(repeat),
  });
}
function flatten(entries) {
  return entries.flatMap((entry) => [entry, ...flatten(entry.children)]);
}
async function menu(page, predicate = () => true) {
  return wait(async () => {
    const snapshot = await invoke(page, "tray_snapshot");
    assert.equal(snapshot.error, null);
    return predicate(snapshot) ? snapshot : null;
  }, "native menu state");
}
async function tab(page, label) {
  const button = page
    .getByRole("navigation", { name: "Navigation" })
    .getByRole("button", { name: label, exact: true });
  await button.evaluate((node) => node.click());
  await wait(
    async () => (await button.getAttribute("aria-pressed")) === "true",
    "selected tray tab",
  );
  if (label === "Notes")
    await page.getByRole("textbox", { name: "Note title", exact: true }).waitFor();
  if (label === "Clipboard")
    await page.getByRole("textbox", { name: "Search clipboard", exact: true }).waitFor();
  if (label === "Files") await page.locator('.shelf-grid[aria-busy="false"]').waitFor();
}
try {
  let tray = await start();
  results.captureTime = new Date().toISOString();
  await tray.clock.setFixedTime(new Date(results.captureTime));
  await invoke(tray, "acknowledge_first_run");
  await invoke(tray, "tray_fixture", { id: "open" });
  await tray.getByRole("heading", { name: "Nabbit", exact: true }).waitFor();
  const manifest = JSON.parse(await readFile(resolve(root, "dist/.vite/manifest.json"), "utf8"));
  const files = [
    ...new Set(
      Object.values(manifest).flatMap((entry) => [
        entry.file,
        ...(entry.css ?? []),
        ...(entry.assets ?? []),
      ]),
    ),
  ];
  results.embeddedAssets = await tray.evaluate(
    async (files) =>
      Promise.all(
        files.map(async (file) => {
          const response = await globalThis.fetch(`/${file}`),
            bytes = await response.arrayBuffer();
          return {
            file,
            ok: response.ok,
            bytes: bytes.byteLength,
            sha256: [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join(""),
          };
        }),
      ),
    files,
  );
  for (const asset of results.embeddedAssets) {
    const raw = await readFile(resolve(root, "dist", asset.file));
    assert(asset.ok);
    assert.equal(asset.bytes, raw.length);
    assert.equal(asset.sha256, hash(raw), asset.file);
  }
  await invoke(tray, "add_clipboard_text", {
    content: "Owned tray history",
    sourceApp: "Owned fixture editor",
  });
  await invoke(tray, "add_clipboard_text", {
    content: "https://example.test/owned-video",
    sourceApp: "Owned fixture browser",
  });
  await invoke(tray, "create_note_card", {
    draft: {
      title: "Owned tray note",
      body: "Stored only in this acceptance profile",
      color: "blue",
    },
    expectedScope: null,
  });
  const owned = resolve(env.NABBIT_APP_DATA_DIR, "fixtures");
  await mkdir(owned, { recursive: true });
  const paths = [],
    pinIds = [];
  for (let slot = 1; slot <= 9; slot++) {
    const path = resolve(owned, `pin-${slot}.txt`);
    await writeFile(path, `Owned pin ${slot}\n`, { flag: "wx" });
    paths.push(path);
    pinIds.push(
      await invoke(tray, "files_save_pin", {
        draft: { id: null, path, label: `Owned pin ${slot}`, slot, alwaysMove: false },
      }),
    );
  }
  await invoke(tray, "shelf_add", { paths: [paths[0]] });
  const shelf = await invoke(tray, "shelf_list");
  results.mainDragPlan = await invoke(tray, "shelf_drag_plan", { ids: [shelf[0].id] });
  assert.deepEqual(results.mainDragPlan.item, [paths[0]]);
  assert.equal(results.mainDragPlan.mode, "copy");
  assert.equal(await invoke(tray, "shelf_paths", { ids: [shelf[0].id] }), paths[0]);
  await invoke(tray, "shelf_drag_active", { active: true });
  await invoke(tray, "shelf_drag_active", { active: false });
  await assert.rejects(() => invoke(tray, "shelf_copy_paths", { ids: [shelf[0].id] }));
  const initial = await menu(
    tray,
    (snapshot) =>
      snapshot.entries
        .find((entry) => entry.id === "pins")
        .children.filter((entry) => entry.id.startsWith("pin:")).length === 9,
  );
  results.initialMenu = initial;
  results.modeRegression = [];
  for (const [id, mode] of [
    ["mode-tray", "trayOnly"],
    ["mode-island", "islandOnly"],
    ["mode-both", "islandAndTray"],
  ]) {
    await invoke(tray, "tray_fixture", { id });
    const snapshot = await wait(async () => {
      const snapshot = await invoke(tray, "get_mode_snapshot");
      assert.equal(snapshot.trayError, null);
      return snapshot.applied?.presentation.mode === mode &&
        snapshot.applied.revision === snapshot.revision
        ? snapshot
        : null;
    }, "native mode presentation after menu dispatch");
    assert.equal(snapshot.applied.presentation.visible, mode !== "islandOnly");
    const radio = await menu(tray, (snapshot) => {
      const rows = snapshot.entries.find((entry) => entry.id === "mode").children;
      return (
        rows.find((entry) => entry.id === id)?.checked === true &&
        rows.filter((entry) => entry.checked).length === 1
      );
    });
    assert.equal(
      radio.entries.find((entry) => entry.id === "mode").children.filter((entry) => entry.checked)
        .length,
      1,
    );
    if (mode === "trayOnly")
      await wait(
        async () => !(await invoke(tray, "get_island_snapshot")).hosts.length,
        "native island teardown",
      );
    results.modeRegression.push({ id, mode, snapshot, menu: radio });
  }
  for (const id of [
    "open",
    "new-note",
    "download-clipboard",
    "clipboard",
    "settings",
    "updates",
    "quit",
  ])
    assert.equal(initial.entries.find((entry) => entry.id === id).kind, "icon");
  for (const id of [
    "open",
    "new-note",
    "download-clipboard",
    "clipboard",
    "island",
    "mode",
    "widgets",
    "pins",
    "pause-capture",
    "settings",
    "updates",
    "quit",
  ])
    assert(
      initial.entries.some((entry) => entry.id === id),
      id,
    );
  results.menuActions = [];
  for (const id of [
    "island-show",
    "island-show",
    "island-fullscreen",
    "island-maximized",
    "shape-notch",
    "shape-island",
    "shape-island",
    "monitor-primary",
    "monitor-all",
    "monitor-follow",
    "pause-capture",
  ]) {
    await invoke(tray, "tray_fixture", { id });
    const settings = await invoke(tray, "get_settings");
    const snapshot = await menu(tray, (snapshot) => {
      const entry = flatten(snapshot.entries).find((entry) => entry.id === id);
      return id === "pause-capture"
        ? entry.checked === settings.pauseClipboardCapture
        : id === "island-show"
          ? entry.checked === settings.island.enabled
          : id === "island-fullscreen"
            ? entry.checked === settings.island.hideOverFullscreen
            : id === "island-maximized"
              ? entry.checked === settings.island.fadeOverMaximized
              : entry.checked === true;
    });
    results[id] = { settings, menu: snapshot };
    results.menuActions.push({ id, settings, menu: snapshot });
  }
  await invoke(tray, "tray_fixture", { id: "pause-capture" });
  await tray.evaluate(async () => {
    globalThis.__OWNED_TRAY_PIN_EVENTS__ = [];
    const handler = globalThis.__TAURI_INTERNALS__.transformCallback((event) =>
      globalThis.__OWNED_TRAY_PIN_EVENTS__.push(event.payload),
    );
    await globalThis.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
      event: "pins:action",
      target: { kind: "Any" },
      handler,
    });
  });
  await invoke(tray, "tray_fixture", { id: `pin:${pinIds[8]}` });
  results.pinLaunch = await wait(
    () => tray.evaluate(() => globalThis.__OWNED_TRAY_PIN_EVENTS__[0] ?? null),
    "owned pin launch receipt",
  );
  assert.equal(results.pinLaunch.path, paths[8]);
  assert.equal(results.pinLaunch.action, "open");
  assert.equal(results.pinLaunch.injected, true);
  await rename(paths[0], `${paths[0]}.held`);
  await invoke(tray, "patch_settings", { change: { theme: "dark" } });
  results.missingPin = await menu(tray, (snapshot) =>
    flatten(snapshot.entries).some((entry) => entry.id === `pin:${pinIds[0]}` && !entry.enabled),
  );
  await assert.rejects(() => invoke(tray, "tray_fixture", { id: `pin:${pinIds[0]}` }));
  await rename(`${paths[0]}.held`, paths[0]);
  await invoke(tray, "files_save_pin", {
    draft: {
      id: pinIds[8],
      path: paths[8],
      label: "Owned pin nine moved",
      slot: 1,
      alwaysMove: false,
    },
  });
  results.reorderedPins = await menu(
    tray,
    (snapshot) =>
      snapshot.entries.find((entry) => entry.id === "pins").children[0].id === `pin:${pinIds[8]}`,
  );
  await invoke(tray, "files_remove_pin", { id: pinIds[4] });
  results.removedPin = await menu(
    tray,
    (snapshot) => !flatten(snapshot.entries).some((entry) => entry.id === `pin:${pinIds[4]}`),
  );
  await assert.rejects(() => invoke(tray, "tray_fixture", { id: `pin:${pinIds[4]}` }));
  const destination = resolve(owned, "destination");
  await mkdir(destination);
  await invoke(tray, "files_save_pin", {
    draft: { id: pinIds[2], path: destination, label: "Owned folder", slot: 3, alwaysMove: false },
  });
  for (const theme of ["light", "dark"]) {
    await invoke(tray, "patch_settings", { change: { theme } });
    await tray.waitForFunction(
      (theme) => globalThis.document.documentElement.dataset.theme === theme,
      theme,
    );
    for (const [label, name] of [
      ["Nab", "nab"],
      ["Notes", "notes"],
      ["Clipboard", "clipboard"],
      ["Files", "files"],
    ]) {
      await tab(tray, label);
      await capture(tray, `${name}-${theme}`);
    }
  }
  await invoke(tray, "tray_fixture", { id: "clipboard" });
  await tab(tray, "Clipboard");
  assert.equal((await invoke(tray, "get_settings")).lastTab, "clipboard");
  await invoke(tray, "tray_fixture", { id: "new-note" });
  await tab(tray, "Notes");
  await invoke(tray, "tray_fixture", { id: "island-settings" });
  const settings = await settingsPage("Island");
  await invoke(tray, "tray_fixture", { id: "settings" });
  await assert.rejects(() => invoke(settings, "shelf_list"));
  results.settingsWindow = nativeWindow();
  await invoke(tray, "tray_fixture", { id: "island-settings" });
  await settings.getByRole("heading", { name: "Island", level: 1, exact: true }).waitFor();
  await invoke(tray, "tray_fixture", { id: "widgets-settings" });
  await settings.getByRole("heading", { name: "Widgets", level: 1, exact: true }).waitFor();
  await invoke(tray, "tray_fixture", { id: "files" });
  await tab(tray, "Files");
  const searchTrigger = tray.getByRole("button", { name: "Search files", exact: true });
  await searchTrigger.evaluate((node) => node.click());
  const searchField = tray.getByRole("searchbox", { name: "Search Shelf and Pins", exact: true });
  await searchField.fill("Owned folder");
  assert.equal(await tray.locator(".files-pin-grid > li").count(), 1);
  await searchField.press("Escape");
  await wait(
    async () => (await invoke(tray, "files_drop_status")) > 0,
    "owned native tray drop registration",
  );
  await tray.evaluate(async () => {
    globalThis.__OWNED_TRAY_DROPS__ = [];
    const handler = globalThis.__TAURI_INTERNALS__.transformCallback(({ payload }) => {
      const x = payload.x / globalThis.devicePixelRatio;
      const y = payload.y / globalThis.devicePixelRatio;
      const hit = globalThis.document.elementFromPoint(x, y);
      globalThis.__OWNED_TRAY_DROPS__.push({
        payload,
        dpr: globalThis.devicePixelRatio,
        hit: hit?.outerHTML ?? null,
        zone: hit?.closest("[data-drop-zone]")?.dataset.dropZone ?? null,
      });
    });
    await globalThis.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
      event: "nabbit://native-drop",
      target: { kind: "Any" },
      handler,
    });
  });
  const dropOn = async (selector, path) => {
    const target = tray.locator(selector).first();
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    assert(box);
    const hit = await tray.evaluate(({ x, y }) => {
      const node = globalThis.document.elementFromPoint(x, y);
      return {
        zone: node?.closest("[data-drop-zone]")?.dataset.dropZone ?? null,
        dpr: globalThis.devicePixelRatio,
      };
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    assert(hit.dpr > 0);
    assert.equal(hit.zone, await target.getAttribute("data-drop-zone"), "Drop centre must hit its actual visible DOM zone");
    await invoke(tray, "files_fixture_drop", {
      request: {
        path,
        kind: "drop",
        x: Math.round((box.x + box.width / 2) * hit.dpr),
        y: Math.round((box.y + box.height / 2) * hit.dpr),
        modifiers: { shift: false, ctrl: false },
      },
    });
  };
  const sourceHash = hash(await readFile(paths[1]));
  await dropOn('.shelf-drop[data-drop-zone="shelf"]', paths[1]);
  await wait(
    async () => (await invoke(tray, "shelf_list")).length === 2,
    "owned tray drop added to Shelf",
  );
  await dropOn(`[data-drop-zone="pin:${pinIds[2]}"]`, paths[1]);
  const moved = await wait(async () => {
    const rows = await invoke(tray, "files_history");
    return (
      rows.find((row) =>
        row.entries.some((entry) => entry.source.path === paths[1] && entry.output),
      ) ?? null
    );
  }, "owned tray drop-to-pin move");
  results.nativeDrops = await tray.evaluate(() => globalThis.__OWNED_TRAY_DROPS__);
  assert.equal(results.nativeDrops.length, 2);
  assert.equal(results.nativeDrops[0].zone, "shelf");
  assert.equal(results.nativeDrops[1].zone, `pin:${pinIds[2]}`);
  assert.equal(moved.error, null);
  assert.equal(hash(await readFile(moved.entries[0].output)), sourceHash);
  await tray.locator(".files-history > summary").evaluate((node) => node.click());
  await tray
    .locator(".files-history")
    .getByRole("button", { name: "Undo", exact: true })
    .evaluate((node) => node.click());
  await wait(async () => {
    try {
      return hash(await readFile(paths[1])) === sourceHash;
    } catch {
      return false;
    }
  }, "owned tray Undo restored original bytes");
  const historyCount = (await invoke(tray, "files_history")).length;
  await tab(tray, "Nab");
  await tab(tray, "Files");
  assert.equal(
    (await invoke(tray, "files_history")).length,
    historyCount,
    "tab remount must not replay the consumed pin drop",
  );
  results.dropAndUndo = {
    moved,
    sourceSha256: sourceHash,
    restoredSha256: hash(await readFile(paths[1])),
    historyCount,
  };
  results.beforeRestart = {
    settings: await invoke(tray, "get_settings"),
    menu: await menu(tray),
    window: results.settingsWindow,
  };
  assert.notEqual(results.settingsWindow.foregroundProcessId, child.pid);
  await stop();
  tray = await start();
  results.afterRestart = { settings: await invoke(tray, "get_settings"), menu: await menu(tray) };
  assert.equal(results.afterRestart.settings.lastTab, "files");
  assert.equal(results.afterRestart.settings.pauseClipboardCapture, false);
  assert.equal(
    results.afterRestart.menu.entries
      .find((entry) => entry.id === "pins")
      .children.filter((entry) => entry.id.startsWith("pin:")).length,
    8,
  );
  checks.push(
    "Real native menu tree, radio/checkbox settings, live 1–9 pin identity/availability/order/removal, owned pin launch, all four persisted tabs, native settings page intents and restart passed; no system clipboard/global input or shell launch.",
  );
  passed = true;
} catch (error) {
  failure = { message: error.message ?? String(error), stack: error.stack };
  const tray = browser && pages().find((page) =>
    page.url().includes("tauri.localhost") &&
    !page.url().includes("island.html") &&
    !page.url().includes("settings.html"),
  );
  if (tray) {
    results.failureDom = await tray.evaluate(() => ({
      text: globalThis.document.body.innerText,
      drops: globalThis.__OWNED_TRAY_DROPS__ ?? [],
    })).catch((reason) => ({ error: String(reason) }));
    results.failureHistory = await invoke(tray, "files_history").catch((reason) => ({ error: String(reason) }));
  }
  throw error;
} finally {
  await stop();
  await writeFile(
    output,
    JSON.stringify(
      {
        passed,
        failure,
        checks,
        captures,
        results,
        executableSha256: hash(await readFile(exe)),
        buildManifestSha256: hash(await readFile(resolve(root, "dist/.vite/manifest.json"))),
        renderingFlags: deterministicRenderingFlags,
        noUserProfile: true,
        noRealClipboardOrGlobalInput: true,
        noShellOrGlobalShortcutRegistration: true,
        noOsSettingChange: true,
        scope:
          "Owned release executable, data/control/WebView fixtures and process-filtered native HWND queries. DOM-only input and per-WebView DPR emulation. Owned HWND drop targets register/unregister; no real clipboard/cursor/global keys, external accounts, shell/autostart/global-hotkey registration, installer or OS setting changes.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(folder, `${prefix}-scene-log.txt`), logs, { flag: "wx" });
}
