import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { preview } from "vite";
import { JSDOM } from "jsdom";
import { auditFont } from "./font-audit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: { prefix: { type: "string", default: "l1" } } });
assert(/^[a-z][a-z0-9-]{0,50}$/.test(values.prefix));
const output = resolve(root, "progress/v2/M3");
const temporary = resolve(root, ".tools/landing-captures", values.prefix);
await mkdir(output, { recursive: true });
await mkdir(temporary, { recursive: true });
const reportPath = resolve(output, `${values.prefix}-browser-checks.json`);
try {
  await access(reportPath);
  throw new Error("Capture prefix already exists");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const manifest = JSON.parse(
  await readFile(resolve(root, "docs/assets/landing-manifest.json"), "utf8"),
);
const expectedMilestone = new JSDOM(
  await readFile(resolve(root, "docs/index.html"), "utf8"),
).window.document.querySelector('meta[name="nabbit-milestone"]').content;
const sourceSvg = new Map(manifest.svg.map((item) => [item.file, item]));
const sourceBytes = new Map(
  await Promise.all(
    [...sourceSvg.keys()].map(async (file) => [file, await readFile(resolve(root, "docs", file))]),
  ),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const contexts = [];
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
          deviceScaleFactor: scale,
          colorScheme: theme,
          reducedMotion: "reduce",
          serviceWorkers: "block",
        });
        try {
          await context.addInitScript(() => {
            globalThis.__bookmarkletCopies = [];
            Object.defineProperty(globalThis.navigator, "clipboard", {
              configurable: true,
              value: {
                writeText: async (value) => {
                  globalThis.__bookmarkletCopies.push(value);
                },
              },
            });
          });
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
          page.setDefaultTimeout(10000);
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
          await open();
          assert.equal(await page.locator("[data-download-cta]").count(), 3);
          for (const cta of await page.locator("[data-download-cta]").all())
            assert.equal((await cta.textContent()).trim(), "Follow the build");
          assert.equal(
            await page.locator('meta[name="nabbit-milestone"]').getAttribute("content"),
            expectedMilestone,
          );
          const menu = page.locator(".nav-menu"),
            summary = menu.locator("summary");
          if (width === 390) {
            assert.equal(await menu.getAttribute("open"), null);
            await summary.focus();
            await page.keyboard.press("Enter");
            assert.notEqual(await menu.getAttribute("open"), null);
            await page.keyboard.press("Tab");
            assert.equal(
              await page.evaluate(() => globalThis.document.activeElement.textContent.trim()),
              "Features",
            );
            assert.equal(
              await page.evaluate(
                () => globalThis.getComputedStyle(globalThis.document.activeElement).outlineStyle,
              ),
              "solid",
            );
            await page.keyboard.press("Escape");
            assert.equal(await menu.getAttribute("open"), null);
            assert(await summary.evaluate((el) => el === globalThis.document.activeElement));
            await summary.click();
            await page.locator('.nav-links a[href="#downloads"]').click();
            assert.equal(await menu.getAttribute("open"), null);
            assert(await page.locator("#downloads").isVisible());
            await summary.click();
            await page.locator('.nav-links a[href="#files"]').click();
            assert.equal(await menu.getAttribute("open"), null);
            assert(await page.locator("#files").isVisible());
            const more = page.locator(".progress-more");
            assert.equal(await more.getAttribute("open"), null);
            await more.locator("summary").focus();
            await page.keyboard.press("Enter");
            assert.notEqual(await more.getAttribute("open"), null);
            assert(await page.locator('[data-milestone="M12"]').isVisible());
          } else assert.notEqual(await menu.getAttribute("open"), null);
          const bookmarklet = page.locator("[data-bookmarklet]");
          await bookmarklet.click();
          await page
            .getByRole("status")
            .getByText("Bookmarklet copied.", { exact: false })
            .waitFor();
          const copied = await page.evaluate(() => globalThis.__bookmarkletCopies[0]);
          assert.equal(
            copied,
            "javascript:location.href='nabbit://nab?url='+encodeURIComponent(location.href)",
          );
          const location = { href: "https://example.invalid/watch?v=a&title='sample'#one" };
          const original = location.href;
          Function(
            "location",
            "encodeURIComponent",
            copied.slice("javascript:".length),
          )(location, encodeURIComponent);
          assert.equal(location.href, `nabbit://nab?url=${encodeURIComponent(original)}`);
          assert(new URL(page.url()).origin === origin);
          await page.evaluate(() => {
            globalThis.navigator.clipboard.writeText = async () => {
              throw new Error("Fixture clipboard unavailable");
            };
          });
          await bookmarklet.click();
          await page
            .getByRole("status")
            .getByText("Copy is unavailable.", { exact: false })
            .waitFor();
          await open();
          const fonts = {
            sans: await auditFont(page, "h1", "Geist"),
            mono: await auditFont(page, ".milestones code", "Geist Mono"),
          };
          const geometry = await page.evaluate(() => {
            const svgs = [...globalThis.document.querySelectorAll('img[src$=".svg"]')]
              .filter((img) => img.getBoundingClientRect().width > 0)
              .map((img) => {
                const rect = img.getBoundingClientRect(),
                  style = globalThis.getComputedStyle(img);
                let scaleX = 1,
                  scaleY = 1;
                for (let parent = img.parentElement; parent; parent = parent.parentElement) {
                  const matrix = new globalThis.DOMMatrixReadOnly(
                    globalThis.getComputedStyle(parent).transform,
                  );
                  scaleX *= Math.hypot(matrix.a, matrix.b);
                  scaleY *= Math.hypot(matrix.c, matrix.d);
                }
                return {
                  file: img.getAttribute("src"),
                  cssWidth: parseFloat(style.width),
                  cssHeight: parseFloat(style.height),
                  width: rect.width,
                  height: rect.height,
                  scaleX,
                  scaleY,
                  complete: img.complete,
                  naturalWidth: img.naturalWidth,
                };
              });
            return {
              colorAdjustmentRects: [
                ...globalThis.document.querySelectorAll(
                  '.release-note,.caption,.milestones code,.milestones [data-status="in-progress"] .milestone-status,.replica-49,.replica-39,.replica-135,.replica-139,.replica-141',
                ),
              ]
                .map((el) => {
                  const rect = el.getBoundingClientRect();
                  return {
                    className: el.className,
                    x: rect.x,
                    y: rect.y + globalThis.scrollY,
                    width: rect.width,
                    height: rect.height,
                  };
                })
                .filter((rect) => rect.width > 0 && rect.height > 0),
              pageHeight: globalThis.document.documentElement.scrollHeight,
              scrollWidth: globalThis.document.documentElement.scrollWidth,
              sections: [
                ...globalThis.document.querySelectorAll(
                  "main>section,footer>.final-cta,.site-nav,.footer-bottom",
                ),
              ].map((el) => {
                const rect = el.getBoundingClientRect();
                return {
                  name: el.className,
                  x: rect.x,
                  y: rect.y + globalThis.scrollY,
                  width: rect.width,
                  height: rect.height,
                };
              }),
              svgs,
            };
          });
          assert.equal(geometry.scrollWidth, width);
          if (width === 1440) {
            assert.equal(geometry.pageHeight, 7113);
            assert.deepEqual(
              geometry.sections.map((item) => Math.round(item.height)),
              [69, 977, 600, 728, 728, 728, 620, 648, 516, 990, 428, 81],
            );
          }
          for (const image of geometry.svgs) {
            const expected = sourceSvg.get(image.file);
            assert(expected, image.file);
            assert(image.complete && image.naturalWidth > 0);
            assert(
              Math.abs(image.cssWidth - expected.width) < 0.03,
              `SVG width changed: ${image.file}`,
            );
            assert(
              Math.abs(image.cssHeight - expected.height) < 0.03,
              `SVG height changed: ${image.file}`,
            );
            assert(
              Math.abs(image.width - expected.width * image.scaleX) < 0.1,
              `SVG rendered width changed: ${image.file}`,
            );
            assert(
              Math.abs(image.height - expected.height * image.scaleY) < 0.1,
              `SVG rendered height changed: ${image.file}`,
            );
          }
          for (const file of new Set(geometry.svgs.map((img) => img.file))) {
            const response = await context.request.get(`${origin}/nabbit/${file}`);
            assert.equal(hash(await response.body()), hash(sourceBytes.get(file)));
          }
          assert.deepEqual(errors, []);
          assert.deepEqual(external, []);
          const fullName = `${values.prefix}-${width}-${theme}@${scale}x-full.png`;
          const full = await page.screenshot({
            path: resolve(temporary, fullName),
            animations: "disabled",
            fullPage: true,
            scale: "device",
            caret: "hide",
          });
          contexts.push({
            width,
            theme,
            scale,
            fonts,
            geometry,
            menuAndRoadmapKeyboard: width === 390,
            bookmarkletCopiedAndEncodedWithoutNavigation: true,
            clipboardFailureHasFeedback: true,
            errors,
            external,
            fullSource: fullName,
            fullSha256: hash(full),
          });
        } finally {
          await context.close();
        }
      }
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        prefix: values.prefix,
        figma: { desktop: "27:220", mobile: "31:933", files: "49:1132" },
        sourceImages: manifest.composites,
        contexts,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  globalThis.console.log(
    `Passed ${contexts.length} landing contexts, custom fonts, SVG geometry/bytes, keyboard disclosures and bookmarklet success/failure.`,
  );
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    if (server) await new Promise((done) => server.httpServer.close(done));
  }
}
