import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { colors } from "../src/styles/tokens.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("playwright", { paths: [root, resolve(root, ".tools/site-qa")] }),
);
const output = resolve(root, "progress/v2/M2");
await mkdir(output, { recursive: true });
const base = "http://127.0.0.1:1442";
const server = spawn(
  process.execPath,
  [
    resolve(root, "node_modules/vite/bin/vite.js"),
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "1442",
    "--strictPort",
  ],
  { cwd: root, windowsHide: true, stdio: "ignore" },
);
let browser;
const reports = [];
const pngs = [];
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
async function capture(page, name) {
  const path = resolve(output, name);
  await page.screenshot({ path, animations: "disabled" });
  const bytes = (await stat(path)).size;
  assert(bytes <= 300 * 1024);
  pngs.push({ name, bytes });
}
async function theme(page, value) {
  await page.waitForFunction(
    (value) => globalThis.document.documentElement.dataset.theme === value,
    value,
  );
  const actual = await page.locator("main").evaluate((element) => ({
    background: globalThis.getComputedStyle(element).backgroundColor,
    color: globalThis.getComputedStyle(element).color,
  }));
  assert.equal(actual.background, rgb(colors["bg/canvas"][value]));
  assert.equal(actual.color, rgb(colors["text/primary"][value]));
}
async function acknowledge(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  const button = page.getByRole("button", { name: "Acknowledge", exact: true });
  if (await button.isVisible()) await button.click();
  await button.waitFor({ state: "hidden" });
}
async function openSettings(page) {
  await acknowledge(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  return page.getByRole("group", { name: "Appearance", exact: true });
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await globalThis.fetch(base)).ok;
    } catch {
      /* starting */
    }
    if (ready) break;
    await setTimeout(100);
  }
  assert(ready, "Vite preview did not start");
  browser = await chromium.launch({ headless: true });
  for (const scheme of ["light", "dark"])
    for (const scale of [1, 1.5]) {
      const context = await browser.newContext({
        viewport: { width: 460, height: 680 },
        colorScheme: scheme,
        deviceScaleFactor: scale,
        reducedMotion: "reduce",
      });
      const errors = [],
        external = [];
      await context.route("**/*", (route) => {
        if (
          !route
            .request()
            .url()
            .startsWith(base + "/")
        ) {
          external.push(route.request().url());
          return route.abort();
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(base, { waitUntil: "networkidle" });
      await acknowledge(page);
      await theme(page, scheme);
      await capture(page, `v11-tray-${scheme}@${scale}x.png`);
      const appearance = await openSettings(page);
      assert.equal(
        await appearance
          .getByRole("button", { name: "System", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      await capture(page, `v11-settings-${scheme}@${scale}x.png`);
      for (const preference of ["dark", "light"]) {
        await appearance
          .getByRole("button", { name: preference === "dark" ? "Dark" : "Light", exact: true })
          .click();
        await theme(page, preference);
        await page.emulateMedia({ colorScheme: preference === "dark" ? "light" : "dark" });
        await theme(page, preference);
      }
      await page.reload({ waitUntil: "networkidle" });
      await theme(page, "light");
      const restored = await openSettings(page);
      assert.equal(
        await restored
          .getByRole("button", { name: "Light", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      await restored.getByRole("button", { name: "System", exact: true }).click();
      await theme(page, "dark");
      await page.emulateMedia({ colorScheme: "light" });
      await theme(page, "light");
      await page.emulateMedia({ colorScheme: "dark" });
      await theme(page, "dark");
      await page.emulateMedia({ colorScheme: scheme });
      await theme(page, scheme);

      // Render the Figma colour-board geometry with actual generated CSS variables.
      const palette = await context.newPage();
      palette.on("pageerror", (e) => errors.push(e.message));
      await palette.setViewportSize({ width: 762, height: 922 });
      await palette.goto(base, { waitUntil: "networkidle" });
      await theme(palette, scheme);
      const tokenValues = await palette.evaluate((colors) => {
        const style = globalThis.getComputedStyle(globalThis.document.documentElement);
        const values = Object.fromEntries(
          Object.keys(colors).map((key) => [
            key,
            style
              .getPropertyValue("--" + key.replaceAll("/", "-"))
              .trim()
              .toUpperCase(),
          ]),
        );
        const board = globalThis.document.createElement("div");
        board.id = "token-board";
        board.style.cssText =
          "width:762px;min-height:922px;padding:28px;border:1px solid var(--border-subtle);border-radius:20px;background:var(--bg-canvas);display:flex;flex-direction:column;gap:20px";
        const title = globalThis.document.createElement("h1");
        title.textContent =
          globalThis.document.documentElement.dataset.theme === "dark" ? "Dark mode" : "Light mode";
        title.style.cssText =
          "font-size:18px;line-height:24px;letter-spacing:-.2px;font-weight:600;margin:0";
        board.append(title);
        const groups = [
          [
            "Surface",
            ["bg/canvas", "bg/surface", "bg/raised", "bg/sunken", "border/subtle", "border/strong"],
          ],
          [
            "Text & action",
            [
              "text/primary",
              "text/secondary",
              "text/tertiary",
              "action/primary",
              "action/on-primary",
            ],
          ],
          [
            "Signal & status",
            [
              "signal/base",
              "signal/strong",
              "signal/soft",
              "danger/base",
              "danger/soft",
              "warning/base",
              "warning/soft",
            ],
          ],
          [
            "Island (mode-independent)",
            ["island/bg", "island/raised", "island/track", "island/fg", "island/muted"],
          ],
          [
            "Notes · Tack colour keys",
            Object.keys(colors).filter((key) => key.startsWith("note/")),
          ],
          [
            "Note accents (dots, swatch rings)",
            Object.keys(colors).filter((key) => key.startsWith("note-accent/")),
          ],
        ];
        for (const [label, keys] of groups) {
          const section = globalThis.document.createElement("section");
          section.style.cssText = "display:flex;flex-direction:column;gap:10px";
          const heading = globalThis.document.createElement("h2");
          heading.textContent = label;
          heading.style.cssText =
            "font-size:11px;line-height:14px;font-weight:500;letter-spacing:.2px;color:var(--text-secondary);margin:0";
          section.append(heading);
          const row = globalThis.document.createElement("div");
          row.style.cssText = "display:flex;gap:10px";
          for (const key of keys) {
            const item = globalThis.document.createElement("div");
            item.style.cssText =
              "display:flex;flex-direction:column;align-items:flex-start;flex-shrink:0;gap:6px;min-width:92px;width:max-content";
            const swatch = globalThis.document.createElement("div");
            swatch.dataset.token = key;
            swatch.style.cssText = `height:52px;width:92px;border:1px solid var(--border-subtle);border-radius:10px;background:var(--${key.replaceAll("/", "-")})`;
            const name = globalThis.document.createElement("span");
            name.textContent = key;
            name.style.cssText = "font-size:12px;line-height:16px;white-space:nowrap";
            const hex = globalThis.document.createElement("span");
            hex.textContent = values[key];
            hex.style.cssText =
              'font:500 12px/16px "Geist Mono","Cascadia Code",Consolas,monospace;color:var(--text-tertiary)';
            item.append(swatch, name, hex);
            row.append(item);
          }
          section.append(row);
          board.append(section);
        }
        globalThis.document.getElementById("root").replaceChildren(board);
        return values;
      }, colors);
      for (const [key, value] of Object.entries(colors))
        assert.equal(tokenValues[key], value[scheme]);
      for (const swatch of await palette.locator("[data-token]").all()) {
        const key = await swatch.getAttribute("data-token");
        assert.equal(
          await swatch.evaluate((e) => globalThis.getComputedStyle(e).backgroundColor),
          rgb(colors[key][scheme]),
        );
      }
      await capture(palette, `v11-tokens-${scheme}@${scale}x.png`);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      reports.push({
        scheme,
        scale,
        tokenCount: Object.keys(tokenValues).length,
        overrideWins: true,
        overrideRestoredAfterReload: true,
        systemEventsFollowed: true,
        runtimeErrors: errors,
        externalRequests: external,
      });
      await context.close();
    }
  await writeFile(
    resolve(output, "v11-preview-checks.json"),
    JSON.stringify(
      {
        reports,
        pngs,
        figmaNodes: ["12:53", "12:213"],
        componentGeometryAndFontsRemainForV12V13: true,
      },
      null,
      2,
    ) + "\n",
  );
  globalThis.console.log(
    `Passed ${reports.length} theme contexts, all 36 computed tokens, saved overrides and system changes; ${pngs.length} PNGs.`,
  );
} finally {
  if (browser) await browser.close();
  server.kill();
}
