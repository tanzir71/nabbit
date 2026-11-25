import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { JSDOM } from "jsdom";

function svgTree(xml) {
  const document = new JSDOM(xml, { contentType: "image/svg+xml" }).window.document;
  const tree = (element) => ({
    name: element.tagName,
    attributes: [...element.attributes].map((attr) => [attr.name, attr.value]).sort(),
    children: [...element.children].map(tree),
  });
  return tree(document.documentElement);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("playwright", { paths: [root, resolve(root, ".tools/site-qa")] }),
);
const output = resolve(root, "progress/v2/M2");
await mkdir(output, { recursive: true });
const manifest = JSON.parse(
  await readFile(resolve(root, "src/assets/brand/manifest.json"), "utf8"),
);
for (const source of manifest.sources) {
  const data = await readFile(resolve(root, "src/assets/brand", source.file));
  assert.equal(createHash("sha256").update(data).digest("hex"), source.sha256);
}
const base = "http://127.0.0.1:1446";
const server = spawn(
  process.execPath,
  [
    resolve(root, "node_modules/vite/bin/vite.js"),
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "1446",
    "--strictPort",
  ],
  { cwd: root, windowsHide: true, stdio: "ignore" },
);
// Serve the site at its actual /nabbit/ base, including nested custom 404s.
const docs = resolve(root, "docs");
const site = createServer(async (request, response) => {
  let path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  if (!path.startsWith("/nabbit/")) {
    response.writeHead(404).end();
    return;
  }
  path = path.slice("/nabbit/".length);
  if (!path || path.endsWith("/")) path += "index.html";
  let file = resolve(docs, path);
  if (!file.startsWith(docs + sep)) {
    response.writeHead(403).end();
    return;
  }
  let status = 200;
  try {
    await stat(file);
  } catch {
    file = resolve(docs, "404.html");
    status = 404;
  }
  const type = file.endsWith(".svg")
    ? "image/svg+xml"
    : file.endsWith(".ico")
      ? "image/x-icon"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
  response.writeHead(status, { "content-type": type });
  response.end(await readFile(file));
});
await new Promise((done) => site.listen(0, "127.0.0.1", done));
const siteBase = `http://127.0.0.1:${site.address().port}/nabbit/`;
const contexts = [],
  pngs = [];
let browser;
async function capture(target, name) {
  const path = resolve(output, name);
  await target.screenshot({ path, animations: "disabled" });
  const bytes = (await stat(path)).size;
  assert(bytes < 300 * 1024, name);
  pngs.push({ name, bytes });
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await globalThis.fetch(base + "/components.html")).ok;
    } catch {
      /* starting */
    }
    if (ready) break;
    await setTimeout(100);
  }
  assert(ready);
  browser = await chromium.launch({ headless: true });
  for (const theme of ["light", "dark"])
    for (const scale of [1, 1.5]) {
      const context = await browser.newContext({
        viewport: { width: 1420, height: 1000 },
        colorScheme: theme,
        deviceScaleFactor: scale,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const errors = [],
        external = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await context.route("**/*", (route) => {
        if (![base + "/", siteBase].some((prefix) => route.request().url().startsWith(prefix))) {
          external.push(route.request().url());
          return route.abort();
        }
        return route.continue();
      });
      await page.goto(base + "/components.html", { waitUntil: "networkidle" });
      const mark = page.locator("#brand-foundations");
      assert.deepEqual(await mark.boundingBox().then(({ width, height }) => ({ width, height })), {
        width: 506,
        height: 186,
      });
      const assets = await mark.locator("img").evaluateAll((images) =>
        images.map((img) => {
          const { width, height } = img.getBoundingClientRect();
          return {
            complete: img.complete,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            width,
            height,
            src: img.src,
            filter: globalThis.getComputedStyle(img).filter,
          };
        }),
      );
      assert.equal(assets.length, 7);
      for (const [i, asset] of assets.entries()) {
        const size = [16, 24, 32, 64, 128, 16, 24][i];
        assert(asset.complete);
        assert.deepEqual(
          [asset.naturalWidth, asset.naturalHeight, asset.width, asset.height],
          [size, size, size, size],
        );
        const original = await readFile(
          resolve(root, "src/assets/brand", manifest.sources[i].file),
          "utf8",
        );
        assert(asset.src.startsWith("data:image/svg+xml,") || asset.src.startsWith(base + "/"));
        // Vite minifies SVG quotes/whitespace in data URLs, preserving the tree.
        assert.deepEqual(
          svgTree(await (await globalThis.fetch(asset.src)).text()),
          svgTree(original),
        );
        assert.equal(asset.filter, theme === "dark" && i > 4 ? "brightness(0) invert(1)" : "none");
      }
      await capture(mark, `v15-mark-${theme}@${scale}x.png`);
      await page.setViewportSize({ width: 460, height: 680 });
      await page.goto(base + "/index.html", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
      await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
      await page
        .getByRole("button", { name: "Acknowledge", exact: true })
        .waitFor({ state: "hidden" });
      const headerMark = page.locator("header img");
      assert.deepEqual(
        await headerMark.boundingBox().then(({ width, height }) => [width, height]),
        [32, 32],
      );
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      await capture(page, `v15-tray-${theme}@${scale}x.png`);
      const favicons = [];
      for (const entry of ["", "demo/", "missing/nested/page"]) {
        const response = await page.goto(siteBase + entry, { waitUntil: "networkidle" });
        assert.equal(response.status(), entry.startsWith("missing") ? 404 : 200);
        const links = await page
          .locator('link[rel="icon"]')
          .evaluateAll((nodes) => nodes.map((node) => node.href));
        assert.equal(links.length, 2);
        for (const link of links) {
          assert(link.startsWith(siteBase + "assets/favicon."), link);
          const resource = await context.request.get(link);
          assert(resource.ok());
          assert(
            (await resource.body()).equals(
              await readFile(resolve(root, "docs/assets", link.split("/").pop())),
            ),
          );
        }
        const dimensions = await page.evaluate(
          async (src) => {
            const img = new globalThis.Image();
            img.src = src;
            await img.decode();
            return [img.naturalWidth, img.naturalHeight];
          },
          links.find((link) => link.endsWith(".svg")),
        );
        assert.deepEqual(dimensions, [32, 32]);
        favicons.push({
          entry,
          status: response.status(),
          svgDecoded: true,
          links: ["assets/favicon.ico", "assets/favicon.svg"],
        });
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      contexts.push({
        theme,
        scale,
        assets: assets.map((asset) => {
          const result = { ...asset };
          delete result.src;
          return result;
        }),
        favicons,
        runtimeErrors: errors,
        externalRequests: external,
      });
      await context.close();
    }
  await writeFile(
    resolve(output, "v15-brand-checks.json"),
    JSON.stringify({ figma: "12:478", contexts, pngs }, null, 2) + "\n",
  );
  globalThis.console.log(
    `Passed brand geometry, all seven original assets, tray headers and base-path favicons in four contexts; ${pngs.length} PNGs.`,
  );
} finally {
  if (browser) await browser.close();
  server.kill();
  await new Promise((done) => site.close(done));
}
