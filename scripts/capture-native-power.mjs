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
  prefix = process.argv[2] ?? "v56-native";
assert(/^[a-z0-9-]+$/.test(prefix));
assert.equal(process.platform, "win32");
const output = resolve(root, `progress/v2/M10/${prefix}-scene.json`),
  pngOutput = resolve(root, `progress/v2/M10/${prefix}-peek@2x.png`),
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
env.NABBIT_ACCEPTANCE_REDUCED_MOTION = "1";
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
  await setTimeout(200);
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
  await setTimeout(100);
  const box = await page.locator(selector).boundingBox();
  const contentBounds = role === "peek" ? await page.locator(".island-morph").boundingBox() : box;
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
  const sample = (ac, flags, percent) => ({
    acLineStatus: ac,
    batteryFlag: flags,
    batteryLifePercent: percent,
  });
  const set = async (value, notify = true) =>
    invoke(tray, "power_fixture", { sample: value, notify, unavailable: false });
  const primary = async () => (await island({})).snapshot.activity.views[0].primary;
  const gone = () => wait(async () => !(await primary()), "four-second power dismissal", 10000);
  const isPower = async (label) =>
    wait(async () => {
      const item = await primary();
      return (
        item?.event.kind === "powerChanged" &&
        (label === "charging"
          ? item.event.charging
          : label === "low"
            ? item.event.percent === 20
            : !item.event.charging) &&
        item
      );
    }, `native ${label} activity`);
  const rawCapture = async (role) => {
    await setTimeout(180);
    const stem = `power-${role}`,
      frame = (await island({ capture: { label: "island", stem } })).result,
      file = `${prefix}-${role}@1x.png`;
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
    assert(bytes.length <= 300000);
    captures.push({
      role,
      file,
      width: frame.width,
      height: frame.height,
      bytes: bytes.length,
      sha256: hash(bytes),
    });
  };
  let state = await set(sample(0, 1, 82));
  assert.equal(await primary(), null);
  assert.equal(state.snapshot.status.percent, 82);
  assert.equal(state.snapshot.notificationError, null);
  const baseline = state;
  for (let i = 0; i < 100; i++)
    assert.deepEqual(await invoke(tray, "power_snapshot"), baseline.snapshot);
  state = await invoke(tray, "power_fixture", { sample: null, notify: false, unavailable: false });
  assert.equal(state.reads, baseline.reads);
  checks.push(
    "Actual release establishes a quiet82% battery baseline.100 Tauri cache reads do not sample the provider or create an activity; registered power notifications have no error",
  );
  await set(sample(1, 9, 82), false);
  const beforeWake = await invoke(tray, "power_fixture", {
    sample: null,
    notify: false,
    unavailable: false,
  });
  await island({ powerWake: true });
  await isPower("charging");
  state = await invoke(tray, "power_fixture", { sample: null, notify: false, unavailable: false });
  assert.equal(state.reads, beforeWake.reads + 1);
  assert.equal(state.snapshot.status.charging, true);
  await rawCapture("charging");
  const chargingRevision = state.snapshot.revision;
  await set(sample(1, 9, 82));
  assert.equal((await invoke(tray, "power_snapshot")).revision, chargingRevision);
  await gone();
  await set(sample(1, 9, 82));
  assert.equal(await primary(), null);
  checks.push(
    "The shared native power-notification handler samples the injected AC/charging change and renders the original battery icon/82% pill. Identical messages neither change revision nor restart expiry; the real Rust scheduler dismisses it after4s and duplicates do not revive it",
  );
  await set(sample(0, 1, 82));
  const unplugged = await isPower("unplugged");
  assert.equal(unplugged.event.pluggedIn, false);
  assert.equal(unplugged.event.percent, 82);
  await rawCapture("unplugged");
  await gone();
  await set(sample(0, 0, 21));
  assert.equal(await primary(), null);
  await set(sample(0, 0, 20));
  await isPower("low");
  await rawCapture("low");
  await set(sample(0, 0, 20));
  await gone();
  assert.equal(await primary(), null);
  checks.push(
    "Unplugging at82% creates a transient On battery event above the low threshold.21% is quiet,20% triggers the inclusive low warning, and repeated20% does not keep it permanently visible",
  );
  await set(sample(0, 0, 82));
  await set(sample(1, 8, 82));
  await writeFile(env.NABBIT_ACCEPTANCE_CURSOR, JSON.stringify({ x: 960, y: 30 }));
  await island({ surface: { label: "island", state: "peek" } });
  const page = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("island.html")),
    "owned battery Peek",
  );
  const details = page.getByRole("region", { name: "Battery status" });
  await details.getByText("Charging", { exact: true }).waitFor();
  await details.getByText("82% battery remaining", { exact: true }).waitFor();
  const builtHtml = await readFile(resolve(root, "dist/island.html"), "utf8"),
    entry = builtHtml.match(/<script[^>]+src="([^"]+)"/)[1];
  assert.equal(await page.locator('script[type="module"]').getAttribute("src"), entry);
  embeddedEntry = entry;
  const expectedStyles = [...builtHtml.matchAll(/<link\b[^>]+>/g)]
    .filter(([tag]) => tag.includes('rel="stylesheet"'))
    .map(([tag]) => tag.match(/href="([^"]+)"/)[1]);
  embeddedStyles = await page
    .locator('link[rel="stylesheet"]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href")));
  assert(expectedStyles.length > 0);
  for (const href of expectedStyles) assert(embeddedStyles.includes(href), href);
  await capture(page, "peek", "body");
  await writeFile(env.NABBIT_ACCEPTANCE_CURSOR, JSON.stringify({ x: 1000, y: 700 }));
  await island({ surface: { label: "island", state: "live" } });
  checks.push(
    "The actual pushed power event drives read-only battery Peek through native/WebView ownership. Stable DPR2 capture and the embedded entry/all static stylesheet names match the completed frontend, without freezing or extending the4s policy",
  );
  await set(sample(1, 128, 255));
  assert.equal(await primary(), null);
  await set(sample(0, 0, 50));
  await set(sample(1, 8, 255));
  const unknown = await primary();
  assert.equal(unknown.event.percent, null);
  assert.equal((await invoke(tray, "power_snapshot")).status.percent, null);
  await invoke(tray, "power_fixture", { sample: null, unavailable: true, notify: true });
  assert.equal(await primary(), null);
  assert((await invoke(tray, "power_snapshot")).error);
  await set(sample(0, 0, 21));
  assert.equal(await primary(), null);
  await island({ gate: "hidden" });
  await set(sample(0, 0, 20));
  await setTimeout(200);
  const hidden = await island({ capture: { label: "island", stem: "power-hidden" } });
  assert.equal(hidden.snapshot.activity.views[0].gate, "hidden");
  const pixels = await readFile(resolve(control, "power-hidden.bgra"));
  for (let i = 3; i < pixels.length; i += 4) assert.equal(pixels[i], 0);
  await wait(
    async () => {
      const v = (await island({})).snapshot.activity.views[0];
      return ![v.primary, v.bubble, ...v.queue].some((i) => i?.category === "power");
    },
    "hidden queued power expiry",
    10000,
  );
  await island({ gate: "visible" });
  assert.equal(await primary(), null);
  checks.push(
    "No-battery and provider errors clear stale activity; recovery is a quiet baseline and an unknown percentage stays null. A low event queued under fullscreen silence has zero native alpha, expires while hidden and never reappears when visibility returns. No real power, sleep, settings, input or battery state is changed",
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
        noRealPowerChange: true,
        noOsSettingChange: true,
        scope:
          "Owned production DirectComposition/WebView2 release, actual Tauri PowerProvider sample seam/service/activity scheduler/native notification handler and pushed Peek. Power/fullscreen/cursor facts are fixtures; notification registration/unregistration is tested on an owned hidden HWND. No real power source, battery, sleep, user profile or OS setting is changed.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(root, `progress/v2/M10/${prefix}-scene-log.txt`), logs, { flag: "wx" });
}
globalThis.console.log(
  "Verified native battery/charging events, exact20% threshold, pushed Peek and visible/hidden4s expiry.",
);
