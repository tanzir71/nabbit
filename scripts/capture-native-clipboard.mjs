// Runs only an owned executable with unique app-data, control and WebView2
// directories. DOM input stays inside its webview; no global input is injected.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
import { chromium } from "playwright";
const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v51-native";
assert(/^[a-z0-9-]+$/.test(prefix));
assert.equal(process.platform, "win32");
const output = resolve(root, `progress/v2/M10/${prefix}-scene.json`),
  pngOutput = resolve(root, `progress/v2/M10/${prefix}-clipboard@2x.png`),
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
const reservation = createServer();
await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
const port = reservation.address().port;
await new Promise((r) => reservation.close(r));
const env = {
  ...process.env,
  NABBIT_STICKY_ACCEPTANCE: "1",
  NABBIT_APP_DATA_DIR: resolve(trial, "profile"),
  NABBIT_ACCEPTANCE_COMMAND_DIR: control,
  WEBVIEW2_USER_DATA_FOLDER: resolve(trial, "webview"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
};
env.NABBIT_ISLAND_ACCEPTANCE = "1";
env.NABBIT_ISLAND_LAYOUT = resolve(trial, "layout.json");
env.NABBIT_ACCEPTANCE_CURSOR = resolve(trial, "cursor.json");
await writeFile(
  env.NABBIT_ISLAND_LAYOUT,
  JSON.stringify({
    monitors: [
      {
        id: "primary",
        name: "Fixture primary",
        primary: true,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1032 },
        scaleFactor: 1,
      },
    ],
    cursor: { x: 120, y: 400 },
  }),
);
await writeFile(env.NABBIT_ACCEPTANCE_CURSOR, JSON.stringify({ x: 1000, y: 700 }));
delete env.NABBIT_ISLAND_SPIKE;
let child,
  browser,
  logs = "";
const checks = [],
  captures = [];
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
async function start() {
  child = spawn(exe, [], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (b) => {
    logs += b;
  });
  child.stderr.on("data", (b) => {
    logs += b;
  });
  await island({ gate: "visible", prepareTray: true });
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
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function island(fields) {
  const id = randomUUID(),
    path = resolve(control, "island-request.json");
  await writeFile(`${path}.pending`, JSON.stringify({ id, ...fields }));
  await rename(`${path}.pending`, path);
  return wait(async () => {
    try {
      const r = JSON.parse(await readFile(resolve(control, "island-response.json"), "utf8"));
      if (r.id !== id) return null;
      assert.equal(r.error, null);
      assert.equal(r.snapshot.lastError, null);
      return r;
    } catch (e) {
      if (e.code === "ENOENT" || e instanceof SyntaxError) return null;
      throw e;
    }
  }, "island control");
}
const invoke = (page, command, args = {}) =>
  page.evaluate(({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
async function capture(page, role, selector) {
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready;
    await Promise.all([...globalThis.document.images].map((i) => i.decode()));
  });
  // DOM-only emulation in this owned WebView; OS DPI/display settings stay untouched.
  const session = await page.context().newCDPSession(page);
  const before = await page.evaluate(() => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  }));
  await session.send("Emulation.setDeviceMetricsOverride", {
    ...before,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await setTimeout(800);
  await page.evaluate(() => globalThis.document.activeElement?.blur());
  await page.evaluate(async () => {
    for (let i = 0; i < 5; i++) {
      const animations = globalThis.document
        .getAnimations()
        .filter((a) => a.playState === "running" || a.pending);
      await Promise.all(animations.map((a) => a.finished.catch(() => undefined)));
      await new Promise(globalThis.requestAnimationFrame);
    }
  });
  await setTimeout(500);
  const box = await page.locator(selector).boundingBox();
  const contentBounds =
    role === "clipboard" ? await page.locator(".island-morph").boundingBox() : box;
  const shot = async () =>
    Buffer.from(
      (
        await session.send("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: true,
          clip: { ...box, scale: 1 },
        })
      ).data,
      "base64",
    );
  const bytes = await shot(),
    repeat = await shot();
  assert.equal(hash(bytes), hash(repeat), "Capture must be stable");
  assert(bytes.length <= 300000);
  assert.equal(bytes.readUInt32BE(16), Math.round(box.width * 2));
  assert.equal(bytes.readUInt32BE(20), Math.round(box.height * 2));
  const file = `${prefix}-${role}@2x.png`;
  await writeFile(resolve(root, "progress/v2/M10", file), bytes, { flag: "wx" });
  captures.push({
    role,
    file,
    sha256: hash(bytes),
    bytes: bytes.length,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    logicalBounds: box,
    contentBounds,
    scale: 2,
    repeatMatches: true,
  });
  await session.send("Emulation.clearDeviceMetricsOverride");
  await session.detach();
}
let passed = false,
  failure;
try {
  await start();
  const main = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => !p.url().includes("island.html") && !p.url().includes("sticky.html")),
    "owned tray",
  );
  await main.waitForFunction(() => Boolean(globalThis.__TAURI_INTERNALS__));
  for (const content of [
    "Native fixture meeting at 4:30",
    "https://example.invalid/native-clipboard?utm_source=keep",
    "Native fixture third text",
  ])
    await invoke(main, "add_clipboard_text", { content });
  const initial = await invoke(main, "list_clipboard_entries", { query: null });
  assert.equal(initial.length, 3);
  await island({ shortcut: "Alt+Space" });
  const page = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("island.html")),
    "owned island",
  );
  const tab = page
    .getByRole("navigation", { name: "Island modules" })
    .getByRole("button", { name: "Clipboard", exact: true });
  await tab.click();
  const grid = page.getByRole("grid", { name: "Clipboard history" });
  await wait(
    async () => (await grid.locator("[data-clipboard-id]").count()) === 3,
    "real IPC history",
  );
  const manifest = JSON.parse(await readFile(resolve(root, "dist/.vite/manifest.json"), "utf8"));
  assert(
    (await page.locator('script[type="module"]').getAttribute("src")).endsWith(
      manifest["island.html"].file,
    ),
  );
  checks.push(
    "Current release custom-protocol island renders actual clipboard history through Tauri IPC and isolated SQLite",
  );
  await invoke(main, "add_clipboard_text", { content: "Native pushed fixture event" });
  await wait(
    async () => (await grid.locator("[data-clipboard-id]").count()) === 4,
    "native clipboard:changed push",
  );
  await grid.getByRole("button", { name: "Pin Native pushed fixture event", exact: true }).click();
  await page.getByText("Item pinned", { exact: true }).waitFor();
  await page
    .getByRole("group", { name: "Clipboard filters" })
    .getByRole("button", { name: "Pinned", exact: true })
    .click();
  await wait(
    async () => (await grid.locator("[data-clipboard-id]").count()) === 1,
    "native pin filter",
  );
  const pinned = await invoke(main, "list_clipboard_entries", { query: null });
  assert(pinned.find((e) => e.content === "Native pushed fixture event").pinned);
  await page
    .getByRole("group", { name: "Clipboard filters" })
    .getByRole("button", { name: "All", exact: true })
    .click();
  await tab.focus();
  await capture(page, "clipboard", "body");
  checks.push(
    "Actual Tauri add/pin commands push updates across owned surfaces; All/Pinned filters use persisted native history",
  );
  checks.push(
    "Repeat-exact DPR2 native capture; fixture monitor/cursor, DOM-only emulation and no OS clipboard, paste adapter, global input or display-setting changes",
  );
  passed = true;
} catch (e) {
  failure = { message: e.message, stack: e.stack };
  throw e;
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
        executableSha256: hash(await readFile(exe)),
        buildManifestSha256: hash(await readFile(resolve(root, "dist/.vite/manifest.json"))),
        noUserProfile: true,
        noHostedTack: true,
        noRealClipboard: true,
        noOsDisplayChange: true,
        scope:
          "Actual owned release WebView2 with Tauri IPC and isolated clipboard SQLite. Add/pin/read and event rendering only; the production Windows clipboard/focus/paste adapter is not invoked.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(root, `progress/v2/M10/${prefix}-scene-log.txt`), logs, { flag: "wx" });
}
globalThis.console.log("Verified native Clipboard IPC and captured the current release surface.");
