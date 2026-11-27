// Runs only an owned executable with unique app-data, control and WebView2
// directories. DOM input stays inside its webview; no global input is injected.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir, unlink, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
import { chromium } from "playwright";
const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v48-scene";
assert(/^[a-z0-9-]+$/.test(prefix));
assert.equal(process.platform, "win32");
const output = resolve(root, `progress/v2/M9/${prefix}-scene.json`),
  pngOutput = resolve(root, `progress/v2/M9/${prefix}-native.png`),
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
const rpc = async (request) => {
  await unlink(resolve(control, "sticky.done")).catch((e) => assert.equal(e.code, "ENOENT"));
  await writeFile(resolve(control, "sticky.pending"), JSON.stringify(request));
  await rename(resolve(control, "sticky.pending"), resolve(control, "sticky.json"));
  const result = await wait(async () => {
    try {
      return JSON.parse(await readFile(resolve(control, "sticky.done"), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT" || e instanceof SyntaxError) return null;
      throw e;
    }
  }, request.action);
  assert(result.ok, `Owned RPC failed: ${request.action}`);
  return result.value;
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
  const contentBounds = role === "island" ? await page.locator(".island-morph").boundingBox() : box;
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
  await writeFile(resolve(root, "progress/v2/M9", file), bytes, { flag: "wx" });
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
  await island({ gate: "visible", prepareTray: true });
  const drafts = [
    { title: "Groceries", kind: "checklist", color: "default", items: ["Eggs", "Coffee"] },
    {
      title: "Island idea",
      body: "A little timer on the island would be nice.\nMaybe a focus mode?\nKeep it out of the way.",
      kind: "note",
      color: "blue",
    },
    {
      title: "Launch checklist",
      kind: "checklist",
      color: "green",
      items: ["Verify island at 150% DPI", "Record demo GIF", "Write release notes"],
    },
  ];
  const notes = [];
  for (const draft of drafts) notes.push(await rpc({ action: "seed", draft }));
  const mainPage = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => !p.url().includes("island.html") && !p.url().includes("sticky.html")),
    "tray WebView",
  );
  const n = notes[2];
  await mainPage.waitForFunction(() => Boolean(globalThis.__TAURI_INTERNALS__));
  const settings = await invoke(mainPage, "get_settings");
  await invoke(mainPage, "save_settings", { settings: { ...settings, theme: "light" } });
  notes[2] = await invoke(mainPage, "update_note_card", {
    id: n.value.id,
    expectedRevision: n.value.revision,
    expectedEditToken: n.editToken,
    expectedScope: null,
    patch: { pinned: true, items: n.value.items.map((item, i) => ({ ...item, checked: i === 0 })) },
  });
  const labels = [];
  for (const note of notes.slice(1)) labels.push(await rpc({ action: "open", id: note.value.id }));
  await island({ shortcut: "Alt+Space" });
  const islandPage = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("island.html")),
    "island page",
  );
  await islandPage
    .getByRole("navigation", { name: "Island modules" })
    .getByRole("button", { name: "Notes", exact: true })
    .click();
  await islandPage
    .getByRole("textbox", { name: "Note title", exact: true })
    .fill("Ship beta build tomorrow 9am #nabbit !now");
  await islandPage.getByLabel("Capture preview").waitFor();
  const entry = await islandPage.locator('script[type="module"]').getAttribute("src");
  const manifest = JSON.parse(await readFile(resolve(root, "dist/.vite/manifest.json"), "utf8"));
  assert(entry.endsWith(manifest["island.html"].file));
  // Keep the transparent host margins: cropping at the morph's border cuts
  // its live CSS shadow into a visible rectangle on the landing gradient.
  await capture(islandPage, "island", "body");
  for (const [i, role] of ["blue", "green"].entries()) {
    const page = await wait(async () => {
      for (const p of browser
        .contexts()
        .flatMap((c) => c.pages())
        .filter((p) => p.url().includes("sticky.html"))) {
        try {
          const s = await invoke(p, "sticky_snapshot");
          if (s.binding.cardId === notes[i + 1].value.id) return p;
        } catch {
          /* Initial WebView load */
        }
      }
      return null;
    }, `${role} sticky`);
    const s = await invoke(page, "sticky_snapshot");
    assert.equal(s.content.note.localOnly, true);
    assert.equal(s.content.note.value.ref, "");
    assert(
      (await page.locator('script[type="module"]').getAttribute("src")).endsWith(
        manifest["sticky.html"].file,
      ),
    );
    await capture(page, role, "main.sticky-surface");
  }
  checks.push(
    "Three stable captures of the current owned release WebView2, real Tauri IPC/SQLite, synthetic local-only notes; fixture monitor/cursor and DOM-only DPR2 emulation",
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
          "Actual owned release WebView2 with native IPC and SQLite; local-only fixture data. This is capture provenance, not fake-Tack or native window-manager acceptance.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(root, `progress/v2/M9/${prefix}-scene-log.txt`), logs, { flag: "wx" });
}
globalThis.console.log("Captured three stable current native Notes surfaces.");
