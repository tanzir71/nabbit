// Real native bitmap provenance is checked separately by generate-notes-visual.
// This checks the shipped composition and responsive geometry against Figma.
import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import process from "node:process";
import { preview } from "vite";
import { chromium } from "playwright";
const root = fileURLToPath(new URL("../", import.meta.url));
const prefix = process.argv[2] ?? "v48-notes-site";
assert(/^[a-z0-9-]+$/.test(prefix));
const output = resolve(root, `progress/v2/M9/${prefix}-landing.json`);
await stat(output).then(
  () => {
    throw Error("Evidence exists");
  },
  (e) => assert.equal(e.code, "ENOENT"),
);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const server = await preview({
  build: { outDir: "docs" },
  base: "/nabbit/",
  preview: { host: "127.0.0.1", port: 0, strictPort: true },
  logLevel: "error",
});
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
const captures = [],
  problems = [];
try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 375])
    for (const theme of ["light", "dark"])
      for (const scale of [1, 1.5]) {
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          deviceScaleFactor: scale,
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        try {
          await context.route("**/*", (r) =>
            new URL(r.request().url()).origin === origin
              ? r.continue()
              : (problems.push("External request"), r.abort()),
          );
          const page = await context.newPage();
          page.on("pageerror", (e) => problems.push(e.message));
          page.on("response", (r) => {
            if (r.status() >= 400) problems.push(`HTTP ${r.status()}`);
          });
          await page.goto(`${origin}/nabbit/`, { waitUntil: "networkidle" });
          const section = page.locator("#notes");
          await section.scrollIntoViewIfNeeded();
          await page.evaluate(async () => {
            await globalThis.document.fonts.ready;
            await Promise.all(
              [...globalThis.document.querySelectorAll("#notes img")].map((i) => {
                i.loading = "eager";
                return i.decode();
              }),
            );
          });
          const mobile = width < 600,
            stage = section.locator(mobile ? ".notes-mobile" : ".notes-desktop");
          const geometry = await stage.boundingBox();
          assert.equal(geometry.width, mobile ? 335 : 596);
          assert.equal(geometry.height, mobile ? 240 : 560);
          const green = await stage.locator(mobile ? "img" : ".notes-green").boundingBox();
          assert(Math.abs(green.width - 280) < 0.02);
          if (!mobile) {
            const island = await stage.locator(".notes-island").boundingBox();
            assert(Math.abs(island.width - 576) < 0.02);
            // Native host includes transparent 20px/6px margins around the
            // 680px morph; its 0.8x placement still starts at design (26,24).
            assert(Math.abs(island.x + 20 * 0.8 - geometry.x - 26) < 0.02);
            assert(Math.abs(island.y + 6 * 0.8 - geometry.y - 24) < 0.02);
            assert(Math.abs(green.x - geometry.x - 48) < 0.02);
            assert(Math.abs(green.y - geometry.y - 300) < 0.02);
          }
          assert(
            await page.evaluate(
              () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
            ),
          );
          assert(
            (await section.locator("figcaption").textContent()).includes("local fixture data"),
          );
          // Separate DOM captures keep both halves below the PNG budget at
          // 1.5x without downsampling, recompositing or changing any pixels.
          // The mobile copy container uses display:contents to preserve the
          // design's reading order; capture its complete section instead.
          const targets = mobile
            ? [["section", section]]
            : [
                ["visual", stage],
                ["copy", section.locator(".feature-copy")],
              ];
          for (const [role, target] of targets) {
            const shot = () => target.screenshot({ animations: "disabled", caret: "hide" });
            const bytes = await shot(),
              repeat = await shot();
            assert.equal(hash(bytes), hash(repeat));
            assert(bytes.length <= 300000);
            const file = `${prefix}-${role}-${width}-${theme}@${scale}x.png`;
            await writeFile(resolve(root, "progress/v2/M9", file), bytes, { flag: "wx" });
            captures.push({
              file,
              role,
              width,
              theme,
              scale,
              bytes: bytes.length,
              sha256: hash(bytes),
              repeatMatches: true,
              geometry,
            });
          }
        } finally {
          await context.close();
        }
      }
  assert.deepEqual(problems, []);
  await writeFile(
    output,
    JSON.stringify(
      {
        passed: true,
        figma: { desktop: "27:605", mobile: "31:1064" },
        captures,
        problems,
        sourcePins: await Promise.all(
          ["docs/index.html", "docs/assets/site.css", "docs/assets/notes-capture.json"].map(
            async (file) => ({ file, sha256: hash(await readFile(resolve(root, file))) }),
          ),
        ),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
} finally {
  await browser?.close();
  await server.close();
}
globalThis.console.log(
  "Verified eight repeat-exact Notes landing compositions and Figma geometry.",
);
