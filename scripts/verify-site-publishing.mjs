import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { preview } from "vite";
import { auditFont } from "./font-audit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: { prefix: { type: "string", default: "l2" } } });
assert(/^[a-z][a-z0-9-]{0,50}$/.test(values.prefix));
const output = resolve(root, "progress/v2/M3");
await mkdir(output, { recursive: true });
const reportPath = resolve(output, `${values.prefix}-publishing-checks.json`);
try {
  await access(reportPath);
  throw new Error("Capture prefix already exists");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const notFoundHtml = await readFile(resolve(root, "docs/404.html"), "utf8");
const ogImage = await readFile(resolve(root, "docs/assets/og.png"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const captures = [],
  contexts = [];
let server, browser;
try {
  server = await preview({
    build: { outDir: "docs" },
    base: "/nabbit/",
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
    logLevel: "error",
  });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const missing = `${origin}/nabbit/absent/deep/page.html`;
  browser = await chromium.launch({ headless: true });
  for (const kind of ["404", "og"])
    for (const width of kind === "404" ? [1440, 390] : [1200])
      for (const theme of ["light", "dark"])
        for (const scale of [1, 1.5]) {
          const context = await browser.newContext({
            viewport: { width, height: kind === "og" ? 630 : width === 390 ? 844 : 1000 },
            colorScheme: theme,
            deviceScaleFactor: scale,
            reducedMotion: "reduce",
            serviceWorkers: "block",
          });
          try {
            const errors = [],
              external = [],
              recovery = [];
            await context.route("**/*", (route) => {
              const request = route.request();
              if (
                request.url() === "https://tanzir71.github.io/nabbit/" &&
                request.isNavigationRequest()
              ) {
                // Observe real keyboard navigation without contacting the deployed site.
                recovery.push("https://tanzir71.github.io/nabbit/");
                return route.fulfill({
                  status: 302,
                  headers: { location: `${origin}/nabbit/` },
                  body: "",
                });
              }
              if (new URL(request.url()).origin !== origin) {
                external.push(request.url());
                return route.abort();
              }
              return route.continue();
            });
            await context.route(missing, (route) =>
              route.fulfill({ status: 404, contentType: "text/html", body: notFoundHtml }),
            );
            const page = await context.newPage();
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("response", (response) => {
              if (response.status() >= 400 && response.url() !== missing)
                errors.push(`${response.status()} ${response.url()}`);
            });
            const response = await page.goto(
              kind === "404" ? missing : `${origin}/nabbit/og.html`,
              { waitUntil: "networkidle" },
            );
            assert.equal(response.status(), kind === "404" ? 404 : 200);
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
              mono: await auditFont(
                page,
                kind === "404" ? ".not-found-code" : ".og-state",
                "Geist Mono",
              ),
            };
            assert.equal(
              await page.evaluate(() => globalThis.document.documentElement.scrollWidth),
              width,
            );
            assert.equal(
              await page.evaluate(
                () => globalThis.getComputedStyle(globalThis.document.body).fontStyle,
              ),
              "normal",
            );
            const logo = page.locator('img[src="assets/favicon.svg"]');
            assert(await logo.isVisible(), "The brand mark must remain visible on every surface");
            const logoBounds = await logo.boundingBox();
            assert.equal(logoBounds.width, 32);
            assert.equal(logoBounds.height, 32);
            assert.deepEqual(
              await logo.evaluate((img) => [
                img.width,
                img.height,
                img.naturalWidth,
                img.naturalHeight,
              ]),
              [32, 32, 32, 32],
            );
            if (kind === "404") {
              assert.equal(
                await page.locator('meta[name="robots"]').getAttribute("content"),
                "noindex, follow",
              );
              const home = page.getByRole("link", { name: "Back to Nabbit", exact: true });
              await home.focus();
              assert.equal(
                await home.evaluate((el) => globalThis.getComputedStyle(el).outlineStyle),
                "solid",
              );
            }
            const name = `${values.prefix}-${kind}-${width}-${theme}@${scale}x.png`;
            const png = await page.screenshot({
              animations: "disabled",
              scale: "device",
              caret: "hide",
              fullPage: true,
            });
            assert(png.length <= 300000, `Screenshot exceeds 300 KB: ${name}`);
            assert.equal(png.readUInt32BE(16), width * scale);
            const info = {
              file: name,
              bytes: png.length,
              sha256: sha(png),
              width: png.readUInt32BE(16),
              height: png.readUInt32BE(20),
            };
            captures.push({ ...info, png });
            if (kind === "404") {
              await page.keyboard.press("Enter");
              await page.waitForURL(`${origin}/nabbit/`);
              assert.deepEqual(recovery, ["https://tanzir71.github.io/nabbit/"]);
              assert.equal(
                await page.locator("h1").textContent(),
                "The top of your screen, put to work.",
              );
              assert.equal(await page.locator("[data-download-cta]").count(), 3);
              const imageUrl = await page
                .locator('meta[property="og:image"]')
                .getAttribute("content");
              const twitterUrl = await page
                .locator('meta[name="twitter:image"]')
                .getAttribute("content");
              assert.equal(imageUrl, "https://tanzir71.github.io/nabbit/assets/og.png");
              assert.equal(imageUrl, twitterUrl);
              const image = await context.request.get(`${origin}${new URL(imageUrl).pathname}`);
              assert.equal(image.status(), 200);
              assert.equal(sha(await image.body()), sha(ogImage));
              const llms = await context.request.get(`${origin}/nabbit/llms.txt`);
              assert.equal(llms.status(), 200);
              assert((await llms.text()).includes("There is no v2 release yet"));
            } else if (scale === 1) assert.equal(sha(png), sha(ogImage));
            assert.deepEqual(errors, []);
            assert.deepEqual(external, []);
            contexts.push({
              kind,
              width,
              theme,
              scale,
              fonts,
              screenshot: info,
              expected404Status: kind === "404",
              recoveryNavigationInterceptedLocally: recovery,
              errors,
              external,
            });
          } finally {
            await context.close();
          }
        }
  for (const capture of captures)
    await writeFile(resolve(output, capture.file), capture.png, { flag: "wx" });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        basePath: "/nabbit/",
        canonical: "https://tanzir71.github.io/nabbit/",
        socialPngSha256: sha(ogImage),
        contexts,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  globalThis.console.log(
    `Passed ${contexts.length} publishing contexts; saved ${captures.length} PNGs, largest ${Math.max(...captures.map((item) => item.bytes))} bytes. Nested 404 recovery and social/agent assets resolve without external resource requests.`,
  );
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    if (server) await new Promise((done) => server.httpServer.close(done));
  }
}
