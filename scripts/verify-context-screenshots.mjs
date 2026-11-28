import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { contextFixture } from "./screenshots/context-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const modes = [
  "link",
  "video",
  "json",
  "image",
  "files",
  "path",
  "text-menu",
  "case",
  "lines",
  "encoding",
  "selection",
  "selected-link",
  "blocked",
  "error",
];
const cases = modes
  .filter((m) => !process.argv[3] || m === process.argv[3])
  .map((mode) => ({
    name: `context-${mode}`,
    suite: "context",
    entry: "index.html",
    surface: "tray",
    label: "main",
    viewport: { width: 496, height: 760 },
    caret: "initial",
    naturalMotion: true,
    retainFailures: true,
    selector: ["blocked", "error"].includes(mode) ? "main" : ".clipboard-context",
    font: ["text-menu", "case", "lines", "encoding", "selection"].includes(mode)
      ? ".text-tools-menu button"
      : "header",
    figmaNode: ["text-menu", "selection"].includes(mode)
      ? "36:505"
      : mode === "case"
        ? "36:539"
        : ["link", "video", "selected-link"].includes(mode)
          ? "45:568"
          : null,
    fixture: () => contextFixture(mode),
    async ready(page) {
      await page.getByPlaceholder("Search clipboard").waitFor();
      if (["text-menu", "case", "lines", "encoding"].includes(mode))
        await page.getByRole("button", { name: "Text tools", exact: true }).click();
      if (["case", "lines", "encoding"].includes(mode))
        await page
          .getByRole("menuitem", {
            name: {
              case: "Change case",
              lines: "Trim, sort or dedupe lines",
              encoding: "Encode or decode",
            }[mode],
            exact: true,
          })
          .click();
      if (mode === "error") await page.getByRole("alert").waitFor();
      else if (mode === "blocked") {
        await page.getByText("Owned fixture", { exact: true }).waitFor();
        assert.equal(await page.locator(".clipboard-context").count(), 0);
      } else await page.locator(".clipboard-context").waitFor();
      await page.mouse.move(490, 750);
      await page.evaluate(async () => {
        if (globalThis.document.activeElement?.matches("input,textarea,[contenteditable=true]"))
          globalThis.document.activeElement.blur();
        await globalThis.document.fonts.ready;
        await Promise.all([...globalThis.document.images].map((i) => i.decode()));
      });
      await page.addScriptTag({ content: axe });
      const accessibility = await page.evaluate(async () => {
        const r = await globalThis.axe.run();
        const compact = (rows) =>
          rows.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
          }));
        return { violations: compact(r.violations), incomplete: compact(r.incomplete) };
      });
      assert.deepEqual(accessibility, { violations: [], incomplete: [] });
      const menu = page.getByRole("menu");
      let geometry = null;
      if (await menu.count()) {
        geometry = await menu.boundingBox();
        assert.equal(geometry.width, ["case", "lines", "encoding"].includes(mode) ? 200 : 280);
        if (["text-menu", "selection"].includes(mode)) assert.equal(geometry.height, 348);
        if (mode === "case") assert.equal(geometry.height, 190);
      }
      if (["link", "video", "selected-link"].includes(mode)) {
        const row = page.getByRole("region", { name: "Copied link actions" });
        geometry = await row.boundingBox();
        // The existing 460px tray host constrains the 480px Figma row.
        assert.equal(geometry.width, 442);
        assert.equal(geometry.height, 70);
        assert.equal(
          await row.getByRole("button").first().innerText(),
          mode === "video" ? "Download" : "Save link",
        );
      }
      const calls = await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot().calls);
      assert(
        !calls.some((c) =>
          [
            "clipboard_transform",
            "clipboard_context_action",
            "tool_start",
            "tool_open_media_sheet",
            "start_download",
          ].includes(c.command),
        ),
      );
      return { mode, accessibility, geometry, noJobOrClipboardWrite: true };
    },
  }));
const report = await captureSuite(
  root,
  {
    milestone: "M10",
    prefix: process.argv[2] ?? "v511-context-a",
    suite: "all",
    repeatCheck: true,
  },
  cases,
);
globalThis.console.log(`Verified ${report.captures.length} clipboard context captures.`);
