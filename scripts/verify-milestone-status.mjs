import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";
import { JSDOM } from "jsdom";
import { chromium } from "playwright";
import { preview } from "vite";
import { auditFont } from "./font-audit.mjs";

const { values } = parseArgs({
  options: {
    milestone: { type: "string" },
    "previous-ref": { type: "string" },
    prefix: { type: "string" },
  },
});
assert(/^M(?:[1-9]|1[0-2])$/.test(values.milestone));
assert(/^[a-f0-9]{7,40}$/.test(values["previous-ref"]));
const prefix = values.prefix ?? `${values.milestone.toLowerCase()}-status`;
assert(/^[a-z][a-z0-9-]{0,50}$/.test(prefix));
const root = fileURLToPath(new URL("../", import.meta.url)),
  folder = resolve(root, "progress/v2", values.milestone);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const beforeHtml = execFileSync("git", ["show", `${values["previous-ref"]}:docs/index.html`], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
});
const html = await readFile(resolve(root, "docs/index.html"), "utf8");
const previous = new JSDOM(beforeHtml),
  current = new JSDOM(html);
const index = Number(values.milestone.slice(1)),
  changed = [values.milestone, ...(index < 12 ? [`M${index + 1}`] : [])];
assert.equal(
  current.window.document.querySelector('meta[name="nabbit-milestone"]').content,
  values.milestone,
);
for (const name of changed) {
  const old = previous.window.document.querySelector(`[data-milestone="${name}"]`),
    row = current.window.document.querySelector(`[data-milestone="${name}"]`);
  assert(old && row);
  assert.equal(row.dataset.status, name === values.milestone ? "done" : "in-progress");
  if (name === values.milestone)
    assert.equal(
      row.querySelector("a").href,
      `https://github.com/tanzir71/nabbit/tree/main/progress/v2/${name}`,
    );
  row.replaceWith(old.cloneNode(true));
}
current.window.document.querySelector('meta[name="nabbit-milestone"]').content =
  previous.window.document.querySelector('meta[name="nabbit-milestone"]').content;
assert.equal(
  current.serialize(),
  previous.serialize(),
  "Only milestone metadata and the two affected rows may change",
);
await mkdir(folder, { recursive: true });
const contexts = [],
  captures = [];
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
          viewport: { width, height: width === 390 ? 844 : 1000 },
          colorScheme: theme,
          deviceScaleFactor: scale,
          reducedMotion: "reduce",
          serviceWorkers: "block",
          acceptDownloads: false,
        });
        try {
          const errors = [],
            external = [];
          await context.route("**/*", (route) => {
            if (
              new URL(route.request().url()).origin !== origin ||
              route.request().method() !== "GET"
            ) {
              external.push(route.request().url());
              return route.abort();
            }
            return route.continue();
          });
          const dimensions = [];
          let result;
          for (const baseline of [true, false]) {
            const page = await context.newPage();
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("response", (response) => {
              if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
            });
            if (baseline)
              await page.route(`${origin}/nabbit/`, (route) =>
                route.fulfill({ contentType: "text/html", body: beforeHtml }),
              );
            await page.goto(`${origin}/nabbit/`, { waitUntil: "networkidle" });
            await page.evaluate(async () => {
              await globalThis.document.fonts.ready;
              await Promise.all(
                [...globalThis.document.images].map((image) => {
                  image.loading = "eager";
                  return image.decode();
                }),
              );
            });
            dimensions.push(
              await page.evaluate(() => ({
                height: globalThis.document.documentElement.scrollHeight,
                width: globalThis.document.documentElement.scrollWidth,
              })),
            );
            const more = page.locator("#all-milestones");
            if ((await more.getAttribute("open")) === null) await more.locator("summary").click();
            assert.equal(await page.locator("#progress [data-milestone]").count(), 13);
            assert(await page.locator('[data-milestone="M12"]').isVisible());
            const assets = await page.locator("#progress img").evaluateAll((images) =>
              images.map((image) => ({
                src: image.getAttribute("src"),
                width: image.width,
                height: image.height,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                renderedWidth: image.getBoundingClientRect().width,
                renderedHeight: image.getBoundingClientRect().height,
              })),
            );
            for (const asset of assets) {
              assert.equal(asset.width, 16);
              assert.equal(asset.height, 16);
              assert.equal(asset.naturalWidth, 16);
              assert.equal(asset.naturalHeight, 16);
              assert.equal(asset.renderedWidth, 16);
              assert.equal(asset.renderedHeight, 16);
            }
            if (!baseline) {
              const font = await auditFont(page, "#progress h2", "Geist"),
                mono = await auditFont(page, "#progress code", "Geist Mono");
              for (const name of changed) {
                const row = page.locator(`[data-milestone="${name}"]`);
                assert.equal(
                  await row.getAttribute("data-status"),
                  name === values.milestone ? "done" : "in-progress",
                );
              }
              const file = `${prefix}-${width}-${theme}@${scale}x.png`,
                path = resolve(folder, file);
              await assert.rejects(access(path), { code: "ENOENT" });
              const png = await page.locator("#progress").screenshot({
                type: "png",
                animations: "disabled",
                caret: "hide",
                scale: "device",
              });
              assert(png.length <= 300000);
              const box = await page.locator("#progress").boundingBox();
              const scroll = await page.evaluate(() => ({
                x: globalThis.scrollX,
                y: globalThis.scrollY,
              }));
              // Locator screenshots enclose fractional document bounds in whole
              // CSS pixels before Chromium rounds the physical pixel extent.
              const enclosedCssHeight =
                Math.ceil(box.y + scroll.y + box.height - 0.001) -
                Math.floor(box.y + scroll.y + 0.001);
              assert.equal(png.readUInt32BE(16), Math.round(box.width * scale));
              assert(
                [
                  Math.floor(enclosedCssHeight * scale),
                  Math.ceil(enclosedCssHeight * scale),
                ].includes(png.readUInt32BE(20)),
                JSON.stringify({
                  box,
                  scroll,
                  scale,
                  actual: png.readUInt32BE(20),
                  enclosedCssHeight,
                }),
              );
              captures.push({ file, png });
              result = {
                file,
                width,
                theme,
                scale,
                bytes: png.length,
                pixelWidth: png.readUInt32BE(16),
                pixelHeight: png.readUInt32BE(20),
                clipCss: box,
                enclosedCssHeight,
                sha256: sha(png),
                font,
                mono,
                assets,
              };
            }
            await page.close();
          }
          assert.deepEqual(dimensions[0], dimensions[1], "Default page geometry must be unchanged");
          assert.equal(dimensions[1].width, width);
          assert.deepEqual(errors, []);
          assert.deepEqual(external, []);
          contexts.push({ ...result, defaultGeometry: dimensions[1], errors, external });
        } finally {
          await context.close();
        }
      }
  const reportPath = resolve(folder, `${prefix}-checks.json`);
  await assert.rejects(access(reportPath), { code: "ENOENT" });
  for (const capture of captures)
    await writeFile(resolve(folder, capture.file), capture.png, { flag: "wx" });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        milestone: values.milestone,
        previousRef: values["previous-ref"],
        onlyMetadataAndAffectedRowsChanged: true,
        htmlSha256: sha(html),
        browser: browser.version(),
        contexts,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  globalThis.console.log(
    `Verified ${values.milestone} status/link, next milestone, eight focused device-scale PNGs, unchanged default page geometry, fonts and original icon geometry.`,
  );
} finally {
  await browser?.close();
  await server?.close();
}
