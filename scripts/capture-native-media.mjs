// Runs only an owned executable with unique app-data, control and WebView2
// directories. DOM input stays inside its webview; no global input is injected.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
import { chromium } from "playwright";
import { recordedMedia, mediaArtwork } from "./screenshots/media-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v53-native";
assert(/^[a-z0-9-]+$/.test(prefix));
assert.equal(process.platform, "win32");
const output = resolve(root, `progress/v2/M10/${prefix}-scene.json`),
  pngOutput = resolve(root, `progress/v2/M10/${prefix}-media@2x.png`),
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
let embeddedEntry, embeddedStyles;
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
  const contentBounds = ["media", "no-timeline"].includes(role)
    ? await page.locator(".island-morph").boundingBox()
    : box;
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
  const tray = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("tauri.localhost") && !p.url().includes("island.html")),
    "owned tray WebView",
  );
  await tray.waitForFunction(() => !!globalThis.__TAURI_INTERNALS__?.invoke);
  const media = globalThis.structuredClone(recordedMedia);
  media.sessions[0].art = mediaArtwork;
  await invoke(tray, "media_fixture", { snapshot: media, resume: false });
  await setTimeout(400);
  const native = await island({ capture: { label: "island", stem: "media-compact" } });
  assert.equal(native.media.sessions[0].art, mediaArtwork);
  const frame = native.result;
  const compactFile = `${prefix}-compact@1x.png`;
  execFileSync(
    "python",
    [
      resolve(root, "scripts/encode-island-surface.py"),
      resolve(control, "media-compact.bgra"),
      String(frame.width),
      String(frame.height),
      resolve(root, "progress/v2/M10", compactFile),
    ],
    { windowsHide: true },
  );
  const compact = await readFile(resolve(root, "progress/v2/M10", compactFile));
  captures.push({
    role: "native-compact",
    file: compactFile,
    width: frame.width,
    height: frame.height,
    bytes: compact.length,
    sha256: hash(compact),
  });
  checks.push(
    "The native DirectComposition compact pill renders recorded GSMTC artwork; no WebView or provider polling is needed for the pill",
  );
  const gesture = async (delta, fine = false, x = 360, y = 24) =>
    island({ mediaGesture: { label: "island", x, y, delta, fine } });
  assert.equal((await gesture(60)).mediaGesture, true);
  assert.equal((await island({})).media.volume.percent, 64);
  await gesture(60);
  await wait(async () => (await island({})).media.volume.percent === 66, "native wheel +2");
  await gesture(-120, true);
  await wait(async () => (await island({})).media.volume.percent === 65, "native shift wheel -1");
  await gesture(null);
  await wait(
    async () => (await island({})).media.sessions[0].playing === false,
    "native middle pause",
  );
  checks.push(
    "The production native hit-gated handler accumulates two half-detents, applies +2 / Shift -1, and middle-click pauses the current recorded session",
  );
  assert.equal((await gesture(120, false, 0, 0)).mediaGesture, false);
  await island({ gate: "hidden" });
  await setTimeout(400);
  assert.equal((await gesture(120)).mediaGesture, false);
  await island({ gate: "visible" });
  await setTimeout(400);
  checks.push("Transparent corners and fullscreen-hidden native hosts reject media gestures");
  await invoke(tray, "media_fixture", { snapshot: media, resume: true });
  await island({ shortcut: "Alt+Space" });
  const page = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("island.html")),
    "owned Media WebView",
  );
  const builtHtml = await readFile(resolve(root, "dist/island.html"), "utf8");
  const entry = builtHtml.match(/<script[^>]+src="([^"]+)"/)[1];
  assert.equal(
    await page.locator('script[type="module"]').getAttribute("src"),
    entry,
    "The executable must embed the current frontend entry",
  );
  embeddedEntry = entry;
  const expectedStyles = [...builtHtml.matchAll(/<link\b[^>]+>/g)]
    .filter(([tag]) => tag.includes('rel="stylesheet"'))
    .map(([tag]) => tag.match(/href="([^"]+)"/)[1]);
  embeddedStyles = await page
    .locator('link[rel="stylesheet"]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href")));
  assert(expectedStyles.length > 0);
  for (const href of expectedStyles)
    assert(
      embeddedStyles.includes(href),
      `The executable must embed the current stylesheet: ${href}`,
    );
  await page
    .getByRole("navigation", { name: "Island modules" })
    .getByRole("button", { name: "Media", exact: true })
    .click();
  await page.getByText("Night Drive", { exact: true }).waitFor();
  await capture(page, "media", "body");
  await page.getByRole("button", { name: "Pause playback" }).click();
  await page.getByRole("button", { name: "Play playback" }).waitFor();
  await page.getByRole("button", { name: "Browser", exact: true }).click();
  await page.getByText("Live radio", { exact: true }).waitFor();
  assert.equal(await page.locator("[data-media-timeline]").count(), 0);
  assert(await page.getByRole("button", { name: "Next track" }).isDisabled());
  await capture(page, "no-timeline", "body");
  checks.push(
    "Current release WebView2 uses actual Tauri media IPC, playback controls and session chips; paused radio omits its unsupported timeline and skip controls, with exact-repeat DPR2 captures",
  );
  const audit = await invoke(page, "media_fixture", { snapshot: null, resume: false });
  assert.equal(audit.audit.hardwareCalls, 0);
  assert.deepEqual(audit.audit.lifecycle, ["subscribe", "unsubscribe", "subscribe"]);
  checks.push(
    "Resume replaces the injected subscription; all playback/audio calls are recorded and no real player, audio output or OS input is touched",
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
        embeddedEntry,
        embeddedStyles,
        executableSha256: hash(await readFile(exe)),
        buildManifestSha256: hash(await readFile(resolve(root, "dist/.vite/manifest.json"))),
        noUserProfile: true,
        noHostedTack: true,
        noRealClipboard: true,
        noOsDisplayChange: true,
        scope:
          "Owned custom-protocol release DirectComposition and WebView2, actual Tauri media IPC and native gesture handler, production media service with recorded MediaProvider. No live GSMTC/Core Audio, global input, OS display/audio settings, user profile or account.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(root, `progress/v2/M10/${prefix}-scene-log.txt`), logs, { flag: "wx" });
}
globalThis.console.log("Verified native media IPC/gestures and captured current release states.");
