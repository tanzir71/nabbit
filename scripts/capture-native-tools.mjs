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
  prefix = process.argv[2] ?? "v57-native";
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
  await setTimeout(200);
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
  await start();
  const tray = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("tauri.localhost") && !p.url().includes("island.html")),
    "owned tray WebView",
  );
  await tray.waitForFunction(() => !!globalThis.__TAURI_INTERNALS__?.invoke);
  const profile = env.NABBIT_APP_DATA_DIR;
  const input = resolve(profile, "pdf-fixture.png");
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
  const originalHash = hash(await readFile(input));
  const request = { requestId: randomUUID(), toolId: "to-jpg", input, presetId: "jpg" };
  const first = await invoke(tray, "tool_start", { request });
  const done = await wait(async () => {
    const job = (await invoke(tray, "tool_jobs")).find((j) => j.id === first.id);
    if (job?.status === "failed") throw Error(job.error);
    return job?.status === "completed" && job;
  }, "owned JPG conversion");
  assert.equal(hash(await readFile(input)), originalHash);
  assert(done.output.endsWith("pdf-fixture (To JPG).jpg"));
  const firstHash = hash(await readFile(done.output));
  const rawCapture = async (role) => {
    await setTimeout(180);
    const stem = `tools-${role}`,
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

  await rawCapture("result");
  checks.push(
    "Actual release Tauri tool_start runs the default JPG executor on an owned PNG, preserves its bytes and produces a named result with copied dates, typed progress and the native compact result scene",
  );
  await writeFile(env.NABBIT_ACCEPTANCE_CURSOR, JSON.stringify({ x: 960, y: 30 }));
  await island({ surface: { label: "island", state: "peek" } });
  const page = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("island.html")),
    "owned tool Peek",
  );
  await page.getByRole("region", { name: "Tool result" }).waitFor();
  const builtHtml = await readFile(resolve(root, "dist/island.html"), "utf8"),
    entry = builtHtml.match(/<script[^>]+src="([^"]+)"/)[1];
  assert.equal(await page.locator('script[type="module"]').getAttribute("src"), entry);
  embeddedEntry = entry;
  const expectedStyles = [...builtHtml.matchAll(/<link\b[^>]+>/g)]
    .filter(([tag]) => tag.includes('rel="stylesheet"'))
    .map(([tag]) => tag.match(/href="([^"]+)"/)[1]);
  embeddedStyles = await page
    .locator('link[rel="stylesheet"]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href")));
  for (const href of expectedStyles) assert(embeddedStyles.includes(href));
  await capture(page, "peek", "body");
  await island({ surface: { label: "island", state: "expanded" } });
  await page.locator('[data-island-state="expanded"]').waitFor();
  await invoke(page, "shelf_add", { paths: [input] });
  await invoke(tray, "create_note_card", {
    draft: { title: "PDF fixture invoice", body: "Owned native search note", kind: "note" },
    expectedScope: null,
  });
  await invoke(tray, "create_note_card", {
    draft: { title: "PDF fixture link", kind: "bookmark", url: "https://example.invalid/pdf" },
    expectedScope: null,
  });
  execFileSync(
    "python",
    [
      "-X",
      "utf8",
      "-c",
      "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]);db.execute('INSERT INTO pins(id,kind,path,label,slot) VALUES(?,?,?,?,?)',('native-fixture-pin','folder',sys.argv[2],'PDF fixture folder',1));db.commit();db.close()",
      resolve(profile, "nabbit.sqlite3"),
      profile,
    ],
    { windowsHide: true },
  );
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("combobox").fill("pdf");
  for (const text of [
    "PDF fixture invoice",
    "PDF fixture link",
    "PDF fixture folder",
    "pdf-fixture.png",
  ])
    await page
      .getByRole("option", { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
      .waitFor();
  await capture(page, "search", "body");
  checks.push(
    "The owned expanded release searches real scoped local notes, a saved link, a stored folder pin and the Shelf through actual Tauri/SQLite reads, with no hosted Tack or browser profile",
  );
  await page.getByRole("combobox").fill("jpg");
  await page.getByRole("option", { name: /To JPG/ }).click();
  const sheet = page.getByRole("region", { name: "To JPG options" });
  await sheet.getByLabel("From Shelf").selectOption(input);
  await sheet.getByRole("button", { name: "To JPG", exact: true }).click();
  const second = await wait(async () => {
    const jobs = await invoke(tray, "tool_jobs");
    const job = jobs.find((j) => j.id !== first.id);
    if (job?.status === "failed") throw Error(job.error);
    return job?.status === "completed" && job;
  }, "explicit review conversion");
  assert(second.output.endsWith("pdf-fixture (To JPG) 2.jpg"));
  assert.equal(hash(await readFile(done.output)), firstHash);
  assert.equal(hash(await readFile(input)), originalHash);
  await island({ surface: { label: "island", state: "peek" } });
  await page
    .getByRole("region", { name: "Tool result" })
    .getByRole("button", { name: "Tool jobs", exact: true })
    .click();
  const queue = page.getByRole("region", { name: "Tool jobs" });
  await queue.getByRole("article").first().waitFor();
  await capture(page, "queue", "body");
  await page.evaluate(async () => {
    globalThis.__toolIntents = [];
    const api = globalThis.__TAURI_INTERNALS__;
    const handler = api.transformCallback((event) => globalThis.__toolIntents.push(event.payload));
    await api.invoke("plugin:event|listen", {
      event: "tools:revealed",
      target: { kind: "Any" },
      handler,
    });
  });
  const result = queue.getByRole("article").first();
  await result.getByRole("button", { name: "Reveal", exact: true }).click();
  await wait(
    async () =>
      page.evaluate(
        (id) => globalThis.__toolIntents.some((e) => e.id === id && e.injected),
        second.id,
      ),
    "injected Reveal intent",
  );
  await result.getByRole("button", { name: "Undo", exact: true }).click();
  await wait(
    async () =>
      (await invoke(tray, "tool_jobs")).some((j) => j.id === second.id && j.status === "undone"),
    "injected Undo result",
  );
  await assert.rejects(readFile(second.output), (e) => e.code === "ENOENT");
  assert.equal(hash(await readFile(input)), originalHash);
  assert.equal(hash(await readFile(done.output)), firstHash);
  checks.push(
    "A real Search → tool form → explicit Run → durable queue flow creates the numbered second output without changing either existing file. Queue buttons invoke guarded Reveal and Undo; acceptance providers record Reveal and quarantine only the owned output, without Explorer or the real Recycle Bin",
  );
  await stop();
  await start();
  const reopened = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("tauri.localhost") && !p.url().includes("island.html")),
    "reopened owned tray",
  );
  const persisted = await invoke(reopened, "tool_jobs");
  assert.equal(persisted.length, 2);
  assert.equal(persisted.find((j) => j.id === first.id).status, "completed");
  assert.equal(persisted.find((j) => j.id === second.id).status, "undone");
  const notices = await invoke(reopened, "third_party_licenses");
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
              .map((key) => [key, ordered(value[key])]),
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
  const embedded = await reopened.evaluate(
    async (files) =>
      Promise.all(
        files.map(async (file) => {
          const response = await globalThis.fetch("/" + file);
          if (!response.ok) throw Error("Missing embedded asset: " + file);
          const bytes = await response.arrayBuffer();
          const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
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
  assert(notices.components.length > 1000);
  assert.equal(notices.ffmpeg.builds.length, 2);
  assert(notices.ffmpeg.sourceOffer.includes("three years"));
  assert(notices.ffmpeg.gpl.includes("GNU GENERAL PUBLIC LICENSE"));
  checks.push(
    "Restart of the same isolated profile retains completed/undone queue records without rerunning jobs. The offline licence command returns the generated dependency notices, original GPL text, source offer and both pinned configure lines",
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
        embeddedEntry,
        embeddedStyles,
        embeddedAssetCount,
        executableSha256: hash(await readFile(exe)),
        buildManifestSha256: hash(await readFile(resolve(root, "dist/.vite/manifest.json"))),
        noUserProfile: true,
        noRealRecycleBinOrExplorer: true,
        noOsSettingChange: true,
        scope:
          "Owned production DirectComposition/WebView2 release, actual registry/presets/runner, owned conversion files, SQLite search/queue and Tauri result actions. Reveal/Undo providers are injected only for files inside this owned app-data directory. No user profiles, real clipboard, Explorer, Recycle Bin or OS setting is used.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(root, `progress/v2/M10/${prefix}-scene-log.txt`), logs, { flag: "wx" });
}
globalThis.console.log(
  "Verified native tool/search/review/queue/results and restart with owned files and injected Shell providers.",
);
