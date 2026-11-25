import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
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
const report = JSON.parse(await readFile(resolve(root, ".tools/entry-build-current.json"), "utf8"));
const folder = resolve(root, "progress/v2/M2");
await mkdir(folder, { recursive: true });
const base = "http://127.0.0.1:1445";
const server = spawn(
  process.execPath,
  [
    resolve(root, "node_modules/vite/bin/vite.js"),
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "1445",
    "--strictPort",
  ],
  { cwd: root, windowsHide: true, stdio: "ignore" },
);
let browser;
const reports = [],
  pngs = [];
async function capture(page, name, transparent = false) {
  const path = resolve(folder, name);
  await page.screenshot({ path, animations: "disabled", omitBackground: transparent });
  const bytes = (await stat(path)).size;
  assert(bytes <= 300 * 1024);
  pngs.push({ name, bytes });
}
const pathOf = (url) => new URL(url).pathname.slice(1);
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await globalThis.fetch(base + "/island.html")).ok;
    } catch {
      /*starting*/
    }
    if (ready) break;
    await setTimeout(100);
  }
  assert(ready);
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
      const app = await context.newPage();
      app.on("pageerror", (e) => errors.push(e.message));
      const mainJs = [];
      app.on("request", (r) => {
        if (r.url().endsWith(".js")) mainJs.push(pathOf(r.url()));
      });
      await app.goto(base, { waitUntil: "networkidle" });
      await app.getByRole("button", { name: "Settings", exact: true }).waitFor();
      const acknowledge = app.getByRole("button", { name: "Acknowledge", exact: true });
      if (await acknowledge.isVisible()) await acknowledge.click();
      await acknowledge.waitFor({ state: "hidden" });
      await app.evaluate(() => globalThis.document.fonts.ready);
      assert.equal(await app.locator("html").getAttribute("data-surface"), "tray");
      const initialMain = [...new Set(mainJs)].sort();
      assert.deepEqual(initialMain, report.entries["index.html"].initial);
      assert(!initialMain.some((file) => report.entries["index.html"].deferred.includes(file)));
      await capture(app, `v14-tray-${theme}@${scale}x.png`);
      await app.getByRole("button", { name: "Settings", exact: true }).click();
      await app.getByRole("group", { name: "Appearance", exact: true }).waitFor();
      assert(
        report.entries["index.html"].deferred.some((file) => mainJs.includes(file)),
        "Tray settings must load on demand",
      );
      await app.getByRole("button", { name: "Close settings", exact: true }).click();

      const settings = await context.newPage();
      settings.on("pageerror", (e) => errors.push(e.message));
      const settingsJs = [];
      settings.on("request", (r) => {
        if (r.url().endsWith(".js")) settingsJs.push(pathOf(r.url()));
      });
      await settings.goto(base + "/settings.html", { waitUntil: "networkidle" });
      const appearance = settings.getByRole("group", { name: "Appearance", exact: true });
      await appearance.waitFor();
      await settings.evaluate(() => globalThis.document.fonts.ready);
      assert.equal(await settings.locator("html").getAttribute("data-surface"), "settings");
      assert.deepEqual([...new Set(settingsJs)].sort(), report.entries["settings.html"].initial);
      await auditFont(settings, "h2", "Geist");
      await capture(settings, `v14-settings-${theme}@${scale}x.png`);
      const forced = theme === "light" ? "dark" : "light";
      await appearance
        .getByRole("button", { name: forced === "light" ? "Light" : "Dark", exact: true })
        .click();
      await settings.waitForFunction(
        (value) => globalThis.document.documentElement.dataset.theme === value,
        forced,
      );
      await settings.reload({ waitUntil: "networkidle" });
      await settings.waitForFunction(
        (value) => globalThis.document.documentElement.dataset.theme === value,
        forced,
      );
      const sticky = await context.newPage();
      sticky.on("pageerror", (e) => errors.push(e.message));
      await sticky.setViewportSize({ width: 280, height: 208 });
      await sticky.goto(base + "/sticky.html", { waitUntil: "networkidle" });
      assert.equal(
        await sticky.locator("html").getAttribute("data-theme"),
        forced,
        "New entry reads the shared saved appearance cache",
      );
      await settings
        .getByRole("group", { name: "Appearance", exact: true })
        .getByRole("button", { name: "System", exact: true })
        .click();
      await sticky.reload({ waitUntil: "networkidle" });
      await sticky.evaluate(() => globalThis.document.fonts.ready);
      assert.equal(await sticky.locator("html").getAttribute("data-theme"), theme);
      assert.equal(await sticky.locator("html").getAttribute("data-surface"), "sticky");
      await sticky.getByRole("heading", { name: "No note selected", exact: true }).waitFor();
      assert.equal(
        await sticky.locator("input,textarea,[contenteditable=true]").count(),
        0,
        "Unbound sticky must not claim editing/persistence",
      );
      assert.equal(
        await sticky.evaluate(() => globalThis.document.documentElement.scrollWidth),
        280,
      );
      await auditFont(sticky, "h1", "Geist");
      await capture(sticky, `v14-sticky-${theme}@${scale}x.png`);
      await settings.setViewportSize({ width: 980, height: 720 });
      await settings
        .getByRole("textbox", { name: "Output folder", exact: true })
        .fill("Downloads/Entry-check");
      assert.equal(
        await settings.getByRole("textbox", { name: "Output folder", exact: true }).inputValue(),
        "Downloads/Entry-check",
      );
      await settings.getByRole("button", { name: "Close settings", exact: true }).click();
      await settings.waitForURL(base + "/index.html");

      const island = await context.newPage();
      island.on("pageerror", (e) => errors.push(e.message));
      await island.setViewportSize({ width: 720, height: 460 });
      const islandJs = [];
      island.on("request", (r) => {
        if (r.url().endsWith(".js")) islandJs.push(pathOf(r.url()));
      });
      await island.addInitScript(() => {
        globalThis.localStorage.setItem("nabbit.theme.v1", "light");
        globalThis.__islandIpc = [];
        globalThis.__TAURI_INTERNALS__ = {
          invoke: (...args) => {
            globalThis.__islandIpc.push(args);
            throw Error("Foundations island attempted IPC");
          },
        };
      });
      await island.goto(base + "/island.html", { waitUntil: "networkidle" });
      assert.equal(await island.locator("html").getAttribute("data-surface"), "island");
      assert.equal(await island.locator("html").getAttribute("data-theme"), "dark");
      assert.deepEqual(
        [...new Set(islandJs)].sort(),
        report.entries["island.html"].initial,
        "Cold island network must match the measured initial closure",
      );
      const pill = await island.locator(".island-idle").boundingBox();
      assert.deepEqual(pill, { x: 304, y: 6, width: 112, height: 26 });
      assert.equal(
        await island
          .locator(".island-idle")
          .evaluate((e) => globalThis.getComputedStyle(e).borderRadius),
        "13px",
      );
      await island.emulateMedia({ colorScheme: theme === "light" ? "dark" : "light" });
      assert.equal(await island.locator("html").getAttribute("data-theme"), "dark");
      await capture(island, `v14-island-${theme}@${scale}x.png`, true);
      await island.evaluate(() => {
        const counts = { timeout: 0, interval: 0, raf: 0 };
        globalThis.__islandIdle = counts;
        const t = globalThis.setTimeout,
          i = globalThis.setInterval,
          r = globalThis.requestAnimationFrame;
        globalThis.setTimeout = (...a) => {
          counts.timeout++;
          return t(...a);
        };
        globalThis.setInterval = (...a) => {
          counts.interval++;
          return i(...a);
        };
        globalThis.requestAnimationFrame = (...a) => {
          counts.raf++;
          return r(...a);
        };
      });
      await setTimeout(800);
      const idle = await island.evaluate(() => globalThis.__islandIdle);
      assert.deepEqual(idle, { timeout: 0, interval: 0, raf: 0 });
      assert.deepEqual(await island.evaluate(() => globalThis.__islandIpc), []);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      reports.push({
        theme,
        scale,
        initialMain,
        initialIsland: [...new Set(islandJs)].sort(),
        islandGzipBytes: report.entries["island.html"].initialGzipBytes,
        islandGeometry: pill,
        settingsLoadsOnDemand: true,
        standaloneSettingsSaveAndClose: true,
        sharedAppearanceCache: true,
        stickyUnboundState: true,
        idleScheduling: idle,
        islandIpcCalls: 0,
        runtimeErrors: errors,
        externalRequests: external,
      });
      await context.close();
    }
  await writeFile(
    resolve(folder, "v14-entry-checks.json"),
    JSON.stringify({ reports, pngs }, null, 2) + "\n",
  );
  globalThis.console.log(
    `Passed four entry contexts, cold bundle boundaries, settings/appearance/close behavior, transparent island and zero idle callbacks; ${pngs.length} PNGs.`,
  );
} finally {
  if (browser) await browser.close();
  server.kill();
}
