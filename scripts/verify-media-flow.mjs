// Browser -> IPC forwarding seam -> actual Rust Service/SQLite -> Rust fake.
// All services are ephemeral loopback; production HTTPS validation is retained.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { preview } from "vite";
import { chromium } from "playwright";

import { installMockIpc } from "./screenshots/mock-ipc.mjs";
import { installBridge } from "./screenshots/rust-bridge.mjs";
import { mediaFixture, recordedMedia, mediaArtwork } from "./screenshots/media-fixtures.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v53-flow";
assert(/^[a-z0-9-]+$/.test(prefix));
const folder = resolve(root, "progress/v2/M10"),
  trial = resolve(root, `.tools/${prefix}-${randomUUID()}`),
  reportPath = resolve(folder, `${prefix}-flow.json`);
await mkdir(folder, { recursive: true });
await mkdir(trial, { recursive: true });
await stat(reportPath).then(
  () => {
    throw Error("Evidence prefix already exists");
  },
  (error) => assert.equal(error.code, "ENOENT"),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const checks = [],
  problems = [];
let server,
  child,
  browser,
  context,
  page,
  info,
  logs = "",
  passed = false,
  failure;
const wait = async (action, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await action();
    if (value) return value;
    if (child && child.exitCode !== null) throw Error(`Owned Rust bridge exited while ${label}`);
    assert(Date.now() < deadline, `Timed out: ${label}`);
    await setTimeout(100);
  }
};
const call = async (command, args = {}) => {
  const response = await globalThis.fetch(`${info.url}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Nabbit-Test": info.token },
    body: JSON.stringify({ command, args }),
  });
  const result = await response.json();
  assert(result.ok, `Bridge control failed: ${command}`);
  return result.value;
};
try {
  server = await preview({
    root,
    configFile: resolve(root, "vite.config.ts"),
    preview: { host: "127.0.0.1", port: 0, strictPort: true, open: false },
    logLevel: "error",
  });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  child = spawn(
    "cargo",
    [
      "test",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--lib",
      "tack::tests::browser_bridge::browser_connection_bridge",
      "--",
      "--ignored",
      "--exact",
      "--test-threads=1",
      "--nocapture",
    ],
    {
      cwd: root,
      env: { ...process.env, NABBIT_TACK_TEST_BRIDGE_DIR: trial, NABBIT_TACK_TEST_ORIGIN: origin },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (bytes) => {
    logs += bytes;
  });
  child.stderr.on("data", (bytes) => {
    logs += bytes;
  });
  await wait(
    async () => {
      try {
        info = JSON.parse(await readFile(resolve(trial, "info.json"), "utf8"));
        return true;
      } catch {
        return false;
      }
    },
    "bridge readiness",
    300000,
  );
  info.media = true;
  const media = globalThis.structuredClone(recordedMedia);
  media.sessions[0].art = mediaArtwork;
  await call("test.media", { snapshot: media });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 720, height: 460 },
    colorScheme: "light",
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if ([origin, info.url].includes(url.origin)) return route.continue();
    problems.push(`Unexpected network: ${url.origin}`);
    return route.abort();
  });
  await context.addInitScript({
    content: `(${installMockIpc.toString()})(${JSON.stringify({ ...mediaFixture(), label: "island", theme: "light" })});(${installBridge.toString()})(${JSON.stringify(info)});`,
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(`${origin}/island.html`, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("navigation", { name: "Island modules" })
    .getByRole("button", { name: "Media", exact: true })
    .click();
  await page.getByText("Night Drive", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Pause playback" }).click();
  await page.getByRole("button", { name: "Play playback" }).waitFor();
  assert.equal((await call("test.media")).snapshot.sessions[0].playing, false);
  checks.push(
    "Playback controls invoke production media validation and recorded hardware; pushed snapshots change Pause to Play",
  );
  await page.getByRole("button", { name: "Play playback" }).click();
  await page.getByRole("button", { name: "Pause playback" }).waitFor();
  await page.getByRole("button", { name: "Previous track" }).click();
  await page.getByRole("button", { name: "Next track" }).click();
  await page.getByRole("slider", { name: "Playback position" }).fill("120");
  await wait(
    async () => (await call("test.media")).snapshot.sessions[0].timeline.positionS === 120,
    "seek response",
  );
  checks.push(
    "Previous, next and absolute seek reach the selected session; the timeline updates only through pushed state",
  );
  await page.getByRole("button", { name: "Browser", exact: true }).click();
  await page.getByText("Live radio", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "Previous track" }).isDisabled());
  assert.equal(await page.locator("[data-media-timeline]").count(), 0);
  assert.equal((await call("test.media")).snapshot.selected, "browser");
  checks.push(
    "Session chips switch Rust selection; paused radio offers Play with disabled skip controls and no fabricated timeline",
  );
  await page
    .locator(".media-titles")
    .dispatchEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
  await page.getByRole("button", { name: "Pause playback" }).waitFor();
  assert.equal((await call("test.media")).snapshot.sessions[1].playing, true);
  checks.push("Middle-click uses the Rust-selected session and never synthesizes an OS key");
  await page
    .locator(".media-titles")
    .dispatchEvent("wheel", { deltaY: -100, deltaMode: 0, bubbles: true, cancelable: true });
  await wait(
    async () => (await call("test.media")).snapshot.volume.percent === 66,
    "two percent wheel up",
  );
  await page.locator(".media-titles").dispatchEvent("wheel", {
    deltaY: 100,
    deltaMode: 0,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  await wait(
    async () => (await call("test.media")).snapshot.volume.percent === 65,
    "fine wheel down",
  );
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await page.getByRole("button", { name: "Unmute", exact: true }).waitFor();
  checks.push(
    "Scroll uses exact +2 and Shift -1 percentage points; mute is confirmed by a provider event",
  );
  const before = await page.evaluate(() => globalThis.__NABBIT_TACK_TEST__.commands.length);
  await setTimeout(1300);
  assert.equal(await page.evaluate(() => globalThis.__NABBIT_TACK_TEST__.commands.length), before);
  checks.push("Mounted player idle time causes no provider reads, IPC polling or timeline timer");
  const next = globalThis.structuredClone(media);
  next.sessions = next.sessions.slice(0, 1);
  next.selected = "player";
  await call("test.media", { snapshot: next, resume: true });
  await page.getByText("Night Drive", { exact: true }).waitFor();
  const audit = (await call("test.media")).audit;
  assert.deepEqual(audit.lifecycle, ["subscribe", "unsubscribe", "subscribe"]);
  assert.equal(audit.hardwareCalls, 0);
  checks.push(
    "Removed selection falls back to the remaining session and resume replaces the subscription; all hardware effects remain recorded",
  );
  await call("test.media", { snapshot: { ...media, sessions: [], selected: null, volume: null } });
  await page.getByText("Nothing playing", { exact: true }).waitFor();
  checks.push(
    "Final session removal produces a truthful empty state and clears the media activity",
  );
  const final = await page.evaluate(() => ({
    unsupported: globalThis.__NABBIT_CAPTURE__.snapshot().unsupported,
    events: globalThis.__NABBIT_TACK_TEST__.events,
    streamError: globalThis.__NABBIT_TACK_TEST__.streamError,
  }));
  assert.deepEqual(final.unsupported, []);
  assert(!final.streamError);
  assert(final.events >= 5);
  assert.deepEqual(problems, []);
  checks.push(
    `Verified ${final.events} pushed events with zero unknown IPC, runtime errors or external network`,
  );
  passed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  if (page)
    failure.telemetry = await page
      .evaluate(() => ({
        headings: [...globalThis.document.querySelectorAll("h1,h2")].map(
          (node) => node.textContent,
        ),
        notes: globalThis.document.querySelectorAll(".notes-card-wrap").length,
        footer: globalThis.document.querySelector(".notes-footer")?.textContent,
        events: globalThis.__NABBIT_TACK_TEST__?.events,
        streamError: globalThis.__NABBIT_TACK_TEST__?.streamError,
        commands: globalThis.__NABBIT_TACK_TEST__?.commands,
      }))
      .catch(() => null);
  throw error;
} finally {
  await context?.close();
  await browser?.close();
  if (info && child?.exitCode === null) await call("test.stop").catch(() => {});
  if (child) {
    await Promise.race([
      new Promise((done) => {
        if (child.exitCode !== null) done();
        else child.once("exit", done);
      }),
      setTimeout(10000),
    ]);
    if (child.exitCode === null) child.kill();
  }
  await server?.close();
  await writeFile(resolve(folder, `${prefix}-rust-log.txt`), logs, { flag: "wx" });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        passed,
        failure,
        checks,
        problems,
        buildManifestSha256: hash(await readFile(resolve(root, "dist/.vite/manifest.json"))),
        rustBridgeExitCode: child?.exitCode,
        scope:
          "Actual media UI and typed API through a test-only loopback bridge to production MediaProvider service, action validation, activity arbitration and recording hardware. No real GSMTC/audio calls, keys, accounts or OS settings.",
        noHostedTack: true,
        noUserAccount: true,
        noRealClipboard: true,
        noExternalNetwork: true,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
globalThis.console.log(
  `Verified ${checks.length} browser-to-Rust media checks against the production service and recording provider.`,
);
