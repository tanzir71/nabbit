import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { preview } from "vite";
import { auditFont } from "./font-audit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const imagePath = resolve(root, "docs/assets/og.png");
const manifestPath = resolve(root, "docs/assets/og-manifest.json");
const chromiumArgs = ["--disable-gpu", "--disable-skia-runtime-opts"];
let server, browser;
try {
  server = await preview({
    build: { outDir: "docs" },
    base: "/nabbit/",
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
    logLevel: "error",
  });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, args: chromiumArgs });
  const context = await browser.newContext({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  const external = [],
    errors = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`${origin}/nabbit/og.html`, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready;
    await Promise.all(
      [...globalThis.document.images].map((img) => {
        img.loading = "eager";
        return img.decode();
      }),
    );
  });
  const fonts = {
    sans: await auditFont(page, "h1", "Geist"),
    mono: await auditFont(page, ".og-state", "Geist Mono"),
  };
  assert.deepEqual(
    await page.evaluate(() => [
      globalThis.document.documentElement.scrollWidth,
      globalThis.document.documentElement.scrollHeight,
    ]),
    [1200, 630],
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const bytes = await page.screenshot({ animations: "disabled", scale: "device", caret: "hide" });
  const repeated = await page.screenshot({
    animations: "disabled",
    scale: "device",
    caret: "hide",
  });
  assert(bytes.equals(repeated), "Social image changed between exact repeat captures");
  assert.equal(bytes.readUInt32BE(16), 1200);
  assert.equal(bytes.readUInt32BE(20), 630);
  assert(bytes.length < 300000);
  const imageSources = await page
    .locator("img")
    .evaluateAll((imgs) => imgs.map((img) => img.getAttribute("src")));
  const paths = [
    ...new Set([
      "og.html",
      "assets/site.css",
      "assets/tokens.css",
      "assets/favicon.ico",
      "assets/fonts/Geist-Latin.woff2",
      "assets/fonts/GeistMono-Latin.woff2",
      ...imageSources,
    ]),
  ].sort();
  const sources = await Promise.all(
    paths.map(async (file) => {
      const input = await readFile(resolve(root, "docs", file));
      return {
        file,
        sha256: sha(
          /\.(?:html|css|svg)$/.test(file) ? input.toString().replace(/\r\n/g, "\n") : input,
        ),
      };
    }),
  );
  const manifest = {
    source: "og.html",
    renderer: "Playwright Chromium",
    chromiumArgs,
    repeatIdentical: true,
    playwright: require("playwright/package.json").version,
    width: 1200,
    height: 630,
    scale: 1,
    image: { file: "assets/og.png", bytes: bytes.length, sha256: sha(bytes) },
    fonts,
    sources,
    textHashNormalization: "LF for HTML/CSS/SVG; binary bytes unchanged",
  };
  if (values.check) {
    const saved = await readFile(imagePath);
    // A Buffer deep-diff can allocate tens of GB when the image differs. Keep
    // exact byte equality and report compact digests instead of a byte-array diff.
    assert(
      saved.equals(bytes),
      `Regenerate stale social image with npm run site:og (${sha(saved)} != ${sha(bytes)})`,
    );
    assert.deepEqual(
      JSON.parse(await readFile(manifestPath, "utf8")),
      manifest,
      "Stale social image provenance",
    );
  } else {
    await writeFile(imagePath, bytes);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  globalThis.console.log(
    `${values.check ? "Verified" : "Rendered"} 1200×630 Playwright social preview (${bytes.length} bytes), custom fonts and local-only assets.`,
  );
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    if (server) await new Promise((done) => server.httpServer.close(done));
  }
}
