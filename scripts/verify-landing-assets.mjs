import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(resolve(root, "docs/assets/landing-manifest.json"), "utf8"),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const html = await readFile(resolve(root, "docs/index.html"), "utf8");
const document = new JSDOM(html).window.document;
const sourceImages = new Set(
  [...document.querySelectorAll('img[src^="assets/design/"]')].map((img) =>
    img.getAttribute("src"),
  ),
);
assert.equal(sourceImages.size, manifest.svg.length);
for (const entry of manifest.svg) {
  assert(sourceImages.has(entry.file), `Unused manifest asset: ${entry.file}`);
  const bytes = await readFile(resolve(root, "docs", entry.file));
  assert.equal(hash(bytes), entry.sha256, `Original SVG changed: ${entry.file}`);
  const svg = new JSDOM(bytes.toString(), { contentType: "image/svg+xml" }).window.document
    .documentElement;
  assert.equal(Number(svg.getAttribute("width")), entry.width);
  assert.equal(Number(svg.getAttribute("height")), entry.height);
  for (const img of document.querySelectorAll(`img[src="${entry.file}"]`)) {
    assert.equal(Number(img.getAttribute("width")), entry.width);
    assert.equal(Number(img.getAttribute("height")), entry.height);
    assert(img.hasAttribute("alt"));
  }
}
for (const entry of manifest.composites) {
  const bytes = await readFile(resolve(root, "docs", entry.file));
  assert.equal(hash(bytes), entry.sha256);
  assert(bytes.length < 180000, `${entry.file} must stay under 180 KB`);
  assert.equal(entry.scale, 2);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
  const img = document.querySelector(`img[src="${entry.file}"]`);
  assert(img?.getAttribute("alt")?.length > 20);
  assert.equal(Number(img.getAttribute("width")), entry.width);
  assert.equal(Number(img.getAttribute("height")), entry.height);
}
for (const entry of [...(manifest.retiredComposites ?? []), ...(manifest.retiredSvg ?? [])]) {
  assert.equal(hash(await readFile(resolve(root, "docs", entry.file))), entry.sha256);
}
const hero = JSON.parse(await readFile(resolve(root, "docs/assets/island-hero.json"), "utf8"));
const heroImage = document.querySelector(`[data-harness-capture] img[src="${hero.file}"]`);
assert(heroImage && heroImage.getAttribute("alt").includes("Current Nabbit island"));
assert.equal(Number(heroImage.getAttribute("width")), hero.width);
assert.equal(Number(heroImage.getAttribute("height")), hero.height);
assert.equal(document.querySelectorAll(".hero [role=img]").length, 0);
assert(document.querySelector(".hero figcaption").textContent.includes("fixture data"));
execFileSync("python", [resolve(root, "scripts/generate-island-hero.py"), "--check"], {
  cwd: root,
  stdio: "pipe",
});
const fonts = JSON.parse(await readFile(resolve(root, "docs/assets/fonts/manifest.json"), "utf8"));
const downloads = JSON.parse(
  await readFile(resolve(root, "docs/assets/download-capture.json"), "utf8"),
);
for (const capture of downloads.captures) {
  const images = [...document.querySelectorAll(`#downloads img[src="${capture.file}"]`)];
  assert(images.length > 0);
  for (const img of images) {
    assert.equal(Number(img.getAttribute("width")), capture.width);
    assert.equal(Number(img.getAttribute("height")), capture.height);
    assert(img.getAttribute("alt").includes("Current Nabbit"));
  }
}
assert(document.querySelector("#downloads .caption").textContent.includes("fixture data"));
execFileSync("python", [resolve(root, "scripts/generate-download-visual.py"), "--check"], {
  cwd: root,
  stdio: "pipe",
});
for (const entry of fonts.files) {
  assert.equal(hash(await readFile(resolve(root, "docs/assets/fonts", entry.file))), entry.sha256);
  const sourceName = entry.file.replace("-Latin", "-Variable");
  assert.equal(
    hash(await readFile(resolve(root, "src/assets/fonts", sourceName))),
    entry.sourceSha256,
  );
}
const notes = JSON.parse(await readFile(resolve(root, "docs/assets/notes-capture.json"), "utf8"));
assert.equal(notes.captures.length, 3);
for (const capture of notes.captures) {
  const images = [...document.querySelectorAll(`#notes img[src="${capture.file}"]`)];
  assert(images.length > 0);
  for (const img of images) {
    assert.equal(Number(img.getAttribute("width")), capture.width);
    assert.equal(Number(img.getAttribute("height")), capture.height);
    assert(img.getAttribute("alt").includes("Current Nabbit"));
  }
}
assert(document.querySelector("#notes .caption").textContent.includes("local fixture data"));
assert.equal(document.querySelectorAll("#notes .replica").length, 0);
execFileSync("python", [resolve(root, "scripts/generate-notes-visual.py"), "--check"], {
  cwd: root,
  stdio: "pipe",
});
assert.deepEqual(
  await readFile(resolve(root, "docs/assets/fonts/OFL.txt")),
  await readFile(resolve(root, "src/assets/fonts/OFL.txt")),
);
assert.deepEqual(
  await readFile(resolve(root, "docs/assets/tokens.css")),
  await readFile(resolve(root, "src/styles/tokens.css")),
);
assert.equal(document.querySelectorAll("script[src]").length, 1);
assert.equal(document.querySelector("script[src]").getAttribute("src"), "assets/site.js");
assert(!/https:\/\/www\.figma\.com\/api\/mcp\/asset/.test(html));
const bookmarklet = document.querySelector("[data-bookmarklet]");
assert.equal(
  bookmarklet?.getAttribute("href"),
  "javascript:location.href='nabbit://nab?url='+encodeURIComponent(location.href)",
);
assert.equal(bookmarklet?.textContent.trim(), "Send to Nabbit");
assert.equal(bookmarklet?.getAttribute("draggable"), "true");
globalThis.console.log(
  `Verified ${manifest.svg.length} pinned original SVGs, ${manifest.composites.length} design WebPs, exact lossless harness hero, Latin font subsets/OFL, token parity and bookmarklet contract.`,
);
