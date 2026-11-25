import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { writeFile, stat } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("playwright", { paths: [root, resolve(root, ".tools/site-qa")] }),
);
const [endpoint, prefix = "v14"] = process.argv.slice(2);
assert(/^[a-z0-9-]+$/.test(prefix));
let browser;
const folder = resolve(root, "progress/v2/M2"),
  captures = [];
try {
  for (let i = 0; i < 100; i++) {
    try {
      browser = await chromium.connectOverCDP(endpoint);
      break;
    } catch {
      await setTimeout(100);
    }
  }
  assert(browser);
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => !p.url().includes("spikes/"));
  assert(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  const base = page.url();
  const initial = await page.evaluate(() => globalThis.__TAURI_INTERNALS__.invoke("get_settings"));
  async function open(entry, width, height) {
    await page.setViewportSize({ width, height });
    await page.goto(new URL(entry, base).href, { waitUntil: "networkidle" });
    assert.equal(
      await page.locator("html").getAttribute("data-surface"),
      entry === "index.html" ? "tray" : entry.replace(".html", ""),
    );
    await page.evaluate(() => globalThis.document.fonts.ready);
  }
  async function capture(name, width, height) {
    await page.evaluate(() => {
      for (const animation of globalThis.document.getAnimations()) animation.finish();
    });
    await setTimeout(180);
    const session = await page.context().newCDPSession(page);
    let bytes;
    try {
      const result = await session.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      bytes = Buffer.from(result.data, "base64");
      assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [width, height]);
    } finally {
      await session.detach();
    }
    const file = `${prefix}-native-${name}.png`;
    await writeFile(resolve(folder, file), bytes);
    assert((await stat(resolve(folder, file))).size <= 300 * 1024);
    captures.push({ file, width, height, bytes: bytes.length });
  }
  await capture("tray", 460, 680);
  for (const theme of ["light", "dark"]) {
    await open("settings.html", 460, 680);
    const appearance = page.getByRole("group", { name: "Appearance", exact: true });
    await appearance.waitFor();
    await appearance
      .getByRole("button", { name: theme === "light" ? "Light" : "Dark", exact: true })
      .evaluate((e) => e.click());
    await page.waitForFunction(
      async (theme) =>
        globalThis.document.documentElement.dataset.theme === theme &&
        (await globalThis.__TAURI_INTERNALS__.invoke("get_settings")).theme === theme,
      theme,
      { polling: 100 },
    );
    await capture(`settings-${theme}`, 460, 680);
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
    await open("sticky.html", 280, 208);
    await page.getByRole("heading", { name: "No note selected", exact: true }).waitFor();
    assert.equal(await page.locator("input,textarea,[contenteditable=true]").count(), 0);
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth), 280);
    await capture(`sticky-${theme}`, 280, 208);
  }
  await page.evaluate(() => globalThis.localStorage.setItem("nabbit.theme.v1", "light"));
  await open("island.html", 720, 460);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.deepEqual(await page.locator(".island-idle").boundingBox(), {
    x: 304,
    y: 6,
    width: 112,
    height: 26,
  });
  await capture("island", 720, 460);
  // Hiding the native host can suspend subsequent paints. Verify the close
  // binding after every entry's screenshot, rather than capturing stale frames.
  await open("settings.html", 460, 680);
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .evaluate((element) => element.click());
  assert.equal(
    await page.evaluate(() =>
      globalThis.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" }),
    ),
    false,
  );
  const saved = await page.evaluate(() => globalThis.__TAURI_INTERNALS__.invoke("get_settings"));
  assert.equal(saved.theme, "dark");
  for (const key of Object.keys(initial).filter((k) => k !== "theme"))
    assert.deepEqual(saved[key], initial[key], key);
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(folder, `${prefix}-native-entry-checks.json`),
    JSON.stringify(
      {
        entries: ["index.html", "settings.html", "sticky.html", "island.html"],
        allEntriesServedByPackagedProtocol: true,
        appearancePersistedAcrossEntries: true,
        islandAlwaysDark: true,
        unboundStickyHasNoEditor: true,
        otherSettingsPreserved: true,
        windowLifecycleRemainsForLaterPhases: true,
        runtimeErrors: errors,
        captures,
      },
      null,
      2,
    ) + "\n",
  );
  globalThis.console.log(
    "Passed four packaged HTML entries, settings persistence, sticky appearance cache and always-dark island without runtime errors.",
  );
} finally {
  if (browser) await browser.close();
}
