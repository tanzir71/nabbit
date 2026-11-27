// Runs only an owned executable with unique app-data, control and WebView2
// directories. DOM input stays inside its webview; no global input is injected.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir, unlink, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { chromium } from "playwright";
const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v47-native";
assert(/^[a-z0-9-]+$/.test(prefix));
assert.equal(process.platform, "win32");
const output = resolve(root, `progress/v2/M9/${prefix}-native.json`),
  pngOutput = resolve(root, `progress/v2/M9/${prefix}-native.png`),
  exe = resolve(root, "src-tauri/target/release/nabbit.exe"),
  trial = resolve(root, `.tools/${prefix}-${randomUUID()}`),
  control = resolve(trial, "control");
for (const path of [output, pngOutput])
  await stat(path).then(
    () => {
      throw Error("Evidence already exists");
    },
    (e) => assert.equal(e.code, "ENOENT"),
  );
await mkdir(control, { recursive: true });
let port;
const env = {
  ...process.env,
  NABBIT_STICKY_ACCEPTANCE: "1",
  NABBIT_APP_DATA_DIR: resolve(trial, "profile"),
  NABBIT_ACCEPTANCE_COMMAND_DIR: control,
  WEBVIEW2_USER_DATA_FOLDER: resolve(trial, "webview"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
};
delete env.NABBIT_ISLAND_ACCEPTANCE;
delete env.NABBIT_ISLAND_SPIKE;
let child,
  browser,
  logs = "";
const checks = [],
  snapshots = [];
const wait = async (action, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await action();
    if (value) return value;
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw Error(`Owned process exited: ${label}`);
    assert(Date.now() < deadline, `Timed out: ${label}`);
    await setTimeout(100);
  }
};
const rpc = async (request) => {
  await unlink(resolve(control, "sticky.done")).catch((e) => assert.equal(e.code, "ENOENT"));
  await writeFile(resolve(control, "sticky.pending"), JSON.stringify(request));
  await rename(resolve(control, "sticky.pending"), resolve(control, "sticky.json"));
  const result = await wait(async () => {
    try {
      return JSON.parse(await readFile(resolve(control, "sticky.done"), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT" || e instanceof SyntaxError) return null;
      throw e;
    }
  }, request.action);
  assert(result.ok, `Owned RPC failed: ${request.action}`);
  return result.value;
};
async function start() {
  // WebView2 descendants can briefly outlive their owner on restart. Give each
  // owned launch its own endpoint so readiness cannot match the previous host.
  const reservation = createServer();
  await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
  port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`;
  child = spawn(exe, [], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (b) => {
    logs += b;
  });
  child.stderr.on("data", (b) => {
    logs += b;
  });
  await wait(async () => {
    try {
      return (await globalThis.fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {
      return false;
    }
  }, "isolated CDP");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
}
async function stop() {
  if (browser) {
    await browser.close();
    browser = null;
  }
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once("exit", r));
  }
}
async function windows() {
  return rpc({ action: "windows" });
}
try {
  await start();
  const first = await rpc({
      action: "seed",
      draft: {
        title: "Sticky native acceptance",
        body: "Original text",
        kind: "note",
        color: "green",
      },
    }),
    second = await rpc({
      action: "seed",
      draft: { title: "Independent card", body: "Second sticky", kind: "note", color: "blue" },
    });
  const label = await rpc({ action: "open", id: first.value.id });
  assert.equal(await rpc({ action: "open", id: first.value.id }), label);
  let rows = await wait(async () => {
    const rows = await windows();
    return rows.length === 1 &&
      rows[0].visible &&
      rows[0].native.alphaOk &&
      rows[0].native.alpha === 255
      ? rows
      : null;
  }, "visible ready sticky");
  assert.equal(rows[0].decorated, false);
  // Tao retains WS_CAPTION for DWM shadows and removes nonclient content
  // through WM_NCCALCSIZE. Check real client insets rather than that bit.
  const insets = rows[0].clientInsets;
  assert(insets.top >= 0 && insets.top <= Math.max(1, rows[0].scale));
  // The native caption is absent; DWM's symmetric resize/shadow insets remain.
  assert(insets.left >= 0);
  assert(Math.abs(insets.left - insets.right) <= 1);
  assert(Math.abs(insets.left - insets.bottom) <= 1);
  assert.equal(rows[0].native.resizable, true);
  assert.equal(rows[0].native.noActivate, false);
  assert.equal(rows[0].native.topmost, true);
  assert.equal(rows[0].native.alpha, 255);
  assert.equal(rows[0].native.alphaOk, true);
  assert.equal(rows[0].native.foreground, false);
  checks.push(
    "One native frameless resizable window per scoped card; duplicate open reuses it; default pin and alpha are real HWND attributes; acceptance opening does not steal focus",
  );
  const page = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("sticky.html")),
    "sticky CDP page",
  );
  const buildBytes = await readFile(resolve(root, "dist/.vite/manifest.json"));
  const buildManifest = JSON.parse(buildBytes);
  const entryScript = await page.locator('script[type="module"]').getAttribute("src");
  assert(
    entryScript.endsWith(buildManifest["sticky.html"].file),
    "Native executable must embed the completed current build",
  );
  await page.getByLabel("Note body", { exact: true }).fill("Saved via actual native IPC — বাংলা");
  await page.getByRole("button", { name: "Close sticky note", exact: true }).focus();
  rows = await wait(async () => {
    const r = await windows();
    // The note transaction and checkpoint acknowledgement are separate IPC
    // steps. Wait for both durable postconditions before taking the snapshot.
    return r[0]?.snapshot.content.note?.value.body === "Saved via actual native IPC — বাংলা" &&
      r[0]?.snapshot.content.checkpoint === null
      ? r
      : null;
  }, "native autosave");
  assert.equal(rows[0].snapshot.content.checkpoint, null);
  checks.push(
    "Production sticky React entry edits and autosaves through real Tauri IPC and SQLite; completed save clears its checkpoint",
  );
  const instance = rows[0].snapshot.binding.instance;
  await page.evaluate(
    async ({ instance }) =>
      globalThis.__TAURI_INTERNALS__.invoke("sticky_configure", {
        request: { instance, pinned: false, opacity: 60 },
      }),
    { instance },
  );
  rows = await windows();
  assert.equal(rows[0].native.topmost, false);
  assert.equal(rows[0].native.alpha, 153);
  const monitor = rows[0].snapshot.monitors[0],
    scale = rows[0].scale;
  const rect = {
    x: monitor.workArea.x + Math.round(70 * scale),
    y: monitor.workArea.y + Math.round(90 * scale),
    width: Math.round(480 * scale),
    height: Math.round(260 * scale),
  };
  await rpc({ action: "move", label, rect });
  rows = await wait(async () => {
    const r = await windows();
    return Math.abs(r[0]?.snapshot.profile.width - 480) < 1 &&
      Math.abs(r[0]?.snapshot.profile.height - 260) < 1
      ? r
      : null;
  }, "native move/resize persistence");
  snapshots.push(rows[0]);
  const label2 = await rpc({ action: "open", id: second.value.id });
  assert.notEqual(label, label2);
  await wait(async () => {
    const r = await windows();
    return r.length === 2 && r.every((w) => w.visible);
  }, "second sticky");
  const settings = await page.evaluate(() => globalThis.__TAURI_INTERNALS__.invoke("get_settings"));
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      ({ settings, theme }) =>
        globalThis.__TAURI_INTERNALS__.invoke("save_settings", {
          settings: { ...settings, theme },
        }),
      { settings, theme },
    );
    await wait(async () => {
      const pages = browser
        .contexts()
        .flatMap((c) => c.pages())
        .filter((p) => p.url().includes("sticky.html"));
      return (
        pages.length === 2 &&
        (await Promise.all(pages.map((p) => p.locator("html").getAttribute("data-theme")))).every(
          (t) => t === theme,
        )
      );
    }, `${theme} theme event reaches both real stickies`);
  }
  await page.evaluate(
    (settings) => globalThis.__TAURI_INTERNALS__.invoke("save_settings", { settings }),
    settings,
  );
  checks.push(
    "Saving the isolated app theme broadcasts to both real sticky webviews; the prior app preference is restored without changing Windows theme settings",
  );
  await rpc({ action: "close", label: label2 });
  await wait(async () => (await windows()).length === 1, "second close");
  checks.push(
    "Pin off restores normal z-order; native alpha60% is153; physical move/resize persists logical per-card profile; closing another card leaves the first open",
  );
  const nativePng = await page.screenshot({
    animations: "disabled",
    caret: "hide",
  });
  await stop();
  await start();
  rows = await wait(async () => {
    const r = await windows();
    return r.length === 1 && r[0].visible && r[0].native.alphaOk && r[0].native.alpha === 153
      ? r
      : null;
  }, "restart restores only opened card");
  const restored = rows[0];
  assert.equal(restored.label, label);
  assert.equal(restored.snapshot.profile.width, 480);
  assert.equal(restored.snapshot.profile.height, 260);
  assert.equal(restored.snapshot.profile.pinned, false);
  assert.equal(restored.snapshot.profile.opacity, 60);
  assert.equal(restored.native.alpha, 153);
  assert.equal(restored.native.topmost, false);
  assert.equal(restored.snapshot.content.note.value.body, "Saved via actual native IPC — বাংলা");
  assert(Math.abs(restored.rect.x - rect.x) <= 1 && Math.abs(restored.rect.y - rect.y) <= 1);
  assert.equal(restored.native.foreground, false);
  snapshots.push(restored);
  checks.push(
    "Owned process restart restores the open card, body, position, size, unpinned z-order and alpha; explicitly closed card stays closed; restore does not focus",
  );
  const restoredPage = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("sticky.html")),
    "restored sticky CDP target",
  );
  const restoredIpc = await restoredPage.evaluate(() =>
    globalThis.__TAURI_INTERNALS__.invoke("sticky_snapshot"),
  );
  assert.equal(restoredIpc.binding.instance, restored.snapshot.binding.instance);
  const stale = await restoredPage.evaluate(async (instance) => {
    try {
      await globalThis.__TAURI_INTERNALS__.invoke("sticky_configure", {
        request: { instance, pinned: true },
      });
      return false;
    } catch {
      return true;
    }
  }, instance);
  assert(stale);
  await rpc({ action: "configure", label, pinned: true, opacity: 100 });
  rows = await windows();
  assert(rows[0].native.topmost);
  assert.equal(rows[0].native.alpha, 255);
  await rpc({ action: "close", label });
  await wait(async () => (await windows()).length === 0, "final sticky close");
  checks.push(
    "An old window-instance command is rejected after restart; pin and100% opacity are reversible; explicit close destroys the owned HWND",
  );
  assert(nativePng.length <= 300000);
  await writeFile(pngOutput, nativePng, { flag: "wx" });
  await writeFile(
    output,
    JSON.stringify(
      {
        passed: true,
        png: {
          file: `${prefix}-native.png`,
          bytes: nativePng.length,
          sha256: createHash("sha256").update(nativePng).digest("hex"),
        },
        executableSha256: createHash("sha256")
          .update(await readFile(exe))
          .digest("hex"),
        buildManifestSha256: createHash("sha256").update(buildBytes).digest("hex"),
        checks,
        snapshots: JSON.parse(
          JSON.stringify(snapshots, (key, value) => (key === "editToken" ? undefined : value)),
        ),
        omittedOptimisticEditTokens: true,
        isolatedProfiles: true,
        realTauriIpc: true,
        realWindowsHwnd: true,
        osDisplaySettingsChanged: false,
        globalInputInjected: false,
        realClipboardRead: false,
        remoteTackUsed: false,
        performanceClaim: false,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  globalThis.console.log(`Verified ${checks.length} native sticky cases.`);
} finally {
  await stop();
  await writeFile(resolve(trial, "process-output.txt"), logs);
}
