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
  prefix = process.argv[2] ?? "v62-native-a";
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
async function settingsPage() {
  const page = await wait(
    () => pages().find((page) => page.url().includes("settings.html")),
    "settings WebView",
  );
  await page.getByRole("heading", { name: "General", level: 1, exact: true }).waitFor();
  await page.waitForFunction(() => !!globalThis.document.documentElement.dataset.settingsBackdrop);
  await page.emulateMedia({ reducedMotion: "reduce" });
  return page;
}
async function capture(page, name) {
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready;
    await Promise.all([...globalThis.document.images].map((image) => image.decode()));
    globalThis.document.activeElement?.blur();
  });
  const staticAssets = await page.locator("[data-settings-asset]").evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return {
        file: node.dataset.settingsAsset,
        naturalWidth: node.naturalWidth,
        naturalHeight: node.naturalHeight,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      };
    }),
  );
  assert(staticAssets.length > 0);
  for (const asset of staticAssets) {
    assert(asset.naturalWidth > 0 && asset.naturalHeight > 0);
    assert.equal(asset.width, asset.naturalWidth, `Original asset width: ${asset.file}`);
    assert.equal(asset.height, asset.naturalHeight, `Original asset height: ${asset.file}`);
  }
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 980,
    height: 720,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.evaluate(async () => {
    await new Promise(globalThis.requestAnimationFrame);
    await new Promise(globalThis.requestAnimationFrame);
    await Promise.all(
      globalThis.document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  // Let the mode's native window/tray composition commit before measuring its
  // renderer. This is a fixed settling interval, never a retry-until-match.
  await setTimeout(100);
  const paintState = await page.evaluate(() => ({
    theme: globalThis.document.documentElement.dataset.theme,
    reducedMotion: globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches,
    animations: globalThis.document
      .getAnimations()
      .map((animation) => ({ state: animation.playState, timing: animation.effect?.getTiming() })),
  }));
  const shot = async () =>
    Buffer.from(
      (
        await session.send("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
          clip: { x: 0, y: 0, width: 980, height: 720, scale: 1 },
        })
      ).data,
      "base64",
    );
  const bytes = await shot();
  await setTimeout(100);
  const repeated = await shot();
  if (hash(bytes) !== hash(repeated)) {
    await writeFile(resolve(folder, `${prefix}-${name}-failed-first.png`), bytes, { flag: "wx" });
    await writeFile(resolve(folder, `${prefix}-${name}-failed-repeat.png`), repeated, {
      flag: "wx",
    });
    results.captureFailure = { name, paintState };
  }
  assert.equal(hash(bytes), hash(repeated), `Native repeat: ${name}`);
  assert(bytes.length <= 300000);
  const file = `${prefix}-${name}@2x.png`;
  await writeFile(resolve(folder, file), bytes, { flag: "wx" });
  captures.push({
    file,
    sha256: hash(bytes),
    bytes: bytes.length,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    repeatMatches: true,
    staticAssets,
    paintState,
    scope: "Owned WebView pixels; DWM material independently queried on its HWND",
  });
  await session.detach();
}
const urls = [
  "https://example.test/mode-a",
  "https://example.test/mode-b",
  "https://example.test/mode-c",
  "https://example.test/mode-d",
];
const downloadsFolder = resolve(trial, "profile", "owned-downloads");
let held = urls.slice(0, 2);
async function downloadFixture() {
  await writeFile(
    env.NABBIT_ACCEPTANCE_DOWNLOAD_FIXTURE,
    JSON.stringify({
      holdAt62: held,
      metadata: Object.fromEntries(
        urls.map((url, index) => [
          url,
          {
            url,
            normalizedUrl: url,
            title: `Owned <download ${index + 1}> & fixture`,
            channel: null,
            duration: 12,
            thumbnail: null,
            isPlaylist: false,
            playlistCount: null,
            extractor: "acceptance",
            qualities: [],
            details: null,
            livePending: false,
          },
        ]),
      ),
    }),
  );
}
async function downloadRequest(operation) {
  const id = randomUUID(),
    path = resolve(control, "downloads-request.json");
  await writeFile(`${path}.pending`, JSON.stringify({ id, operation }));
  await rename(`${path}.pending`, path);
  return wait(async () => {
    try {
      const result = JSON.parse(
        await readFile(resolve(control, "downloads-response.json"), "utf8"),
      );
      if (result.id !== id) return null;
      assert.equal(result.error, null);
      return result;
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }, "owned download control");
}
function ownedWindows() {
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        resolve(root, "scripts/read-owned-windows.ps1"),
        "-OwnedProcessId",
        String(child.pid),
      ],
      { windowsHide: true, encoding: "utf8", timeout: 15000 },
    ),
  );
}
async function settled(page) {
  return wait(async () => {
    const snapshot = await invoke(page, "get_mode_snapshot");
    assert.equal(snapshot.trayError, null);
    return snapshot.applied?.revision === snapshot.revision ? snapshot : null;
  }, "applied native tray presentation");
}
async function choose(page, mode, label) {
  await page
    .getByRole("group", { name: "Where Nabbit lives", exact: true })
    .getByRole("button", { name: new RegExp(`^${label.replace("+", "\\+")}`) })
    .click();
  await page.locator('.settings-window[aria-busy="false"]').waitFor();
  const snapshot = await wait(async () => {
    const value = await settled(page);
    return value.desired.mode === mode ? value : null;
  }, `mode ${mode}`);
  assert.equal((await invoke(page, "get_settings")).displayMode, mode);
  assert.deepEqual(
    snapshot.applied.checked,
    ["islandAndTray", "trayOnly", "islandOnly"].map((value) => value === mode),
  );
  await wait(async () => {
    const state = await invoke(page, "get_island_snapshot");
    assert.equal(state.lastError, null);
    results.lastLifecycle = {
      mode,
      snapshot: state,
      islandViews: pages()
        .filter((page) => page.url().includes("island.html"))
        .map((page) => page.url()),
    };
    return mode === "trayOnly"
      ? state.hosts.length === 0 &&
          Object.keys(state.surfaces).length === 0 &&
          results.lastLifecycle.islandViews.length === 0
      : state.hosts.length > 0;
  }, "mode island lifecycle");
  return snapshot;
}
async function iconMatrix(page, name) {
  const records = [];
  for (const light of [true, false])
    for (const size of [16, 24]) {
      await invoke(page, "mode_fixture", { action: { kind: "theme", light, size } });
      const snapshot = await settled(page),
        icon = snapshot.applied;
      assert.equal(icon.width, size);
      assert.equal(icon.height, size);
      assert.equal(icon.theme, light ? "light" : "dark");
      assert.equal(hash(Buffer.from(icon.rgbaBase64, "base64")), icon.rgbaSha256);
      const png = await page.evaluate(({ rgbaBase64, width, height }) => {
        const canvas = globalThis.document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const pixels = Uint8ClampedArray.from(globalThis.atob(rgbaBase64), (char) =>
          char.charCodeAt(0),
        );
        canvas.getContext("2d").putImageData(new globalThis.ImageData(pixels, width, height), 0, 0);
        return canvas.toDataURL("image/png").split(",")[1];
      }, icon);
      const bytes = Buffer.from(png, "base64"),
        file = `${prefix}-tray-${name}-${light ? "light" : "dark"}@${size === 16 ? 1 : 1.5}x.png`;
      assert(bytes.length <= 300000);
      await writeFile(resolve(folder, file), bytes, { flag: "wx" });
      records.push({
        file,
        bytes: bytes.length,
        sha256: hash(bytes),
        icon,
        scope:
          "Exact RGBA passed to the owned native tray, exported through an offscreen canvas; 16/24px DPI seam, no Windows display change",
      });
    }
  return records;
}
try {
  await downloadFixture();
  let tray = await start();
  await invoke(tray, "acknowledge_first_run");
  await invoke(tray, "patch_settings", {
    change: { outputDir: downloadsFolder, maxConcurrentDownloads: 1 },
  });
  await invoke(tray, "open_settings_window");
  let settings = await settingsPage();
  results.window = nativeWindow();
  assert.notEqual(results.window.foregroundProcessId, child.pid);
  results.webViewVersion = browser.version();
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
  results.assets = await settings.evaluate(
    async (files) =>
      Promise.all(
        files.map(async (file) => {
          const response = await globalThis.fetch(`/${file}`),
            bytes = await response.arrayBuffer();
          return {
            file,
            ok: response.ok,
            sha256: [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join(""),
          };
        }),
      ),
    files,
  );
  for (const asset of results.assets) {
    assert(asset.ok);
    assert.equal(asset.sha256, hash(await readFile(resolve(root, "dist", asset.file))), asset.file);
  }
  results.modes = [];
  for (const theme of ["light", "dark"]) {
    await invoke(settings, "patch_settings", { change: { theme } });
    await settings.waitForFunction(
      (theme) => globalThis.document.documentElement.dataset.theme === theme,
      theme,
    );
    for (const [mode, label] of [
      ["islandAndTray", "Island + tray"],
      ["trayOnly", "Tray only"],
      ["islandOnly", "Island only"],
    ]) {
      const snapshot = await choose(settings, mode, label);
      await capture(
        settings,
        `${mode.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-${theme}`,
      );
      results.modes.push({ theme, snapshot, windows: ownedWindows() });
    }
  }
  checks.push(
    "All three real General mode controls apply and render in both themes; actual tray menu checkmarks follow settings, native HWND visibility is observed, and every embedded manifest asset matches the current frontend build.",
  );
  await invoke(settings, "mode_fixture", { action: { kind: "menu", id: "mode-both" } });
  await settled(settings);
  await invoke(settings, "mode_fixture", { action: { kind: "menu", id: "mode-both" } });
  results.reselectedModeMenu = await settled(settings);
  assert.deepEqual(results.reselectedModeMenu.applied.checked, [true, false, false]);
  const host = (await invoke(settings, "get_island_snapshot")).hosts[0];
  await island({ surface: { label: host.placement.label, state: "expanded" } });
  await wait(
    async () =>
      Object.keys((await invoke(settings, "get_island_snapshot")).surfaces).length === 1 &&
      pages().filter((page) => page.url().includes("island.html")).length === 1,
    "owned expanded island",
  );
  await choose(settings, "trayOnly", "Tray only");
  results.trayOnlyWindows = ownedWindows();
  assert(
    !results.trayOnlyWindows.windows.some((window) => window.className === "NabbitIslandHost"),
  );
  const before = (await invoke(settings, "get_island_snapshot")).inputWatcher;
  await setTimeout(900);
  const after = (await invoke(settings, "get_island_snapshot")).inputWatcher;
  assert.equal(after.cursorSamples, before.cursorSamples);
  assert.equal(after.systemSamples, before.systemSamples);
  checks.push(
    "Tray only destroys an already expanded island WebView and its native host; owned Win32 enumeration finds no island host and its adaptive worker stops sampling.",
  );
  results.shortcutBefore = ownedWindows();
  await island({ shortcut: "Alt+Space" });
  await wait(
    () => ownedWindows().windows.some((window) => window.title === "Nabbit" && window.visible),
    "tray-only shortcut opens popover",
  );
  results.shortcutOpen = ownedWindows();
  assert.notEqual(results.shortcutOpen.foregroundProcessId, child.pid);
  await island({ shortcut: "Alt+Space" });
  await wait(
    () =>
      ownedWindows()
        .windows.filter((window) => window.title === "Nabbit")
        .every((window) => !window.visible),
    "tray-only shortcut closes popover",
  );
  checks.push(
    "Injected Alt+Space toggles the owned tray popover in tray-only mode without registering or pressing a global shortcut and without taking foreground focus.",
  );
  const first = await invoke(settings, "start_download", { request: { url: urls[0] } }),
    second = await invoke(settings, "start_download", { request: { url: urls[1] } });
  await wait(async () => {
    const snapshot = await settled(settings);
    results.lastDownloadWait = { snapshot, jobs: await invoke(settings, "list_downloads") };
    return (
      snapshot.desired.badge.kind === "progress" &&
      snapshot.desired.badge.percent === 62 &&
      snapshot.desired.queued === 1
    );
  }, "real fake-runner progress and queue badge");
  results.progressIcons = await iconMatrix(settings, "progress-62");
  await invoke(settings, "pause_download", { id: first.id });
  await wait(async () => {
    const jobs = await invoke(settings, "list_downloads");
    return jobs.find((job) => job.id === second.id)?.progress === 62;
  }, "second owned download running");
  await invoke(settings, "pause_download", { id: second.id });
  await wait(async () => (await settled(settings)).desired.badge.kind === "paused", "paused badge");
  results.pausedIcons = await iconMatrix(settings, "paused");
  await invoke(settings, "cancel_download", { id: second.id });
  held = [];
  await downloadFixture();
  await invoke(settings, "resume_download", { id: first.id });
  await wait(async () => {
    const snapshot = await settled(settings);
    assert.equal(snapshot.notificationError, null);
    return snapshot.notifications.length === 1 && snapshot.desired.badge.kind === "none";
  }, "one real completion routed to WinRT validation");
  results.completed = await settled(settings);
  assert.equal(results.completed.notifications[0].completion.jobId, first.id);
  assert(results.completed.notifications[0].xml.includes("Owned &lt;download 1&gt; &amp; fixture"));
  assert.equal(results.completed.notifications[0].error, null);
  results.idleIcons = await iconMatrix(settings, "idle");
  checks.push(
    "Real queued/running/paused/cancelled/resumed fake downloads drive native progress, pause and idle icons. Both taskbar themes and 16/24px seams preserve exact icon RGBA. Completion reaches the real WinRT XML/notification constructor once; no system toast is shown.",
  );
  const jobsBefore = (await invoke(settings, "list_downloads")).map((job) => job.id).sort();
  const capturedBefore = await invoke(settings, "get_captured_link");
  await downloadRequest({ kind: "deepLink", uri: "nabbit://downloads" });
  const jobsAfter = (await invoke(settings, "list_downloads")).map((job) => job.id).sort();
  const capturedAfter = await invoke(settings, "get_captured_link");
  assert.deepEqual(jobsAfter, jobsBefore);
  assert.deepEqual(capturedAfter, capturedBefore);
  results.activation = {
    uri: "nabbit://downloads",
    jobsBefore,
    jobsAfter,
    capturedBefore,
    capturedAfter,
  };
  assert.equal((await invoke(settings, "get_settings")).lastTab, "download");
  await invoke(settings, "hide_main_window");
  for (const [mode, label, url] of [
    ["islandAndTray", "Island + tray", urls[2]],
    ["islandOnly", "Island only", urls[3]],
  ]) {
    await choose(settings, mode, label);
    const job = await invoke(settings, "start_download", { request: { url } });
    await wait(
      async () =>
        (await invoke(settings, "list_downloads")).find((row) => row.id === job.id)?.status ===
        "completed",
      `completion in ${mode}`,
    );
    assert.equal((await settled(settings)).notifications.length, 1);
  }
  checks.push(
    "Notification activation opens Downloads without adding or probing a job. Completions in island+tray and island-only modes retain the island flow and do not create duplicate Windows notifications.",
  );
  await stop();
  tray = await start();
  const restarted = await settled(tray);
  assert.equal(restarted.desired.mode, "islandOnly");
  assert.equal(restarted.applied.presentation.visible, false);
  assert.equal(restarted.notifications.length, 0);
  results.restart = restarted;
  await invoke(tray, "open_settings_window");
  settings = await settingsPage();
  await invoke(settings, "mode_fixture", { action: { kind: "menu", id: "mode-tray" } });
  await settled(settings);
  assert.equal((await invoke(settings, "get_settings")).displayMode, "trayOnly");
  await stop();
  tray = await start();
  results.restartTrayOnly = await settled(tray);
  assert.equal(results.restartTrayOnly.desired.mode, "trayOnly");
  assert.equal(results.restartTrayOnly.applied.presentation.visible, true);
  assert.equal(results.restartTrayOnly.notifications.length, 0);
  const trayRestartIsland = await invoke(tray, "get_island_snapshot");
  assert.equal(trayRestartIsland.hosts.length, 0);
  assert.equal(Object.keys(trayRestartIsland.surfaces).length, 0);
  assert.equal(pages().filter((page) => page.url().includes("island.html")).length, 0);
  results.restartTrayOnlyWindows = ownedWindows();
  assert(
    !results.restartTrayOnlyWindows.windows.some(
      (window) => window.className === "NabbitIslandHost",
    ),
  );
  await invoke(tray, "open_settings_window");
  settings = await settingsPage();
  await invoke(settings, "mode_fixture", { action: { kind: "menu", id: "mode-island" } });
  await settled(settings);
  assert.equal((await invoke(settings, "get_settings")).displayMode, "islandOnly");
  await wait(
    async () => (await invoke(settings, "get_island_snapshot")).hosts.length > 0,
    "menu restores native island host",
  );
  const noTray = await island({ prepareTray: false }),
    label = noTray.snapshot.hosts[0].placement.label;
  const closed = settings.waitForEvent("close");
  await settings
    .getByRole("button", { name: "Close settings", exact: true })
    .evaluate((node) => node.click());
  await closed;
  await island({ shortcut: "Alt+Space" });
  await wait(async () => {
    const state = await island({});
    return state.snapshot.webviews > 0;
  }, "island-only view allocation");
  await browser.close();
  await wait(async () => {
    try {
      return (await globalThis.fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {
      return false;
    }
  }, "current owned WebView endpoint");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const islandPage = await wait(
    () => pages().find((page) => page.url().includes("island.html")),
    "island-only WebView",
  );
  results.islandOnlyShortcut = { windows: ownedWindows(), label };
  assert.notEqual(results.islandOnlyShortcut.windows.foregroundProcessId, child.pid);
  await islandPage
    .getByRole("button", { name: "Settings", exact: true })
    .evaluate((node) => node.click());
  settings = await settingsPage();
  results.islandOnlyGear = await settled(settings);
  assert.equal(results.islandOnlyGear.desired.mode, "islandOnly");
  await invoke(settings, "mode_fixture", { action: { kind: "reapply" } });
  const reapply = await settled(settings);
  assert.equal(reapply.applied.presentation.visible, false);
  assert.deepEqual(reapply.applied.checked, [false, false, true]);
  results.reapply = reapply;
  checks.push(
    "Both tray-only and island-only survive process restart with silent completed history; every tray-menu mode handler persists the mode. Injected Alt+Space opens the actual island-only view without a tray WebView or foreground focus, its gear opens settings, and reapplication retains the hidden tray and checked menu.",
  );
  passed = true;
} catch (error) {
  failure = { message: error.message ?? String(error), stack: error.stack };
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
          "Owned executable, app-data/WebView/control profiles and HWND queries; DOM-only input and per-WebView DPR emulation. Owned HWND drop targets may register/unregister; no real clipboard/cursor/global keys, hosted Tack/account, shell/autostart/global-shortcut/notification registration, dialogs, Store, signing or installer execution.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(folder, `${prefix}-scene-log.txt`), logs, { flag: "wx" });
}
