import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { createServer } from "node:net";
import process from "node:process";
import { chromium } from "playwright";
import { auditFont } from "./font-audit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const executable = resolve(root, process.argv[2] ?? "src-tauri/target/release/nabbit.exe");
const prefix = process.argv[3] ?? "v37-native";
assert(/^[a-z0-9-]+$/.test(prefix));
const folder = resolve(root, "progress/v2/M7"),
  trial = resolve(root, `.tools/${prefix}-${randomUUID()}`),
  control = resolve(trial, "control");
await mkdir(control, { recursive: true });
await mkdir(folder, { recursive: true });
const reportPath = resolve(folder, `${prefix}-downloads.json`);
await stat(reportPath).then(
  () => {
    throw new Error("Evidence prefix already exists");
  },
  (error) => {
    assert.equal(error.code, "ENOENT");
  },
);
const existing = execFileSync(
  "powershell.exe",
  ["-NoProfile", "-Command", "@(Get-Process -Name nabbit -ErrorAction SilentlyContinue).Count"],
  { encoding: "utf8", windowsHide: true },
).trim();
assert.equal(existing, "0", "An existing Nabbit process is left untouched");
const url = "https://www.youtube.com/watch?v=fixture",
  playlist = "https://www.youtube.com/playlist?list=fixture";
const loFi = "https://www.youtube.com/watch?v=capture_lofi",
  doneUrl = "https://www.youtube.com/watch?v=capture_done",
  memberUrl = "https://www.youtube.com/watch?v=capture_member";
const base = {
  url,
  normalizedUrl: url,
  title: "Tiny tray app in Rust, full walkthrough",
  channel: "Ferris Builds",
  duration: 768,
  thumbnail: null,
  isPlaylist: false,
  playlistCount: null,
  extractor: "acceptance",
  qualities: [
    { height: 1080, estimatedBytes: 420000000 },
    { height: 720, estimatedBytes: 210000000 },
  ],
  details: { chapters: [], thumbnails: [], entries: [], truncated: false },
  livePending: false,
};
const entries = Array.from({ length: 18 }, (_, index) => ({
  index: index + 1,
  url: `https://www.youtube.com/watch?v=playlist_${index + 1}`,
  title: `Fixture playlist video ${index + 1}`,
  duration: 120 + index * 10,
  thumbnail: null,
  qualities: [{ height: 720, estimatedBytes: 12000000 }],
}));
const fixture = {
  metadata: {
    [url]: base,
    [playlist]: {
      ...base,
      url: playlist,
      normalizedUrl: playlist,
      title: "Creative Commons short films",
      isPlaylist: true,
      playlistCount: 18,
      details: { ...base.details, entries },
    },
    [loFi]: {
      ...base,
      url: loFi,
      normalizedUrl: loFi,
      title: "Lofi beats to code to (2 hour mix)",
    },
    [doneUrl]: {
      ...base,
      url: doneUrl,
      normalizedUrl: doneUrl,
      title: "Creative Commons short film, part 1",
    },
    [memberUrl]: {
      ...base,
      url: memberUrl,
      normalizedUrl: memberUrl,
      title: "Members-only livestream replay",
    },
  },
  failures: {
    [entries[2].url]: ["ERROR: Requested format is not available"],
    [memberUrl]: ["ERROR: Sign in to confirm you’re not a bot"],
  },
  holdAt62: [loFi],
  onlineUrls: [],
};
for (const entry of entries)
  fixture.metadata[entry.url] = {
    ...base,
    url: entry.url,
    normalizedUrl: entry.url,
    title: entry.title,
    duration: entry.duration,
  };
const fixturePath = resolve(trial, "fixture.json");
await writeFile(fixturePath, JSON.stringify(fixture));
const checks = [],
  events = [],
  screenshots = [];
let app,
  browser,
  page,
  endpoint,
  appLog = "",
  environment;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const wait = async (fn, label, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    if (app?.exitCode !== null) throw new Error(`Owned app exited: ${appLog}`);
    await setTimeout(100);
  }
  throw new Error(`Timed out: ${label}; trial=${trial}`);
};
async function rpc(operation, allowError = false) {
  const id = randomUUID(),
    path = resolve(control, "downloads-request.json");
  await writeFile(`${path}.tmp`, JSON.stringify({ id, operation }));
  await rename(`${path}.tmp`, path);
  const response = await wait(async () => {
    try {
      const value = JSON.parse(await readFile(resolve(control, "downloads-response.json"), "utf8"));
      return value.id === id && value;
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  }, operation.kind);
  if (!allowError) assert.equal(response.error, null, JSON.stringify(response));
  return allowError ? response : response.result;
}
const snapshot = () => rpc({ kind: "snapshot" });
async function record(name) {
  const state = await snapshot();
  checks.push({ name, state });
  return state;
}
async function jobsSettled(ids) {
  return wait(
    async () => {
      const state = await snapshot();
      return (
        ids.every((id) =>
          state.jobs.some(
            (job) =>
              job.id === id && ["completed", "failed", "cancelled", "paused"].includes(job.status),
          ),
        ) && state
      );
    },
    "terminal queue rows",
    20000,
  );
}
async function launch() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  endpoint = `http://127.0.0.1:${port}`;
  environment = {
    ...process.env,
    NABBIT_APP_DATA_DIR: resolve(trial, "app-data"),
    NABBIT_ACCEPTANCE_COMMAND_DIR: control,
    NABBIT_ACCEPTANCE_FAKE_DOWNLOAD: "1",
    NABBIT_DOWNLOAD_ACCEPTANCE: "1",
    NABBIT_ACCEPTANCE_CLIPBOARD_PROVIDER: "1",
    NABBIT_ACCEPTANCE_DOWNLOAD_FIXTURE: fixturePath,
    NABBIT_ACCEPTANCE_FAKE_DOWNLOAD_DELAY_MS: "120",
    WEBVIEW2_USER_DATA_FOLDER: resolve(trial, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  };
  delete environment.NABBIT_ISLAND_SPIKE;
  delete environment.NABBIT_ISLAND_ACCEPTANCE;
  app = spawn(executable, [], {
    cwd: root,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [app.stdout, app.stderr])
    stream.on("data", (value) => {
      appLog += value.toString();
    });
  await wait(
    async () => {
      try {
        return (await globalThis.fetch(`${endpoint}/json/version`)).ok;
      } catch {
        return false;
      }
    },
    "owned WebView2 endpoint",
    30000,
  );
  browser = await chromium.connectOverCDP(endpoint);
  for (const target of browser.contexts().flatMap((context) => context.pages())) {
    target.on("pageerror", (error) => {
      appLog += `\nRenderer: ${error.stack}`;
    });
    appLog += `\nCDP page: ${target.url()}`;
  }
  page = await wait(
    async () => {
      for (const target of browser.contexts().flatMap((context) => context.pages())) {
        const label = await target
          .evaluate(() => globalThis.__TAURI_INTERNALS__?.metadata?.currentWindow?.label)
          .catch(() => null);
        if (label === "main") return target;
      }
      return false;
    },
    "owned tray page",
    45000,
  );
  await rpc({
    kind: "settings",
    patch: {
      outputDir: resolve(trial, "downloads"),
      maxConcurrentDownloads: 1,
      theme: "light",
      sensitiveHeuristics: true,
      showDetectNotification: false,
      revealAfterDownload: false,
      engineAutoUpdate: false,
      firstRunAcknowledged: true,
    },
  });
  const settings = await page.evaluate(() => globalThis.__TAURI_INTERNALS__.invoke("get_settings"));
  assert.equal(settings.outputDir, resolve(trial, "downloads"));
  await page.evaluate(async () => {
    globalThis.__downloadAcceptanceEvents = [];
    await globalThis.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
      event: "download:updated",
      target: { kind: "Any" },
      handler: globalThis.__TAURI_INTERNALS__.transformCallback((message) =>
        globalThis.__downloadAcceptanceEvents.push(message.payload),
      ),
    });
  });
}
async function stop() {
  if (page && !page.isClosed())
    events.push(
      ...(await page.evaluate(() => globalThis.__downloadAcceptanceEvents ?? []).catch(() => [])),
    );
  if (app?.exitCode === null) {
    try {
      execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "pipe",
      });
    } catch (error) {
      appLog += `\nOwned tree cleanup: ${error.stderr?.toString() ?? error.message}`;
    }
    const end = Date.now() + 10000;
    while (app.exitCode === null && Date.now() < end) await setTimeout(50);
    assert.notEqual(app.exitCode, null, "Owned app did not exit after cleanup");
  }
  if (browser) await browser.close().catch(() => {});
  browser = null;
  page = null;
}
async function invoke(command, args) {
  return Promise.race([
    page.evaluate(({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    }),
    setTimeout(15000, undefined, { ref: false }).then(() => {
      throw new Error(`IPC deadline: ${command}`);
    }),
  ]);
}
try {
  await launch();
  await record("isolated native process ready");
  const before = (await snapshot()).jobs.length;
  await rpc({
    kind: "clipboard",
    text: "https://youtu.be/fixture",
    sourceApp: "Acceptance.exe",
    protected: false,
  });
  await wait(async () => (await snapshot()).captured?.title === base.title, "clipboard enrichment");
  assert.equal((await snapshot()).jobs.length, before);
  await record("clipboard producer stages without enqueue");
  await rpc({
    kind: "clipboard",
    text: "https://example.invalid/protected",
    sourceApp: "Acceptance.exe",
    protected: true,
  });
  assert.equal((await snapshot()).captured.normalizedUrl, url);
  assert.equal((await snapshot()).jobs.length, before);
  const dropUrl = "https://example.invalid/nabbit/drop";
  await page.locator(".nab-tray-body").evaluate((target, url) => {
    const data = new globalThis.DataTransfer();
    data.setData("text/uri-list", url);
    target.dispatchEvent(
      new globalThis.DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }),
    );
  }, dropUrl);
  await wait(
    async () => (await snapshot()).captured?.normalizedUrl === dropUrl,
    "native synthetic tray drop",
  );
  assert.equal((await snapshot()).jobs.length, before);
  await record("synthetic drop uses native capture without enqueue");
  for (const uri of [
    "nabbit://nab",
    "nabbit://other?url=https://example.invalid/",
    "nabbit://nab?url=javascript%3Aalert(1)",
    "nabbit://nab?url=file%3A%2F%2FC%3A%2Fsecret",
    "nabbit://nab?url=https://example.invalid/&download=1",
  ]) {
    assert((await rpc({ kind: "deepLink", uri }, true)).error);
    assert.equal((await snapshot()).jobs.length, before);
  }
  const deepUrl = "https://example.invalid/nabbit/forwarded",
    deepUri = `nabbit://nab?url=${encodeURIComponent(deepUrl)}`;
  const forwarding = spawn(executable, [deepUri], {
    cwd: root,
    env: environment,
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise((done, reject) => {
    forwarding.once("exit", done);
    forwarding.once("error", reject);
  });
  await wait(
    async () => (await snapshot()).captured?.normalizedUrl === deepUrl,
    "real second-instance URI forwarding",
  );
  assert.equal((await snapshot()).jobs.length, before);
  const forwarded = await wait(async () => {
    const state = await snapshot();
    return state.captured?.extractor === "acceptance" && state.captured;
  }, "forwarded link metadata");
  await page.getByRole("heading", { name: forwarded.title, exact: true }).waitFor();
  await record("valid forwarded deep link opens review without enqueue");

  const preset = { format: "m4a", height: null, embedMetadata: true, speedLimit: "2M" };
  await rpc({ kind: "preset", url, options: preset });
  await stop();
  await launch();
  const hot = await rpc({ kind: "hotkey", text: "https://youtu.be/fixture" });
  assert.equal(hot.options.format, "m4a");
  assert.equal(hot.options.speedLimit, "2M");
  await jobsSettled([hot.id]);
  assert.equal((await snapshot()).jobs.length, before + 1);
  assert((await rpc({ kind: "hotkey", text: "javascript:alert(1)" }, true)).error);
  await record("remembered site preset survives restart and explicit hotkey enqueues it");

  await rpc({ kind: "settings", patch: { maxConcurrentDownloads: 2 } });
  const race = await rpc({
    kind: "start",
    request: { url: "https://example.invalid/nabbit/race", quality: "1080p" },
  });
  await wait(
    async () => (await snapshot()).jobs.find((j) => j.id === race.id)?.status === "running",
    "race worker starts",
  );
  await rpc({ kind: "control", id: race.id, action: "pause" });
  await rpc({ kind: "control", id: race.id, action: "resume" });
  await rpc({ kind: "control", id: race.id, action: "cancel" });
  await rpc({ kind: "control", id: race.id, action: "retry" });
  const raceEnd = await jobsSettled([race.id]);
  assert.equal(raceEnd.jobs.find((j) => j.id === race.id).status, "completed");
  await wait(async () => (await snapshot()).queue.activeWorkers === 0, "all stale workers drained");
  const raceState = await record("rapid pause/resume/cancel/retry isolates old workers");
  assert(raceState.queue.epochs[race.id] >= 4);

  await rpc({ kind: "settings", patch: { maxConcurrentDownloads: 1 } });
  const beforePlaylist = new Set((await snapshot()).jobs.map((job) => job.id));
  await rpc({ kind: "capture", url: playlist });
  await wait(
    async () => (await snapshot()).captured?.details?.entries.length === 18,
    "playlist fixture metadata",
  );
  await invoke("open_download_sheet", {
    draft: {
      kind: "playlist",
      url: playlist,
      options: { format: "mp4", height: 720, playlistMode: "playlist", playlistItems: "1-5" },
      remember: false,
    },
  });
  const sheet = await wait(async () => {
    for (const target of browser.contexts().flatMap((context) => context.pages())) {
      if (
        (await target
          .evaluate(() => globalThis.__TAURI_INTERNALS__?.metadata.currentWindow.label)
          .catch(() => null)) === "download-sheet"
      )
        return target;
    }
    return false;
  }, "owned native playlist sheet");
  await sheet.getByRole("button", { name: "Download 5", exact: true }).click();
  const batch = await wait(async () => {
    const jobs = (await snapshot()).jobs.filter((job) => !beforePlaylist.has(job.id));
    return jobs.length === 5 && jobs;
  }, "native sheet enqueued five distinct videos");
  assert.equal(batch.length, 5);
  assert.equal(new Set(batch.map((j) => j.id)).size, 5);
  // History is newest-first; compare membership in the playlist's source order.
  batch.sort(
    (a, b) => entries.findIndex((e) => e.url === a.url) - entries.findIndex((e) => e.url === b.url),
  );
  assert.deepEqual(
    batch.map((j) => j.url),
    entries.slice(0, 5).map((e) => e.url),
  );
  let activeMaximum = 0;
  await wait(
    async () => {
      const state = await snapshot();
      activeMaximum = Math.max(activeMaximum, state.queue.activeWorkers);
      assert(state.queue.activeWorkers <= 1);
      return (
        batch.every((j) =>
          state.jobs.some((row) => row.id === j.id && ["failed", "completed"].includes(row.status)),
        ) && state
      );
    },
    "playlist range 1-5",
    20000,
  );
  const failed = (await snapshot()).jobs.find((j) => j.id === batch[2].id);
  assert.equal(failed.failure.kind, "FormatUnavailable");
  const others = (await snapshot()).jobs
    .filter((j) => batch.some((b) => b.id === j.id) && j.id !== failed.id)
    .map((j) => ({ id: j.id, updatedAt: j.updatedAt, outputPath: j.outputPath }));
  await rpc({ kind: "control", id: failed.id, action: "retry" });
  await jobsSettled([failed.id]);
  const after = (await snapshot()).jobs;
  assert.equal(after.find((j) => j.id === failed.id).status, "completed");
  for (const old of others)
    assert.deepEqual(
      {
        id: old.id,
        updatedAt: after.find((j) => j.id === old.id).updatedAt,
        outputPath: after.find((j) => j.id === old.id).outputPath,
      },
      old,
    );
  for (const row of after.filter((j) => batch.some((b) => b.id === j.id))) {
    assert.equal(row.options.height, 720);
    assert.equal(row.playlistMode, "video");
    assert((await stat(row.outputPath)).size > 0);
  }
  checks.push({
    name: "playlist range 1-5 and independent per-item retry",
    activeMaximum,
    state: await snapshot(),
  });
  await stop();
  await launch();
  for (const row of batch)
    assert.equal((await snapshot()).jobs.find((j) => j.id === row.id).status, "completed");
  await record("playlist item history survives native process restart");

  for (const row of (await snapshot()).jobs)
    if (row.status !== "completed") await rpc({ kind: "control", id: row.id, action: "cancel" });
  await invoke("clear_finished_downloads");
  await rpc({ kind: "preset", url, options: { format: "mp4", height: 1080 } });
  await rpc({ kind: "settings", patch: { maxConcurrentDownloads: 2 } });
  const member = await rpc({
    kind: "start",
    request: { url: memberUrl, options: { format: "mp4", height: 720 } },
  });
  await jobsSettled([member.id]);
  const completed = await rpc({
    kind: "start",
    request: { url: doneUrl, options: { format: "mp4", height: 720 } },
  });
  await jobsSettled([completed.id]);
  const running = await rpc({
    kind: "start",
    request: { url: loFi, options: { format: "mp3", height: null } },
  });
  await wait(
    async () => (await snapshot()).jobs.find((j) => j.id === running.id)?.progress === 62,
    "fixture live progress hold",
  );
  await rpc({ kind: "capture", url });
  await rpc({ kind: "show" });
  await page.getByRole("heading", { name: base.title, exact: true }).waitFor();
  await page.getByRole("button", { name: "Use Chrome sign-in", exact: true }).waitFor();
  await wait(async () => !(await snapshot()).engine.busy, "local engine probes finish", 35000);
  await page.waitForFunction(() => globalThis.document.documentElement.dataset.theme === "light");
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 460,
    height: 680,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.evaluate(async () => {
    globalThis.document.activeElement?.blur();
    await globalThis.document.fonts.ready;
    await Promise.all([...globalThis.document.images].map((image) => image.decode()));
  });
  const box = await page.locator(".tray-popover").boundingBox();
  assert.deepEqual(box, { x: 0, y: 0, width: 460, height: 680 });
  const fonts = await auditFont(page, ".nab-details h2", "Geist");
  const mono = await auditFont(page, ".nab-job-progress", "Geist Mono");
  // WebView2's Playwright element helper resets device metrics while clipping.
  // Capture directly through CDP and verify the emitted PNG's actual dimensions.
  const capture = async () =>
    Buffer.from(
      (
        await session.send("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 460, height: 680, scale: 1 },
        })
      ).data,
      "base64",
    );
  const bytes = await capture();
  assert.equal(hash(await capture()), hash(bytes));
  assert.equal(bytes.readUInt32BE(16), 920);
  assert.equal(bytes.readUInt32BE(20), 1360);
  assert(bytes.length <= 300000);
  const filename = `${prefix}-tray-light@2x.png`;
  await writeFile(resolve(folder, filename), bytes, { flag: "wx" });
  screenshots.push({
    file: filename,
    sha256: hash(bytes),
    bytes: bytes.length,
    width: 920,
    height: 1360,
    scale: 2,
    cssBox: box,
    fonts,
    mono,
    repeatMatches: true,
    source: "owned release WebView2 with real IPC and isolated Rust fixture providers",
  });
  await writeFile(resolve(control, "release-downloads"), "");
  await jobsSettled([running.id]);
  await record("real tray renderer capture, explicit review and queue states");
  events.push(...(await page.evaluate(() => globalThis.__downloadAcceptanceEvents ?? [])));
  const report = {
    executable,
    executableSha256: hash(await readFile(executable)),
    buildManifestSha256: hash(await readFile(resolve(root, "dist/.vite/manifest.json"))),
    trial,
    checks,
    events,
    screenshots,
    noRealBrowserProfile: true,
    noSystemClipboard: true,
    noGlobalKeypresses: true,
    noProtocolRegistration: true,
    source:
      "real owned app processes, SQLite, Tauri IPC, single-instance forwarding and the v0.1 fake runner",
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  globalThis.console.log(`Verified ${checks.length} native downloader cases; trial=${trial}`);
} catch (error) {
  const pages = browser
    ? await Promise.all(
        browser
          .contexts()
          .flatMap((context) => context.pages())
          .map(async (target) => ({
            url: target.url(),
            state: await Promise.race([
              target
                .evaluate(() => ({
                  ready: globalThis.document.readyState,
                  metadata: globalThis.__TAURI_INTERNALS__?.metadata,
                  title: globalThis.document.title,
                  body: globalThis.document.body?.textContent?.slice(0, 2000),
                }))
                .catch(String),
              setTimeout(3000, "Renderer unresponsive", { ref: false }),
            ]),
          })),
      )
    : [];
  await writeFile(
    resolve(folder, `${prefix}-failure.json`),
    JSON.stringify(
      {
        error: error.stack,
        trial,
        checks,
        events,
        screenshots,
        pages,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  throw error;
} finally {
  await stop();
  await writeFile(resolve(trial, "app.log"), appLog);
}
