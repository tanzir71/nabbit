import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { captureSuite } from "./screenshots/harness.mjs";
import { settingsFixture } from "./screenshots/settings-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const prefix = process.argv[2] ?? "v64-shortcuts-a";
assert(/^[a-z0-9-]+$/.test(prefix));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const scans = [];
const rows = [
  ["island", "islandShortcut", "Alt+Space"],
  ["quickNote", "quickNoteShortcut", "Ctrl+Alt+N"],
  ["download", "quickDownloadShortcut", "Ctrl+Alt+D"],
  ["clipboard", "clipboardSearchShortcut", "Ctrl+Alt+V"],
  ["timer", "focusTimerShortcut", "Ctrl+Alt+T"],
  ["hideIsland", "hideIslandShortcut", "Ctrl+Alt+H"],
  ["selection", "selectedTextShortcut", "Ctrl+Alt+S"],
  ["toggleTray", "togglePopoverShortcut", "Ctrl+Shift+V"],
];
const variants = ["conflict", "ready", "recording", "disabled", "error", "other"];
const cases = variants.map((variant) => ({
  name: `shortcuts-${variant}`,
  suite: "surfaces",
  entry: "settings.html",
  surface: "settings",
  label: "settings",
  figmaNode: "22:474",
  viewport: { width: 980, height: 720 },
  font: "h1",
  retainFailures: true,
  cdpCapture: true,
  fixture() {
    const fixture = settingsFixture();
    if (variant === "disabled") fixture.data.settings.quickNoteShortcut = "";
    if (["conflict", "error"].includes(variant)) {
      fixture.responses.shortcuts_snapshot = {
        rows: rows.map(([id, field, fallback]) => ({
          id,
          shortcut: fixture.data.settings[field] ?? fallback,
          activeShortcut:
            variant === "conflict" && id === "hideIsland"
              ? null
              : (fixture.data.settings[field] ?? fallback),
          problem:
            variant === "conflict" && id === "hideIsland"
              ? { shortcut: "Ctrl+Alt+H", message: "Also used by another app.", conflict: true }
              : variant === "error" && id === "download"
                ? {
                    shortcut: "Ctrl+Alt+F9",
                    message:
                      "Shortcut conflict: this combination is already registered. Your previous shortcut is still active.",
                    conflict: true,
                  }
                : null,
        })),
        recording: false,
        cleanupError: null,
        injected: true,
      };
    }
    if (variant === "error")
      fixture.failures = {
        patch_settings: "Shortcut conflict: this combination is already registered.",
      };
    return fixture;
  },
  async ready(page) {
    await page.getByRole("heading", { name: "General", exact: true, level: 1 }).waitFor();
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Shortcuts", exact: true })
      .click();
    await page.getByRole("heading", { name: "Shortcuts", exact: true, level: 1 }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Change / }).count(), 8);
    if (variant === "conflict") await page.getByText("Conflict", { exact: true }).waitFor();
    if (["recording", "error"].includes(variant)) {
      const title =
        variant === "recording" ? "Open or close the island" : "Download link on clipboard";
      const change = page.getByRole("button", { name: `Change ${title}`, exact: true });
      await change.focus();
      await page.keyboard.press("Space");
      const field = page.getByRole("textbox", { name: "Shortcut combination", exact: true });
      await field.and(page.locator(":enabled")).waitFor();
      await field.press("Control+Alt+F9");
      assert.equal(await field.inputValue(), "Ctrl+Alt+F9");
      assert.equal(
        (await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot())).calls.filter(
          (row) => row.command === "patch_settings",
        ).length,
        0,
        "Recording alone must not save",
      );
      if (variant === "recording") {
        await field.press("Escape");
        await page.waitForFunction(
          () =>
            globalThis.document.activeElement?.getAttribute("aria-label") ===
            "Change Open or close the island",
        );
        await change.press("Space");
        await field.and(page.locator(":enabled")).waitFor();
        await field.press("Control+Alt+F9");
      } else {
        await page.getByRole("button", { name: "Save shortcut", exact: true }).click();
        await page.waitForFunction(() =>
          globalThis.document.querySelector('input[aria-invalid="true"]'),
        );
      }
    } else if (variant === "other") {
      await page.getByRole("button", { name: "Change Act on selected text", exact: true }).focus();
      await page
        .getByRole("heading", { name: "Other global shortcuts", exact: true })
        .scrollIntoViewIfNeeded();
    } else await page.evaluate(() => globalThis.document.activeElement?.blur());
    const assets = await page
      .locator("img[data-settings-asset],img[data-asset],img.island-asset")
      .evaluateAll((images) =>
        images.map((image) => {
          const box = image.getBoundingClientRect();
          return {
            file: image.dataset.settingsAsset || image.dataset.asset || image.dataset.assetSlot,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            width: box.width,
            height: box.height,
          };
        }),
      );
    for (const asset of assets) {
      assert(asset.naturalWidth > 0);
      assert.equal(asset.width, asset.naturalWidth);
      assert.equal(asset.height, asset.naturalHeight);
    }
    await page.evaluate(axe);
    const result = await page.evaluate(async () => {
      const scan = await globalThis.axe.run();
      return {
        theme: globalThis.document.documentElement.dataset.theme,
        scale: globalThis.devicePixelRatio,
        violations: scan.violations,
        incomplete: scan.incomplete,
        passes: scan.passes.length,
      };
    });
    scans.push({ variant, ...result });
    assert.equal(result.violations.length, 0, JSON.stringify(result.violations));
    assert.equal(result.incomplete.length, 0, JSON.stringify(result.incomplete));
    return { variant, assets, axe: result };
  },
}));
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
    cases,
  );
} finally {
  await writeFile(
    new URL(`../progress/v2/M11/${prefix}-axe.json`, import.meta.url),
    JSON.stringify(
      { scope: "Whole-document default axe; no exclusions or disabled rules", scans },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
