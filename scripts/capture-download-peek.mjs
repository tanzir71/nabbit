import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { createServer } from "node:net";
import process from "node:process";
import { chromium } from "playwright";
import { auditFont } from "./font-audit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const prefix = process.argv[2] ?? "v37-peek";
assert(/^[a-z0-9-]+$/.test(prefix));
assert.equal(
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", "@(Get-Process nabbit -ErrorAction SilentlyContinue).Count"],
    { encoding: "utf8", windowsHide: true },
  ).trim(),
  "0",
);
const trial = resolve(root, `.tools/${prefix}-${randomUUID()}`),
  control = resolve(trial, "control"),
  folder = resolve(root, "progress/v2/M7");
await mkdir(control, { recursive: true });
const url = "https://www.youtube.com/watch?v=fixture";
const metadata = {
  url,
  normalizedUrl: url,
  title: "Tiny tray app in Rust, full walkthrough",
  channel: "Ferris Builds",
  duration: 768,
  thumbnail: null,
  isPlaylist: false,
  playlistCount: null,
  extractor: "acceptance",
  qualities: [{ height: 1080, estimatedBytes: 420000000 }],
  details: { chapters: [], thumbnails: [], entries: [], truncated: false },
  livePending: false,
};
await writeFile(resolve(trial, "fixture.json"), JSON.stringify({ metadata: { [url]: metadata } }));
await writeFile(
  resolve(trial, "layout.json"),
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
    cursor: { x: 960, y: 20 },
  }),
);
await writeFile(resolve(trial, "cursor.json"), JSON.stringify({ x: 960, y: 20, leftDown: false }));
const server = createServer();
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
await new Promise((done) => server.close(done));
const executable = resolve(root, "src-tauri/target/release/nabbit.exe");
const app = spawn(executable, [], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    NABBIT_APP_DATA_DIR: resolve(trial, "data"),
    NABBIT_ACCEPTANCE_COMMAND_DIR: control,
    NABBIT_ACCEPTANCE_FAKE_DOWNLOAD: "1",
    NABBIT_DOWNLOAD_ACCEPTANCE: "1",
    NABBIT_ACCEPTANCE_CLIPBOARD_PROVIDER: "1",
    NABBIT_ACCEPTANCE_DOWNLOAD_FIXTURE: resolve(trial, "fixture.json"),
    NABBIT_ISLAND_ACCEPTANCE: "1",
    NABBIT_ISLAND_LAYOUT: resolve(trial, "layout.json"),
    NABBIT_ACCEPTANCE_CURSOR: resolve(trial, "cursor.json"),
    WEBVIEW2_USER_DATA_FOLDER: resolve(trial, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  },
});
let log = "",
  browser;
for (const stream of [app.stdout, app.stderr])
  stream.on("data", (data) => {
    log += data;
  });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function wait(fn, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    assert.equal(app.exitCode, null, log);
    await setTimeout(75);
  }
  throw new Error(`Timed out: ${label}; ${trial}`);
}
async function request(kind, fields) {
  const id = randomUUID(),
    path = resolve(control, `${kind}-request.json`);
  await writeFile(`${path}.tmp`, JSON.stringify({ id, ...fields }));
  await rename(`${path}.tmp`, path);
  return wait(async () => {
    try {
      const result = JSON.parse(await readFile(resolve(control, `${kind}-response.json`), "utf8"));
      if (result.id !== id) return false;
      assert.equal(result.error, null);
      return result;
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  }, `${kind} response`);
}
try {
  await request("island", { prepareTray: true, gate: "visible" });
  // Bootstrap the lazy WebView with an ongoing fact before the link's exposure
  // deadline starts. Remove this fixture before capturing the actual review.
  await request("island", {
    activity: [
      { kind: "timerTick", id: "capture-bootstrap", label: "Capture fixture", remainingS: 1440 },
    ],
    surface: { label: "island", state: "peek" },
  });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await wait(async () => {
    for (const page of browser.contexts().flatMap((c) => c.pages()))
      if (
        (await page
          .evaluate(() => globalThis.__TAURI_INTERNALS__?.metadata.currentWindow.label)
          .catch(() => null)) === "island"
      )
        return page;
    return false;
  }, "island WebView");
  await request("downloads", { operation: { kind: "capture", url } });
  await request("island", {
    activity: [{ kind: "dismissed", id: "timer:capture-bootstrap" }],
    surface: { label: "island", state: "peek" },
  });
  await page.getByText(metadata.title, { exact: true }).waitFor();
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: 460,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await session.send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready;
    for (let pass = 0; pass < 5; pass++) {
      await Promise.all(globalThis.document.getAnimations().map((a) => a.finished.catch(() => {})));
      await new Promise(globalThis.requestAnimationFrame);
    }
  });
  await request("downloads", { operation: { kind: "capture", url } });
  await request("island", { surface: { label: "island", state: "peek" } });
  await wait(async () => {
    const state = (await request("island", {})).snapshot.surfaces.island;
    const box = await page.locator(".island-morph").boundingBox();
    return state.state === "peek" && state.webOwner && box?.width === 400 && box.height === 100;
  }, "settled Peek paint ownership");
  const geometry = await page.locator(".island-morph").boundingBox();
  assert.deepEqual(geometry, { x: 160, y: 6, width: 400, height: 100 });
  const fonts = await auditFont(page, ".island-peek-header strong", "Geist");
  const options = {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { x: 144, y: 0, width: 432, height: 140, scale: 1 },
  };
  const capture = async () =>
    Buffer.from((await session.send("Page.captureScreenshot", options)).data, "base64");
  const bytes = await capture(),
    repeated = await capture();
  assert.equal(hash(bytes), hash(repeated));
  assert.equal(bytes.readUInt32BE(16), 864);
  assert.equal(bytes.readUInt32BE(20), 280);
  assert(bytes.length <= 300000);
  const file = `${prefix}@2x.png`;
  await writeFile(resolve(folder, file), bytes, { flag: "wx" });
  const state = (await request("downloads", { operation: { kind: "snapshot" } })).result;
  assert.equal(state.jobs.length, 0);
  await writeFile(
    resolve(folder, `${prefix}.json`),
    JSON.stringify(
      {
        file,
        sha256: hash(bytes),
        bytes: bytes.length,
        width: 864,
        height: 280,
        scale: 2,
        clip: options.clip,
        geometry,
        fonts,
        repeatMatches: true,
        state,
        source:
          "Owned release island WebView2 with real Rust capture/metadata and fixture providers",
        executableSha256: hash(await readFile(executable)),
        trial,
        noRealBrowserProfile: true,
        noSystemClipboard: true,
        noGlobalKeys: true,
        noDisplayChanges: true,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  globalThis.console.log(`Captured native download Peek: ${bytes.length} bytes`);
} catch (error) {
  const pages = browser
    ? await Promise.all(
        browser
          .contexts()
          .flatMap((c) => c.pages())
          .map(async (page) => ({
            url: page.url(),
            state: await Promise.race([
              page
                .evaluate(() => ({
                  metadata: globalThis.__TAURI_INTERNALS__?.metadata,
                  ready: globalThis.document.readyState,
                  title: globalThis.document.title,
                  body: globalThis.document.body?.textContent?.slice(0, 1500),
                }))
                .catch(String),
              setTimeout(3000, "unresponsive", { ref: false }),
            ]),
          })),
      )
    : [];
  const targets = await globalThis
    .fetch(`http://127.0.0.1:${port}/json/list`)
    .then((r) => r.json())
    .catch(String);
  await writeFile(
    resolve(folder, `${prefix}-failure-${randomUUID()}.json`),
    JSON.stringify(
      {
        error: error.stack,
        trial,
        pages,
        targets,
        snapshot: await request("island", {}).catch(String),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  throw error;
} finally {
  if (app.exitCode === null) {
    try {
      execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "pipe",
      });
    } catch (error) {
      log += error.stderr ?? error.message;
    }
    const end = Date.now() + 10000;
    while (app.exitCode === null && Date.now() < end) await setTimeout(50);
    assert.notEqual(app.exitCode, null);
  }
  if (browser) await browser.close().catch(() => {});
  await writeFile(resolve(trial, "app.log"), log);
}
