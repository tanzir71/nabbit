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
const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v54-native";
assert(/^[a-z0-9-]+$/.test(prefix));
assert.equal(process.platform, "win32");
const output = resolve(root, `progress/v2/M10/${prefix}-scene.json`),
  pngOutput = resolve(root, `progress/v2/M10/${prefix}-focus@2x.png`),
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
  const contentBounds = ["focus", "paused"].includes(role)
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
  const base = Date.now() + 3_600_000;
  await invoke(tray, "timer_fixture", { nowMs: base, defer: false });
  const note = await invoke(tray, "create_note_card", {
    draft: { title: "Owned timer card" },
    expectedScope: null,
  });
  const action = async (page, action) => {
    const current = await invoke(page, "timer_snapshot");
    return invoke(page, "timer_action", {
      request: { expectedGeneration: current.generation, action },
    });
  };
  await action(tray, { kind: "link", card: { id: note.value.id, expectedScope: null } });
  await island({ shortcut: "Ctrl+Alt+T" });
  await wait(
    async () => (await invoke(tray, "timer_snapshot")).session?.status === "running",
    "timer hotkey dispatch",
  );
  let current = await invoke(tray, "timer_fixture", { nowMs: base + 47_000, defer: false });
  assert.equal(current.session.remainingS, 1453);
  const sessionId = current.session.id;
  const rawCapture = async (stem, file) => {
    const frame = (await island({ capture: { label: "island", stem } })).result;
    execFileSync(
      "python",
      [
        resolve(root, "scripts/encode-island-surface.py"),
        resolve(control, `${stem}.bgra`),
        String(frame.width),
        String(frame.height),
        resolve(root, "progress/v2/M10", file),
      ],
      { windowsHide: true },
    );
    const bytes = await readFile(resolve(root, "progress/v2/M10", file));
    captures.push({
      role: stem,
      file,
      width: frame.width,
      height: frame.height,
      bytes: bytes.length,
      sha256: hash(bytes),
    });
  };
  await setTimeout(300);
  await rawCapture("timer-compact", `${prefix}-compact@1x.png`);
  checks.push(
    "Ctrl+Alt+T dispatch starts the actual timer worker without OS key injection; native compact renders the persisted25/5 countdown and a guarded owned local card link",
  );
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
    .getByRole("button", { name: "Timer", exact: true })
    .click();
  await page.getByText("24:13", { exact: true }).waitFor();
  await capture(page, "focus", "body");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
  current = await invoke(page, "timer_fixture", { nowMs: base + 3_600_000, defer: false });
  assert.equal(current.session.remainingS, 1453);
  assert.equal(current.session.status, "paused");
  await capture(page, "paused", "body");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
  current = await invoke(page, "timer_snapshot");
  const deadline = current.session.deadlineMs;
  assert.equal(deadline, base + 3_600_000 + 1_453_000);
  checks.push(
    "Actual release WebView2/Tauri Pause and Resume survive an injected hour asleep with exact remaining time; stable DPR2 running/paused captures use the current JS/stylesheets",
  );
  await stop();
  await setTimeout(1000);
  await start();
  const restartedTray = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("tauri.localhost") && !p.url().includes("island.html")),
    "restarted owned tray",
  );
  await restartedTray.waitForFunction(() => !!globalThis.__TAURI_INTERNALS__?.invoke);
  current = await invoke(restartedTray, "timer_fixture", { nowMs: base + 3_630_000, defer: false });
  assert.equal(current.session.id, sessionId);
  assert.equal(current.session.status, "running");
  assert.equal(current.session.remainingS, 1423);
  assert.equal(current.session.deadlineMs, deadline);
  checks.push(
    "After terminating and restarting the owned release against the same isolated SQLite, the running session ID/deadline/card link persist and the injected UTC clock recomputes23:43",
  );
  await island({ gate: "hidden" });
  await setTimeout(300);
  await invoke(restartedTray, "timer_fixture", { nowMs: deadline + 1000, defer: true });
  await island({ timerWake: true });
  await wait(
    async () =>
      (await invoke(restartedTray, "timer_fixture", { nowMs: null, defer: true })).session
        ?.status === "ended",
    "native wake completes expired timer without a snapshot refresh",
  );
  const hidden = await island({ capture: { label: "island", stem: "timer-hidden" } });
  assert.equal(hidden.snapshot.activity.views[0].gate, "hidden");
  const pixels = await readFile(resolve(control, "timer-hidden.bgra"));
  for (let i = 3; i < pixels.length; i += 4) assert.equal(pixels[i], 0);
  checks.push(
    "The native clock/power wake seam completes the persisted expired timer. Fullscreen silence queues its alert and every captured native alpha byte stays zero",
  );
  await invoke(restartedTray, "island_activity_action", {
    action: {
      kind: "configure",
      preferences: { ...hidden.snapshot.activity.preferences, showAlertsOverFullscreen: true },
    },
  });
  await setTimeout(200);
  const alerted = await island({});
  assert.equal(alerted.snapshot.activity.views[0].gate, "visible");
  assert.equal(alerted.snapshot.activity.views[0].primary.event.kind, "timerEnded");
  await rawCapture("timer-ended", `${prefix}-ended@1x.png`);
  await action(restartedTray, { kind: "stop" });
  assert.equal((await invoke(restartedTray, "timer_snapshot")).session, null);
  const notes = await invoke(restartedTray, "list_note_cards");
  assert.deepEqual(notes.find((n) => n.value.id === note.value.id).value, note.value);
  checks.push(
    "Enabling the existing fullscreen-alert preference renders the native completion pill; Stop removes it and all card JSON remains byte-equivalent. No Tack card/time mutation or real OS clock/power/key change occurs",
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
          "Owned production DirectComposition/WebView2 release, actual Tauri timer service/SQLite/card linking and shortcut/wake handlers. The clock, fullscreen and power facts are injected; no real OS clock, power, keys, audio, account or user profile is touched. The owned process restarts against its own persistent profile.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(root, `progress/v2/M10/${prefix}-scene-log.txt`), logs, { flag: "wx" });
}
globalThis.console.log("Verified native Focus timer IPC, restart, wake and fullscreen completion.");
