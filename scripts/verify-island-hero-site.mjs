import assert from "node:assert/strict";
import { readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { chromium } from "playwright";
import { preview } from "vite";
import { auditFont } from "./font-audit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const prefix = process.argv[2] ?? "v27-hero";
assert(/^[a-z0-9-]+$/.test(prefix));
const folder = resolve(root, "progress/v2/M5"),
  reportPath = resolve(folder, `${prefix}-site.json`);
try {
  await access(reportPath);
  throw new Error("Evidence exists; use a unique prefix");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(await readFile(resolve(root, "docs/assets/island-hero.json"), "utf8"));
let browser, server;
const captures = [];
try {
  server = await preview({
    build: { outDir: "docs" },
    base: "/nabbit/",
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
    logLevel: "error",
  });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"])
      for (const scale of [1, 1.5]) {
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          colorScheme: theme,
          deviceScaleFactor: scale,
          reducedMotion: "reduce",
          serviceWorkers: "block",
        });
        try {
          const errors = [],
            external = [];
          await context.route("**/*", (route) => {
            if (new URL(route.request().url()).origin !== origin) {
              external.push(route.request().url());
              return route.abort();
            }
            return route.continue();
          });
          const page = await context.newPage();
          page.on("pageerror", (e) => errors.push(e.message));
          page.on("requestfailed", (r) => errors.push(r.url()));
          await page.goto(`${origin}/nabbit/`, { waitUntil: "networkidle" });
          await page.evaluate(async () => {
            await globalThis.document.fonts.ready;
            await Promise.all(
              [...globalThis.document.images]
                .filter((i) => i.getBoundingClientRect().width)
                .map((i) => {
                  i.loading = "eager";
                  return i.decode();
                }),
            );
          });
          assert(
            await page.evaluate(
              () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
            ),
          );
          const image = page.locator(".hero-capture img");
          const actual = await image.evaluate(async (i) => ({
            src: new globalThis.URL(i.currentSrc).pathname,
            width: i.naturalWidth,
            height: i.naturalHeight,
            bytes: Array.from(
              new Uint8Array(await (await globalThis.fetch(i.currentSrc)).arrayBuffer()),
            ),
          }));
          const expected = width === 390 ? manifest.mobile : manifest;
          assert(actual.src.endsWith(expected.file));
          assert.equal(actual.width, expected.width);
          assert.equal(actual.height, expected.height);
          assert.equal(sha(new Uint8Array(actual.bytes)), expected.sha256);
          const assets = await page.locator(".hero img[src$='.svg']").evaluateAll((images) =>
            images
              .filter((i) => i.getBoundingClientRect().width)
              .map((i) => ({
                natural: [i.naturalWidth, i.naturalHeight],
                actual: [i.getBoundingClientRect().width, i.getBoundingClientRect().height],
              })),
          );
          assert(assets.every((a) => a.natural.every((v, n) => Math.abs(v - a.actual[n]) < 0.01)));
          const fonts = await auditFont(page, ".hero h1", "Geist");
          const figure = page.locator(".hero-capture"),
            box = await figure.boundingBox();
          const png = await figure.screenshot({ animations: "disabled", scale: "device" });
          assert(png.length <= 300000);
          assert.equal(png.readUInt32BE(16), Math.round(box.width * scale));
          const repeat = await figure.screenshot({ animations: "disabled", scale: "device" });
          assert(png.equals(repeat));
          const file = `${prefix}-${width}-${theme}@${scale}x.png`;
          await writeFile(resolve(folder, file), png, { flag: "wx" });
          assert.equal(
            await page.locator(".hero [data-download-cta]").textContent(),
            "Follow the build",
          );
          assert.deepEqual(errors, []);
          assert.deepEqual(external, []);
          captures.push({
            file,
            width: png.readUInt32BE(16),
            height: png.readUInt32BE(20),
            bytes: png.length,
            sha256: sha(png),
            viewportWidth: width,
            theme,
            scale,
            currentImage: expected.file,
            servedImageSha256: expected.sha256,
            fonts,
            originalAssetGeometry: assets,
            repeatMatches: true,
            errors,
            external,
          });
        } finally {
          await context.close();
        }
      }
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        captures,
        heroManifestSha256: sha(await readFile(resolve(root, "docs/assets/island-hero.json"))),
        noExternalRequests: true,
        releaseCtasPreserved: true,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  globalThis.console.log(
    `Verified ${captures.length} responsive harness-hero contexts with exact served assets and device-pixel captures.`,
  );
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.httpServer.close(done));
}
