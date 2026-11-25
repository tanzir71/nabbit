import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { colors } from "../src/styles/tokens.mjs";
import { auditFont } from "./font-audit.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("playwright", { paths: [root, resolve(root, ".tools/site-qa")] }),
);
const output = resolve(root, "progress/v2/M2");
await mkdir(output, { recursive: true });
const manifest = JSON.parse(
  await readFile(resolve(root, "src/assets/components/manifest.json"), "utf8"),
);
for (const asset of manifest) {
  const bytes = await readFile(resolve(root, "src/assets/components", asset.file));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
}
const base = "http://127.0.0.1:1444";
const server = spawn(
  process.execPath,
  [
    resolve(root, "node_modules/vite/bin/vite.js"),
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "1444",
    "--strictPort",
  ],
  { cwd: root, windowsHide: true, stdio: "ignore" },
);
let browser;
const reports = [],
  pngs = [];
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
async function capture(target, name) {
  const path = resolve(output, name);
  await target.screenshot({ path, animations: "disabled" });
  const bytes = (await stat(path)).size;
  assert(bytes <= 300 * 1024, name);
  pngs.push({ name, bytes });
}
async function style(page, selector, property) {
  return page
    .locator(selector)
    .first()
    .evaluate(
      (el, property) => globalThis.getComputedStyle(el).getPropertyValue(property),
      property,
    );
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await globalThis.fetch(base + "/components.html")).ok;
    } catch {
      /* starting */
    }
    if (ready) break;
    await setTimeout(100);
  }
  assert(ready);
  browser = await chromium.launch({ headless: true });
  for (const theme of ["light", "dark"])
    for (const scale of [1, 1.5]) {
      const context = await browser.newContext({
        viewport: { width: 1420, height: 1000 },
        deviceScaleFactor: scale,
        colorScheme: theme,
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
      await page.addInitScript(() => {
        globalThis.__previewIpcCalls = [];
        globalThis.__TAURI_INTERNALS__ = {
          invoke: (...args) => {
            globalThis.__previewIpcCalls.push(args);
            throw Error("Component preview attempted IPC");
          },
        };
      });
      await page.goto(base + "/components.html", { waitUntil: "networkidle" });
      await page.evaluate(() => globalThis.document.fonts.ready);
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      const core = page.locator("#core-foundations");
      const box = await core.boundingBox();
      assert.deepEqual([box.width, box.height], [624, 766]);
      const primary = core.locator(".n-button--primary.n-button--md");
      const small = core.locator(".n-button--primary.n-button--sm");
      assert.equal(await style(page, "#core-foundations .n-button--md", "height"), "32px");
      assert.equal(await style(page, "#core-foundations .n-button--sm", "height"), "28px");
      assert.equal(
        await style(page, "#core-foundations .n-button--primary", "background-color"),
        rgb(colors["action/primary"][theme]),
      );
      assert.equal(
        await style(page, "#core-foundations .n-button--secondary", "border-top-color"),
        rgb(colors["border/strong"][theme]),
      );
      assert.equal(
        await style(page, "#core-foundations .n-badge--signal", "color"),
        rgb(colors["signal/strong"][theme]),
      );
      assert.equal(
        await style(page, "#core-foundations .n-preset--island.is-selected", "background-color"),
        rgb(colors["island/fg"][theme]),
      );
      const assets = await page.locator("img[data-asset]").evaluateAll((images) =>
        images.map((img) => {
          const box = img.getBoundingClientRect();
          return {
            file: img.dataset.asset,
            loaded: img.complete && img.naturalWidth > 0,
            width: box.width,
            height: box.height,
          };
        }),
      );
      for (const asset of assets) {
        const expected = manifest.find((a) => a.file === asset.file);
        assert(expected);
        assert(asset.loaded, asset.file);
        assert.equal(asset.width, Number(expected.width), asset.file);
        assert.equal(asset.height, Number(expected.height), asset.file);
      }
      assert.equal(
        new Set(assets.map((asset) => asset.file)).size,
        manifest.length,
        "Every provided asset must have a rendered callsite",
      );
      const noteBoxes = await page.locator("#note-foundations .n-note-card").evaluateAll((cards) =>
        cards.map((card) => {
          const r = card.getBoundingClientRect();
          return [r.width, r.height];
        }),
      );
      assert.deepEqual(noteBoxes, [
        [200, 138],
        [200, 154],
        [200, 116],
      ]);
      for (const color of ["default", "blue", "purple", "green", "pink", "gray"])
        assert.equal(
          await style(page, `#note-colours [data-color="${color}"]`, "background-color"),
          rgb(colors[`note/${color}`][theme]),
        );
      const customFonts = {
        body: await auditFont(page, "#core-foundations .n-button", "Geist"),
        mono: await auditFont(page, "#core-foundations .n-kbd", "Geist Mono"),
      };
      assert.equal(await style(page, "#control-states .n-input.font-mono", "font-size"), "12px");
      assert.equal(await style(page, "#control-states .n-input.font-mono", "line-height"), "16px");
      for (const [id, label] of [
        ["core-foundations", "core"],
        ["note-foundations", "notes"],
        ["control-states", "states"],
        ["note-colours", "colours"],
      ])
        await capture(page.locator("#" + id), `v13-${label}-${theme}@${scale}x.png`);
      const actions = page.getByRole("status");
      const initialActions = await actions.textContent();
      await page
        .locator(":disabled")
        .evaluateAll((buttons) => buttons.forEach((button) => button.click()));
      assert.equal(await actions.textContent(), initialActions);
      await primary.click();
      assert.equal(await actions.textContent(), "1 preview actions");
      const preset = page.getByRole("group", { name: "light presets", exact: true });
      await preset.getByRole("button").nth(0).click();
      assert.equal(await preset.locator('[aria-pressed="true"]').count(), 1);
      assert.equal(await preset.getByRole("button").nth(0).getAttribute("aria-pressed"), "true");
      const island = page.getByRole("group", { name: "island presets", exact: true });
      await island.getByRole("button").nth(1).click();
      assert.equal(await island.getByRole("button").nth(1).getAttribute("aria-pressed"), "true");
      const toggle = page.getByRole("switch", { name: "Enabled example", exact: true });
      await toggle.focus();
      await page.keyboard.press("Space");
      assert.equal(await toggle.getAttribute("aria-checked"), "false");
      const segments = page.getByRole("group", { name: "Capture type", exact: true });
      const video = segments.getByRole("button", { name: "Video", exact: true });
      const audio = segments.getByRole("button", { name: "Audio", exact: true });
      await video.focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(await audio.getAttribute("aria-pressed"), "true");
      assert(await audio.evaluate((e) => e === globalThis.document.activeElement));
      await page.keyboard.press("Home");
      assert.equal(await video.getAttribute("aria-pressed"), "true");
      await page.keyboard.press("End");
      assert.equal(await audio.getAttribute("aria-pressed"), "true");
      const standalone = page.getByRole("group", { name: "Standalone tabs", exact: true });
      await standalone.getByRole("button").nth(1).click();
      assert.equal(await standalone.locator('[aria-pressed="true"]').count(), 1);
      const folder = page.getByRole("textbox", { name: "Output folder", exact: true });
      await folder.fill("Downloads/Clips");
      assert.equal(await folder.inputValue(), "Downloads/Clips");
      const select = page.getByRole("combobox", { name: "Format", exact: true });
      await select.focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      assert.equal(await select.inputValue(), "mp3");
      const checkbox = page.getByRole("checkbox", { name: "Record demo GIF", exact: true });
      await checkbox.check();
      assert(await checkbox.isChecked());
      assert.equal(await actions.textContent(), "1 preview actions");
      const progress = page.getByRole("slider", { name: "Preview progress", exact: true });
      await progress.focus();
      await page.keyboard.press("End");
      assert.equal(
        await page
          .getByRole("progressbar", { name: "Live download", exact: true })
          .getAttribute("aria-valuenow"),
        "100",
      );
      await primary.focus();
      await page.keyboard.press("Tab");
      assert(await small.evaluate((e) => e === globalThis.document.activeElement));
      assert.equal(
        await small.evaluate((e) => globalThis.getComputedStyle(e).outlineStyle),
        "solid",
      );
      await capture(core, `v13-focus-${theme}@${scale}x.png`);
      const appearance = page.getByRole("group", { name: "Preview appearance", exact: true });
      await appearance
        .getByRole("button", { name: theme === "light" ? "Dark" : "Light", exact: true })
        .click();
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        theme === "light" ? "dark" : "light",
      );
      await page.evaluate(() => {
        const counts = { timeout: 0, interval: 0, raf: 0 };
        globalThis.__previewIdle = counts;
        const timeout = globalThis.setTimeout,
          interval = globalThis.setInterval,
          raf = globalThis.requestAnimationFrame;
        globalThis.setTimeout = (...args) => {
          counts.timeout++;
          return timeout(...args);
        };
        globalThis.setInterval = (...args) => {
          counts.interval++;
          return interval(...args);
        };
        globalThis.requestAnimationFrame = (...args) => {
          counts.raf++;
          return raf(...args);
        };
      });
      await setTimeout(800);
      const idle = await page.evaluate(() => globalThis.__previewIdle);
      assert.deepEqual(idle, { timeout: 0, interval: 0, raf: 0 });
      assert.deepEqual(await page.evaluate(() => globalThis.__previewIpcCalls), []);
      // Reuse the real app entry with its existing mocked IPC for compatibility.
      const app = await context.newPage();
      app.on("pageerror", (e) => errors.push(e.message));
      await app.setViewportSize({ width: 460, height: 680 });
      await app.goto(base, { waitUntil: "networkidle" });
      await app.getByRole("button", { name: "Settings", exact: true }).waitFor();
      const ack = app.getByRole("button", { name: "Acknowledge", exact: true });
      if (await ack.isVisible()) await ack.click();
      await ack.waitFor({ state: "hidden" });
      await app.evaluate(() => globalThis.document.fonts.ready);
      await capture(app, `v13-tray-${theme}@${scale}x.png`);
      const navigation = app.getByRole("group", { name: "Navigation", exact: true });
      await navigation.getByRole("button", { name: "Download", exact: true }).focus();
      await app.keyboard.press("ArrowRight");
      await app.getByPlaceholder("Search clipboard").waitFor();
      assert.equal(
        await navigation
          .getByRole("button", { name: "Clipboard", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      await navigation.getByRole("button", { name: "Clipboard", exact: true }).focus();
      await app.keyboard.press("ArrowLeft");
      await app.getByRole("heading", { name: "Queue", exact: true }).waitFor();
      await app.getByRole("button", { name: "Settings", exact: true }).click();
      await capture(app, `v13-settings-${theme}@${scale}x.png`);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      reports.push({
        theme,
        scale,
        assets,
        noteBoxes,
        customFonts,
        idleScheduling: idle,
        keyboardAndNativeControlInteractions: true,
        disabledActionsSuppressed: true,
        previewIpcCalls: 0,
        runtimeErrors: errors,
        externalRequests: external,
      });
      await context.close();
    }
  await writeFile(
    resolve(output, "v13-component-checks.json"),
    JSON.stringify({ figmaNodes: ["5:408", "12:511", "17:195"], reports, pngs }, null, 2) + "\n",
  );
  globalThis.console.log(
    `Passed ${reports.length} component contexts, original asset geometry, keyboard/native controls and zero idle callbacks; ${pngs.length} PNGs.`,
  );
} finally {
  if (browser) await browser.close();
  server.kill();
}
