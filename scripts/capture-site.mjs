import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

// P.4 uses an isolated QA runtime until the app's screenshot harness lands in V1.6:
// npm install --prefix .tools/site-qa --no-audit --no-fund --ignore-scripts playwright@1.65.1
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const paths = [root, resolve(root, ".tools/site-qa")];
const { chromium } = require(require.resolve("playwright", { paths }));
const version = require(require.resolve("playwright/package.json", { paths })).version;
const output = resolve(root, process.argv[2] ?? "progress/v2/M0");
const prefix = process.argv[3] ?? "p4";
assert(/^[a-z0-9-]+$/.test(prefix), "Use a simple capture prefix");
await mkdir(output, { recursive: true });
const origin = "http://127.0.0.1:1438";
const base = `${origin}/nabbit/`;
const server = spawn(
  process.execPath,
  [
    resolve(root, "node_modules/vite/bin/vite.js"),
    "preview",
    "--outDir",
    "docs",
    "--base",
    "/nabbit/",
    "--host",
    "127.0.0.1",
    "--port",
    "1438",
    "--strictPort",
  ],
  { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
for (const stream of [server.stdout, server.stderr])
  stream.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
let browser;
const checks = [];
const screenshots = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Vite preview exited: ${serverLog}`);
    try {
      ready = (await globalThis.fetch(base)).ok;
    } catch {
      /* Server is starting. */
    }
    if (ready) break;
    await setTimeout(100);
  }
  assert(ready, `Vite preview did not start: ${serverLog}`);
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390])
    for (const colorScheme of ["light", "dark"])
      for (const deviceScaleFactor of [1, 1.5]) {
        const context = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 1000 },
          colorScheme,
          deviceScaleFactor,
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        const errors = [];
        const external = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", (route) => {
          if (!route.request().url().startsWith(`${origin}/`)) {
            external.push(route.request().url());
            return route.abort();
          }
          return route.continue();
        });
        page.on("response", (response) => {
          if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
        });
        const suffix = `${width}-${colorScheme}@${deviceScaleFactor}x`;
        async function capture(name, target = page) {
          const filename = `${prefix}-${name}-${suffix}.png`;
          await target.screenshot({ path: resolve(output, filename), animations: "disabled" });
          const bytes = (await stat(resolve(output, filename))).size;
          assert(bytes <= 300 * 1024, `Screenshot exceeds 300 KiB: ${filename}`);
          screenshots.push({ filename, bytes });
        }
        await page.goto(base, { waitUntil: "networkidle" });
        const primary = page.locator("[data-download-cta]");
        assert.equal(await primary.count(), 3);
        assert(await primary.first().isVisible(), "Mobile navigation must retain the primary CTA");
        for (const cta of await primary.all())
          assert.equal((await cta.textContent()).trim(), "Follow the build");
        assert(
          await page.evaluate(
            () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
          ),
          "Landing overflows horizontally",
        );
        await primary.first().focus();
        assert.equal(
          await primary
            .first()
            .evaluate((element) => globalThis.getComputedStyle(element).outlineStyle),
          "solid",
        );
        await capture("landing");
        await page.keyboard.press("Enter");
        await page.waitForURL("**/#progress");
        assert.equal(await page.locator("#progress [data-milestone]").count(), 13);
        for (const icon of await page.locator(".milestones img").all()) {
          assert(
            await icon.evaluate(
              (image) => image.complete && image.naturalWidth === 16 && image.naturalHeight === 16,
            ),
          );
          const rect = await icon.boundingBox();
          assert.equal(rect.width, 16);
          assert.equal(rect.height, 16);
        }
        await capture("progress", page.locator("#progress"));
        await page.locator('footer a[href="demo/"]').click();
        await page.waitForURL("**/nabbit/demo/");
        assert((await page.locator(".bar").textContent()).includes("does not read your clipboard"));
        await page.getByRole("button", { name: "Stage", exact: true }).click();
        assert(await page.getByRole("button", { name: "Download", exact: true }).isVisible());
        await page.goto(`${base}404.html`, { waitUntil: "networkidle" });
        assert.equal(
          await page.getByRole("link", { name: "Back to Nabbit" }).getAttribute("href"),
          "https://tanzir71.github.io/nabbit/",
        );
        assert(
          await page.evaluate(
            () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
          ),
          "404 overflows horizontally",
        );
        await capture("404");
        assert.deepEqual(external, [], "The static site must not request third-party resources");
        assert.deepEqual(errors, [], "The page must have no runtime or missing-resource errors");
        checks.push({ width, colorScheme, deviceScaleFactor, status: "passed" });
        await context.close();
      }
  await writeFile(
    resolve(output, `${prefix}-site-checks.json`),
    JSON.stringify(
      {
        playwright: version,
        basePath: "/nabbit/",
        checks,
        screenshots,
        source404Bytes: (await readFile(resolve(root, "docs/404.html"))).length,
      },
      null,
      2,
    ) + "\n",
  );
  globalThis.console.log(
    `Passed ${checks.length} browser contexts; saved ${screenshots.length} PNGs under ${output}.`,
  );
} finally {
  if (browser) await browser.close();
  server.kill();
}
