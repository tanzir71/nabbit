// Synthetic Figma/reference fixtures. Native HWNDs and real persistence are
// checked separately; this suite exercises the production React entry.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { createHash } from "node:crypto";
import { captureSuite } from "./screenshots/harness.mjs";
import { fixtureData } from "./screenshots/fixtures.mjs";
import { notesFixture } from "./screenshots/notes-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const assetPins = JSON.parse(
  await readFile(new URL("../progress/v2/M9/v47-assets.json", import.meta.url), "utf8"),
).assets;
for (const asset of assetPins) {
  const bytes = await readFile(new URL(`../${asset.file}`, import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
}
const modes = [
  "green",
  "blue",
  "default",
  "purple",
  "pink",
  "gray",
  "narrow",
  "wide-menu",
  "readonly",
  "gone",
  "workspace",
  "offline",
  "recovered",
  "decision",
];
const cases = modes.map((mode) => ({
  name: `sticky-${mode}`,
  suite: "sticky",
  entry: "sticky.html",
  surface: "sticky",
  label: "sticky-fixture",
  caret: "initial",
  font: mode === "decision" ? ".sticky-decision p" : ".sticky-heading",
  figmaNode: "14:531",
  viewport: {
    width: mode === "narrow" ? 220 : mode === "wide-menu" ? 480 : 280,
    height: [
      "gone",
      "workspace",
      "offline",
      "readonly",
      "wide-menu",
      "recovered",
      "decision",
    ].includes(mode)
      ? 340
      : mode === "blue" || mode === "default"
        ? 158
        : 200,
  },
  fixture(theme) {
    const data = fixtureData("sticky");
    data.settings.theme = theme;
    const scope = { key: "fixture", epoch: 1 };
    const note = notesFixture()[mode === "blue" ? 1 : 0];
    note.scope = scope;
    note.localOnly = false;
    note.editToken = "fixture-token";
    if (mode === "default")
      Object.assign(note.value, {
        kind: "note",
        items: [],
        title: "Standup notes",
        body: "Ship island spike today. Ask Tack agent to draft release notes once DPI checks pass.",
        ref: "tck-33",
      });
    if (mode === "blue")
      note.value.body =
        "Scroll on the pill to change volume; middle-click toggles play. Long-press opens the shelf.";
    note.value.color = ["green", "blue", "default", "purple", "pink", "gray"].includes(mode)
      ? mode
      : "green";
    const snapshot = {
      binding: { instance: "fixture-window", cardId: note.value.id, scope },
      profile: {
        monitor: "fixture-monitor",
        x: 32,
        y: 64,
        width: 280,
        height: 200,
        pinned: true,
        opacity: 100,
      },
      monitors: [{ id: "fixture-monitor", name: "Fixture display", primary: true, scaleFactor: 1 }],
      content: {
        status: mode === "gone" ? "gone" : mode === "workspace" ? "scopeChanged" : "ready",
        note,
        checkpoint: null,
        currentScope: mode === "workspace" ? null : scope,
        readOnly: mode === "readonly",
      },
      theme,
      nativeOpacity: false,
    };
    const sync = {
      scope,
      state: mode === "offline" ? "offline" : "upToDate",
      pending: mode === "offline" ? 2 : 0,
      conflicts: 0,
      referenceIssues: 0,
      lastSynced: "2026-11-26T09:00:00Z",
      error: null,
      nextAttemptMs: null,
    };
    if (["recovered", "decision"].includes(mode)) {
      const base = globalThis.structuredClone(note);
      base.value.body = "Before the competing edit";
      snapshot.content.checkpoint = {
        instance: "previous-window",
        sequence: 9,
        draft: {
          base,
          value: { ...base.value, body: "My recovered draft" },
          copyId: "fixture-copy-id",
        },
      };
      note.value.body = "A competing server edit";
    }
    return {
      data,
      responses: {
        sticky_snapshot: snapshot,
        sticky_ready: null,
        sticky_configure: snapshot.profile,
        sticky_drag: null,
        sticky_checkpoint: null,
        sticky_clear_checkpoint: null,
        sticky_close: null,
        tack_sync_snapshot: sync,
      },
    };
  },
  async ready(page) {
    await page.getByLabel("Note title", { exact: true }).waitFor();
    await page.waitForFunction(() =>
      globalThis.__NABBIT_CAPTURE__.snapshot().calls.some((c) => c.command === "sticky_ready"),
    );
    if (mode === "wide-menu")
      await page.getByRole("button", { name: "Sticky note options", exact: true }).click();
    const title = page.getByLabel("Note title", { exact: true });
    if (["readonly", "gone", "workspace", "recovered", "decision"].includes(mode))
      assert(await title.isDisabled());
    else assert(await title.isEnabled());
    if (mode === "gone") await page.getByText("This card was removed.", { exact: false }).waitFor();
    if (mode === "workspace")
      await page.getByText("Workspace changed.", { exact: false }).waitFor();
    if (mode === "decision") {
      await page.getByRole("button", { name: "Close sticky note", exact: true }).click();
      const dialog = page.getByRole("alertdialog", { name: "Keep your sticky draft" });
      await dialog.waitFor();
      await page.keyboard.press("Shift+Tab");
      assert(
        await dialog
          .getByRole("button", { name: "Discard draft and close" })
          .evaluate((e) => e === globalThis.document.activeElement),
      );
      await page.keyboard.press("Tab");
      assert(
        await dialog
          .getByRole("button", { name: "Keep editing" })
          .evaluate((e) => e === globalThis.document.activeElement),
      );
    } else await page.getByRole("button", { name: "Close sticky note", exact: true }).focus();
    await page.mouse.move(0, 0);
    await page.addScriptTag({ content: axe });
    const accessibility = await page.evaluate(async () => {
      const report = await globalThis.axe.run();
      return {
        violations: report.violations.map((r) => ({
          id: r.id,
          impact: r.impact,
          nodes: r.nodes.map((n) => n.target),
        })),
        incomplete: report.incomplete.map((r) => ({
          id: r.id,
          nodes: r.nodes.map((n) => n.target),
        })),
      };
    });
    assert.deepEqual(accessibility, { violations: [], incomplete: [] });
    const geometry = await page.evaluate(() => {
      const css = (e) => globalThis.getComputedStyle(e),
        rect = (e) => {
          const r = e.getBoundingClientRect();
          return { width: r.width, height: r.height, x: r.x, y: r.y };
        };
      const heading = globalThis.document.querySelector(".sticky-heading"),
        bar = globalThis.document.querySelector(".sticky-titlebar");
      return {
        paper: rect(globalThis.document.querySelector(".sticky-surface")),
        toolbar: rect(bar),
        title: {
          ...rect(heading),
          font: css(heading).fontSize,
          line: css(heading).lineHeight,
          weight: css(heading).fontWeight,
          align: css(heading).textAlign,
        },
        assets: [...globalThis.document.querySelectorAll(".n-asset img")].map((e) => ({
          file: e.getAttribute("data-asset"),
          width: e.width,
          height: e.height,
          naturalWidth: e.naturalWidth,
          naturalHeight: e.naturalHeight,
          slot: rect(e.parentElement),
        })),
        overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
      };
    });
    assert.equal(geometry.toolbar.height, 34);
    assert.equal(geometry.title.font, "14px");
    assert.equal(geometry.title.line, "20px");
    assert.equal(geometry.title.weight, "600");
    assert.equal(geometry.title.width, geometry.paper.width - 34);
    assert.equal(geometry.overflow, false);
    for (const asset of geometry.assets) {
      const pin = assetPins.find((p) => p.file === `src/assets/${asset.file}`);
      assert(pin, `Unpinned visible sticky asset: ${asset.file}`);
      assert.equal(asset.width, pin.width);
      assert(asset.naturalWidth > 0);
      assert.equal(asset.width, asset.height);
      assert.equal(asset.slot.width, asset.width);
      assert.equal(asset.slot.height, asset.height);
      assert([12, 13, 14, 16].includes(asset.width));
    }
    const ipc = await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot());
    const expectedReads = mode === "decision" ? 2 : 1;
    assert.equal(ipc.calls.filter((c) => c.command === "sticky_snapshot").length, expectedReads);
    assert.equal(ipc.calls.filter((c) => c.command === "tack_sync_snapshot").length, expectedReads);
    assert(
      !ipc.calls.some((c) =>
        ["sticky_save", "capture_note", "sticky_save_as_new"].includes(c.command),
      ),
    );
    return {
      accessibility,
      geometry,
      readyHeight: ipc.calls.find((c) => c.command === "sticky_ready").args.height,
      fixtureOnly: true,
    };
  },
}));
const report = await captureSuite(
  root,
  { milestone: "M9", prefix: process.argv[2] ?? "v47-sticky", suite: "all", repeatCheck: true },
  cases,
);
globalThis.console.log(`Verified ${report.captures.length} sticky captures.`);
