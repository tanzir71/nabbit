import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("playwright", { paths: [root, resolve(root, ".tools/site-qa")] }),
);
const [endpoint] = process.argv.slice(2);
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      browser = await chromium.connectOverCDP(endpoint);
      break;
    } catch {
      await new Promise((r) => globalThis.setTimeout(r, 100));
    }
  }
  assert(browser);
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => !p.url().includes("spikes/island"));
  assert(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  const initial = await page.evaluate(async () => ({
    nativeTheme: await globalThis.__TAURI_INTERNALS__.invoke("plugin:window|theme", {
      label: "main",
    }),
    settings: await globalThis.__TAURI_INTERNALS__.invoke("get_settings"),
  }));
  assert(["light", "dark"].includes(initial.nativeTheme));
  await page.waitForFunction(
    (theme) => globalThis.document.documentElement.dataset.theme === theme,
    initial.nativeTheme,
    { polling: 100 },
  );
  await page.getByRole("button", { name: "Settings", exact: true }).evaluate((e) => e.click());
  const appearance = page.getByRole("group", { name: "Appearance", exact: true });
  const choose = async (name) => {
    await appearance.getByRole("button", { name, exact: true }).evaluate((e) => e.click());
    await page.waitForFunction(
      async (value) =>
        (await globalThis.__TAURI_INTERNALS__.invoke("get_settings")).theme === value,
      name.toLowerCase(),
      { polling: 100 },
    );
  };
  const expectTheme = (theme) =>
    page.waitForFunction(
      (theme) => globalThis.document.documentElement.dataset.theme === theme,
      theme,
      { polling: 100 },
    );
  const emit = async (theme) =>
    page.evaluate(
      (payload) =>
        globalThis.__TAURI_INTERNALS__.invoke("plugin:event|emit_to", {
          target: { kind: "Window", label: "main" },
          event: "tauri://theme-changed",
          payload,
        }),
      theme,
    );
  const folder = resolve(root, "progress/v2/M2");
  await mkdir(folder, { recursive: true });
  for (const value of ["Light", "Dark"]) {
    await choose(value);
    await expectTheme(value.toLowerCase());
    await page.screenshot({
      path: resolve(folder, `v11-native-settings-${value.toLowerCase()}.png`),
      animations: "disabled",
    });
    assert(
      (await stat(resolve(folder, `v11-native-settings-${value.toLowerCase()}.png`))).size <=
        300 * 1024,
    );
  }
  await choose("System");
  await emit("light");
  await expectTheme("light");
  await emit("dark");
  await expectTheme("dark");
  await choose("Light");
  await emit("dark");
  await expectTheme("light");
  await choose("Dark");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectTheme("dark");
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  const saved = await page.evaluate(() => globalThis.__TAURI_INTERNALS__.invoke("get_settings"));
  assert.equal(saved.theme, "dark");
  for (const key of Object.keys(initial.settings).filter((key) => key !== "theme"))
    assert.deepEqual(saved[key], initial.settings[key], `Theme save changed ${key}`);
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(folder, "v11-native-theme.json"),
    JSON.stringify(
      {
        surface: "actual Windows WebView2",
        nativeTheme: initial.nativeTheme,
        osThemeEventsInjected: true,
        windowsPreferencesChanged: false,
        themeQueryAndListenerAuthorized: true,
        overrideWins: true,
        overrideRestoredAfterReload: true,
        otherSettingsPreserved: true,
        runtimeErrors: errors,
      },
      null,
      2,
    ) + "\n",
  );
  globalThis.console.log(
    "Passed Windows theme query/event bridge, override precedence, SQLite-backed reload and preservation of other settings.",
  );
} finally {
  if (browser) await browser.close();
}
