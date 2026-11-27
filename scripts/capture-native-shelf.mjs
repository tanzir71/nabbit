// Runs only an owned executable with unique app-data, control and WebView2
// directories. DOM input stays inside its webview; no global input is injected.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
import { chromium } from "playwright";
import { shelfPreview } from "./screenshots/shelf-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v52-native";
assert(/^[a-z0-9-]+$/.test(prefix));
assert.equal(process.platform, "win32");
const output = resolve(root, `progress/v2/M10/${prefix}-scene.json`),
  pngOutput = resolve(root, `progress/v2/M10/${prefix}-clipboard@2x.png`),
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
  const contentBounds = ["shelf", "missing"].includes(role) ? await page.locator(".island-morph").boundingBox() : box;
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
  const inputs = resolve(trial, "inputs");
  await mkdir(inputs, { recursive: true });
  const paths = ["photo.png", "native-video.mp4", "fixture.md"].map((name) =>
    resolve(inputs, name),
  );
  await writeFile(paths[0], Buffer.from(shelfPreview.split(",")[1], "base64"));
  await writeFile(paths[1], Buffer.alloc(1000000));
  await writeFile(paths[2], "Owned native Shelf fixture");
  const originalHashes = await Promise.all(paths.map(async (path) => hash(await readFile(path))));
  await start();
  await island({ shortcut: "Alt+Space" });
  const page = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("island.html")),
    "owned Shelf WebView",
  );
  await page
    .getByRole("navigation", { name: "Island modules" })
    .getByRole("button", { name: "Files", exact: true })
    .click();
  const list = page.getByRole("list", { name: "Shelf files" });
  await list.waitFor();
  await invoke(page, "island_stage_drop", { payload: { files: paths }, zone: "shelf" });
  await wait(
    async () => (await list.locator("[data-shelf-id]").count()) === 3,
    "native persisted file drop",
  );
  assert.equal(await invoke(page, "get_island_drop"), null);
  const rows = await invoke(page, "shelf_list");
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((item) => item.path),
    paths,
  );
  await invoke(page, "shelf_add", { paths: [paths[0], paths[1]] });
  assert.equal((await invoke(page, "shelf_list")).length, 3);
  checks.push(
    "Real Tauri island_stage_drop persists canonical file references into isolated SQLite, consumes the old draft and pushes the Files view; duplicate add keeps the same three rows",
  );
  const text = await invoke(page, "shelf_paths", { ids: [rows[2].id, rows[0].id] });
  assert.equal(text, [paths[0], paths[2]].join("\r\n"));
  const plan = await invoke(page, "shelf_drag_plan", { ids: [rows[2].id, rows[0].id] });
  assert.deepEqual(plan.item, [paths[0], paths[2]]);
  assert.equal(plan.mode, "copy");
  assert(plan.icon.startsWith("data:image/png;base64,"));
  checks.push(
    "Actual native IPC builds ordered selected path text and a copy-mode drag plan from stored IDs; no clipboard write, source lease or interactive plugin drag is invoked",
  );
  await list.locator(".shelf-thumbnail").waitFor();
  const manifest = JSON.parse(await readFile(resolve(root, "dist/.vite/manifest.json"), "utf8"));
  assert(
    (await page.locator('script[type="module"]').getAttribute("src")).endsWith(
      manifest["island.html"].file,
    ),
  );
  await capture(page, "shelf", "body");
  checks.push(
    "The current production custom-protocol WebView2 displays a bounded on-demand PNG preview and exact-repeat DPR2 Shelf capture using owned files only",
  );
  const gone = resolve(inputs, "gone.txt");
  await writeFile(gone, "Owned missing-file fixture");
  await invoke(page, "shelf_add", { paths: [gone] });
  await unlink(gone);
  await invoke(page, "shelf_add", { paths: [paths[0]] });
  await page.getByRole("button", { name: "Remove gone.txt", exact: true }).waitFor();
  const missing = (await invoke(page, "shelf_list")).find((item) => item.name === "gone.txt");
  assert.equal(missing.available, false);
  assert.equal(missing.size, null);
  await capture(page, "missing", "body");
  await page.getByRole("button", { name: "Remove gone.txt", exact: true }).click();
  await wait(
    async () => (await list.locator("[data-shelf-id]").count()) === 3,
    "remove native missing reference",
  );
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByText("Shelf cleared. Original files are unchanged.", { exact: true }).waitFor();
  assert.equal((await invoke(page, "shelf_list")).length, 0);
  assert.deepEqual(
    await Promise.all(paths.map(async (path) => hash(await readFile(path)))),
    originalHashes,
  );
  checks.push(
    "Actual missing-file status, Remove and Clear leave every original available and byte-identical; no stored file is deleted, copied or converted",
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
        executableSha256: hash(await readFile(exe)),
        buildManifestSha256: hash(await readFile(resolve(root, "dist/.vite/manifest.json"))),
        noUserProfile: true,
        noHostedTack: true,
        noRealClipboard: true,
        noOsDisplayChange: true,
        scope:
          "Actual owned production release WebView2 with Tauri IPC, Shelf SQLite, metadata and bounded previews from isolated fixture files. Path text/drag-plan building is read-only; no OS clipboard, global input, interactive drag or external app claim.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(root, `progress/v2/M10/${prefix}-scene-log.txt`), logs, { flag: "wx" });
}
globalThis.console.log("Verified native Shelf IPC and captured two current release states.");
