import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { gzipSync } from "node:zlib";
import process from "node:process";
import { assertIslandBudget, measureEntry, islandGzipBudget } from "./entry-bundles.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const dist = resolve(root, "dist");
const manifest = JSON.parse(await readFile(resolve(dist, ".vite/manifest.json"), "utf8"));
const graph = JSON.parse(
  await readFile(resolve(root, "node_modules/.tmp/nabbit-entry-graph.json"), "utf8"),
);
assert.equal(graph.version, 1);
const chunks = {};
for (const [file, metadata] of Object.entries(graph.chunks)) {
  const bytes = await readFile(resolve(dist, file));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    metadata.sha256,
    `Stale entry graph: ${file}`,
  );
  chunks[file] = { ...metadata, bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
}
function scripts(html, entry) {
  const found = [];
  for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const attributes = Object.fromEntries(
      [...tag[0].matchAll(/([\w-]+)=["']([^"']*)["']/g)].map((a) => [a[1], a[2]]),
    );
    const value =
      attributes.src ?? (attributes.rel === "modulepreload" ? attributes.href : undefined);
    if (!value) continue;
    const url = new URL(value, `https://nabbit.invalid/${entry}`);
    assert.equal(url.origin, "https://nabbit.invalid");
    if (url.pathname.endsWith(".js")) found.push(decodeURIComponent(url.pathname.slice(1)));
  }
  return found;
}
const entries = {};
for (const entry of ["index.html", "island.html", "settings.html", "sticky.html"]) {
  assert(manifest[entry]?.isEntry, `Missing production HTML entry ${entry}`);
  const html = await readFile(resolve(dist, entry), "utf8");
  if (entry === "island.html") {
    assert(
      !/<script\b(?![^>]*\bsrc=)[^>]*>\s*\S[\s\S]*?<\/script>/i.test(html),
      "Island inline JS must be moved into an analyzed module",
    );
  }
  entries[entry] = {
    file: manifest[entry].file,
    ...measureEntry(chunks, manifest[entry].file, scripts(html, entry)),
  };
}
assertIslandBudget(entries["island.html"]);
const flag = process.argv.indexOf("--report");
const reportPath =
  flag < 0
    ? resolve(root, ".tools/entry-build-current.json")
    : resolve(root, process.argv[flag + 1]);
await mkdir(resolve(reportPath, ".."), { recursive: true });
await writeFile(
  reportPath,
  JSON.stringify(
    {
      budgetBytes: islandGzipBudget,
      compression: {
        implementation: "node:zlib.gzipSync",
        node: process.version,
        zlib: process.versions.zlib,
      },
      budgetDefinition:
        "Sum of independently gzipped initial JS chunks, including shared chunks and HTML module preloads; 120 KB = 120,000 bytes",
      entries,
      chunks,
      experimentalEntries: Object.keys(manifest).filter(
        (key) => manifest[key].isEntry && !entries[key],
      ),
    },
    null,
    2,
  ) + "\n",
);
globalThis.console.log(
  `Verified four HTML entries. Island initial JS: ${entries["island.html"].initialGzipBytes.toLocaleString("en-US")} gzip bytes / ${islandGzipBudget.toLocaleString("en-US")}; no settings, clipboard list, editor or app store imports.`,
);
