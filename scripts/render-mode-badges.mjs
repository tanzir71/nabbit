import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { chromium } from "playwright";
import { deterministicRenderingFlags } from "./screenshots/policy.mjs";
const prefix = process.argv[2] ?? "v62-native-a";
assert(/^[a-z0-9-]+$/.test(prefix));
const folder = fileURLToPath(new URL("../progress/v2/M11/", import.meta.url));
const raw = await readFile(resolve(folder, `${prefix}-scene.json`)),
  scene = JSON.parse(raw);
assert(scene.passed);
const rows = [];
for (const [label, key] of [
  ["Idle", "idleIcons"],
  ["Downloading · 62%", "progressIcons"],
  ["Paused", "pausedIcons"],
]) {
  const cards = [];
  for (const row of scene.results[key]) {
    assert(/^[a-z0-9@.-]+\.png$/.test(row.file));
    const bytes = await readFile(resolve(folder, row.file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.sha256);
    cards.push(
      `<div class="card ${row.icon.theme}"><span>${row.icon.theme} · ${row.icon.width}px</span><img width="${row.icon.width * 6}" height="${row.icon.height * 6}" src="data:image/png;base64,${bytes.toString("base64")}" alt="${label}, ${row.icon.theme}, ${row.icon.width} pixels"></div>`,
    );
  }
  rows.push(`<section><h2>${label}</h2><div class="row">${cards.join("")}</div></section>`);
}
const browser = await chromium.launch({ headless: true, args: deterministicRenderingFlags });
try {
  const page = await browser.newPage({
    viewport: { width: 840, height: 760 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#ecece9;color:#17171a;font:14px/20px Arial,sans-serif}h1{font-size:20px;margin:0 0 4px}p{margin:0 0 18px}h2{font-size:14px;margin:12px 0 6px}.row{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.card{height:160px;border-radius:8px;display:flex;align-items:center;justify-content:center;position:relative}.card span{position:absolute;left:8px;top:4px;font-size:11px}.light{background:#f3f3f1}.dark{background:#17171a;color:#f3f3f1}img{image-rendering:pixelated;margin-top:12px}</style></head><body><h1>Nabbit tray progress</h1><p>Exact native icon pixels at 6× for inspection. Owned 16/24px seams; Windows display settings unchanged.</p>${rows.join("")}</body></html>`,
  );
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready;
    await Promise.all([...globalThis.document.images].map((image) => image.decode()));
  });
  const bytes = await page.screenshot({ type: "png", animations: "disabled" }),
    repeat = await page.screenshot({ type: "png", animations: "disabled" });
  assert(bytes.length <= 300000);
  assert.deepEqual(bytes, repeat);
  const file = `${prefix}-badge-gallery.png`;
  await writeFile(resolve(folder, file), bytes, { flag: "wx" });
  await writeFile(
    resolve(folder, `${prefix}-badge-gallery.json`),
    JSON.stringify(
      {
        file,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sourceSceneSha256: createHash("sha256").update(raw).digest("hex"),
        sourceIconFiles: [
          ...scene.results.idleIcons,
          ...scene.results.progressIcons,
          ...scene.results.pausedIcons,
        ].map((row) => ({ file: row.file, sha256: row.sha256, rgbaSha256: row.icon.rgbaSha256 })),
        repeatMatches: true,
        scope:
          "Visualization of the exact RGBA sent to the owned tray. Offscreen icon PNGs at 6x; no Windows desktop capture or display change.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
} finally {
  await browser.close();
}
