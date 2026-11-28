import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { settingsFixture } from "./screenshots/settings-fixtures.mjs";
import { clipboardFixture } from "./screenshots/clipboard-fixtures.mjs";
import { notesFixture } from "./screenshots/notes-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const prefix = process.argv[2] ?? "v63-tray-a";
assert(/^[a-z0-9-]+$/u.test(prefix));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const scans = [];
const variants = [
  "nab",
  "notes",
  "clipboard",
  "files",
  "clipboard-empty",
  "clipboard-paused",
  "clipboard-keyboard",
  "files-empty",
  "files-search",
];
const cases = variants
  .filter((variant) => !process.argv[3] || variant === process.argv[3])
  .map((variant) => ({
    name: `tray-${variant}`,
    suite: "surfaces",
    entry: "index.html",
    surface: "tray",
    figmaNode: variant.startsWith("clipboard")
      ? "13:422"
      : variant.startsWith("files")
        ? "10:249"
        : variant === "notes"
          ? "13:242"
          : "13:2",
    label: "main",
    viewport: { width: 460, height: 680 },
    font: "h1",
    retainFailures: true,
    cdpCapture: true,
    fixture() {
      const fixture = settingsFixture();
      fixture.data.settings.lastTab = variant.startsWith("clipboard")
        ? "clipboard"
        : variant.startsWith("files")
          ? "files"
          : variant === "notes"
            ? "notes"
            : "download";
      fixture.data.settings.pauseClipboardCapture = variant === "clipboard-paused";
      fixture.data.clipboard = clipboardFixture(
        variant === "clipboard-empty" ? "empty" : "all",
      ).data.clipboard;
      if (fixture.data.clipboard.length) {
        fixture.data.clipboard[1].content = "https://www.youtube.com/watch?v=ownedFixture";
        fixture.data.clipboard[1].preview = fixture.data.clipboard[1].content;
      }
      fixture.data.notes = notesFixture();
      fixture.responses.tray_ready = null;
      fixture.responses.tray_take_notice = null;
      if (variant === "clipboard-keyboard") {
        fixture.responses.clipboard_context = {
          entry: fixture.data.clipboard[1],
          kind: "video",
          selection: false,
          tools: [],
          textTools: [],
        };
      }
      if (variant !== "files-empty") {
        fixture.data.shelf = [
          {
            id: "owned-shelf",
            path: "D:\\Owned fixtures\\brief.pdf",
            name: "brief.pdf",
            kind: "file",
            size: 2048,
            available: true,
            cloud: false,
          },
        ];
        fixture.data.filePins = [
          {
            id: "owned-folder",
            kind: "folder",
            path: "D:\\Owned fixtures\\Research",
            label: "Research",
            slot: 1,
            alwaysMove: false,
            available: true,
            cloud: false,
            network: false,
          },
          {
            id: "owned-missing",
            kind: "file",
            path: "D:\\Owned fixtures\\missing.md",
            label: "Old brief",
            slot: 9,
            alwaysMove: false,
            available: false,
            cloud: false,
            network: false,
          },
        ];
      }
      return fixture;
    },
    async ready(page) {
      const tab = variant.startsWith("clipboard")
        ? "Clipboard"
        : variant.startsWith("files")
          ? "Files"
          : variant === "notes"
            ? "Notes"
            : "Nab";
      const button = page
        .getByRole("navigation", { name: "Navigation" })
        .getByRole("button", { name: tab, exact: true });
      await button.waitFor();
      assert.equal(await button.getAttribute("aria-pressed"), "true");
      if (tab === "Notes")
        await page.getByRole("button", { name: "Launch checklist", exact: true }).waitFor();
      if (tab === "Files") {
        await page.getByRole("region", { name: "Files, Shelf and Pins" }).waitFor();
        await page.locator('.shelf-grid[aria-busy="false"]').waitFor();
        if (variant === "files-empty")
          await page
            .getByText(
              "Pin a file or folder to keep it close. Removing a pin leaves the original unchanged.",
              { exact: true },
            )
            .waitFor();
        else
          await page.getByRole("button", { name: "Actions for Research", exact: true }).waitFor();
      }
      if (tab === "Clipboard")
        await page.getByRole("textbox", { name: "Search clipboard", exact: true }).waitFor();
      if (variant === "files-search") {
        const trigger = page.getByRole("button", { name: "Search files", exact: true });
        await trigger.focus();
        await page.keyboard.press("Space");
        const field = page.getByRole("searchbox", { name: "Search Shelf and Pins", exact: true });
        await field.fill("Research");
        assert.equal(await page.locator(".files-pin-grid > li").count(), 1);
        await page.getByText("No matching Shelf files.", { exact: true }).waitFor();
        await field.fill("brief.pdf");
        assert.equal(await page.locator("[data-shelf-id]").count(), 1);
        await page.getByText("No matching pins.", { exact: true }).waitFor();
        await field.press("Escape");
        await page.waitForFunction(
          () => globalThis.document.activeElement?.getAttribute("aria-label") === "Search files",
        );
        await trigger.press("Space");
        await field.fill("Research");
      }
      if (variant === "clipboard-keyboard") {
        const search = page.getByRole("textbox", { name: "Search clipboard", exact: true });
        await search.fill("4:30");
        assert.equal(await page.locator("[data-tray-clipboard-id]").count(), 1);
        await search.press("Control+KeyA");
        await search.press("Backspace");
        await search.press("ArrowDown");
        await page.getByRole("button", { name: "Pinned", exact: true }).focus();
        await page.keyboard.press("Space");
        assert.equal(await page.locator("[data-tray-clipboard-id]").count(), 1);
        const context = page.getByRole("region", { name: "Copied link actions", exact: true });
        await context.waitFor();
        const primary = await context.locator("button.is-signal").evaluate((button) => ({
          background: globalThis.getComputedStyle(button).backgroundColor,
          color: globalThis.getComputedStyle(button).color,
          theme: globalThis.document.documentElement.dataset.theme,
        }));
        assert.equal(primary.background, primary.theme === "dark" ? "rgb(242, 242, 240)" : "rgb(23, 23, 26)");
        assert.equal(primary.color, primary.theme === "dark" ? "rgb(23, 23, 26)" : "rgb(255, 255, 255)");
      } else if (variant !== "files-search")
        await page.evaluate(() => globalThis.document.activeElement?.blur());
      await page.evaluate(async () => {
        await globalThis.document.fonts.ready;
        await Promise.all([...globalThis.document.images].map((image) => image.decode()));
      });
      const assets = await page.locator("img[data-asset],img.island-asset").evaluateAll((images) =>
        images
          .map((image) => {
            const box = image.getBoundingClientRect();
            return {
              file: image.dataset.asset || image.dataset.assetSlot,
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
              width: box.width,
              height: box.height,
            };
          })
          .filter((image) => image.width > 0 && image.height > 0),
      );
      assert(assets.length > 0);
      for (const asset of assets) {
        assert(asset.naturalWidth > 0);
        assert.equal(asset.width, asset.naturalWidth, JSON.stringify(asset));
        assert.equal(asset.height, asset.naturalHeight, JSON.stringify(asset));
      }
      const geometry = await page.locator(".tray-popover").evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        overflow: element.scrollWidth > element.clientWidth,
      }));
      assert.equal(geometry.width, 460);
      assert.equal(geometry.height, 680);
      assert.equal(geometry.overflow, false);
      await page.evaluate(axe);
      const scan = await page.evaluate(async () => {
        const result = await globalThis.axe.run();
        return {
          theme: globalThis.document.documentElement.dataset.theme,
          scale: globalThis.devicePixelRatio,
          violations: result.violations,
          incomplete: result.incomplete,
          passes: result.passes.length,
        };
      });
      scans.push({ variant, ...scan });
      assert.equal(scan.violations.length, 0, JSON.stringify(scan.violations));
      assert.equal(scan.incomplete.length, 0, JSON.stringify(scan.incomplete));
      return { variant, geometry, assets, axe: scan };
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
      {
        scope:
          "Whole-document axe defaults, four real popover tabs and empty/paused/keyboard variants",
        scans,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
