import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const docs = resolve(root, "docs");
const base = new URL("https://tanzir71.github.io/nabbit/");
const pages = ["index.html", "demo/index.html", "404.html"];
const documents = new Map();
const resources = new Set([...pages, "llms.txt"]);
for (const path of [...resources, ".nojekyll"]) await access(resolve(docs, path));
for (const path of pages)
  documents.set(path, new JSDOM(await readFile(resolve(docs, path), "utf8")).window.document);

function localPath(url) {
  assert.equal(url.origin, base.origin, `Unexpected resource origin: ${url.href}`);
  assert(url.pathname.startsWith(base.pathname), `URL escapes /nabbit/: ${url.href}`);
  let path = decodeURIComponent(url.pathname.slice(base.pathname.length));
  if (!path || path.endsWith("/")) path += "index.html";
  assert(resolve(docs, path).startsWith(`${docs}${sep}`), `Path escapes docs: ${path}`);
  return path;
}

async function checkCss(css, path) {
  assert(!/@import\b/i.test(css), "CSS imports must be bundled locally");
  for (const match of css.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g))
    await checkResource(match[1], path);
}

async function checkResource(value, page) {
  assert(!/^(?:[a-z]+:|\/)/i.test(value), `Asset URL must be relative: ${value}`);
  const path = localPath(new URL(value, new URL(page, base)));
  const info = await stat(resolve(docs, path));
  assert(info.isFile() && info.size > 0, `Missing or empty asset: ${path}`);
  if (resources.has(path)) return;
  resources.add(path);
  if (path.endsWith(".css")) await checkCss(await readFile(resolve(docs, path), "utf8"), path);
}

for (const [path, document] of documents) {
  for (const anchor of document.querySelectorAll("a[href]")) {
    const url = new URL(anchor.getAttribute("href"), new URL(path, base));
    if (url.origin !== base.origin) continue;
    const targetPath = localPath(url);
    await access(resolve(docs, targetPath));
    if (url.hash)
      assert(
        documents.get(targetPath)?.getElementById(decodeURIComponent(url.hash.slice(1))),
        `Missing anchor: ${url.href}`,
      );
  }
  for (const resource of document.querySelectorAll(
    "[src], link[rel='stylesheet'], link[rel='icon'], link[rel='preload']",
  )) {
    await checkResource(resource.getAttribute("src") ?? resource.getAttribute("href"), path);
  }
  for (const style of document.querySelectorAll("style")) await checkCss(style.textContent, path);
}

const landing = documents.get("index.html");
assert.equal(landing.querySelector('link[rel="canonical"]')?.getAttribute("href"), base.href);
assert.equal(landing.querySelector('meta[property="og:url"]')?.getAttribute("content"), base.href);
assert(landing.querySelector('meta[property="og:title"]'));
assert.equal(landing.querySelector('footer a[href="llms.txt"]')?.textContent.trim(), "llms.txt");
assert(
  landing.querySelector('footer a[href="demo/"]'),
  "Keep the simulated tray linked from the footer",
);

const current = landing.querySelector('meta[name="nabbit-milestone"]')?.getAttribute("content");
assert(/^M(?:[0-9]|1[0-2])$/.test(current), "Invalid milestone metadata");
const currentIndex = Number(current.slice(1));
const milestones = [...landing.querySelectorAll("#progress [data-milestone]")];
assert.equal(milestones.length, 13, "Publish all milestones M0–M12");
const currentDone = milestones[currentIndex].dataset.status === "done";
for (const [index, row] of milestones.entries()) {
  assert.equal(row.dataset.milestone, `M${index}`, "Milestones must stay in order");
  const expected =
    index < currentIndex || (index === currentIndex && currentDone)
      ? "done"
      : index === currentIndex || (currentDone && index === currentIndex + 1)
        ? "in-progress"
        : "planned";
  assert.equal(row.dataset.status, expected, `Unexpected status for M${index}`);
  assert.equal(
    row.querySelector(".milestone-status")?.textContent.trim(),
    { done: "Done", "in-progress": "In progress", planned: "Planned" }[expected],
  );
  const screenshots = row.querySelector("a");
  if (expected === "done") {
    assert.equal(screenshots?.textContent.trim(), "Screenshots");
    assert.equal(
      screenshots?.getAttribute("href"),
      `https://github.com/tanzir71/nabbit/tree/main/progress/v2/M${index}`,
    );
  } else assert(!screenshots, `Unbuilt milestone M${index} must not advertise screenshots`);
}

const ctas = [...landing.querySelectorAll("[data-download-cta]")];
assert.equal(ctas.length, 3, "Nav, hero and final primary CTAs must share the release switch");
for (const [index, cta] of ctas.entries()) {
  assert.equal(
    cta.textContent.trim(),
    "Follow the build",
    "No release download CTA before v2 exists",
  );
  assert.equal(
    cta.getAttribute("href"),
    index < 2 ? "#progress" : "https://github.com/tanzir71/nabbit",
  );
}
assert(
  landing
    .querySelector(".eyebrow")
    ?.textContent.includes("FOR WINDOWS 10 AND 11 · OPEN SOURCE · BUILDING IN PUBLIC"),
);
assert.equal(
  landing.querySelector(".release-note")?.textContent.trim(),
  "In development · first v2 release after milestone M12 · No account, no telemetry",
);
assert(
  !landing.querySelector('a[href*="/releases/"]'),
  "No installer links before a v2 release exists",
);
assert(
  ![...landing.querySelectorAll("button")].some((button) =>
    /^download/i.test(button.textContent.trim()),
  ),
  "Tray illustration must not be a dead Download button",
);

const demo = documents.get("demo/index.html");
assert(demo.body.textContent.includes("Simulated demo"));
assert(demo.body.textContent.includes("does not read your clipboard"));
assert(demo.getElementById("download"));
const notFound = documents.get("404.html");
assert.equal(notFound.querySelector('meta[name="robots"]')?.getAttribute("content"), "noindex");
assert(
  notFound.querySelector(`a[href="${base.href}"]`),
  "404 recovery must work from nested missing URLs",
);

for (const path of ["docs/index.html", "docs/llms.txt", "README.md"]) {
  const content = await readFile(resolve(root, path), "utf8");
  assert(content.includes(base.href), `Missing Pages link in ${path}`);
  assert(!content.includes("nabbit-local.vercel.app"), `Stale landing URL in ${path}`);
}
let bytes = 0;
for (const path of resources)
  if (!/\.(?:woff2?|ttf|otf)$/i.test(path)) bytes += (await stat(resolve(docs, path))).size;
assert(bytes <= 500 * 1024, `Site transfer exceeds 500 KiB excluding fonts: ${bytes}`);
globalThis.console.log(
  `Verified Pages base path, links/assets, 13 milestone states, 3 pre-release CTAs, demo and 404 (${bytes} bytes excluding fonts).`,
);
