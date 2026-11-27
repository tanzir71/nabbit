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
import { clipboardFixture } from "./screenshots/clipboard-fixtures.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v51-flow";
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
  info.clipboard = true;
  await call("test.clipboard", { seed: true });
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
    const target = new URL(route.request().url());
    if ([origin, info.url].includes(target.origin)) return route.continue();
    problems.push(`Unexpected network: ${target.origin}`);
    return route.abort();
  });
  await context.addInitScript({
    content: `(${installMockIpc.toString()})(${JSON.stringify({ ...clipboardFixture(), label: "island", theme: "light" })});(${installBridge.toString()})(${JSON.stringify(info)});`,
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(`${origin}/island.html`, { waitUntil: "domcontentloaded" });
  const tab = page
    .getByRole("navigation", { name: "Island modules" })
    .getByRole("button", { name: "Clipboard", exact: true });
  await tab.click();
  const grid = page.getByRole("grid", { name: "Clipboard history" }),
    rows = grid.locator("[data-clipboard-id]"),
    search = page.getByRole("combobox", { name: "Search clipboard" });
  await wait(async () => (await rows.count()) === 5, "SQLite history read");
  const read = () => call("test.clipboard");
  let state = await read();
  const url = state.rows.find((e) => e.contentType === "url"),
    path = state.rows.find((e) => e.contentType === "file");
  assert.equal(state.calls.length, 0);
  checks.push(
    "Opening reads the existing SQLite history and storage count without OS clipboard, file or input access",
  );
  await tab.focus();
  await page.keyboard.press("2");
  await wait(async () => (await read()).calls.length === 1, "number copy");
  state = await read();
  assert.equal(state.calls[0], `copy:${url.content}`);
  assert.notEqual(state.rows.find((entry) => entry.id === url.id).lastUsedAt, url.lastUsedAt);
  await page.getByText("Copied", { exact: true }).waitFor();
  assert.equal(await page.locator('[aria-label="Search island"]').count(), 0);
  checks.push(
    "Bare 2 copies the second filtered item exactly and touches real history before the global search router",
  );
  const filters = page.getByRole("group", { name: "Clipboard filters" });
  for (const [filter, count] of [
    ["Text", 2],
    ["Links", 1],
    ["Images", 1],
    ["Files", 1],
    ["Pinned", 1],
    ["All", 5],
  ]) {
    await filters.getByRole("button", { name: filter, exact: true }).click();
    assert.equal(await rows.count(), count);
  }
  await tab.focus();
  await page.keyboard.press("Control+f");
  assert(await search.evaluate((e) => e === globalThis.document.activeElement));
  await search.fill("2027");
  assert.equal(await rows.count(), 1);
  await search.fill("");
  checks.push(
    "All six filters use actual history types and pin flags; Ctrl+F and numeric fuzzy queries do not pick",
  );
  await filters.getByRole("button", { name: "Links", exact: true }).click();
  await grid.getByRole("button", { name: /^Pin / }).click();
  await wait(async () => (await read()).rows.find((e) => e.id === url.id).pinned, "pin persisted");
  await filters.getByRole("button", { name: "Pinned", exact: true }).click();
  await wait(async () => (await rows.count()) === 2, "pinned refresh");
  await call("toggle_pin_clipboard_entry", { id: url.id });
  await wait(async () => (await rows.count()) === 1, "pushed external mutation");
  checks.push(
    "Pin mutates the v0.1 SQLite row; an external bridge mutation pushes clipboard:changed and refreshes the island without polling",
  );
  await filters.getByRole("button", { name: "Files", exact: true }).click();
  await search.focus();
  await page.keyboard.press("Delete");
  await wait(async () => !(await read()).rows.some((e) => e.id === path.id), "delete persisted");
  await page.getByText("No clipboard items match these filters.").waitFor();
  checks.push("Delete removes the selected file-path history record without reading its path");
  await filters.getByRole("button", { name: "Images", exact: true }).click();
  await search.focus();
  const beforeImage = (await read()).calls.length;
  await page.keyboard.press("Enter");
  await page.getByRole("alert").filter({ hasText: "Image copying is not available" }).waitFor();
  assert.equal((await read()).calls.length, beforeImage);
  checks.push(
    "Image rows are filterable but unsupported image copying is rejected before any write or file access",
  );
  await filters.getByRole("button", { name: "Links", exact: true }).click();
  const beforeNab = (await read()).calls.length;
  await grid.getByRole("button", { name: /^Nab / }).click();
  await page.getByRole("region", { name: "Download review", exact: true }).waitFor();
  assert.equal((await read()).calls.length, beforeNab);
  await tab.click();
  await filters.getByRole("button", { name: "Text", exact: true }).click();
  checks.push(
    "A link-row Nab action opens review on the Nab tab; no download or clipboard write begins",
  );
  await call("test.clipboard", { mode: "no-lease" });
  await search.focus();
  await page.keyboard.press("Enter");
  await page.getByText("Copied. Return to your app and press Ctrl+V.", { exact: true }).waitFor();
  assert.equal(await page.locator("main").getAttribute("data-island-state"), "expanded");
  await call("test.clipboard", { mode: "denied" });
  await search.focus();
  await page.keyboard.press("Enter");
  await page
    .getByText("Copied. Automatic paste was unavailable; use Ctrl+V in your app.", { exact: true })
    .waitFor();
  assert.equal((await read()).calls.at(-1), "restore");
  checks.push(
    "Missing lease or denied restore returns copied-only, retains the panel and never invokes the paste provider",
  );
  await call("test.clipboard", { mode: "copy-error" });
  await search.focus();
  await page.keyboard.press("Control+c");
  await page.getByRole("alert").filter({ hasText: "clipboard action could not finish" }).waitFor();
  await call("test.clipboard", { mode: "ok" });
  await search.focus();
  await page.keyboard.press("Enter");
  await wait(async () => (await read()).calls.at(-1) === "collapse", "successful paste seam");
  assert.deepEqual((await read()).calls.slice(-3), ["restore", "paste", "collapse"]);
  await wait(
    async () => (await page.locator("main").getAttribute("data-island-state")) !== "expanded",
    "collapse after success",
  );
  checks.push(
    "Write failure remains visible; success uses the shared production pick core in copy -> restore -> paste -> collapse order with recording providers only",
  );
  const final = await read();
  const telemetry = await page.evaluate(() => ({
    unsupported: globalThis.__NABBIT_CAPTURE__.snapshot().unsupported,
    commands: globalThis.__NABBIT_TACK_TEST__.commands,
    events: globalThis.__NABBIT_TACK_TEST__.events,
    streamError: globalThis.__NABBIT_TACK_TEST__.streamError,
  }));
  assert(telemetry.events >= 5);
  assert(!telemetry.streamError);
  assert.deepEqual(telemetry.unsupported, []);
  assert.deepEqual(problems, []);
  assert(!telemetry.commands.some((c) => c.startsWith("start_download")));
  checks.push(
    `Verified ${telemetry.events} pushed events; no unknown IPC, external network, OS clipboard or global input`,
  );
  checks.push(`Final SQLite history contains ${final.rows.length} records`);
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
          "Actual Clipboard UI and typed API through a test-only forwarding bridge to production v0.1 SQLite and clipboard pick core. Recording copy/focus/paste providers, never the Windows OS adapter. Native IPC/rendering has a separate owned release smoke.",
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
  `Verified ${checks.length} browser-to-Rust Clipboard checks against SQLite and the recording pick providers.`,
);
