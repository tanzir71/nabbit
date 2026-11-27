// The reference is executed only after verifying the exact Tack lockfile SRI.
// Usage: node scripts/generate-tack-rank-fixtures.mjs <fractional-indexing-4.0.0.tgz> <pinned-rank.ts>
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
const integrity =
  "Nr2P1Yyaj2sy1Qdt/wI3GcByxrUdbSKg5+cGvw8f18hT2SkQt6V72iOjBpk7IO3UkzBsdlGRs2a4z6dLrJprgw==";
if (!process.argv[2]) throw new Error("Supply the pinned fractional-indexing@4.0.0 npm tarball");
const archive = await readFile(process.argv[2]);
if (createHash("sha512").update(archive).digest("base64") !== integrity)
  throw new Error("Reference integrity mismatch");
const tar = gunzipSync(archive);
let source;
for (let at = 0; at + 512 <= tar.length;) {
  const header = tar.subarray(at, at + 512);
  const name = header.subarray(0, 100).toString().replace(/\0.*$/s, "");
  if (!name) break;
  const size = Number.parseInt(
    header.subarray(124, 136).toString().replace(/\0.*$/s, "").trim(),
    8,
  );
  if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length)
    throw new Error("Invalid reference tarball");
  if (name === "package/src/index.js") source = tar.subarray(at + 512, at + 512 + size);
  at += 512 + Math.ceil(size / 512) * 512;
}
if (!source) throw new Error("Pinned reference source is missing");
const { generateKeyBetween } = await import(
  `data:text/javascript;base64,${source.toString("base64")}`
);
const cases = [];
function add(a, b, name) {
  try {
    const expected = generateKeyBetween(a, b);
    cases.push({ name, a, b, expected });
    return expected;
  } catch {
    cases.push({ name, a, b, error: true });
    return null;
  }
}
const smallest = "A" + "0".repeat(26),
  largest = "z" + "z".repeat(26);
for (const [a, b] of [
  [null, null],
  [null, "a0"],
  ["a0", null],
  ["a0", "a1"],
  ["a0", "a0V"],
  ["a0V", "a1"],
  ["a1", "a0"],
  ["Zz", "a0"],
  [null, smallest + "V"],
  [largest, null],
  [largest + "V", null],
  [null, smallest],
  [null, "a"],
  ["a0", "a0"],
  ["a00", "a1"],
])
  add(a, b, `boundary-${cases.length}`);
const keys = ["a0"];
let seed = 43;
for (let i = 0; i < 500; i++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const at = seed % (keys.length + 1);
  const key = add(at ? keys[at - 1] : null, at < keys.length ? keys[at] : null, `insert-${i}`);
  keys.splice(at, 0, key);
}
await writeFile(
  new URL("../src-tauri/tests/fixtures/tack/ranks.json", import.meta.url),
  JSON.stringify(cases, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    cases: cases.length,
    package: "fractional-indexing@4.0.0",
    integrity: `sha512-${integrity}`,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
  }),
);

// Tack's nonce/legacy wrapper is a separate pinned primary source.
if (!process.argv[3])
  throw new Error("Supply the pinned Tack src/rank.ts file as the second argument");
let tackSource = await readFile(process.argv[3]);
const expectedBlob = "67657bb72f4adc34387b3bec207b649580f0128d";
const blob = (bytes) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
if (blob(tackSource) !== expectedBlob && tackSource.at(-1) === 10)
  tackSource = tackSource.subarray(0, tackSource.length - 1);
if (blob(tackSource) !== expectedBlob) throw new Error("Tack rank source mismatch");
let code = tackSource.toString("utf8");
// The pinned TypeScript has only parameter/return annotations. Strip those
// mechanically, then replace its package import with the verified JS reference.
code = code
  .replace(
    'import { generateKeyBetween } from "fractional-indexing";',
    `const {generateKeyBetween}=await import(${JSON.stringify(`data:text/javascript;base64,${source.toString("base64")}`)});`,
  )
  .replaceAll(/: string \| number \| null/g, "")
  .replaceAll(/: string \| number/g, "")
  .replaceAll(/: \(string \| number\)\[\]/g, "")
  .replaceAll(/: number/g, "")
  .replaceAll(/: string/g, "");
const { legacyRank, rankBetween } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);
const tackCases = [];
for (const number of [
  "-1.7976931348623157e308",
  "-1000000000000000",
  "-1.5",
  "-1",
  "-0",
  "0",
  "0.0000000001",
  "0.5",
  "1",
  "1.5",
  "9007199254740991",
  "1.7976931348623157e308",
])
  tackCases.push({ number, expected: legacyRank(Number(number)) });
for (const [a, b] of [
  [null, null],
  [null, "a0"],
  ["a0", null],
  ["a0", "a1"],
  ["a0", "a0V"],
  ["a0", `a0${"0".repeat(200)}V`],
  [null, smallest + "V"],
  [largest, null],
])
  for (const nonce of [
    "00000000000000000000000000000001",
    "ffffffffffffffffffffffffffffffff",
    "nonce-with-hyphens",
  ])
    tackCases.push({ a, b, nonce, expected: rankBetween(a, b, nonce) });
await writeFile(
  new URL("../src-tauri/tests/fixtures/tack/rank-tack.json", import.meta.url),
  JSON.stringify(tackCases, null, 2) + "\n",
);
console.log(JSON.stringify({ tackWrapperCases: tackCases.length, tackRankBlob: expectedBlob }));
