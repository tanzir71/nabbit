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
  prefix = process.argv[2] ?? "v64-native-a";
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
  NABBIT_ACCEPTANCE_SHORTCUT_CONFLICTS: JSON.stringify(["Ctrl+Alt+H"]),
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
    width: 980,
    height: 720,
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
  const assets = await page
    .locator("img[data-settings-asset],img[data-asset],img.island-asset")
    .evaluateAll((images) =>
      images.map((image) => {
        const box = image.getBoundingClientRect();
        return {
          file: image.dataset.settingsAsset || image.dataset.asset || image.dataset.assetSlot,
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
    clip: { x: 0, y: 0, width: 980, height: 720, scale: 1 },
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
  assert.equal(first.readUInt32BE(16), 1960);
  assert.equal(first.readUInt32BE(20), 1440);
  const file = `${prefix}-${name}@2x.png`;
  await writeFile(resolve(folder, file), first, { flag: "wx" });
  captures.push({
    file,
    sha256: hash(first),
    bytes: first.length,
    width: 1960,
    height: 1440,
    assets,
    repeatSha256: hash(repeat),
  });
}

const problems = [];
const conflicts = ["Ctrl+Alt+H", "Ctrl+Alt+F10"];
async function snapshot(page) {
  const value = await invoke(page, "shortcuts_snapshot");
  assert.equal(value.injected, true);
  assert.equal(value.cleanupError, null);
  assert.equal(value.rows.length, 8);
  return value;
}
const row = (value, id) => value.rows.find((row) => row.id === id);
async function openSettings(tray) {
  await invoke(tray, "open_settings_window");
  const settings = await settingsPage("General");
  settings.on("pageerror", (error) => problems.push(error.message));
  await settings
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Shortcuts", exact: true })
    .evaluate((node) => node.click());
  await settings.getByRole("heading", { name: "Shortcuts", exact: true, level: 1 }).waitFor();
  return settings;
}
async function editor(settings, title, chord) {
  await settings
    .getByRole("button", { name: `Change ${title}`, exact: true })
    .evaluate((node) => node.click());
  const field = settings.getByRole("textbox", { name: "Shortcut combination", exact: true });
  await field.and(settings.locator(":enabled")).waitFor();
  if (chord) await field.press(chord);
  return field;
}
async function save(settings) {
  await settings
    .getByRole("button", { name: "Save shortcut", exact: true })
    .evaluate((node) => node.click());
  await settings
    .getByRole("textbox", { name: "Shortcut combination", exact: true })
    .waitFor({ state: "detached" });
}
async function captureThemes(settings, name) {
  for (const theme of ["light", "dark"]) {
    await invoke(settings, "patch_settings", { change: { theme } });
    await settings.waitForFunction(
      (theme) => globalThis.document.documentElement.dataset.theme === theme,
      theme,
    );
    await capture(settings, `${name}-${theme}`);
  }
}
async function routes(settings, key) {
  await settings.evaluate(() => {
    globalThis.__OWNED_SHORTCUT_ROUTES__ = [];
  });
  await invoke(settings, "shortcuts_fixture", { conflicts, key });
  return wait(
    () => settings.evaluate(() => globalThis.__OWNED_SHORTCUT_ROUTES__[0] ?? null),
    "owned shortcut route event",
  );
}
try {
  let tray = await start();
  tray.on("pageerror", (error) => problems.push(error.message));
  await invoke(tray, "acknowledge_first_run");
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
          const response = await globalThis.fetch(`/${file}`);
          const bytes = await response.arrayBuffer();
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
    const bytes = await readFile(resolve(root, "dist", asset.file));
    assert(asset.ok);
    assert.equal(asset.bytes, bytes.length);
    assert.equal(asset.sha256, hash(bytes));
  }
  let settings = await openSettings(tray);
  results.initial = await snapshot(settings);
  assert(row(results.initial, "hideIsland").problem.conflict);
  assert.equal(row(results.initial, "hideIsland").activeShortcut, null);
  assert.equal(results.initial.rows.filter((row) => row.activeShortcut).length, 7);
  await captureThemes(settings, "conflict");
  await settings.evaluate(async () => {
    globalThis.__OWNED_SHORTCUT_ROUTES__ = [];
    const handler = globalThis.__TAURI_INTERNALS__.transformCallback((event) =>
      globalThis.__OWNED_SHORTCUT_ROUTES__.push(event.payload),
    );
    await globalThis.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
      event: "shortcuts:fixture-route",
      target: { kind: "Any" },
      handler,
    });
  });
  const field = await editor(settings, "Open or close the island", "Control+Alt+F9");
  results.recording = await snapshot(settings);
  assert.equal(results.recording.recording, true);
  assert.equal(
    (await invoke(settings, "get_settings")).islandShortcut,
    "Alt+Space",
    "Recording must not save",
  );
  results.intercepted = await routes(settings, "Ctrl+Alt+N");
  assert.equal(results.intercepted.captured, true);
  assert.equal(results.intercepted.action, null);
  await wait(
    async () => /keyn$/i.test(await field.inputValue()),
    "native registered-key recorder delivery",
  );
  await field.press("Control+Alt+F9");
  await captureThemes(settings, "recording");
  await save(settings);
  assert.equal((await invoke(settings, "get_settings")).islandShortcut, "Ctrl+Alt+F9");
  await wait(
    async () => !(await snapshot(settings)).recording,
    "recorder session released after save",
  );
  const rejected = await editor(settings, "Download link on clipboard", "Control+Alt+F10");
  await settings
    .getByRole("button", { name: "Save shortcut", exact: true })
    .evaluate((node) => node.click());
  await rejected.and(settings.locator('[aria-invalid="true"]')).waitFor();
  results.rejected = await snapshot(settings);
  assert(row(results.rejected, "download").problem.conflict);
  assert.equal((await invoke(settings, "get_settings")).quickDownloadShortcut, "Ctrl+Alt+D");
  assert(/keyd$/i.test(row(results.rejected, "download").activeShortcut));
  await captureThemes(settings, "error");
  await rejected.press("Escape");
  await editor(settings, "Download link on clipboard", "Control+Alt+F8");
  await save(settings);
  await editor(settings, "Quick note");
  await settings
    .getByRole("button", { name: "Disable", exact: true })
    .evaluate((node) => node.click());
  await save(settings);
  await captureThemes(settings, "disabled");
  results.routes = [];
  for (const [key, expected] of [
    ["Ctrl+Alt+D", null],
    ["Ctrl+Alt+F8", "download"],
    ["Ctrl+Alt+F9", "island"],
    ["Ctrl+Alt+N", null],
    ["Ctrl+Alt+T", "timer"],
    ["Ctrl+Alt+S", "selection"],
    ["Ctrl+Shift+V", "toggleTray"],
  ]) {
    const receipt = await routes(settings, key);
    assert.equal(receipt.captured, false);
    assert.equal(receipt.action, expected);
    assert.equal(receipt.injected, true);
    results.routes.push(receipt);
  }
  await assert.rejects(() =>
    invoke(settings, "patch_settings", { change: { clipboardSearchShortcut: "Alt+Ctrl+F8" } }),
  );
  assert.equal((await invoke(settings, "get_settings")).clipboardSearchShortcut, "Ctrl+Alt+V");
  const host = (await invoke(settings, "get_island_snapshot")).hosts[0];
  assert(host, "The owned island host must exist");
  await island({ surface: { label: host.placement.label, state: "expanded" } });
  const islandPage = await wait(
    () => pages().find((page) => page.url().includes("island.html")),
    "owned island caller boundary",
  );
  await islandPage.waitForFunction(() => !!globalThis.__TAURI_INTERNALS__);
  await assert.rejects(
    () => invoke(islandPage, "shortcuts_snapshot"),
    (error) => String(error).includes("Open settings to manage shortcuts"),
  );
  results.settingsWindow = nativeWindow();
  assert.notEqual(results.settingsWindow.foregroundProcessId, child.pid);
  results.beforeRestart = {
    settings: await invoke(settings, "get_settings"),
    shortcuts: await snapshot(settings),
  };
  await stop();
  tray = await start();
  settings = await openSettings(tray);
  results.afterRestart = {
    settings: await invoke(settings, "get_settings"),
    shortcuts: await snapshot(settings),
  };
  for (const key of [
    "islandShortcut",
    "quickNoteShortcut",
    "quickDownloadShortcut",
    "clipboardSearchShortcut",
    "focusTimerShortcut",
    "hideIslandShortcut",
    "selectedTextShortcut",
    "togglePopoverShortcut",
  ])
    assert.equal(results.afterRestart.settings[key], results.beforeRestart.settings[key], key);
  assert.equal(results.afterRestart.settings.quickNoteShortcut, "");
  assert.equal(row(results.afterRestart.shortcuts, "quickNote").activeShortcut, null);
  assert.equal(results.afterRestart.shortcuts.recording, false);
  assert(row(results.afterRestart.shortcuts, "hideIsland").problem.conflict);
  assert.deepEqual(problems, []);
  checks.push(
    "Owned native settings recorder, injected registration conflict, registered-key delivery, explicit save/disable, old-key preservation, stale/current routing, duplicate aliases, caller restriction, exact asset embedding and restart passed.",
  );
  passed = true;
} catch (error) {
  failure = { message: error.message ?? String(error), stack: error.stack };
  const settings = browser && pages().find((page) => page.url().includes("settings.html"));
  if (settings)
    results.failureDom = await settings
      .evaluate(() => globalThis.document.body.innerText)
      .catch(String);
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
        problems,
        executableSha256: hash(await readFile(exe)),
        buildManifestSha256: hash(await readFile(resolve(root, "dist/.vite/manifest.json"))),
        renderingFlags: deterministicRenderingFlags,
        noRealClipboardOrGlobalInput: true,
        noGlobalShortcutOrShellRegistration: true,
        scope:
          "Owned release app/WebViews/data and DOM input. Registration/focus outcomes injected through the production transaction and recorder delivery paths. No global hotkeys, real clipboard/cursor/global input, external profiles/accounts, shell/autostart/notification registration, installer execution/signing or OS settings.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(folder, `${prefix}-scene-log.txt`), logs, { flag: "wx" });
}
