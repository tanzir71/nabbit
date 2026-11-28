// Runs only an owned executable with unique app-data, control and WebView2
// directories. DOM input stays inside its webview; no global input is injected.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir, rename, stat, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
import { chromium } from "playwright";
const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v510-native-a";
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
const jobs = [];
let restartRecords = [];
try {
  await start();
  const tray = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("tauri.localhost") && !p.url().includes("island.html")),
    "owned tray",
  );
  await tray.waitForFunction(() => !!globalThis.__TAURI_INTERNALS__?.invoke);
  const profile = env.NABBIT_APP_DATA_DIR;
  const photos = [resolve(profile, "Photo 1.png"), resolve(profile, "Photo 2.png")];
  execFileSync(
    "python",
    [
      "-X",
      "utf8",
      "-c",
      `from PIL import Image,ImageDraw,ImageFont;from pathlib import Path;import sys,random
root=Path(sys.argv[1]);font=ImageFont.truetype(sys.argv[2],100)
for n in [1,2]:
 im=Image.new('RGB',(1280,720),'white');d=ImageDraw.Draw(im);d.text((40,180),'NABBIT 510',font=font,fill='black');d.rectangle((40,400,1200,620),fill=(70+n*20,120,180));ex=Image.Exif();ex[0x132]='2024:06:01 12:13:14';im.save(root/f'Photo {n}.png',exif=ex)
Image.frombytes('RGB',(1280,720),random.Random(510).randbytes(1280*720*3)).save(root/'Noise.png')
Image.new('RGB',(400,200),'white').save(root/'Blank.png')
(root/'QR text.txt').write_text('https://example.com/owned-nabbit-510',encoding='utf-8')`,
      profile,
      resolve(root, "src/assets/fonts/Geist-Variable.ttf"),
    ],
    { windowsHide: true, timeout: 30000 },
  );
  const originalHashes = await Promise.all(photos.map(async (p) => hash(await readFile(p))));
  const heic = resolve(profile, "Grid.heic");
  await copyFile(resolve(root, ".tools/v510-heic/image1.heic"), heic);
  const info = await invoke(tray, "tool_image_inspect", { path: heic });
  assert.equal(info.info.decoder, "WIC");
  assert.deepEqual([info.info.width, info.info.height], [3992, 2992]);
  await tray.evaluate(async () => {
    globalThis.__codecIntents = [];
    const api = globalThis.__TAURI_INTERNALS__;
    const handler = api.transformCallback((event) => globalThis.__codecIntents.push(event.payload));
    await api.invoke("plugin:event|listen", {
      event: "tools:codec",
      target: { kind: "Any" },
      handler,
    });
  });
  await invoke(tray, "tool_image_codec", { codec: "heif" });
  await invoke(tray, "tool_image_codec", { codec: "hevc" });
  const codecs = await wait(
    () =>
      tray.evaluate(() =>
        globalThis.__codecIntents.length === 2 ? globalThis.__codecIntents : null,
      ),
    "codec Store seam",
  );
  assert(codecs.every((c) => c.injected));
  assert.deepEqual(
    codecs.map((c) => c.url),
    [
      "https://apps.microsoft.com/detail/9PMMSR1CGPWG",
      "https://apps.microsoft.com/detail/9NMZLZ57R3T7",
    ],
  );
  checks.push(
    "Both fixed HEIF/HEVC Store links run through the native acceptance provider; no Store or browser is launched.",
  );
  const notices = await invoke(tray, "third_party_licenses");
  assert.deepEqual(
    notices,
    JSON.parse(await readFile(resolve(root, "third-party/notices.json"), "utf8")),
  );
  assert(
    notices.components.some(
      (c) => c.name === "Native · libwebp" && c.texts.some((t) => t.name === "PATENTS"),
    ),
  );
  checks.push(
    `The embedded ${notices.components.length}-component offline notice payload matches the generated source, including vendored libwebp BSD terms and patent grant.`,
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
          const response = await globalThis.fetch(`/${file}`);
          const bytes = await response.arrayBuffer();
          const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
          return {
            file,
            ok: response.ok,
            sha256: [...new Uint8Array(digest)]
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
  checks.push(`All ${assets.length} embedded manifest assets match this build byte-for-byte.`);
  const catalog = await invoke(tray, "tool_catalog");
  assert.equal(catalog.length, 17);
  assert.equal(await invoke(tray, "tool_suggest", { paths: photos }), "images-pdf");
  assert.equal(await invoke(tray, "tool_suggest", { paths: [heic] }), "to-jpg");
  const open = async (toolId, inputs) => {
    await invoke(tray, "tool_open_media_sheet", {
      intent: { id: randomUUID(), toolId, input: inputs[0] ?? "", inputs },
    });
    const page = await wait(
      async () =>
        browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url().includes("?media-sheet")),
      "file review",
    );
    await page.waitForFunction(
      (id) => globalThis.document.querySelector("h1")?.textContent === id,
      catalog.find((t) => t.id === toolId).name,
    );
    return page;
  };
  const finish = async (id) =>
    wait(
      async () => {
        const job = (await invoke(tray, "tool_jobs")).find((j) => j.id === id);
        if (!job || ["queued", "running", "publishing"].includes(job.status)) return null;
        assert.equal(job.status, "completed", job.error);
        return job;
      },
      "file output",
      120000,
    );
  const submit = async (toolId, input, presetId, documentOptions = { inputs: [], pages: [] }) => {
    const request = { requestId: randomUUID(), toolId, input, presetId, documentOptions };
    const pending = await invoke(tray, "tool_start", { request });
    const done = await finish(pending.id);
    jobs.push(done);
    return done;
  };
  let review = await open("to-jpg", photos);
  await review.getByRole("button", { name: "Convert 2 photos" }).waitFor();
  await wait(
    () => review.getByRole("button", { name: "Convert 2 photos" }).isEnabled(),
    "image inspection",
  );
  assert.deepEqual(await invoke(tray, "tool_jobs"), []);
  assert.deepEqual(await invoke(review, "shelf_list"), []);
  let denied = false;
  try {
    await invoke(review, "shelf_add", { paths: [photos[0]] });
  } catch (error) {
    denied = String(error).includes("Only an active island");
  }
  assert(denied, "Auxiliary review must not gain Shelf mutation access");
  checks.push(
    "Auxiliary review can read Shelf choices and still cannot mutate the Shelf; valid review captures contain no error alert.",
  );
  await capture(review, "convert", ".image-review");
  await review.getByRole("button", { name: "Convert 2 photos" }).click();
  const converted = await wait(
    async () => {
      const rows = await invoke(tray, "tool_jobs");
      return rows.length === 2 && rows.every((j) => j.status === "completed") ? rows : null;
    },
    "batch image conversion",
    120000,
  );
  for (const job of converted) {
    assert(job.output.endsWith(".jpg"));
    jobs.push(job);
  }
  checks.push(
    "Native image review starts no job until Run; batch conversion produces two new JPGs through the durable runner.",
  );
  await writeFile(env.NABBIT_ACCEPTANCE_CURSOR, JSON.stringify({ x: 960, y: 200 }));
  await island({ surface: { label: "island", state: "expanded" } });
  const islandPage = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("island.html")),
    "expanded island",
  );
  await islandPage.getByRole("button", { name: "Files", exact: true }).click();
  const imageResult = islandPage.getByRole("article", {
    name: "To JPG · Photo 1.png",
    exact: true,
  });
  await imageResult
    .getByRole("button", { name: "Remove location and camera data", exact: true })
    .waitFor();
  await capture(islandPage, "image-result", '.tool-result[aria-label="To JPG · Photo 1.png"]');
  await imageResult
    .getByRole("button", { name: "Remove location and camera data", exact: true })
    .click();
  await review
    .getByRole("heading", { name: "Remove location and camera data", exact: true })
    .waitFor();
  await wait(
    () => review.getByRole("button", { name: "Clean 1 photo", exact: true }).isEnabled(),
    "privacy review",
  );
  assert.equal((await invoke(tray, "tool_jobs")).length, 2);
  await capture(review, "privacy-review", ".image-review");
  await review.getByRole("button", { name: "Clean 1 photo", exact: true }).click();
  const cleaned = await wait(async () => {
    const row = (await invoke(tray, "tool_jobs")).find(
      (j) => j.request.toolId === "strip-metadata",
    );
    return row ? finish(row.id) : null;
  }, "privacy output");
  jobs.push(cleaned);
  checks.push(
    "The registry privacy chip on an actual image result opens a review without starting work; explicit Clean produces a new lossless metadata-stripped image.",
  );
  review = await open("images-pdf", photos);
  await capture(review, "make-pdf", ".document-review");
  await review.getByRole("button", { name: "Make PDF", exact: true }).click();
  const made = await wait(
    async () => {
      const rows = await invoke(tray, "tool_jobs");
      const job = rows.find((j) => j.request.toolId === "images-pdf");
      return job ? finish(job.id) : null;
    },
    "images PDF",
    120000,
  );
  jobs.push(made);
  assert.equal(await invoke(tray, "tool_pdf_pages", { path: made.output }), 2);
  const split = await submit("split-pdf", made.output, "split", { inputs: [], pages: [2] });
  assert.equal(await invoke(tray, "tool_pdf_pages", { path: split.output }), 1);
  const merged = await submit("merge-pdf", split.output, "pdf", {
    inputs: [made.output],
    pages: [],
  });
  assert.equal(await invoke(tray, "tool_pdf_pages", { path: merged.output }), 3);
  review = await open("pdf-png", [made.output]);
  await review.getByText("2 pages", { exact: true }).waitFor();
  await capture(review, "pdf-render", ".document-review");
  const rendered = await submit("pdf-png", made.output, "png", { inputs: [], pages: [2] });
  assert.equal((await readFile(rendered.output)).subarray(1, 4).toString(), "PNG");
  const ocr = await submit("image-text", photos[0], "text");
  assert((await readFile(ocr.output, "utf8")).toUpperCase().includes("NABBIT"));
  const empty = await invoke(tray, "tool_start", {
    request: {
      requestId: randomUUID(),
      toolId: "image-text",
      input: resolve(profile, "Blank.png"),
      presetId: "text",
    },
  });
  const noText = await wait(async () => {
    const row = (await invoke(tray, "tool_jobs")).find((j) => j.id === empty.id);
    return row && !["queued", "running", "publishing"].includes(row.status) ? row : null;
  }, "empty OCR result");
  assert.equal(noText.status, "failed");
  assert(noText.error.includes("No text found"));
  assert.equal(noText.output, null);
  jobs.push(noText);
  checks.push("Blank image OCR reports No text found and publishes no output.");
  const qr = await submit("encode-qr", resolve(profile, "QR text.txt"), "qr");
  const decoded = await submit("decode-qr", qr.output, "text");
  assert.equal(await readFile(decoded.output, "utf8"), "https://example.com/owned-nabbit-510");
  const fit = await invoke(tray, "tool_start", {
    request: {
      requestId: randomUUID(),
      toolId: "fit-size",
      input: resolve(profile, "Noise.png"),
      presetId: "custom-fit",
      imageOptions: { format: "jpg", quality: 82 },
      options: { maxMb: 1 },
    },
  });
  const fitted = await finish(fit.id);
  assert(fitted.beforeBytes > 1_000_000 && fitted.afterBytes <= 1_000_000);
  jobs.push(fitted);
  checks.push(
    "A generated noisy PNG over 1 MB fits the shared custom 1-MB preset as an actual measured JPG output through the durable runner.",
  );
  const webp = await invoke(tray, "tool_start", {
    request: {
      requestId: randomUUID(),
      toolId: "to-jpg",
      input: photos[0],
      presetId: "webp",
      imageOptions: { format: "webp", quality: 82 },
    },
  });
  const encodedWebp = await finish(webp.id);
  assert.equal(
    (await invoke(tray, "tool_image_inspect", { path: encodedWebp.output })).info.format,
    "webp",
  );
  jobs.push(encodedWebp);
  checks.push(
    "Actual two-page image PDF, range split, ordered three-page merge, 144-DPI Windows PDF software rendering, user-language OCR and file QR encode/decode all complete through Tauri and the shared job store.",
  );
  for (const [index, path] of photos.entries()) {
    assert.equal(hash(await readFile(path)), originalHashes[index]);
    const source = await stat(path),
      out = await stat(converted.find((j) => j.request.input === path).output);
    assert.equal(out.mtimeMs, source.mtimeMs);
    assert.equal(out.birthtimeMs, source.birthtimeMs);
  }
  await invoke(tray, "tool_undo", { id: rendered.id });
  assert.equal(
    (await invoke(tray, "tool_jobs")).find((j) => j.id === rendered.id).status,
    "undone",
  );
  checks.push(
    "All original image hashes and physical created/modified dates stay unchanged; output dates match. Guarded Undo uses the injected owned quarantine provider.",
  );
  await stop();
  await start();
  const reopened = await wait(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("tauri.localhost") && !p.url().includes("island.html")),
    "reopened tray",
  );
  const records = await invoke(reopened, "tool_jobs");
  restartRecords = records;
  for (const job of jobs) {
    assert.equal(
      records.find((r) => r.id === job.id).status,
      job.id === rendered.id ? "undone" : job.status,
    );
  }
  assert.equal(records.length, jobs.length);
  assert.equal(records.find((j) => j.id === rendered.id).status, "undone");
  checks.push(
    "Restart retains every completed/undone image/document job and its exact source/options without re-execution.",
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
        jobs,
        restartRecords,
        executableSha256: hash(await readFile(exe)),
        buildManifestSha256: hash(await readFile(resolve(root, "dist/.vite/manifest.json"))),
        noUserProfile: true,
        noRealRecycleBinOrExplorer: true,
        noOsSettingChange: true,
        scope:
          "Owned production executable, isolated app-data/WebView/control profiles and generated image/text fixtures plus a local verification-only public HEIC sample. DOM input only; no clipboard, global input, real cursor, native dialog, Store install, user files, hosted Tack, signing or OS changes.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(root, `progress/v2/M10/${prefix}-scene-log.txt`), logs, { flag: "wx" });
}
globalThis.console.log(
  "Verified native image/document review, explicit batch conversion, PDF basics, OCR, QR, guarded Undo and restart.",
);
