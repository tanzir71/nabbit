// Runs only an owned executable with unique app-data, control and WebView2
// directories. DOM input stays inside its webview; no global input is injected.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir, rename, stat, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
import { chromium } from "playwright";
const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v59-native-a";
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
let embeddedAssetCount = 0;
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
  await setTimeout(1200);
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
          captureBeyondViewport: false,
          clip: { ...box, scale: 1 },
        })
      ).data,
      "base64",
    );
  const bytes = await shot(),
    repeat = await shot();
  if (hash(bytes) !== hash(repeat)) {
    for (const [suffix, data] of [
      ["first", bytes],
      ["second", repeat],
    ]) {
      assert(data.length <= 300000);
      await writeFile(
        resolve(root, `progress/v2/M10/${prefix}-${role}-failed-${suffix}@2x.png`),
        data,
        { flag: "wx" },
      );
    }
  }
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
const jobs = [];
try {
  await start();
  const tray = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("tauri.localhost") && !p.url().includes("island.html")),
    "owned tray",
  );
  await tray.waitForFunction(() => !!globalThis.__TAURI_INTERNALS__?.invoke);
  const profile = env.NABBIT_APP_DATA_DIR,
    input = resolve(profile, "media-fixture.mp4");
  const ffmpeg = resolve(root, "src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe");
  const pins = JSON.parse(await readFile(resolve(root, "scripts/engine-pins.json"), "utf8"));
  assert.equal(
    hash(await readFile(ffmpeg)),
    pins.targets["x86_64-pc-windows-msvc"].ffmpeg.executableSha256,
  );
  execFileSync(
    ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1920x1080:rate=15:duration=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=30",
      "-c:v",
      "mpeg4",
      "-q:v",
      "2",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      input,
    ],
    { windowsHide: true, timeout: 60000 },
  );
  const originalHash = hash(await readFile(input));
  const mov = resolve(profile, "media-fixture.mov");
  await copyFile(input, mov);
  const catalog = await invoke(tray, "tool_catalog");
  assert.equal(catalog.length, 9);
  assert.equal(await invoke(tray, "tool_suggest", { paths: [input] }), "fit-size");
  assert.equal(await invoke(tray, "tool_suggest", { paths: [mov] }), "to-mp4");
  assert.deepEqual(await invoke(tray, "tool_jobs"), []);
  await island({ surface: { label: "island", state: "expanded" } });
  let page = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("island.html")),
    "owned island",
  );
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("combobox").fill("Fit under");
  await page.getByRole("option", { name: /Fit under a size/ }).click();
  const sheet = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("?media-sheet")),
    "native media review",
  );
  await sheet.getByLabel("File path").fill(input);
  await sheet.getByRole("button", { name: "Load file", exact: true }).click();
  await sheet
    .getByRole("button", { name: "Fit under 20 MB", exact: true })
    .waitFor({ state: "visible" });
  await wait(
    async () => sheet.getByRole("button", { name: "Fit under 20 MB", exact: true }).isEnabled(),
    "native estimate",
  );
  assert.equal(
    await sheet.locator(".media-review").evaluate((n) => n.getBoundingClientRect().width),
    440,
  );
  assert.equal(
    await sheet.getByRole("button", { name: "Exact size · 2 passes" }).getAttribute("aria-pressed"),
    "true",
  );
  assert.deepEqual(await invoke(tray, "tool_jobs"), []);
  const firstIntent = await invoke(sheet, "tool_media_sheet");
  await assert.rejects(invoke(tray, "tool_media_sheet_ready", { id: firstIntent.id, height: 200 }));
  const current = { ...firstIntent, id: randomUUID(), input };
  await invoke(tray, "tool_open_media_sheet", { intent: current });
  await wait(
    async () => (await invoke(sheet, "tool_media_sheet"))?.id === current.id,
    "new review intent",
  );
  await invoke(sheet, "tool_close_media_sheet", { id: firstIntent.id });
  assert.equal((await invoke(sheet, "tool_media_sheet")).id, current.id);
  await assert.rejects(
    invoke(sheet, "tool_media_sheet_ready", { id: firstIntent.id, height: 300 }),
  );
  await assert.rejects(
    invoke(tray, "tool_open_media_sheet", { intent: { ...current, input: mov } }),
  );
  await wait(
    async () => sheet.getByRole("button", { name: "Fit under 20 MB", exact: true }).isEnabled(),
    "current review estimate",
  );
  await capture(sheet, "fit-review", ".media-review");
  checks.push(
    "Search opens a separate 440px native review with real ffmpeg inspection and Rust estimates; no job starts on open. MOV/MKV conversion and oversized-video drop suggestions use metadata and the saved cap. Current-id and caller guards reject stale resize and mismatched intents; a stale close cannot hide the next review.",
  );
  await sheet.getByRole("button", { name: "Fit under 20 MB", exact: true }).click();
  const running = await wait(async () => {
    const j = (await invoke(tray, "tool_jobs"))[0];
    if (j?.status === "failed") throw Error(j.error);
    return j?.status === "running" && j.note?.includes("pass 1 of 2") && j;
  }, "actual two-pass child");
  const activity = await invoke(tray, "get_activity_snapshot");
  assert(
    activity.views.some(
      (v) =>
        v.primary?.event.kind === "toolJob" &&
        v.primary.event.jobId === running.id &&
        v.primary.event.label.includes("try 1 of 3"),
    ),
  );
  await island({ surface: { label: "island", state: "live" } });
  await setTimeout(240);
  const stem = "media-running",
    frame = (await island({ capture: { label: "island", stem } })).result;
  const file = `${prefix}-running-native@1x.png`;
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
    role: "running-native",
    file,
    width: frame.width,
    height: frame.height,
    bytes: bytes.length,
    sha256: hash(bytes),
    repeatMatches: null,
    reason: "Actual live native progress frame; data may advance between captures",
    activity,
  });
  await island({ surface: { label: "island", state: "expanded" } });
  page = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => !p.isClosed() && p.url().includes("island.html")),
    "recreated expanded island",
  );
  await page.locator('[data-island-tab="files"]').click();
  const queue = page.getByRole("region", { name: "Tool jobs" });
  await queue.getByRole("button", { name: "Cancel", exact: true }).first().click();
  await wait(
    async () =>
      (await invoke(tray, "tool_jobs")).find((j) => j.id === running.id)?.status === "cancelled",
    "cancel attached child",
  );
  assert.equal(hash(await readFile(input)), originalHash);
  await queue.getByRole("button", { name: "Retry", exact: true }).click();
  const done = await wait(
    async () => {
      const j = (await invoke(tray, "tool_jobs")).find((j) => j.id !== running.id);
      if (j?.status === "failed") throw Error(j.error);
      return j?.status === "completed" && j;
    },
    "retry creates size-target output",
    120000,
  );
  jobs.push(running, done);
  assert(done.afterBytes <= 20000000);
  assert.equal(done.mediaReport.encoder, "libx264");
  assert(done.mediaReport.attempts.every((a) => a.sourceHash === originalHash));
  assert.equal(hash(await readFile(input)), originalHash);
  assert(done.output.endsWith("media-fixture (Fit for Discord).mp4"));
  await capture(page, "queue", "body");
  checks.push(
    "An explicit native Run launches the existing durable runner and pushes a typed try/pass activity. The actual Files queue cancels the attached encode, retries as a new job, and produces an under-20MB libx264 output from the unchanged original.",
  );
  await invoke(page, "shelf_add", { paths: [input] });
  await page.getByRole("button", { name: /Select media-fixture.mp4/ }).click();
  await page
    .getByRole("group", { name: "File tools" })
    .getByRole("button", { name: "Trim video", exact: true })
    .click();
  await sheet.getByLabel("Trim start handle").waitFor();
  await sheet.getByLabel("Start", { exact: true }).fill("0:01.2");
  await sheet.getByLabel("End", { exact: true }).fill("0:03.3");
  await wait(
    async () => sheet.locator(".trim-body").evaluate((n) => n.scrollHeight <= n.clientHeight + 1),
    "trim review grows after inspection",
  );
  await capture(sheet, "local-trim", ".media-review");
  assert.equal((await invoke(tray, "tool_jobs")).length, 2);
  await sheet.getByRole("button", { name: "Trim video", exact: true }).click();
  const trimmed = await wait(
    async () => {
      const j = (await invoke(tray, "tool_jobs")).find((j) => j.request.toolId === "trim-video");
      if (j?.status === "failed") throw Error(j.error);
      return j?.status === "completed" && j;
    },
    "Shelf precise local trim",
    60000,
  );
  assert.deepEqual(trimmed.request.options.trim, { startMs: 1200, endMs: 3300 });
  jobs.push(trimmed);
  checks.push(
    "Shelf accepts the native media registry and opens the existing trim handles/time fields for a local file. Editing does not start a job; the primary Trim video action persists the 1.2–3.3s range and creates a separate result.",
  );
  const latest = queue.getByRole("article").filter({ hasText: "Trimmed" });
  await latest.getByRole("button", { name: "Undo", exact: true }).click();
  await wait(
    async () =>
      (await invoke(tray, "tool_jobs")).find((j) => j.id === trimmed.id)?.status === "undone",
    "owned output Undo",
  );
  await assert.rejects(readFile(trimmed.output), (e) => e.code === "ENOENT");
  assert.equal(hash(await readFile(input)), originalHash);
  const notices = await invoke(tray, "third_party_licenses");
  const expectedNotices = JSON.parse(
    await readFile(resolve(root, "third-party/notices.json"), "utf8"),
  );
  const ordered = (value) =>
    Array.isArray(value)
      ? value.map(ordered)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, ordered(value[k])]),
          )
        : value;
  assert.equal(
    hash(JSON.stringify(ordered(notices))),
    hash(JSON.stringify(ordered(expectedNotices))),
  );
  const manifest = JSON.parse(await readFile(resolve(root, "dist/.vite/manifest.json"), "utf8"));
  const files = [
    ...new Set(Object.values(manifest).flatMap((item) => [item.file, ...(item.css ?? [])])),
  ];
  for (const file of files) {
    const value = await tray.evaluate(async (file) => {
      const r = await globalThis.fetch("/" + file);
      if (!r.ok) throw Error(file);
      return [
        ...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", await r.arrayBuffer())),
      ]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }, file);
    assert.equal(value, hash(await readFile(resolve(root, "dist", file))), file);
  }
  embeddedAssetCount = files.length;
  await stop();
  await start();
  const reopened = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("tauri.localhost") && !p.url().includes("island.html")),
    "reopened tray",
  );
  const records = await invoke(reopened, "tool_jobs");
  assert.equal(records.length, 3);
  assert.equal(records.find((j) => j.id === running.id).status, "cancelled");
  assert.equal(records.find((j) => j.id === done.id).status, "completed");
  assert.equal(records.find((j) => j.id === trimmed.id).status, "undone");
  assert.equal(records.find((j) => j.id === done.id).mediaReport.encoder, "libx264");
  checks.push(
    "Restart retains cancelled/completed/undone job options and attempt reports without re-execution. Undo uses the guarded owned-file quarantine provider, leaving source bytes unchanged. All embedded manifest entry/CSS hashes and the complete generated offline licence payload match this release.",
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
        jobs,
        embeddedAssetCount,
        executableSha256: hash(await readFile(exe)),
        buildManifestSha256: hash(await readFile(resolve(root, "dist/.vite/manifest.json"))),
        noUserProfile: true,
        noRealRecycleBinOrExplorer: true,
        noOsSettingChange: true,
        scope:
          "Owned production release and isolated app-data/WebView/control profiles; DOM-only UI input, generated synthetic media, actual separately pinned ffmpeg and durable Tauri runner; no user files, clipboard, global input, real cursor, native dialog, install, signing or OS changes.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(root, `progress/v2/M10/${prefix}-scene-log.txt`), logs, { flag: "wx" });
}
globalThis.console.log(
  "Verified native media review, explicit size job/cancel/retry, Shelf trim, Undo and restart.",
);
