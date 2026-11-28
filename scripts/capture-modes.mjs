import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { captureSuite } from "./screenshots/harness.mjs";
import { settingsFixture } from "./screenshots/settings-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v62-modes-a";
assert(/^[a-z0-9-]+$/.test(prefix));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8"),
  scans = [];
const modes = [
  ["islandAndTray", "Island + tray"],
  ["trayOnly", "Tray only"],
  ["islandOnly", "Island only"],
];
const scenarios = [];
for (const minimum of [false, true])
  for (const [mode, label] of modes)
    scenarios.push({
      name: `mode-${mode.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}${minimum ? "-minimum" : ""}`,
      suite: "surfaces",
      entry: "settings.html",
      surface: "settings",
      label: "settings",
      viewport: minimum ? { width: 820, height: 600 } : { width: 980, height: 720 },
      font: "h1",
      retainFailures: true,
      cdpCapture: true,
      fixture: settingsFixture,
      async ready(page) {
        await page.getByRole("heading", { name: "General", level: 1, exact: true }).waitFor();
        const group = page.getByRole("group", { name: "Where Nabbit lives", exact: true });
        const button = group.getByRole("button", {
          name: new RegExp(`^${label.replace("+", "\\+")}`),
        });
        await button.focus();
        await button.press("Space");
        await page.waitForFunction(
          (mode) => globalThis.__NABBIT_CAPTURE__.snapshot().state.settings.displayMode === mode,
          mode,
        );
        await page.locator('.settings-window[aria-busy="false"]').waitFor();
        assert.equal(await button.getAttribute("aria-pressed"), "true");
        assert.equal(await group.locator('[aria-pressed="true"]').count(), 1);
        await page.evaluate(axe);
        const scan = await page.evaluate(async () => {
          const result = await globalThis.axe.run();
          return {
            version: globalThis.axe.version,
            theme: globalThis.document.documentElement.dataset.theme,
            scale: globalThis.devicePixelRatio,
            violations: result.violations,
            incomplete: result.incomplete,
            passes: result.passes.length,
          };
        });
        scans.push({ mode, minimum, ...scan });
        assert.equal(scan.violations.length, 0, JSON.stringify(scan.violations));
        assert.equal(scan.incomplete.length, 0, JSON.stringify(scan.incomplete));
        return { mode, minimum, keyboardActivation: true, axe: scan };
      },
    });
try {
  await captureSuite(
    root,
    {
      milestone: "M11",
      prefix,
      suite: "surfaces",
      repeatCheck: true,
      deterministicCompositor: true,
    },
    scenarios,
  );
} finally {
  await writeFile(
    new URL(`../progress/v2/M11/${prefix}-axe.json`, import.meta.url),
    JSON.stringify(
      {
        scope:
          "Whole-document axe defaults; all three mode choices activated through keyboard; default and minimum window sizes",
        scans,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
