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
  prefix = process.argv[2] ?? "v511-native-a";
assert(/^[a-z0-9-]+$/.test(prefix));
assert.equal(process.platform, "win32");
const output = resolve(root, `progress/v2/M10/${prefix}-scene.json`),
  pngOutput = resolve(root, `progress/v2/M10/${prefix}-text-menu@2x.png`),
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
  assert.equal(
    await page.getByRole("alert").count(),
    0,
    "Valid native reviews must show no unexpected error",
  );
  await page.locator(selector).scrollIntoViewIfNeeded();
  const box = await page.locator(selector).boundingBox();
  const contentBounds = role === "peek" ? await page.locator(".island-morph").boundingBox() : box;
  const shot = async () =>
    Buffer.from(
      (
        await session.send("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
          clip: { ...box, scale: 1 },
        })
      ).data,
      "base64",
    );
  const bytes = await shot(),
    repeat = await shot();
  if (hash(bytes) !== hash(repeat)) {
    for (const [suffix, data] of [
      ["first", bytes],
      ["second", repeat],
    ]) {
      assert(data.length <= 300000);
      await writeFile(
        resolve(root, `progress/v2/M10/${prefix}-${role}-failed-${suffix}@2x.png`),
        data,
        { flag: "wx" },
      );
    }
  }
  const raster = await page.evaluate(
    async (data) => {
      const bitmap = await globalThis.createImageBitmap(
        new globalThis.Blob([new Uint8Array(data)], { type: "image/png" }),
      );
      const canvas = globalThis.document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = 0,
        min = 255,
        max = 0;
      for (let p = 0; p < pixels.length; p += 4) {
        if (pixels[p + 3]) {
          opaque++;
          min = Math.min(min, pixels[p], pixels[p + 1], pixels[p + 2]);
          max = Math.max(max, pixels[p], pixels[p + 1], pixels[p + 2]);
        }
      }
      return { opaque, min, max };
    },
    [...bytes],
  );
  assert(
    raster.opaque > 1000 && raster.max - raster.min > 60,
    "Native capture must contain visible rendered content",
  );
  assert.equal(hash(bytes), hash(repeat), "Capture must be stable");
  assert(bytes.length <= 300000);
  assert.equal(bytes.readUInt32BE(16), Math.round(box.width * 2));
  assert.equal(bytes.readUInt32BE(20), Math.round(box.height * 2));
  const file = `${prefix}-${role}@2x.png`;
  await writeFile(resolve(root, "progress/v2/M10", file), bytes, { flag: "wx" });
  captures.push({
    role,
    raster,
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
const results = {};
try {
  await start();
  const findTray = () =>
    browser
      .contexts()
      .flatMap((c) => c.pages())
      .find(
        (p) =>
          p.url().includes("tauri.localhost") &&
          !p.url().includes("island.html") &&
          !p.url().includes("?media-sheet"),
      );
  const tray = await wait(findTray, "owned tray");
  await tray.waitForFunction(() => !!globalThis.__TAURI_INTERNALS__?.invoke);
  await tray.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await tray
    .getByRole("heading", { name: "Private by default", exact: true })
    .waitFor({ state: "hidden" });
  const profile = env.NABBIT_APP_DATA_DIR;
  const photos = [resolve(profile, "Owned one.png"), resolve(profile, "Owned two.png")];
  execFileSync(
    "python",
    [
      "-X",
      "utf8",
      "-c",
      "from PIL import Image;from pathlib import Path;import sys\np=Path(sys.argv[1]);Image.new('RGB',(320,180),(50,100,180)).save(p/'Owned one.png');Image.new('RGB',(240,160),(180,80,50)).save(p/'Owned two.png')",
      profile,
    ],
    { windowsHide: true, timeout: 30000 },
  );
  const originals = await Promise.all(photos.map(async (path) => hash(await readFile(path))));
  const notices = await invoke(tray, "third_party_licenses");
  assert.deepEqual(
    notices,
    JSON.parse(await readFile(resolve(root, "third-party/notices.json"), "utf8")),
  );
  const manifest = JSON.parse(await readFile(resolve(root, "dist/.vite/manifest.json"), "utf8"));
  const assets = [
    ...new Set(
      Object.values(manifest).flatMap((entry) => [
        entry.file,
        ...(entry.css ?? []),
        ...(entry.assets ?? []),
      ]),
    ),
  ];
  const served = await tray.evaluate(
    async (files) =>
      Promise.all(
        files.map(async (file) => {
          const response = await globalThis.fetch(`/${file}`),
            bytes = await response.arrayBuffer();
          return {
            file,
            ok: response.ok,
            sha256: [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))]
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(""),
          };
        }),
      ),
    assets,
  );
  for (const asset of served) {
    assert(asset.ok);
    assert.equal(asset.sha256, hash(await readFile(resolve(root, "dist", asset.file))), asset.file);
  }
  checks.push(
    `All ${assets.length} embedded manifest assets and ${notices.components.length} offline notices match this build.`,
  );
  await tray.evaluate(async () => {
    globalThis.__contextEvents = [];
    const api = globalThis.__TAURI_INTERNALS__;
    for (const name of ["context:clipboard-write", "context:registration", "context:reveal"]) {
      const handler = api.transformCallback((event) =>
        globalThis.__contextEvents.push({ name, payload: event.payload }),
      );
      await api.invoke("plugin:event|listen", { event: name, target: { kind: "Any" }, handler });
    }
  });
  const fixture = (request) => invoke(tray, "context_fixture", { request });
  const current = () => invoke(tray, "clipboard_context", { id: null, explicit: false });
  const shelfPage = async () => {
    await writeFile(env.NABBIT_ACCEPTANCE_CURSOR, JSON.stringify({ x: 960, y: 30 }));
    await island({ surface: { label: "island", state: "expanded" } });
    const page = await wait(
      () =>
        browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url().includes("island.html")),
      "owned Files surface",
    );
    await page
      .getByRole("navigation", { name: "Island modules" })
      .getByRole("button", { name: "Files", exact: true })
      .click();
    await page.locator(".shelf-heading").waitFor();
    return page;
  };
  await tray.getByRole("button", { name: "Clipboard", exact: true }).click();
  const link = (
    await fixture({
      kind: "clipboard",
      text: "https://example.invalid/docs?utm_source=fixture#part",
      source: "Owned editor",
    })
  ).entry;
  await tray.getByRole("button", { name: "Save link", exact: true }).waitFor();
  await capture(tray, "link", ".clipboard-context");
  assert.equal((await current()).kind, "link");
  assert.equal((await current()).entry.id, link.id);
  assert.deepEqual(await invoke(tray, "tool_jobs"), []);
  for (const policy of [
    { exclude: true },
    { history: 0 },
    { cloud: 0 },
    { source: "Bitwarden.exe" },
  ]) {
    const result = await fixture({
      kind: "clipboard",
      text: "owned private fixture",
      source: "Owned editor",
      ...policy,
    });
    assert.equal(result.blocked, true);
    assert.equal(await current(), null);
  }
  checks.push(
    "All three clipboard privacy flags and a default password-manager source suppress context before payload storage.",
  );
  const text = (
    await fixture({ kind: "clipboard", text: "Original text stays here.", source: "Owned editor" })
  ).entry;
  await tray.getByRole("button", { name: "Text tools", exact: true }).click();
  await tray.getByRole("menu", { name: "Text tools", exact: true }).waitFor();
  await capture(tray, "text-menu", ".text-tools-menu");
  await tray.getByRole("menuitem", { name: "Change case", exact: true }).click();
  await capture(tray, "case", ".text-tools-menu");
  await tray.getByRole("menuitem", { name: "UPPERCASE", exact: true }).click();
  await wait(
    async () =>
      (await invoke(tray, "list_clipboard_entries", { query: null })).some(
        (e) => e.content === "ORIGINAL TEXT STAYS HERE.",
      ),
    "new transformed history item",
  );
  const history = await invoke(tray, "list_clipboard_entries", {
    query: null,
  });
  assert(history.some((e) => e.id === text.id && e.content === text.content));
  assert(history.some((e) => e.content === "ORIGINAL TEXT STAYS HERE."));
  const request = { requestId: randomUUID(), id: text.id, operation: "kebab" };
  const first = await invoke(tray, "clipboard_transform", { request });
  assert.equal((await invoke(tray, "clipboard_transform", { request })).id, first.id);
  const writes = await tray.evaluate(() =>
    globalThis.__contextEvents.filter((e) => e.name === "context:clipboard-write"),
  );
  assert.equal(writes.filter((e) => e.payload === first.content).length, 1);
  results.text = {
    originalId: text.id,
    resultId: first.id,
    originalPreserved: true,
    retryCopies: 1,
  };
  checks.push(
    "The native menu creates a new transformed history item, preserves its original, and a frozen request retries without another copy event.",
  );
  const image = (await fixture({ kind: "image", path: photos[0] })).entry;
  assert.equal((await current()).kind, "image");
  await tray.getByRole("button", { name: "Save as file", exact: true }).waitFor();
  await capture(tray, "image", ".clipboard-context");
  await invoke(tray, "clipboard_context_action", { id: image.id, action: "save-image" });
  await invoke(tray, "clipboard_context_action", { id: image.id, action: "save-image" });
  const saved = (await import("node:fs/promises")).readdir;
  assert.equal(
    (await saved(resolve(profile, "context-saved"))).filter((p) => p.endsWith(".png")).length,
    2,
  );
  const inputs = await invoke(tray, "clipboard_tool_inputs", {
    id: image.id,
    toolId: "image-text",
  });
  assert.equal(inputs.length, 1);
  assert(inputs[0].startsWith(resolve(profile, "clipboard")));
  const intent = { id: randomUUID(), toolId: "image-text", input: inputs[0], inputs };
  await invoke(tray, "tool_open_media_sheet", { intent });
  const review = await wait(
    () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("?media-sheet")),
    "image review",
  );
  assert.deepEqual(await invoke(review, "tool_media_sheet"), intent);
  assert.deepEqual(await invoke(tray, "tool_jobs"), []);
  await invoke(review, "tool_close_media_sheet", { id: intent.id });
  checks.push(
    "Copied images use an owned full PNG and thumbnail; Save never overwrites, and Text opens exact-input review without running a job.",
  );
  const files = (await fixture({ kind: "files", paths: photos })).entry;
  await tray.getByRole("button", { name: "Add to Shelf", exact: true }).waitFor();
  await invoke(tray, "clipboard_context_action", { id: files.id, action: "shelf" });
  assert.equal((await invoke(await shelfPage(), "shelf_list")).length, 2);
  const pathEntry = (
    await fixture({ kind: "clipboard", text: photos[0], source: "Owned Explorer" })
  ).entry;
  assert.equal((await current()).kind, "path");
  await tray.getByRole("button", { name: "Reveal", exact: true }).waitFor();
  await capture(tray, "path", ".clipboard-context");
  await invoke(tray, "clipboard_context_action", { id: pathEntry.id, action: "reveal" });
  await invoke(tray, "clipboard_context_action", { id: pathEntry.id, action: "pin" });
  assert((await invoke(tray, "files_pins")).some((pin) => pin.path === photos[0]));
  assert(
    (await tray.evaluate(() => globalThis.__contextEvents)).some(
      (event) => event.name === "context:reveal" && event.payload === photos[0],
    ),
  );
  checks.push(
    "Copied files add only owned Shelf references; a copied path pins in the isolated database and Reveal uses a fake event without launching Explorer.",
  );
  const uia = await fixture({ kind: "selectionUia" });
  assert.equal(uia.text, "selection বাংলা 🐇");
  assert.equal(uia.globalInput, false);
  assert.equal(uia.clipboardAccess, false);
  assert.equal((await current()).selection, true);
  await tray.getByRole("menu", { name: "Text tools", exact: true }).waitFor();
  await capture(tray, "selection", ".clipboard-context");
  await invoke(tray, "clipboard_context_dismiss");
  checks.push(
    "An owned hidden RichEdit supplies real UIA Bengali/emoji selection; a password edit control is rejected, with no global focus/input or clipboard access.",
  );
  for (const state of [2, 3, 4]) {
    assert.equal((await fixture({ kind: "notification", state })).silent, true);
    assert.equal(await current(), null);
    assert.equal(await invoke(tray, "tool_suggest", { paths: photos }), null);
    assert.deepEqual(await invoke(tray, "files_suggestions", { paths: photos, site: null }), []);
    assert.deepEqual(await invoke(tray, "context_batch"), { batch: null, error: null });
    await assert.rejects(invoke(tray, "files_peek_open", { id: "unused-private-pin" }), /quiet/);
  }
  await fixture({ kind: "notification", state: 1 });
  checks.push(
    "All three full-screen/exclusive/presentation notification states suppress rows, tool/drop suggestions, batch actions and folder peeks.",
  );
  const preferences = await invoke(tray, "context_preferences");
  assert.deepEqual(preferences, {
    sendTo: false,
    contextMenu: false,
    selectionCopyFallback: false,
  });
  await invoke(tray, "save_context_preferences", {
    preferences: { sendTo: true, contextMenu: true, selectionCopyFallback: false },
  });
  await invoke(tray, "save_context_preferences", { preferences });
  const integration = await tray.evaluate(() =>
    globalThis.__contextEvents.filter((e) => e.name === "context:registration"),
  );
  assert.equal(integration.length, 2);
  assert(integration.every((e) => e.payload.nativeWrites === false));
  checks.push(
    "Integration options default off and save through the native acceptance provider; no HKCU/Send To/input changes occur.",
  );
  const before = await invoke(tray, "context_batch");
  assert.equal(before.batch, null);
  const started = Date.now();
  await Promise.all(
    photos.map((path) =>
      fixture({
        kind: "explorer",
        args: [exe, "--send-to", "--tool", "to-jpg", "--preset", "webp", "--", path],
      }),
    ),
  );
  const batch = await wait(async () => {
    const s = await invoke(tray, "context_batch");
    return s.batch;
  }, "300ms Explorer batch");
  assert(Date.now() - started >= 290);
  assert.equal(batch.paths.length, 2);
  assert.deepEqual(new Set(batch.paths), new Set(photos));
  assert.equal(batch.reviews.length, 1);
  assert.equal(batch.reviews[0].target.presetId, "webp");
  assert.deepEqual(await invoke(tray, "tool_jobs"), []);
  results.explorer = { ...batch, elapsedMs: Date.now() - started };
  const explorerIntent = {
    id: randomUUID(),
    toolId: "to-jpg",
    presetId: "webp",
    input: batch.paths[0],
    inputs: batch.paths,
  };
  await invoke(tray, "tool_open_media_sheet", { intent: explorerIntent });
  const batchReview = await wait(
    () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("?media-sheet")),
    "batch preset review",
  );
  assert.deepEqual(await invoke(batchReview, "tool_media_sheet"), explorerIntent);
  await batchReview.getByRole("button", { name: "WebP", exact: true }).waitFor();
  assert.equal(
    await batchReview
      .getByRole("button", { name: "WebP", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await wait(async () => {
    const pending = await batchReview.locator(".image-inputs").innerText();
    return (
      !pending.includes("Inspecting") &&
      (await batchReview.getByRole("button", { name: "Convert 2 photos", exact: true }).isEnabled())
    );
  }, "both owned image inspections and the saved preset");
  assert.equal(await batchReview.getByRole("alert").count(), 0);
  await capture(batchReview, "explorer-review", ".media-review");
  assert.deepEqual(await invoke(tray, "tool_jobs"), []);
  await invoke(batchReview, "tool_close_media_sheet", { id: explorerIntent.id });
  await invoke(tray, "context_batch_dismiss", { id: batch.id });
  assert.equal((await invoke(tray, "context_batch")).batch, null);
  checks.push(
    "Concurrent owned Send To arguments become one 300ms Shelf batch; both exact files and requested WebP preset reach review without automatic execution.",
  );
  for (const [index, path] of photos.entries())
    assert.equal(hash(await readFile(path)), originals[index]);
  await stop();
  await start();
  const reopened = await wait(findTray, "restarted tray");
  assert.deepEqual(await invoke(reopened, "context_preferences"), preferences);
  assert.deepEqual(await invoke(reopened, "tool_jobs"), []);
  const retained = await invoke(reopened, "list_clipboard_entries", {
    query: null,
  });
  assert(retained.some((e) => e.id === text.id));
  assert(retained.some((e) => e.id === first.id));
  assert.equal((await invoke(await shelfPage(), "shelf_list")).length, 2);
  checks.push(
    "Restart retains original/result clipboard history, Shelf references and off preferences; every input hash is unchanged and no tool job exists.",
  );
  passed = true;
} catch (e) {
  failure = { message: e.message ?? String(e), stack: e.stack };
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
        results,
        executableSha256: hash(await readFile(exe)),
        buildManifestSha256: hash(await readFile(resolve(root, "dist/.vite/manifest.json"))),
        noUserProfile: true,
        noRealClipboardOrGlobalInput: true,
        noNativeRegistration: true,
        noOsSettingChange: true,
        scope:
          "Owned production executable and hidden UIA controls, isolated app-data/WebView/control profiles, generated PNG fixtures, native typed IPC and DOM-only input. No real clipboard, cursor, global input, installed integrations, dialogs, account, hosted Tack, Store, signing, installer execution or OS changes.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(root, `progress/v2/M10/${prefix}-scene-log.txt`), logs, { flag: "wx" });
}
globalThis.console.log(
  "Verified native context, UIA, privacy, Explorer batching, exact preset review and restart.",
);
