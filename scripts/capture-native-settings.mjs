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
  prefix = process.argv[2] ?? "v61-native-a";
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
  });
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
  assert.equal(hash(bytes), hash(await shot()), `Native repeat: ${name}`);
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
    scope: "Owned WebView pixels; DWM material independently queried on its HWND",
  });
  await session.detach();
}
try {
  let tray = await start();
  results.webViewVersion = browser.version();
  await invoke(tray, "acknowledge_first_run");
  await tray
    .getByRole("button", { name: "Settings", exact: true })
    .evaluate((node) => node.click());
  let settings = await settingsPage();
  results.window = nativeWindow();
  const style = results.window;
  assert(style.visible);
  assert((style.style & 0xc00000) === 0xc00000);
  assert((style.style & 0x40000) !== 0);
  assert((style.exStyle & 0x80) === 0);
  assert((style.exStyle & 8) === 0);
  assert.notEqual(style.foregroundProcessId, child.pid);
  const scale = style.dpi / 96;
  assert(style.minimumWidth >= 820 * scale);
  assert(style.minimumHeight >= 600 * scale);
  results.appearance = await invoke(settings, "settings_window_ready");
  if (style.osBuild >= 22000)
    assert.equal(results.appearance.mica, true, "Windows 11 settings must use Mica");
  await Promise.all([invoke(tray, "open_settings_window"), invoke(tray, "open_settings_window")]);
  assert.equal(pages().filter((page) => page.url().includes("settings.html")).length, 1);
  assert.equal(nativeWindow().hwnd, style.hwnd);
  checks.push(
    "Tray gear opens one decorated, resizable, non-topmost taskbar settings window; repeated/concurrent opens reuse it; native min-track size is at least 820x600 at its own DPI; acceptance did not take focus; Windows 11 Mica is read on the owned HWND.",
  );
  const manifest = JSON.parse(await readFile(resolve(root, "dist/.vite/manifest.json"), "utf8")),
    files = [
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
              .map((b) => b.toString(16).padStart(2, "0"))
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
  assert.deepEqual(
    await invoke(settings, "third_party_licenses"),
    JSON.parse(await readFile(resolve(root, "third-party/notices.json"), "utf8")),
  );
  const before = await invoke(settings, "get_settings");
  await Promise.all([
    invoke(settings, "patch_settings", { change: { retentionDays: 90 } }),
    invoke(tray, "patch_settings", { change: { outputDir: resolve(trial, "Owned downloads") } }),
  ]);
  const merged = await invoke(settings, "get_settings");
  assert.equal(merged.retentionDays, 90);
  assert.equal(merged.outputDir, resolve(trial, "Owned downloads"));
  assert.equal(merged.quickDownloadShortcut, before.quickDownloadShortcut);
  checks.push(
    "Every embedded manifest asset and offline notice matches the current build; independent native patches from tray and settings retain both changes and existing shortcuts.",
  );
  results.sectionWalk = [];
  for (const title of ["Widgets", "Downloads", "Notes & Tack", "Clipboard", "Files", "Privacy & about"]) {
    await settings
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: title, exact: true })
      .click();
    await settings.getByRole("heading", { name: title, level: 1, exact: true }).waitFor();
    if (title === "Notes & Tack")
      await settings.getByRole("button", { name: "Import bookmarks", exact: true }).waitFor();
    if (title === "Files") {
      const ownedPin = resolve(trial, "profile", "owned-settings-pin");
      await mkdir(ownedPin);
      assert.deepEqual(await invoke(settings, "files_pins"), []);
      assert.deepEqual(await invoke(settings, "files_capabilities"), {
        folders: [], terminal: false, code: false,
      });
      await settings.getByRole("button", { name: "Add pin…", exact: true }).click();
      const editor = settings.getByRole("form", { name: "Add pin", exact: true });
      await editor.getByLabel("File or folder path", { exact: true }).fill(ownedPin);
      await editor.getByLabel("Name", { exact: true }).fill("Owned settings pin");
      await editor.getByRole("button", { name: "Save pin", exact: true }).click();
      await wait(async () => (await invoke(settings, "files_pins")).length === 1, "settings pin saved");
      await settings
        .getByRole("list", { name: "Pinned files and folders", exact: true })
        .getByText("Owned settings pin", { exact: true })
        .waitFor();
      const [pin] = await invoke(settings, "files_pins");
      assert.equal(pin.label, "Owned settings pin");
      assert.equal(pin.available, true);
      await invoke(settings, "files_remove_pin", { id: pin.id });
      await wait(async () => (await invoke(settings, "files_pins")).length === 0, "settings pin removed");
      results.pinManagement = { savedThroughEditor: true, ownedFolderOnly: true, removed: true };
      await settings.getByRole("button", { name: "Save file presets", exact: true }).waitFor();
    }
    if (title === "Privacy & about")
      await settings.getByText("MIT licence", { exact: false }).first().waitFor();
    assert.equal(await settings.getByRole("alert").count(), 0, `No native section errors: ${title}`);
    results.sectionWalk.push(title);
  }
  checks.push(
    "Every remaining settings section loads through real native IPC without an error; Files saves a pin through its editor to an owned temporary folder, reads it back and removes it without opening any picker or shell action.",
  );
  for (const theme of ["light", "dark"]) {
    await invoke(settings, "patch_settings", { change: { theme } });
    await settings.waitForFunction(
      (theme) => globalThis.document.documentElement.dataset.theme === theme,
      theme,
    );
    const appearance = nativeWindow();
    assert.equal(appearance.darkCaption, theme === "dark" ? 1 : 0);
    for (const [name, title] of [
      ["general", "General"],
      ["island", "Island"],
      ["activities", "Live activities"],
      ["shortcuts", "Shortcuts"],
    ]) {
      if (title === "Live activities") {
        await settings.getByRole("button", { name: "Live activities", exact: true }).click();
      } else
        await settings
          .getByRole("navigation", { name: "Settings sections" })
          .getByRole("button", { name: title, exact: true })
          .click();
      await settings.getByRole("heading", { name: title, level: 1, exact: true }).waitFor();
      await capture(settings, `${name}-${theme}`);
    }
  }
  await settings
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Island", exact: true })
    .click();
  await settings.getByRole("combobox", { name: "Peek on hover", exact: true }).selectOption("off");
  await wait(
    async () => (await invoke(settings, "get_settings")).island.peekOnHoverMs === null,
    "native hover off",
  );
  await settings
    .getByRole("switch", { name: "Scroll on the pill changes volume", exact: true })
    .click();
  await wait(
    async () =>
      (await invoke(settings, "get_island_snapshot")).preferences.scrollToChangeVolume === false,
    "native wheel preference",
  );
  const closed = settings.waitForEvent("close");
  await settings
    .getByRole("button", { name: "Close settings", exact: true })
    .evaluate((node) => node.click());
  await closed;
  await invoke(tray, "open_settings_window");
  settings = await settingsPage();
  results.reopenedWindow = nativeWindow();
  assert.equal(pages().filter((page) => page.url().includes("settings.html")).length, 1);
  assert.equal((await invoke(settings, "get_settings")).island.peekOnHoverMs, null);
  checks.push(
    "Real settings controls update the native island policy; close destroys the settings WebView and reopening creates a fresh window while preserving preferences; both native themes and four Figma pages have exact DPR-2 repeat captures.",
  );
  await stop();
  tray = await start();
  await invoke(tray, "open_settings_window");
  settings = await settingsPage();
  const restarted = await invoke(settings, "get_settings");
  assert.equal(restarted.retentionDays, 90);
  assert.equal(restarted.outputDir, resolve(trial, "Owned downloads"));
  assert.equal(restarted.theme, "dark");
  assert.equal(restarted.island.peekOnHoverMs, null);
  assert.equal(restarted.island.scrollToChangeVolume, false);
  assert.equal(restarted.quickDownloadShortcut, before.quickDownloadShortcut);
  results.restarted = restarted;
  checks.push(
    "An owned process restart preserves all changed fields, shape/behaviour preferences and original shortcut settings in the same SQLite file.",
  );
  const noTray = await island({ prepareTray: false });
  const label = noTray.snapshot.hosts[0].placement.label;
  const lastClosed = settings.waitForEvent("close");
  await settings
    .getByRole("button", { name: "Close settings", exact: true })
    .evaluate((node) => node.click());
  await lastClosed;
  await wait(
    () => pages().filter((page) => page.url().includes("tauri.localhost")).length === 0,
    "no remaining Tauri WebViews",
  );
  const background = await island({});
  assert.equal(background.snapshot.webviews, 0);
  results.afterLastClose = {
    observerConnected: browser.isConnected(),
    native: background.snapshot,
  };
  await island({ surface: { label, state: "expanded" } });
  await wait(async () => {
    const state = await island({});
    results.afterIslandOpen = state.snapshot;
    assert.equal(state.snapshot.lastError, null);
    return state.snapshot.webviews > 0;
  }, "native island WebView allocation");
  // WebView2 can retire its browser process when its last view closes. Attach
  // to the current endpoint rather than observing the previous empty process.
  await wait(async () => {
    try {
      return (await globalThis.fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {
      return false;
    }
  }, "new WebView2 endpoint");
  await browser.close();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const islandPage = await wait(
    () => pages().find((page) => page.url().includes("island.html")),
    "island WebView",
  );
  await assert.rejects(
    () => invoke(islandPage, "settings_window_ready"),
    (error) => String(error).includes("Only the settings window can become ready"),
  );
  await islandPage
    .getByRole("button", { name: "Settings", exact: true })
    .evaluate((node) => node.click());
  settings = await settingsPage();
  assert.equal(pages().filter((page) => page.url().includes("settings.html")).length, 1);
  assert.equal((await invoke(settings, "get_settings")).theme, "dark");
  results.islandGear = {
    label,
    backgroundWithoutWebviews: true,
    reopenedSettings: true,
    rejectsReadyFromIsland: true,
  };
  checks.push(
    "Closing the last Tauri WebView leaves the native background app alive. The island gear reopens settings without a tray WebView; a non-settings caller cannot mark that window ready.",
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
