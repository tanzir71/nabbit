import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const docs = resolve(root, "docs");
const base = "https://tanzir71.github.io/nabbit/";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const document = new JSDOM(await readFile(resolve(docs, "index.html"), "utf8")).window.document;
const content = (selector) => {
  const nodes = document.querySelectorAll(selector);
  assert.equal(nodes.length, 1, `Expected one ${selector}`);
  return nodes[0].getAttribute("content");
};
const title = document.title;
assert.equal(title, "Nabbit — The top of your screen, put to work.");
const description = content('meta[name="description"]');
assert(description.length >= 100 && description.length <= 160);
assert(description.includes("in development") && description.includes("Tack"));
assert.equal(content('meta[property="og:title"]'), title);
assert.equal(content('meta[name="twitter:title"]'), title);
assert.equal(content('meta[property="og:description"]'), description);
assert.equal(content('meta[name="twitter:description"]'), description);
assert.equal(content('meta[property="og:url"]'), base);
assert.equal(content('meta[property="og:type"]'), "website");
assert.equal(content('meta[property="og:site_name"]'), "Nabbit");
assert.equal(content('meta[name="twitter:card"]'), "summary_large_image");
assert.equal(content('meta[property="og:image"]'), `${base}assets/og.png`);
assert.equal(content('meta[name="twitter:image"]'), `${base}assets/og.png`);
assert.equal(content('meta[property="og:image:type"]'), "image/png");
assert.equal(content('meta[property="og:image:width"]'), "1200");
assert.equal(content('meta[property="og:image:height"]'), "630");
const alt = content('meta[property="og:image:alt"]');
assert(alt.includes("design previews") && alt.includes("development"));
assert.equal(content('meta[name="twitter:image:alt"]'), alt);

const image = await readFile(resolve(docs, "assets/og.png"));
assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
assert.equal(image.readUInt32BE(16), 1200);
assert.equal(image.readUInt32BE(20), 630);
assert(image.length < 300000);
const manifest = JSON.parse(await readFile(resolve(docs, "assets/og-manifest.json"), "utf8"));
assert.equal(manifest.source, "og.html");
assert.equal(manifest.renderer, "Playwright Chromium");
assert.equal(manifest.image.sha256, sha(image));
assert.equal(manifest.image.bytes, image.length);
for (const entry of manifest.sources) {
  assert(!entry.file.includes("..") && !/^(?:\/|[a-z]+:)/i.test(entry.file));
  const bytes = await readFile(resolve(docs, entry.file));
  const normalized = /\.(?:html|css|svg)$/.test(entry.file)
    ? bytes.toString().replace(/\r\n/g, "\n")
    : bytes;
  assert.equal(sha(normalized), entry.sha256, `Regenerate stale OG source: ${entry.file}`);
}
const og = new JSDOM(await readFile(resolve(docs, "og.html"), "utf8")).window.document;
assert(og.body.textContent.includes("V2 IN DEVELOPMENT"));
assert(og.body.textContent.includes("First v2 release after milestone M12"));
assert(og.body.textContent.includes("DESIGN PREVIEW"));
assert.equal(og.querySelectorAll("script").length, 0);
for (const img of og.images) {
  assert(img.hasAttribute("width") && img.hasAttribute("height") && img.hasAttribute("alt"));
  const path = img.getAttribute("src");
  assert(!/^(?:\/|[a-z]+:)/i.test(path));
  assert(manifest.sources.some((entry) => entry.file === path));
}
for (const file of ["index.html", "og.html", "404.html"]) {
  const page = new JSDOM(await readFile(resolve(docs, file), "utf8")).window.document;
  assert(page.querySelector('link[rel="icon"][href="assets/favicon.ico"]'));
  assert(page.querySelector('link[rel="icon"][href="assets/favicon.svg"]'));
}
assert.deepEqual(
  await readFile(resolve(docs, "assets/favicon.svg")),
  await readFile(resolve(root, "src/assets/brand/app-32.svg")),
);
assert.deepEqual(
  await readFile(resolve(docs, "assets/favicon.ico")),
  await readFile(resolve(root, "src-tauri/icons/icon.ico")),
);
const notFound = new JSDOM(await readFile(resolve(docs, "404.html"), "utf8")).window.document;
assert.equal(notFound.querySelector("base")?.getAttribute("href"), "/nabbit/");
assert(notFound.querySelector('link[href="assets/tokens.css"]'));
assert(notFound.querySelector('link[href="assets/site.css"]'));
assert.equal(notFound.querySelectorAll("script").length, 0);
const llms = await readFile(resolve(docs, "llms.txt"), "utf8");
assert(llms.includes("There is no v2 release yet") && llms.includes("Figma design previews"));
assert(llms.includes("Existing v0.1 foundation") && llms.includes("V2 product scope"));
assert(!llms.includes("/releases/latest") && !llms.includes("vercel.app"));
for (const match of llms.matchAll(/https:\/\/github\.com\/tanzir71\/nabbit\/blob\/main\/([^\s]+)/g))
  await access(resolve(root, match[1]));
globalThis.console.log(
  `Verified v2 metadata, 1200×630 OG PNG/provenance, Figma favicons, nested 404 assets and accurate agent documentation.`,
);
