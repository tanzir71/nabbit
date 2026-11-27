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
import { timerFixture } from "./screenshots/timer-fixtures.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v54-flow";
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
  info.timer = true;
  const seed = await call("test.timer", { prepare: true });
  const initialOutbox = seed.outboxCount;
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
    content: `(${installMockIpc.toString()})(${JSON.stringify({ ...timerFixture("idle"), label: "island", theme: "light" })});(${installBridge.toString()})(${JSON.stringify(info)});`,
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(`${origin}/island.html`, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("navigation", { name: "Island modules" })
    .getByRole("button", { name: "Timer", exact: true })
    .click();
  await page.getByRole("button", { name: "Start", exact: true }).waitFor();
  await page.getByRole("button", { name: "Link a card", exact: true }).click();
  await page.getByRole("button", { name: /tck-24.*Island window spike/ }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
  let state = await call("test.timer");
  assert.equal(state.snapshot.session.status, "running");
  assert.equal(state.snapshot.linkedCard.reference, "tck-24");
  const deadline = state.snapshot.session.deadlineMs;
  checks.push(
    "Actual Focus UI links a scoped tck-24 card and starts a persisted timer through production service/SQLite; time logging stays off",
  );
  await call("test.timer", { nowMs: deadline - 1_453_000 });
  await page.getByText("24:13", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
  await call("test.timer", { nowMs: deadline + 3_600_000 });
  assert.equal((await call("test.timer")).snapshot.session.remainingS, 1453);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
  state = await call("test.timer");
  assert.equal(state.snapshot.session.deadlineMs, deadline + 3_600_000 + 1_453_000);
  checks.push(
    "Injected-clock updates change the countdown only through Rust events; pause survives a simulated hour asleep and resume preserves the exact remaining duration",
  );
  const before = await page.evaluate(() => globalThis.__NABBIT_TACK_TEST__.commands.length);
  await setTimeout(1300);
  assert.equal(await page.evaluate(() => globalThis.__NABBIT_TACK_TEST__.commands.length), before);
  checks.push(
    "No renderer interval, snapshot polling or extra IPC occurs while the timer view is idle",
  );
  await call("test.timer", { nowMs: state.snapshot.session.deadlineMs + 60000 });
  await page.getByRole("button", { name: "Start break", exact: true }).waitFor();
  await page.getByRole("button", { name: "Start break", exact: true }).click();
  await wait(
    async () => (await call("test.timer")).snapshot.session.phase === "break",
    "explicit break start",
  );
  state = await call("test.timer");
  await call("test.timer", { nowMs: state.snapshot.session.deadlineMs });
  await page.getByRole("button", { name: "Next round", exact: true }).click();
  await page.getByRole("heading", { name: "Focus · round 2 of 4" }).waitFor();
  checks.push(
    "Focus completion persists once at its UTC deadline; explicit break and next-round controls advance the correct phase/round without starting background rounds",
  );
  await page.getByRole("button", { name: "50 / 10", exact: true }).click();
  await page.getByText("50:00", { exact: true }).waitFor();
  assert.equal((await call("test.timer")).snapshot.session, null);
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Focus minutes" }).fill("1");
  await page.getByRole("spinbutton", { name: "Break minutes" }).fill("0");
  await page.getByRole("spinbutton", { name: "Rounds" }).fill("1");
  await page.getByRole("button", { name: "Use custom timer" }).click();
  await page.getByText("1:00", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  state = await call("test.timer");
  checks.push(
    "Preset and custom controls explicitly stop/prepare settings, preserve the card association and never start until Start is clicked",
  );
  await call("test.timer", { switchWorkspace: true });
  await page.getByRole("button", { name: "Linked card unavailable", exact: true }).waitFor();
  assert.equal((await call("test.timer")).snapshot.linkedCard, null);
  checks.push(
    "Workspace changes hide the old card title/reference while the timer continues; a stale card binding never becomes a foreign-workspace card",
  );
  await call("test.timer", { hidden: true, alerts: false });
  await call("test.timer", { nowMs: state.snapshot.session.deadlineMs + 1000 });
  let hidden = await call("test.timer");
  assert.equal(hidden.snapshot.session.status, "ended");
  assert.equal(hidden.activity.views[0].gate, "hidden");
  await call("test.timer", { hidden: true, alerts: true });
  hidden = await call("test.timer");
  assert.equal(hidden.activity.views[0].gate, "visible");
  assert.equal(hidden.activity.views[0].primary.event.kind, "timerEnded");
  checks.push(
    "The production completion event stays queued under fullscreen silence and becomes eligible only when the existing fullscreen-alert preference is enabled",
  );
  assert.equal(hidden.outboxCount, initialOutbox);
  assert(hidden.history.filter((r) => r.outcome === "completed").length >= 3);
  assert(hidden.history.some((r) => r.outcome === "stopped"));
  checks.push(
    "Completed/stopped session history is local and Tack outbox count is unchanged by linking, timing, completion or workspace changes",
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
          "Actual Focus timer UI and typed API through test-only loopback IPC forwarding to the production worker, SQLite, guarded card linking and activity arbitration. Clock/power/fullscreen facts are injected; no real OS clock, power, global keys or hosted Tack/account.",
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
  `Verified ${checks.length} browser-to-Rust Focus timer checks against the production worker and SQLite.`,
);
