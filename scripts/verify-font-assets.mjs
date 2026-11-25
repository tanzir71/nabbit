import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

const base = new URL("../src/assets/fonts/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", base), "utf8"));
for (const [name, expected] of Object.entries(manifest.files)) {
  const bytes = await readFile(new URL(name, base));
  assert.equal(bytes.length, expected.bytes, `${name}: size`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256, `${name}: hash`);
  if (name.endsWith(".woff2")) assert.equal(bytes.toString("ascii", 0, 4), "wOF2");
  if (name.endsWith(".ttf")) assert.equal(bytes.readUInt32BE(0), 0x00010000);
}
const license = await readFile(new URL("OFL.txt", base), "utf8");
assert(license.includes("SIL OPEN FONT LICENSE Version 1.1"));
globalThis.console.log(
  `Verified ${Object.keys(manifest.files).length} pinned Geist ${manifest.version} assets and OFL.`,
);
