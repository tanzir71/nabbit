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
  prefix = process.argv[2] ?? "v58-native";
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
  captures = [],
  observations = [];
let embeddedEntry, embeddedStyles;
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
          captureBeyondViewport: true,
          clip: { ...box, scale: 1 },
        })
      ).data,
      "base64",
    );
  const bytes = await shot(),
    repeat = await shot();
  if (hash(bytes) !== hash(repeat)) {
    const first = `${prefix}-${role}-failed-first@2x.png`,
      second = `${prefix}-${role}-failed-second@2x.png`;
    for (const [file, data] of [
      [first, bytes],
      [second, repeat],
    ]) {
      assert(data.length <= 300000);
      await writeFile(resolve(root, "progress/v2/M10", file), data, { flag: "wx" });
    }
    const diagnostic = {
      role,
      first,
      second,
      firstSha256: hash(bytes),
      secondSha256: hash(repeat),
      state: await page.evaluate(() => ({
        html: globalThis.document.querySelector("main")?.outerHTML,
        animations: globalThis.document
          .getAnimations()
          .map((a) => ({ state: a.playState, time: a.currentTime })),
        dpr: globalThis.devicePixelRatio,
        focus: globalThis.document.activeElement?.outerHTML,
      })),
    };
    await writeFile(
      resolve(root, `progress/v2/M10/${prefix}-${role}-failed.json`),
      JSON.stringify(diagnostic, null, 2) + "\n",
      { flag: "wx" },
    );
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
const samePath = (a, b) =>
  a.replace(/^\\\\\?\\/u, "").toLowerCase() === b.replace(/^\\\\\?\\/u, "").toLowerCase();
const absent = (path) => assert.rejects(readFile(path), (e) => e.code === "ENOENT");
let passed = false,
  failure;
try {
  await start();
  let tray = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("tauri.localhost") && !p.url().includes("island.html")),
    "owned tray",
  );
  await tray.waitForFunction(() => !!globalThis.__TAURI_INTERNALS__?.invoke);
  const profile = env.NABBIT_APP_DATA_DIR;
  const inputDir = resolve(profile, "Inputs"),
    invoices = resolve(profile, "Invoices"),
    archive = resolve(profile, "Archive"),
    courses = resolve(profile, "Courses");
  for (const dir of [inputDir, invoices, archive, courses]) await mkdir(dir, { recursive: true });
  const input = resolve(inputDir, "hero.png"),
    memo = resolve(inputDir, "memo.txt"),
    collision = resolve(invoices, "memo.txt");
  execFileSync(
    "python",
    [
      "-X",
      "utf8",
      "-c",
      "from PIL import Image;import sys;Image.new('RGB',(320,180),(55,70,90)).save(sys.argv[1])",
      input,
    ],
    { windowsHide: true },
  );
  await writeFile(memo, "Owned source memo\n");
  await writeFile(collision, "Owned original destination\n");
  const originalHash = hash(await readFile(input)),
    memoHash = hash(await readFile(memo)),
    collisionHash = hash(await readFile(collision));
  for (let i = 0; i < 6; i++)
    await writeFile(resolve(invoices, `invoice-${110 + i}.txt`), `Owned invoice ${i}\n`);
  const save = (path, label, slot, id = null, alwaysMove = false) =>
    invoke(tray, "files_save_pin", { draft: { id, path, label, slot, alwaysMove } });
  const invoicePin = await save(invoices, "Invoices", 1),
    archivePin = await save(archive, "Archive", 2),
    filePin = await save(memo, "Memo", 3);
  await save(archive, "Archive edited", 2, archivePin, true);
  let pins = await invoke(tray, "files_pins");
  assert.equal(pins.length, 3);
  assert(pins.find((p) => p.id === archivePin).alwaysMove);
  await invoke(tray, "files_remove_pin", { id: filePin });
  assert.equal(hash(await readFile(memo)), memoHash);
  await writeFile(env.NABBIT_ACCEPTANCE_CURSOR, JSON.stringify({ x: 960, y: 30 }));
  await island({ surface: { label: "island", state: "expanded" } });
  let page = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("island.html")),
    "Files WebView",
  );
  await page.locator('[data-island-state="expanded"]').waitFor();
  const shelf = await invoke(page, "shelf_add", { paths: [input, memo] });
  assert.equal(shelf.length, 2);

  await page.locator('[data-island-tab="files"]').click();
  await page.getByRole("button", { name: /^Invoices / }).waitFor();
  await capture(page, "files", "body");
  await page.evaluate(async () => {
    globalThis.__peekChanges = [];
    const api = globalThis.__TAURI_INTERNALS__;
    const handler = api.transformCallback((e) => globalThis.__peekChanges.push(e.payload));
    await api.invoke("plugin:event|listen", {
      event: "pins:peek-changed",
      target: { kind: "Any" },
      handler,
    });
  });
  await page.getByRole("button", { name: /^Invoices / }).click();
  const peek = page.getByRole("region", { name: "Invoices recent items", exact: true });
  await peek.locator(".files-recent li").first().waitFor();
  assert.equal(await peek.locator(".files-recent li").count(), 6);
  await writeFile(resolve(invoices, "fresh-invoice.txt"), "Owned notify event\n");
  await peek.getByRole("button", { name: /fresh-invoice/ }).waitFor();
  const token = await wait(
    () => page.evaluate(() => globalThis.__peekChanges.at(-1)),
    "actual metadata notify",
  );
  await capture(page, "pin-peek", "body");
  await peek.getByRole("button", { name: "Close", exact: true }).click();
  await assert.rejects(invoke(page, "files_peek_items", { token }));
  assert(
    (await invoke(page, "files_drop_status")) > 0,
    "Owned WebView descendants registered as OLE drop targets",
  );
  checks.push(
    "Pins are created/edited/removed through real IPC/SQLite without changing the target. Files shows the actual Shelf and pins. A held peek lists six metadata rows, refreshes on a real owned notify event, and closes its owner/token watch.",
  );
  const drop = (kind, x, y, ctrl = false) =>
    invoke(page, "files_fixture_drop", {
      request: {
        path: input,
        kind,
        x: Math.round(x),
        y: Math.round(y),
        modifiers: { shift: false, ctrl },
      },
    });
  await drop("enter", 0, 0, true);
  await page.getByRole("region", { name: "Drop on a pin" }).waitFor();
  let box = await page
    .locator(`.island-drop-content [data-drop-zone="pin:${invoicePin}"]`)
    .boundingBox();
  await drop("over", box.x + box.width / 2, box.y + box.height / 2, true);
  await page.locator(`.island-drop-content [data-drop-zone="pin:${invoicePin}"].is-over`).waitFor();
  await page
    .locator(`.island-drop-content [data-drop-zone="pin:${invoicePin}"]`)
    .getByText("Copy here", { exact: true })
    .waitFor();
  await capture(page, "drop-copy", "body");
  // capture restores the original device scale before these physical coordinates.
  box = await page
    .locator(`.island-drop-content [data-drop-zone="pin:${invoicePin}"]`)
    .boundingBox();
  await drop("drop", box.x + box.width / 2, box.y + box.height / 2, true);
  const copy = await wait(
    async () =>
      (await invoke(tray, "files_history")).find(
        (op) => op.status === "completed" && op.entries.some((e) => samePath(e.source.path, input)),
      ),
    "pin copy journal",
  );
  assert.equal(copy.entries[0].verb, "copy");
  assert.equal(hash(await readFile(input)), originalHash);
  assert.equal(hash(await readFile(copy.entries[0].output)), originalHash);
  await wait(async () => {
    const r = await island({});
    return r.snapshot.activity.views.some((v) => v.primary?.event.kind === "filesMoved");
  }, "native copied result");
  const raw = async (role) => {
    const stem = `files-${role}`,
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
  await setTimeout(180);
  await raw("copied-compact");
  // Send one WM_LBUTTONUP to the verified owned native HWND only. No global input.
  const snapshot = (await island({})).snapshot,
    host = snapshot.hosts.find((h) => h.placement.label === "island");
  execFileSync(
    "python",
    [
      "-c",
      [
        "import ctypes,sys",
        "from ctypes import wintypes as W",
        "u=ctypes.WinDLL('user32',use_last_error=True)",
        "u.GetWindowThreadProcessId.argtypes=[W.HWND,ctypes.POINTER(W.DWORD)]",
        "u.GetClassNameW.argtypes=[W.HWND,W.LPWSTR,ctypes.c_int]",
        "u.SendMessageW.argtypes=[W.HWND,W.UINT,W.WPARAM,W.LPARAM]",
        "h=int(sys.argv[1]);pid=W.DWORD();u.GetWindowThreadProcessId(h,ctypes.byref(pid))",
        "assert pid.value==int(sys.argv[2]),'Not owned HWND'",
        "name=ctypes.create_unicode_buffer(256);u.GetClassNameW(h,name,256);assert name.value=='NabbitIslandHost'",
        // 720-wide owned host, 312-wide pill, 46-wide Undo at its right edge.
        "u.SendMessageW(h,0x202,0,(24<<16)|480)",
      ].join("\n"),
      String(host.hwnd),
      String(child.pid),
    ],
    { windowsHide: true },
  );
  await wait(
    async () =>
      (await invoke(tray, "files_history")).some(
        (op) => op.id === copy.id && op.status === "undone",
      ),
    "native compact Undo",
  );
  await absent(copy.entries[0].output);
  assert.equal(hash(await readFile(input)), originalHash);
  checks.push(
    "An actual owned Shell IShellItemArray/IDataObject invokes the production IDropTarget callbacks, preserving physical hover coordinates and Ctrl. The normal pin UI plans and executes a journalled Copy. The native DirectComposition compact Undo hit path is exercised by one application-only message to a PID/class-verified owned HWND; Undo quarantines the copy through the owned provider.",
  );
  await island({ surface: { label: "island", state: "expanded" } });
  page = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("island.html")),
    "reallocated Files view",
  );
  await page.locator('[data-island-state="expanded"]').waitFor();
  await page.getByRole("button", { name: /Select memo\.txt/ }).click();
  await page.getByRole("button", { name: "Move to…", exact: true }).click();
  const move = page.getByRole("region", { name: "Move to folder", exact: true });
  await move.getByRole("button", { name: "Invoices", exact: true }).click();
  const moved = await wait(
    async () =>
      (await invoke(tray, "files_history")).find(
        (op) => op.status === "completed" && op.entries.some((e) => samePath(e.source.path, memo)),
      ),
    "Shelf Move to journal",
  );
  assert.equal(moved.entries[0].verb, "move");
  assert(moved.entries[0].output.endsWith("memo 2.txt"));
  await absent(memo);
  assert.equal(hash(await readFile(moved.entries[0].output)), memoHash);
  assert.equal(hash(await readFile(collision)), collisionHash);
  assert(
    (await invoke(page, "shelf_list")).some((item) => samePath(item.path, moved.entries[0].output)),
  );
  await island({ surface: { label: "island", state: "live" } });
  await wait(async () => {
    const r = await island({});
    return r.snapshot.activity.views.some((v) => v.primary?.event.opId === moved.id);
  }, "Moved primary");
  await raw("moved-compact");
  // No frozen clock: observe real eight-second expiry while visible.
  const expiryStart = Date.now();
  await wait(
    async () => {
      const r = await island({});
      return !r.snapshot.activity.views.some((v) => v.primary?.event.opId === moved.id);
    },
    "eight-second visible result expiry",
    12000,
  );
  assert(Date.now() - expiryStart >= 5500);
  checks.push(
    "Shelf selection → Move to → explicit Invoices destination runs the real UI and journal. The owned conflict provider keeps both files under a numbered output, updates the original Shelf identity, and preserves the existing destination. The visible native Moved result expires on real time at eight seconds (the pure scheduler test pins the exact boundary).",
  );
  // A real built-in tool produces an owned result; file ops update its in-memory and DB locations.
  const job = await invoke(tray, "tool_start", {
    request: { requestId: randomUUID(), toolId: "to-jpg", input, presetId: "jpg" },
  });
  const done = await wait(async () => {
    const j = (await invoke(tray, "tool_jobs")).find((j) => j.id === job.id);
    if (j?.status === "failed") throw Error(j.error);
    return j?.status === "completed" && j;
  }, "owned conversion");
  const toolHash = hash(await readFile(done.output));
  const toolPlan = await invoke(tray, "files_plan", {
    request: {
      paths: [done.output],
      destination: archive,
      pinId: null,
      modifiers: { shift: false, ctrl: false },
      site: null,
    },
  });
  const toolMoved = await invoke(tray, "files_execute", { id: toolPlan.id, confirmed: false });
  assert.equal(toolMoved.status, "completed");
  let updated = (await invoke(tray, "tool_jobs")).find((j) => j.id === done.id);
  assert(samePath(updated.output, toolMoved.entries[0].output));
  assert.equal(hash(await readFile(updated.output)), toolHash);
  await invoke(tray, "files_undo", { id: toolMoved.id });
  updated = (await invoke(tray, "tool_jobs")).find((j) => j.id === done.id);
  assert(samePath(updated.output, done.output));
  // Seed a completed local download record; no engine or network is invoked.
  const download = resolve(inputDir, "Lecture.mkv");
  await writeFile(download, "Owned completed-download fixture\n");
  const dlId = "owned-completed-download";
  execFileSync(
    "python",
    [
      "-c",
      "import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute(\"INSERT INTO downloads(id,url,title,status,progress,output_path,quality,created_at,updated_at) VALUES(?,?,?,'completed',100,?,'best',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))\",(sys.argv[2],'https://example.invalid/course','Lecture',sys.argv[3]));db.commit();db.close()",
      resolve(profile, "nabbit.sqlite3"),
      dlId,
      download,
    ],
    { windowsHide: true },
  );
  // Establish an extension/site destination using the guarded owned journal.
  const seed = resolve(inputDir, "Earlier.mkv");
  await writeFile(seed, "Earlier owned fixture\n");
  const seedPlan = await invoke(tray, "files_plan", {
    request: {
      paths: [seed],
      destination: courses,
      pinId: null,
      modifiers: { shift: false, ctrl: false },
      site: "example.invalid",
    },
  });
  await invoke(tray, "files_execute", { id: seedPlan.id, confirmed: false });
  await island({ surface: { label: "island", state: "expanded" } });
  page = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("island.html")),
    "warm Files view",
  );
  await page.locator('[data-island-state="expanded"]').waitFor();
  observations.push({
    phase: "before-download-peek",
    download: await invoke(tray, "files_download_info", { id: dlId }),
    suggestions: await invoke(tray, "files_suggestions", { paths: [download], site: null }),
    snapshot: (await island({})).snapshot,
  });
  const downloadFrame = await island({
    activity: [
      { kind: "dismissed", id: `files:${seedPlan.id}` },
      { kind: "downloadDone", jobId: dlId, path: download },
    ],
    surface: { label: "island", state: "peek" },
  });
  page = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("island.html")),
    "download Peek view",
  );
  observations.push({ phase: "download-frame", frame: downloadFrame });
  for (let probe = 0; probe < 1; probe++) {
    observations.push({
      phase: "download-dom",
      probe,
      snapshot: (await island({})).snapshot.activity,
      dom: await page
        .evaluate(() => ({
          state: globalThis.document.querySelector("main")?.dataset,
          text: globalThis.document.body.innerText,
        }))
        .catch((e) => ({ error: e.message })),
    });
    await setTimeout(200);
  }
  let saved = page.getByRole("region", { name: "Download saved", exact: true });
  await saved.getByRole("button", { name: "Move to Courses", exact: true }).waitFor();
  await capture(page, "download-done", "body");
  // Capture time counts against the real result TTL. Each subsequent action gets
  // a fresh explicit fixture notification in a warm owned view; the clock stays live.
  const freshSaved = async () => {
    await island({ surface: { label: "island", state: "expanded" } });
    page = await wait(async () => {
      for (const candidate of browser
        .contexts()
        .flatMap((c) => c.pages())
        .filter((p) => p.url().includes("island.html"))) {
        try {
          if ((await candidate.locator("main").getAttribute("data-island-state")) === "expanded")
            return candidate;
        } catch {
          /* prior view can finish closing */
        }
      }
      return null;
    }, "warm download action view");
    await island({
      activity: [
        { kind: "dismissed", id: `downloadDone:${dlId}` },
        { kind: "downloadDone", jobId: dlId, path: download },
      ],
      surface: { label: "island", state: "peek" },
    });
    saved = page.getByRole("region", { name: "Download saved", exact: true });
    await saved.getByRole("button", { name: "To MP4", exact: true }).waitFor();
  };
  await freshSaved();
  await saved.getByRole("button", { name: "To MP4", exact: true }).click();
  await page.getByRole("region", { name: "To MP4 options" }).waitFor();
  assert.equal((await invoke(tray, "tool_jobs")).length, 1);
  await page.locator('[data-island-state="expanded"]').waitFor();
  await setTimeout(4200); // Review survives the original DownloadDone expiry.
  await page.getByRole("region", { name: "To MP4 options" }).waitFor();
  await page
    .getByRole("region", { name: "To MP4 options" })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await freshSaved();
  await saved.getByRole("button", { name: "Move to Courses", exact: true }).click();
  const downloadMoved = await wait(
    async () =>
      (await invoke(tray, "files_history")).find(
        (op) =>
          op.status === "completed" && op.entries.some((e) => samePath(e.source.path, download)),
      ),
    "download Move to suggestion",
  );
  const info = await invoke(tray, "files_download_info", { id: dlId });
  assert(samePath(info.path, downloadMoved.entries[0].output));
  await absent(download);
  checks.push(
    "A real To JPG job's output location and identity follow File operations forward/Undo in the live runner and SQLite. A seeded completed-download row renders actual path/bytes, opens To MP4 review without starting a job, and its explicit recent-destination action moves the owned file and updates the download record.",
  );
  const completedBefore = (await invoke(tray, "files_history")).map((op) => ({
    id: op.id,
    status: op.status,
  }));
  await stop();
  await start();
  tray = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("tauri.localhost") && !p.url().includes("island.html")),
    "reopened owned tray",
  );
  assert.deepEqual(
    (await invoke(tray, "files_history")).map((op) => ({ id: op.id, status: op.status })),
    completedBefore,
  );
  await island({ surface: { label: "island", state: "expanded" } });
  page = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("island.html")),
    "restart Files view",
  );
  await page.locator('[data-island-state="expanded"]').waitFor();
  const restored = await invoke(tray, "files_undo", { id: moved.id });
  assert.equal(restored.status, "undone");
  assert.equal(hash(await readFile(memo)), memoHash);
  assert.equal(hash(await readFile(collision)), collisionHash);
  assert((await invoke(page, "shelf_list")).some((item) => samePath(item.path, memo)));
  assert((await invoke(tray, "files_pins")).some((pin) => pin.id === archivePin && pin.alwaysMove));
  await invoke(tray, "files_undo", { id: downloadMoved.id });
  assert(samePath((await invoke(tray, "files_download_info", { id: dlId })).path, download));
  checks.push(
    "Restart of the same unique profile preserves all operation states without rerunning transfers. Journal Undo after restart restores original file and Shelf identities, preserves the original collision file, and reverses the completed-download location. Pin Always move persists.",
  );
  const notices = await invoke(tray, "third_party_licenses"),
    expected = JSON.parse(await readFile(resolve(root, "third-party/notices.json"), "utf8"));
  const ordered = (v) =>
    Array.isArray(v)
      ? v.map(ordered)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, ordered(v[k])]),
          )
        : v;
  assert.equal(hash(JSON.stringify(ordered(notices))), hash(JSON.stringify(ordered(expected))));
  assert.equal(notices.components.length, 1056);
  const html = await readFile(resolve(root, "dist/island.html"), "utf8");
  embeddedEntry = html.match(/<script[^>]+src="([^"]+)"/)[1];
  embeddedStyles = [...html.matchAll(/<link\b[^>]+>/g)]
    .filter(([tag]) => tag.includes('rel="stylesheet"'))
    .map(([tag]) => tag.match(/href="([^"]+)"/)[1]);
  const manifest = JSON.parse(await readFile(resolve(root, "dist/.vite/manifest.json"), "utf8")),
    files = [
      ...new Set(Object.values(manifest).flatMap((item) => [item.file, ...(item.css ?? [])])),
    ];
  const embedded = await tray.evaluate(
    async (files) =>
      Promise.all(
        files.map(async (file) => {
          const r = await globalThis.fetch("/" + file);
          if (!r.ok) throw Error(file);
          const digest = await globalThis.crypto.subtle.digest("SHA-256", await r.arrayBuffer());
          return {
            file,
            sha256: [...new Uint8Array(digest)]
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(""),
          };
        }),
      ),
    files,
  );
  for (const asset of embedded)
    assert.equal(asset.sha256, hash(await readFile(resolve(root, "dist", asset.file))), asset.file);
  embeddedAssetCount = embedded.length;
  checks.push(
    "The actual custom-protocol release returns all 1056 generated notices and every current manifest entry/CSS byte hashes exactly to the frontend build embedded in this executable.",
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
        observations,
        embeddedEntry,
        embeddedStyles,
        embeddedAssetCount,
        executableSha256: hash(await readFile(exe)),
        buildManifestSha256: hash(await readFile(resolve(root, "dist/.vite/manifest.json"))),
        noUserProfile: true,
        noRealRecycleBinOrExplorer: true,
        noOsSettingChange: true,
        scope:
          "Owned production release Files/Pins/Shelf, actual Tauri/SQLite journal, metadata notify, owned Shell IDataObject callbacks and application-only native Undo message. Transfers/conflicts/recycle use the guarded owned provider; real IFileOperation is covered separately by the owned no-dialog Rust test. Download record is seeded locally; no network download. No user profile, clipboard, Explorer, Recycle Bin or OS setting is used.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(root, `progress/v2/M10/${prefix}-scene-log.txt`), logs, { flag: "wx" });
}
globalThis.console.log(
  "Verified native Files/Pins/drop/move/Undo/download/result references and restart with owned files.",
);
