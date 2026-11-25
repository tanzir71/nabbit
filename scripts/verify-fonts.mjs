import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { auditFont } from "./font-audit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("playwright", { paths: [root, resolve(root, ".tools/site-qa")] }),
);
const output = resolve(root, "progress/v2/M2");
await mkdir(output, { recursive: true });
const base = "http://127.0.0.1:1443";
const server = spawn(
  process.execPath,
  [
    resolve(root, "node_modules/vite/bin/vite.js"),
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "1443",
    "--strictPort",
  ],
  { cwd: root, windowsHide: true, stdio: "ignore" },
);
const ramp = [
  ["display", "Display", "Nab it. Keep it.", "Geist SemiBold · 28/34", 28, 34, 600, -0.4],
  ["title", "Title", "Night Drive", "Geist SemiBold · 18/24", 18, 24, 600, -0.2],
  [
    "heading",
    "Heading",
    "Tiny tray app in Rust, full walkthrough",
    "Geist SemiBold · 14/20",
    14,
    20,
    600,
    -0.1,
  ],
  ["body", "Body", "Captured to Tack. Synced just now.", "Geist Regular · 13/18", 13, 18, 400, 0],
  ["body-strong", "Body strong", "Video link copied", "Geist Medium · 13/18", 13, 18, 500, 0],
  [
    "caption",
    "Caption",
    "Ferris Builds · 12:48 · about 420 MB",
    "Geist Regular · 12/16",
    12,
    16,
    400,
    0,
  ],
  ["label", "Label", "SYNCED · INBOX · NOW", "Geist Medium · 11/14", 11, 14, 500, 0.2],
  ["mono", "Mono", "4.2 MB/s · 1:12 left", "Geist Mono Medium · 12/16", 12, 16, 500, 0],
  ["mono-large", "Mono large", "24:13", "Geist Mono Medium · 15/20", 15, 20, 500, -0.2],
];
const reports = [],
  pngs = [];
let browser;
async function capture(page, name) {
  const path = resolve(output, name);
  await page.screenshot({ path, animations: "disabled" });
  const bytes = (await stat(path)).size;
  assert(bytes <= 300 * 1024);
  pngs.push({ name, bytes });
}
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await globalThis.fetch(base)).ok) break;
    } catch {
      /* starting */
    }
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  for (const theme of ["light", "dark"])
    for (const scale of [1, 1.5]) {
      const context = await browser.newContext({
        viewport: { width: 460, height: 680 },
        colorScheme: theme,
        deviceScaleFactor: scale,
        reducedMotion: "reduce",
      });
      const errors = [],
        external = [],
        fontRequests = [];
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (!url.startsWith(base + "/")) {
          external.push(url);
          return route.abort();
        }
        if (url.endsWith(".woff2")) fontRequests.push(url.slice(base.length));
        return route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(base, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
      const acknowledge = page.getByRole("button", { name: "Acknowledge", exact: true });
      if (await acknowledge.isVisible()) await acknowledge.click();
      await acknowledge.waitFor({ state: "hidden" });
      await page.evaluate(() => globalThis.document.fonts.ready);
      const trayFonts = await auditFont(page, "h1", "Geist");
      await capture(page, `v12-tray-${theme}@${scale}x.png`);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settingsFonts = await auditFont(page, "h2", "Geist");
      await capture(page, `v12-settings-${theme}@${scale}x.png`);

      await page.setViewportSize({ width: 625, height: 390 });
      await page.evaluate((ramp) => {
        const doc = globalThis.document;
        const board = doc.createElement("div");
        board.style.cssText =
          "width:625px;height:390px;padding:28px;border:1px solid var(--border-subtle);border-radius:20px;background:var(--bg-surface);display:flex;flex-direction:column;gap:14px;overflow:hidden";
        const title = doc.createElement("p");
        title.className = "type-title";
        title.textContent = "Type";
        board.append(title);
        for (const [id, label, sample, spec] of ramp) {
          const row = doc.createElement("div");
          row.style.cssText =
            "display:flex;gap:24px;align-items:center;flex-shrink:0;white-space:nowrap";
          const name = doc.createElement("p");
          name.className = "type-caption";
          name.textContent = label;
          name.style.cssText = "width:110px;flex-shrink:0;color:var(--text-tertiary)";
          const text = doc.createElement("p");
          text.className = "type-" + id;
          text.id = id;
          text.textContent = sample;
          const detail = doc.createElement("p");
          detail.className = "type-mono";
          detail.textContent = spec;
          detail.style.color = "var(--text-tertiary)";
          row.append(name, text, detail);
          board.append(row);
        }
        doc.body.replaceChildren(board);
      }, ramp);
      await page.evaluate(() => globalThis.document.fonts.ready);
      const faces = {};
      for (const [id, , , , size, line, weight, tracking] of ramp) {
        faces[id] = await auditFont(page, "#" + id, id.startsWith("mono") ? "Geist Mono" : "Geist");
        const computed = await page.locator("#" + id).evaluate((el) => {
          const s = globalThis.getComputedStyle(el);
          return {
            size: parseFloat(s.fontSize),
            line: parseFloat(s.lineHeight),
            weight: Number(s.fontWeight),
            tracking: s.letterSpacing === "normal" ? 0 : parseFloat(s.letterSpacing),
            style: s.fontStyle,
          };
        });
        assert.deepEqual(computed, { size, line, weight, tracking, style: "normal" });
      }
      const widths = await page.locator("#mono").evaluate((el) => {
        const widths = [];
        for (const digit of "0123456789") {
          el.textContent = digit.repeat(8);
          widths.push(el.getBoundingClientRect().width);
        }
        el.textContent = "4.2 MB/s · 1:12 left";
        return widths;
      });
      assert(
        widths.every((width) => width === widths[0]),
        "Changing mono digits shift width",
      );
      await capture(page, `v12-type-${theme}@${scale}x.png`);
      assert.equal(
        new Set(fontRequests).size,
        2,
        "Both font families must load from our own bundle",
      );
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
      reports.push({
        theme,
        scale,
        trayFonts,
        settingsFonts,
        faces,
        monoDigitWidths: widths,
        fontRequests: [...new Set(fontRequests)],
        externalRequests: external,
        runtimeErrors: errors,
      });
      await context.close();
    }
  await writeFile(
    resolve(output, "v12-font-checks.json"),
    JSON.stringify({ figmaNode: "12:373", reports, pngs }, null, 2) + "\n",
  );
  globalThis.console.log(
    `Passed ${reports.length} font contexts, actual custom faces, all nine type styles and fixed-width digits; ${pngs.length} PNGs.`,
  );
} finally {
  if (browser) await browser.close();
  server.kill();
}
