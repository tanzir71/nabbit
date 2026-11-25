import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { writeFile, stat } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("playwright", { paths: [root, resolve(root, ".tools/site-qa")] }),
);
const [endpoint, theme, scale] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes("spikes/island/index.html"));
  assert(page, "The larger surface must use the existing WebView2 entry");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.emulateMedia({ colorScheme: theme });
  const states = [];
  for (const [state, size] of [
    ["peek", [400, 74]],
    ["expanded", [680, 297]],
  ]) {
    if (state === "expanded")
      await page.evaluate(() => globalThis.nabbitIslandSpike.setState("expanded"));
    await page.waitForFunction(
      (state) => globalThis.document.querySelector(".spike-pill").dataset.state === state,
      state,
    );
    await setTimeout(650);
    const report = await page.evaluate(() => ({
      native: globalThis.__NABBIT_NATIVE_COMPACT__,
      host: [globalThis.innerWidth, globalThis.innerHeight],
      scale: globalThis.devicePixelRatio,
      waiting: globalThis.document.documentElement.dataset.nativeWaiting,
    }));
    assert(report.native);
    assert.deepEqual(report.host, [720, 460]);
    assert.equal(report.scale, Number(scale));
    assert.equal(report.waiting, "false");
    const box = await page.locator(".spike-pill").boundingBox();
    assert.deepEqual([box.width, box.height], size);
    const path = resolve(root, `progress/v2/M1/v04-webview-${theme}@${scale}x-${state}.png`);
    await page.screenshot({ path, omitBackground: true });
    assert((await stat(path)).size <= 300 * 1024);
    states.push({ state, box, ...report });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(root, `progress/v2/M1/v04-webview-${theme}@${scale}x.json`),
    JSON.stringify({ states, runtimeErrors: errors }, null, 2) + "\n",
  );
  await page.evaluate(() => globalThis.nabbitIslandSpike.setState("idle"));
  globalThis.console.log(
    `Passed native→WebView2 peek/expanded→native routing at ${theme}/${scale}x.`,
  );
} finally {
  await browser.close();
}
