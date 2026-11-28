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
  prefix = process.argv[2] ?? "v512-registry-a";
assert(/^[a-z0-9-]+$/.test(prefix));
assert.equal(process.platform, "win32");
const output = resolve(root, `progress/v2/M10/${prefix}-scene.json`),
  pngOutput = resolve(root, `progress/v2/M10/${prefix}-catalog@2x.png`),
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
const results = { jobs: [], matrix: [] };
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
  let tray = await wait(findTray, "owned tray");
  await tray.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await tray
    .getByRole("heading", { name: "Private by default", exact: true })
    .waitFor({ state: "hidden" });
  const profile = env.NABBIT_APP_DATA_DIR;
  await invoke(tray, "context_fixture", { request: { kind: "notification", state: 1 } });
  execFileSync(
    "python",
    [
      "-X",
      "utf8",
      "-c",
      `from PIL import Image,ImageDraw,ImageFont;from pathlib import Path;import sys,random
p=Path(sys.argv[1]);font=ImageFont.truetype(sys.argv[2],100)
for n in [1,2]:
 im=Image.new('RGB',(1280,720),'white');ImageDraw.Draw(im).text((40,180),'NABBIT 512',font=font,fill='black');im.save(p/f'Photo {n}.png');im.save(p/f'Page {n}.pdf',resolution=72)
Image.frombytes('RGB',(1280,720),random.Random(512).randbytes(1280*720*3)).save(p/'Noise.png')
ex=Image.Exif();ex[34853]={1:'N',2:(23.0,45.0,0.0),3:'E',4:(90.0,30.0,0.0)};Image.new('RGB',(320,180),(90,100,180)).save(p/'GPS.jpg',exif=ex)
(p/'QR text.txt').write_text('https://example.com/owned-nabbit-512',encoding='utf-8')`,
      profile,
      resolve(root, "src/assets/fonts/Geist-Variable.ttf"),
    ],
    { windowsHide: true, timeout: 30000 },
  );
  const path = (file) => resolve(profile, file);
  execFileSync(
    resolve(root, "src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe"),
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=480x270:rate=15",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "3",
      "-c:v",
      "mpeg4",
      "-q:v",
      "5",
      "-c:a",
      "aac",
      path("Clip.mp4"),
    ],
    { windowsHide: true, timeout: 30000 },
  );
  const originalFiles = [
    "Photo 1.png",
    "Photo 2.png",
    "Page 1.pdf",
    "Page 2.pdf",
    "Noise.png",
    "GPS.jpg",
    "QR text.txt",
    "Clip.mp4",
  ];
  const originals = Object.fromEntries(
    await Promise.all(originalFiles.map(async (f) => [f, hash(await readFile(path(f)))])),
  );
  const catalog = await invoke(tray, "tool_catalog"),
    presets = await invoke(tray, "tool_presets");
  assert.deepEqual(
    { tools: catalog, presets },
    JSON.parse(await readFile(resolve(root, "src/features/tools/catalog.fixture.json"), "utf8")),
  );
  results.catalog = catalog;
  results.presets = presets;
  assert.equal(new Set(catalog.map((t) => t.id)).size, catalog.length);
  // Every supported extension is classified through the real clipboard metadata command.
  for (const ext of new Set(catalog.flatMap((t) => t.accepts.filetypes))) {
    const file = path(`Contract.${ext.toUpperCase()}`);
    await writeFile(file, "owned classification-only fixture", { flag: "wx" });
    await invoke(tray, "context_fixture", { request: { kind: "files", paths: [file] } });
    const snapshot = await invoke(tray, "clipboard_context");
    const expected = catalog.filter((t) => t.accepts.filetypes.includes(ext)).map((t) => t.id);
    assert.deepEqual(
      snapshot.tools.map((t) => t.id),
      expected,
    );
    results.matrix.push({ ext, tools: expected });
  }
  await invoke(tray, "context_fixture", { request: { kind: "image", path: path("Photo 1.png") } });
  assert.deepEqual(
    (await invoke(tray, "clipboard_context")).tools.map((t) => t.id),
    catalog.filter((t) => t.accepts.image).map((t) => t.id),
  );
  checks.push(
    "The current executable matches the complete registry fixture; every file extension and clipboard image uses exactly the registry accepts contract.",
  );
  for (const state of [2, 3, 4]) {
    assert.equal(
      (await invoke(tray, "context_fixture", { request: { kind: "notification", state } })).silent,
      true,
    );
    assert.deepEqual(await invoke(tray, "tool_catalog", { paths: [path("Photo 1.png")] }), []);
    assert.equal(await invoke(tray, "tool_suggest", { paths: [path("Photo 1.png")] }), null);
  }
  await invoke(tray, "context_fixture", { request: { kind: "notification", state: 1 } });
  assert((await invoke(tray, "tool_catalog", { paths: [path("Photo 1.png")] })).length > 0);
  checks.push(
    "All three quiet notification states suppress both primary and secondary drop tools; ordinary notification state restores accepted actions.",
  );
  const finish = async (id) =>
    wait(
      async () => {
        const job = (await invoke(tray, "tool_jobs")).find((j) => j.id === id);
        if (!job || ["queued", "running", "publishing"].includes(job.status)) return null;
        assert.equal(
          job.status,
          "completed",
          `${job.request.toolId}/${job.request.presetId}: ${job.error}`,
        );
        return job;
      },
      "default preset output",
      180000,
    );
  const open = async (tool, presetId, inputs) => {
    const id = randomUUID();
    await invoke(tray, "tool_open_media_sheet", {
      intent: { id, toolId: tool.id, presetId, input: inputs[0], inputs },
    });
    const page = await wait(
      async () =>
        browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url().includes("?media-sheet")),
      "explicit file review",
    );
    await page.waitForFunction(
      (name) => globalThis.document.querySelector("h1")?.textContent === name,
      tool.id === "to-jpg" ? "Convert images" : tool.name,
    );
    const run = page.locator("button.n-button--primary").last();
    await wait(() => run.isEnabled(), "default review inspection", 60000);
    assert.equal(await page.getByRole("alert").count(), 0);
    return { id, page, run };
  };
  // QR encode precedes decode so every job receives an appropriate generated input.
  const ordered = [...catalog].sort(
    (a, b) => Number(b.id === "encode-qr") - Number(a.id === "encode-qr"),
  );
  let qr;
  for (const tool of ordered)
    for (const presetId of tool.presets) {
      const inputs =
        tool.id === "encode-qr"
          ? [path("QR text.txt")]
          : tool.id === "decode-qr"
            ? [qr]
            : tool.id === "merge-pdf"
              ? [path("Page 1.pdf"), path("Page 2.pdf")]
              : ["split-pdf", "pdf-png"].includes(tool.id)
                ? [path("Page 1.pdf")]
                : tool.id === "images-pdf"
                  ? [path("Photo 1.png"), path("Photo 2.png")]
                  : tool.id === "smaller-image"
                    ? [path("Noise.png")]
                    : tool.category === "documents" || tool.category === "images"
                      ? [path("Photo 1.png")]
                      : [path("Clip.mp4")];
      const inputHashes = await Promise.all(
        inputs.map(async (input) => ({ path: input, sha256: hash(await readFile(input)) })),
      );
      const before = await invoke(tray, "tool_jobs");
      const { page, run } = await open(tool, presetId, inputs);
      assert.equal(
        (await invoke(tray, "tool_jobs")).length,
        before.length,
        "Opening review must not enqueue",
      );
      if (["discord", "avif", "split", "qr"].includes(presetId))
        await capture(page, `defaults-${tool.id}-${presetId}`, ".media-review");
      await run.click();
      const job = await wait(async () => {
        const current = await invoke(tray, "tool_jobs");
        const added = current.filter((j) => !before.some((old) => old.id === j.id));
        assert(
          added.length <= 1,
          "One default output expected for the one-page or one-file fixture",
        );
        return added[0] ?? null;
      }, "explicit Run enqueues default preset");
      const done = await finish(job.id);
      assert.equal(done.request.toolId, tool.id);
      assert.equal(done.request.presetId, presetId);
      for (const input of inputHashes) assert.equal(hash(await readFile(input.path)), input.sha256);
      done.verifiedInputHashes = inputHashes;
      assert(done.output && !inputs.includes(done.output));
      assert(done.output.includes(`(${done.preset.name})`));
      assert((await stat(done.output)).size > 0);
      assert.equal((await stat(done.output)).mtimeMs, (await stat(inputs[0])).mtimeMs);
      assert.equal((await stat(done.output)).birthtimeMs, (await stat(inputs[0])).birthtimeMs);
      results.jobs.push(done);
      if (tool.id === "encode-qr") qr = done.output;
      if (tool.id === "decode-qr")
        assert.equal(await readFile(done.output, "utf8"), "https://example.com/owned-nabbit-512");
      if (tool.id === "image-text")
        assert((await readFile(done.output, "utf8")).includes("NABBIT"));
      if (["images-pdf", "merge-pdf", "split-pdf"].includes(tool.id))
        assert.equal(
          await invoke(tray, "tool_pdf_pages", { path: done.output }),
          tool.id === "split-pdf" ? 1 : 2,
        );
      if (tool.id === "to-jpg")
        assert.equal(
          (await invoke(tray, "tool_image_inspect", { path: done.output })).info.format,
          presetId,
        );
      if (tool.id === "pdf-png") {
        const info = (await invoke(tray, "tool_image_inspect", { path: done.output })).info;
        assert.deepEqual([info.format, info.width, info.height], ["png", 2560, 1440]);
        execFileSync(
          "python",
          [
            "-X",
            "utf8",
            "-c",
            "from PIL import Image;import sys;im=Image.open(sys.argv[1]);im.load();assert im.size==(2560,1440) and im.format=='PNG'",
            done.output,
          ],
          { windowsHide: true, timeout: 30000 },
        );
      }
    }
  assert.equal(
    results.jobs.length,
    catalog.reduce((sum, t) => sum + t.presets.length, 0),
  );
  checks.push(
    `All ${results.jobs.length} native tool/preset combinations run through their untouched default review and explicit Run, retain input files and dates, use preset names and produce real outputs.`,
  );
  // A real JPEG GPS IFD survives default conversion and is removed by the image strip route.
  const outputs = [];
  for (const toolId of ["to-jpg", "strip-metadata"]) {
    const before = await invoke(tray, "tool_jobs");
    const { run } = await open(
      catalog.find((t) => t.id === toolId),
      toolId === "to-jpg" ? "jpg" : "strip",
      [path("GPS.jpg")],
    );
    await run.click();
    const next = await wait(
      async () =>
        (await invoke(tray, "tool_jobs")).find((j) => !before.some((old) => old.id === j.id)),
      "JPEG metadata output",
    );
    const done = await finish(next.id);
    results.jobs.push(done);
    outputs.push(done.output);
  }
  execFileSync(
    "python",
    [
      "-X",
      "utf8",
      "-c",
      "from PIL import Image;import sys;gps=lambda p: Image.open(p).getexif().get_ifd(34853);a,b,c=map(gps,sys.argv[1:]);assert a and a==b and not c,(a,b,c)",
      path("GPS.jpg"),
      ...outputs,
    ],
    { windowsHide: true, timeout: 30000 },
  );
  checks.push(
    "Pillow independently reads the actual JPEG GPS latitude/longitude IFD: default conversion retains it exactly; explicit image metadata strip removes it.",
  );
  for (const [file, digest] of Object.entries(originals))
    assert.equal(hash(await readFile(path(file))), digest);
  results.originals = originals;
  await stop();
  await start();
  tray = await wait(findTray, "restart job history");
  const retained = await invoke(tray, "tool_jobs");
  for (const job of results.jobs)
    assert.equal(retained.find((j) => j.id === job.id)?.output, job.output);
  checks.push(
    "Every completed default job survives restart; all generated source hashes remain unchanged.",
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
        scope:
          "Owned production executable, isolated profile, generated files, real tool executors and DOM-only input. No real clipboard, global input, user files, installed integrations, OS setting changes, Store, account or installer execution.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(root, `progress/v2/M10/${prefix}-scene-log.txt`), logs, { flag: "wx" });
}
globalThis.console.log("Verified every native registry preset with defaults and explicit Run.");
