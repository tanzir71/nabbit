import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { preview } from "vite";
import { reviewContrast } from "./contrast-review.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { values } = parseArgs({ options: { prefix: { type: "string", default: "l3" } } });
assert(/^[a-z][a-z0-9-]{0,50}$/.test(values.prefix));
const output = resolve(root, "progress/v2/M3");
await mkdir(output, { recursive: true });
const reportPath = resolve(output, `${values.prefix}-accessibility.json`);
try {
  await access(reportPath);
  throw new Error("Capture prefix already exists");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const axePath = require.resolve("axe-core/axe.min.js");
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
            external = [],
            activations = [],
            scans = [],
            keyboard = [];
          await context.addInitScript(() => {
            globalThis.__copies = [];
            Object.defineProperty(globalThis.navigator, "clipboard", {
              configurable: true,
              value: { writeText: async (value) => globalThis.__copies.push(value) },
            });
          });
          await context.route("**/*", (route) => {
            const request = route.request();
            if (
              request.url() === "https://github.com/tanzir71/nabbit" &&
              request.isNavigationRequest()
            ) {
              activations.push(request.url());
              return route.fulfill({
                status: 200,
                contentType: "text/html",
                body: "<!doctype html><title>Repository navigation fixture</title><p>Locally intercepted repository link</p>",
              });
            }
            if (new URL(request.url()).origin !== origin) {
              external.push(request.url());
              return route.abort();
            }
            return route.continue();
          });
          const page = await context.newPage();
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("response", (response) => {
            if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
          });
          const open = async () => {
            await page.goto(`${origin}/nabbit/`, { waitUntil: "networkidle" });
            await page.evaluate(async () => {
              await globalThis.document.fonts.ready;
              await Promise.all(
                [...globalThis.document.images].map((img) => {
                  img.loading = "eager";
                  return img.decode();
                }),
              );
            });
          };
          const scan = async (state) => {
            if (!(await page.evaluate(() => Boolean(globalThis.axe))))
              await page.addScriptTag({ path: axePath });
            const report = await page.evaluate(async () => {
              const result = await globalThis.axe.run(globalThis.document, { reporter: "v2" });
              return {
                version: result.testEngine.version,
                violations: result.violations,
                incomplete: result.incomplete,
                passes: result.passes.map((rule) => ({ id: rule.id, nodes: rule.nodes.length })),
                inapplicable: result.inapplicable.map((rule) => rule.id),
              };
            });
            assert.deepEqual(
              report.violations,
              [],
              `Axe violations in ${width}/${theme}/${scale}/${state}`,
            );
            const contrastReviews = await reviewContrast(page, report.incomplete);
            scans.push({ state, ...report, contrastReviews });
          };
          const focused = async (name) => {
            const value = await page.evaluate(() => {
              const el = globalThis.document.activeElement,
                style = globalThis.getComputedStyle(el),
                rect = el.getBoundingClientRect();
              return {
                text: el.getAttribute("aria-label") || el.textContent.trim(),
                href: el.getAttribute("href"),
                outline: style.outlineStyle,
                outlineWidth: parseFloat(style.outlineWidth),
                visible: rect.width > 0 && rect.height > 0,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              };
            });
            assert.equal(value.text, name);
            assert(value.visible && value.outline === "solid" && value.outlineWidth >= 2);
            keyboard.push(value);
          };
          const capture = async (state) => {
            const png = await page.screenshot({
              animations: "disabled",
              caret: "hide",
              scale: "device",
              clip: { x: 0, y: 0, width, height: width === 390 ? 550 : 340 },
            });
            assert(png.length <= 300000);
            captures.push({
              file: `${values.prefix}-${state}-${width}-${theme}@${scale}x.png`,
              bytes: png.length,
              sha256: sha(png),
              png,
            });
          };
          await open();
          await scan("landing-default");
          await page.keyboard.press("Tab");
          await focused("Skip to content");
          await page.keyboard.press("Enter");
          await page.waitForURL("**/#main");
          await page.keyboard.press("Tab");
          await focused("Follow the build");
          assert(
            await page
              .locator(".hero [data-download-cta]")
              .evaluate((el) => el === globalThis.document.activeElement),
          );
          await page.keyboard.press("Enter");
          await page.waitForURL("**/#progress");
          await open();
          await page.keyboard.press("Tab");
          await page.keyboard.press("Tab");
          await focused("Nabbit home");
          await page.keyboard.press("Tab");
          const menu = page.locator(".nav-menu");
          if (width === 390) {
            await focused("Navigation menu");
            await page.keyboard.press("Enter");
            assert.notEqual(await menu.getAttribute("open"), null);
            await scan("mobile-menu-open");
            await capture("menu-focus");
            await page.keyboard.press("Escape");
            assert.equal(await menu.getAttribute("open"), null);
            await focused("Navigation menu");
            await page.keyboard.press("Enter");
            await page.keyboard.press("Tab");
          }
          for (const name of [
            "Features",
            "Files",
            "Notes",
            "Privacy",
            "Progress",
            "GitHub",
            "Follow the build",
          ]) {
            await focused(name);
            if (name !== "Follow the build") await page.keyboard.press("Tab");
          }
          if (width === 1440) await capture("nav-focus");
          await page.keyboard.press("Enter");
          await page.waitForURL("**/#progress");
          if (width === 390) {
            assert.equal(await menu.getAttribute("open"), null);
            const more = page.locator(".progress-more");
            await more.locator("summary").focus();
            await focused("All 13 milestones");
            await page.keyboard.press("Space");
            assert(await page.locator('[data-milestone="M12"]').isVisible());
            await scan("mobile-roadmap-open");
          }
          const bookmarklet = page.locator("[data-bookmarklet]");
          await bookmarklet.focus();
          await focused("Send to Nabbit");
          await page.keyboard.press("Enter");
          assert.equal(
            await page.evaluate(() => globalThis.__copies[0]),
            "javascript:location.href='nabbit://nab?url='+encodeURIComponent(location.href)",
          );
          assert(new URL(page.url()).origin === origin);
          // Exercise every visible source/final CTA by keyboard, intercepting the
          // external document before any network request reaches GitHub.
          for (const selector of [
            ".hero .secondary",
            ".final-cta [data-download-cta]",
            ".final-cta .secondary",
          ]) {
            await open();
            const link = page.locator(selector);
            if (!(await link.isVisible())) continue;
            await link.focus();
            await focused(
              selector.includes("secondary") ? "View source on GitHub" : "Follow the build",
            );
            const before = activations.length;
            await page.keyboard.press("Enter");
            await page.waitForURL("https://github.com/tanzir71/nabbit");
            assert.equal(activations.length, before + 1);
          }
          // Auxiliary public page has no JavaScript and shares the audited type.
          await page.goto(`${origin}/nabbit/404.html`, { waitUntil: "networkidle" });
          await page.evaluate(() => globalThis.document.fonts.ready);
          await scan("404");
          assert.deepEqual(errors, []);
          assert.deepEqual(external, []);
          contexts.push({
            width,
            theme,
            scale,
            scans,
            keyboard,
            externalRepositoryNavigationsInterceptedLocally: activations,
            errors,
            external,
          });
          globalThis.console.log(
            `Verified ${width}/${theme}/${scale}x: ${scans.length} axe states, keyboard navigation and focus.`,
          );
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
        axe: require("axe-core/package.json").version,
        axeSourceSha256: sha(await readFile(axePath)),
        options: "All default rules; no exclusions, disabled rules or result filtering",
        contexts,
        captures: captures.map((item) => ({
          file: item.file,
          bytes: item.bytes,
          sha256: item.sha256,
          kind: item.kind ?? "focus",
        })),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  globalThis.console.log(
    `Passed ${contexts.length} accessibility/keyboard contexts and ${contexts.reduce((sum, context) => sum + context.scans.length, 0)} axe scans; ${captures.length} focus screenshots. All indeterminate contrast checks have explicit conservative proofs.`,
  );
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    if (server) await new Promise((done) => server.httpServer.close(done));
  }
}
