import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { fixtureData } from "./screenshots/fixtures.mjs";
import { notesFixture } from "./screenshots/notes-fixtures.mjs";
import { auditFont } from "./font-audit.mjs";
import { reviewNotesMenuContrast } from "./notes-contrast-review.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const modes = ["design", "empty", "composer", "menu", "trash", "search", "narrow", "keyboard"];
const cases = modes.map((mode) => ({
  name: `notes-${mode}`,
  suite: "notes",
  entry: "index.html",
  surface: "tray",
  label: "main",
  font: "h1",
  figmaNode: "13:242",
  caret: "initial",
  viewport: { width: mode === "narrow" ? 360 : 460, height: 680 },
  fixture() {
    const data = fixtureData("tray-downloads");
    data.settings.lastTab = "notes";
    data.notes = mode === "empty" ? [] : notesFixture();
    if (mode === "trash") data.notes[1].value.trashedAt = "2026-11-27T03:00:00.000Z";
    return { data };
  },
  async ready(page) {
    await page.getByText("Local only · Saved on this device", { exact: true }).waitFor();
    await page
      .getByRole("navigation", { name: "Navigation" })
      .getByRole("button", { name: "Notes", exact: true })
      .waitFor();
    if (mode === "empty")
      await page.getByRole("heading", { name: "A place for your notes", exact: true }).waitFor();
    else await page.getByRole("button", { name: "Launch checklist", exact: true }).waitFor();
    await page.evaluate(() => globalThis.document.fonts.ready);
    const initialCalls = await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot().calls);
    assert(initialCalls.some((c) => c.command === "list_note_cards"));
    assert(!initialCalls.some((c) => ["create_note_card", "update_note_card"].includes(c.command)));
    if (mode === "composer") {
      await page.getByRole("button", { name: "Island idea", exact: true }).click();
      await page
        .getByLabel("Note body", { exact: true })
        .fill("A local draft. It is not saved until Save note is activated.");
      await page.getByLabel("Note colour", { exact: true }).selectOption("purple");
      assert(
        !(await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot().calls)).some(
          (c) => c.command === "update_note_card",
        ),
      );
    }
    if (mode === "menu" || mode === "trash")
      await page.getByLabel("Notes view and labels", { exact: true }).click();
    if (mode === "trash") {
      await page.getByRole("button", { name: "Trash", exact: true }).click();
      await page.getByRole("button", { name: "Island idea", exact: true }).waitFor();
      assert.equal(await page.locator(".notes-card-wrap").count(), 1);
    }
    if (mode === "search") {
      await page.getByRole("button", { name: "Search notes", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search notes", exact: true }).fill("middle-click");
      assert.equal(await page.locator(".notes-card-wrap").count(), 1);
      assert.equal(await page.getByRole("button", { name: "Island idea", exact: true }).count(), 1);
    }
    if (mode === "keyboard")
      await page
        .getByRole("navigation", { name: "Navigation" })
        .getByRole("button", { name: "Notes", exact: true })
        .focus();
    else await page.evaluate(() => globalThis.document.activeElement?.blur());
    const geometry = await page.locator(".notes-view").evaluate((el) => {
      const r = el.getBoundingClientRect(),
        body = el.querySelector(".notes-body"),
        capture = el.querySelector(".notes-capture").getBoundingClientRect(),
        footer = el.querySelector(".notes-footer").getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        captureHeight: capture.height,
        footerHeight: footer.height,
        horizontalOverflow: body.scrollWidth > body.clientWidth,
        columns: el.querySelectorAll(".notes-column").length,
      };
    });
    assert.equal(geometry.captureHeight, 44);
    assert.equal(geometry.footerHeight, 40);
    assert.equal(geometry.horizontalOverflow, false);
    if (mode === "design") {
      assert.equal(geometry.columns, 2);
      assert.equal(await page.locator(".notes-card-wrap").count(), 4);
      assert.equal(
        await page
          .getByRole("checkbox", { name: "Verify island at 150% DPI", exact: true })
          .isChecked(),
        true,
      );
    }
    const fonts = {};
    if (!["empty", "composer", "menu"].includes(mode)) {
      fonts.heading = await auditFont(page, ".n-note-title", "Geist");
      if (mode !== "search") fonts.mono = await auditFont(page, ".n-note-reference", "Geist Mono");
    }
    const assets = await page.locator("img[data-asset]").evaluateAll((nodes) =>
      nodes
        .filter((img) => img.getBoundingClientRect().width > 0)
        .map((img) => ({
          file: img.dataset.asset,
          src: img.src,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          width: img.getBoundingClientRect().width,
          height: img.getBoundingClientRect().height,
          slot: img.closest(".notes-capture")
            ? "capture"
            : img.closest(".notes-footer")
              ? "footer"
              : img.closest(".tray-header")
                ? "header"
                : img.closest(".tray-tabs")
                  ? "tabs"
                  : img.closest(".notes-card-wrap")
                    ? "card"
                    : "view menu",
        })),
    );
    for (const asset of assets) {
      asset.source = `src/assets/${asset.file.includes("/") ? asset.file : `components/${asset.file}`}`;
      const local = await readFile(new URL(`../${asset.source}`, import.meta.url));
      const actual = asset.src.startsWith("data:")
        ? Buffer.from(
            asset.src.includes(";base64,")
              ? asset.src.split(",")[1]
              : decodeURIComponent(asset.src.slice(asset.src.indexOf(",") + 1)),
            asset.src.includes(";base64,") ? "base64" : "utf8",
          )
        : Buffer.from(await (await globalThis.fetch(asset.src)).arrayBuffer());
      // Vite's pinned svgToDataURL serializes inline SVG whitespace/quotes.
      // Compare its exact decoded output, retaining the raw export hash too.
      const expected =
        asset.src.startsWith("data:") && !asset.src.includes(";base64,")
          ? Buffer.from(
              local
                .toString()
                .trim()
                .replaceAll(/>\s+</g, "><")
                .replaceAll('"', "'")
                .replaceAll(/\s+/g, " "),
            )
          : local;
      assert.equal(sha(expected), sha(actual), asset.file);
      assert(local.length > 0);
      assert.equal(asset.width, asset.naturalWidth, asset.file);
      assert.equal(asset.height, asset.naturalHeight, asset.file);
      asset.sha256 = sha(local);
      asset.renderedSvgSha256 = sha(actual);
      delete asset.src;
    }
    await page.addScriptTag({ content: axe });
    const accessibility = await page.evaluate(async () => {
      const report = await globalThis.axe.run(globalThis.document, {
        resultTypes: ["violations", "incomplete"],
      });
      const summarize = (rows) =>
        rows.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
        }));
      return { violations: summarize(report.violations), incomplete: summarize(report.incomplete) };
    });
    assert.deepEqual(accessibility.violations, [], JSON.stringify(accessibility.violations));
    const contrastReviews = await reviewNotesMenuContrast(page, accessibility.incomplete);
    return {
      mode,
      geometry,
      fonts,
      assets,
      accessibility,
      contrastReviews,
      network: "Only the owned loopback preview; no Tack request",
      draftWritesRequireSave: true,
    };
  },
}));
const report = await captureSuite(
  root,
  { milestone: "M8", prefix: process.argv[2] ?? "v41-notes", suite: "all", repeatCheck: true },
  cases,
);
globalThis.console.log(
  `Verified ${report.captures.length} Notes captures with exact repeats, original assets/fonts, full default axe rules and no external network.`,
);
