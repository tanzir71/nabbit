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
import { shelfFixture } from "./screenshots/shelf-fixtures.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v52-flow";
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
  info.shelf = true;
  const seed = await call("test.shelf");
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
    content: `(${installMockIpc.toString()})(${JSON.stringify({ ...shelfFixture("empty"), label: "island", theme: "light" })});(${installBridge.toString()})(${JSON.stringify(info)});`,
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(`${origin}/island.html`, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("navigation", { name: "Island modules" })
    .getByRole("button", { name: "Files", exact: true })
    .click();
  const list = page.getByRole("list", { name: "Shelf files" }),
    rows = list.locator("[data-shelf-id]");
  await list.waitFor();
  await page.getByText("Drop files here. The originals stay where they are.").waitFor();
  assert.equal((await call("test.shelf")).items.length, 0);
  await page.evaluate(
    (paths) =>
      globalThis.__NABBIT_CAPTURE__.emit("tauri://drag-drop", {
        paths,
        position: { x: 120, y: 150 },
      }),
    seed.paths,
  );
  await wait(async () => (await rows.count()) === 4, "native-drop fixture routed to Shelf store");
  let observed = await call("test.shelf");
  assert.equal(observed.items.length, 4);
  assert.deepEqual(
    observed.items.map((item) => item.path),
    seed.paths,
  );
  checks.push(
    "A native file-drop event passes through the actual IslandApp router and stage command into production Shelf SQLite; only original paths are stored in input order",
  );
  await call("shelf_add", { paths: [seed.paths[0], seed.paths[1]] });
  await wait(async () => (await rows.count()) === 4, "deduplicated external add push");
  assert.equal((await call("test.shelf")).items.length, 4);
  await list.locator(".shelf-thumbnail").waitFor();
  checks.push(
    "Duplicate drops preserve one row per canonical file; pushed events refresh the view and bounded on-demand thumbnail decoding runs on an owned PNG",
  );
  const photo = list.getByRole("button", { name: /^Select photo/ }),
    file = list.getByRole("button", { name: /^Select handoff/ });
  await photo.click();
  await file.click();
  await page.getByText("2 selected").waitFor();
  await page.getByRole("button", { name: "Copy paths", exact: true }).click();
  await page.getByText("Paths copied", { exact: true }).waitFor();
  observed = await call("test.shelf");
  assert.equal(observed.copied.at(-1), [seed.paths[0], seed.paths[2]].join("\r\n"));
  checks.push(
    "Copy paths selects the intended IDs, builds exact ordered Windows path text in production Rust and writes only to a recording clipboard provider",
  );
  await file.evaluate((element) =>
    element.dispatchEvent(
      new globalThis.DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer: new globalThis.DataTransfer(),
      }),
    ),
  );
  await page.getByText("Drag finished. Files remain on the Shelf.", { exact: true }).waitFor();
  const telemetry = await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot());
  const drag = telemetry.calls.find((c) => c.command === "plugin:drag|start_drag");
  assert(drag);
  assert.deepEqual(drag.args.item, [seed.paths[0], seed.paths[2]]);
  assert.equal(drag.args.options.mode, "copy");
  assert(drag.args.image.startsWith("data:image/png;base64,"));
  assert.deepEqual(
    telemetry.calls.filter((c) => c.command === "shelf_drag_active").map((c) => c.args.active),
    [true, false],
  );
  assert.equal((await call("test.shelf")).items.length, 4);
  checks.push(
    "Dragging a selected card uses the production ordered drag plan and real JS plugin binding with copy mode; the fixture records plugin intent and cancellation, releases the source lease, and keeps all Shelf rows",
  );
  await page.getByRole("button", { name: "Deselect", exact: true }).click();
  await call("test.shelf", { missing: true });
  await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.emit("tauri://focus", true));
  await page.getByText("Missing file", { exact: true }).waitFor();
  assert.equal(
    await list.getByRole("button", { name: /^Select gone/ }).getAttribute("draggable"),
    "false",
  );
  await page.getByRole("button", { name: "Remove gone.txt", exact: true }).click();
  await wait(async () => (await rows.count()) === 3, "remove missing reference");
  checks.push(
    "Focus refresh probes existing references; a missing file becomes grey/un-draggable and Remove deletes only its database reference",
  );
  const tab = page
    .getByRole("navigation", { name: "Island modules" })
    .getByRole("button", { name: "Files", exact: true });
  await tab.focus();
  await page.keyboard.press("Control+a");
  await page.getByText("3 selected").waitFor();
  await page.keyboard.press("Control+c");
  await page.getByText("Paths copied", { exact: true }).waitFor();
  assert.equal((await call("test.shelf")).copied.at(-1), seed.paths.slice(0, 3).join("\r\n"));
  await page.keyboard.press("Delete");
  await wait(async () => (await rows.count()) === 0, "keyboard removal");
  assert((await call("test.shelf")).originalsRemain);
  checks.push(
    "Ctrl+A/C/Delete route before global search, operate on actual Shelf rows and retain every available original file",
  );
  await call("shelf_add", { paths: seed.paths.slice(0, 3) });
  await wait(async () => (await rows.count()) === 3, "second push");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByText("Shelf cleared. Original files are unchanged.", { exact: true }).waitFor();
  observed = await call("test.shelf");
  assert.equal(observed.items.length, 0);
  assert(observed.originalsRemain);
  checks.push(
    "Clear empties production SQLite while all owned originals remain available; no interactive drag, OS clipboard or external application is used",
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
          "Actual Shelf UI/native-drop router and typed API through a test-only bridge to production Shelf SQLite/path/thumbnail/copy/drag-plan functions. Clipboard and drag providers record intent, never OS input or an interactive drag. Native IPC/rendering has a separate owned release smoke.",
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
  `Verified ${checks.length} browser-to-Rust Shelf checks against SQLite and recording clipboard/drag providers.`,
);
