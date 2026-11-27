import assert from "node:assert/strict";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { captureSuite } from "./screenshots/harness.mjs";
import { fixtureData } from "./screenshots/fixtures.mjs";
import { notesFixture } from "./screenshots/notes-fixtures.mjs";
import { auditFont } from "./font-audit.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const scope = { key: "fixture", epoch: 1 };
const snapshot = {
  revision: 1,
  views: [
    {
      label: "island",
      gate: "visible",
      primary: null,
      bubble: null,
      queue: [],
      fullscreen: false,
      userHidden: false,
      focusMode: false,
    },
  ],
  preferences: {
    order: [],
    disabled: [],
    showAlertsOverFullscreen: false,
    focusMode: false,
    hiddenUntilMs: null,
  },
  syncState: "upToDate",
};
const modes = [
  "island-parsed",
  "island-empty",
  "island-readonly",
  "island-references",
  "island-error",
  "tray-parsed",
  "tray-editor",
  "tray-checklist",
  "tray-narrow",
];
const cases = modes.map((mode) => {
  const island = mode.startsWith("island-");
  return {
    name: mode,
    suite: "notes",
    entry: island ? "island.html" : "index.html",
    surface: island ? "island" : "tray",
    label: island ? "island" : "main",
    notesSync: island,
    noteCapture: island,
    caret: "initial",
    figmaNode: island ? "9:200" : "19:182",
    viewport: {
      width: island ? 720 : mode === "tray-narrow" ? 360 : 460,
      height: island ? 460 : 680,
    },
    transparent: island,
    selector: island
      ? ".island-morph"
      : mode === "tray-editor" || mode === "tray-checklist"
        ? ".note-dialog"
        : ".tray-popover",
    font:
      mode === "island-empty" || mode === "island-readonly"
        ? mode === "island-readonly"
          ? ".island-notes-sync strong"
          : ".island-notes-empty"
        : mode === "tray-editor" || mode === "tray-checklist"
          ? ".note-editor-properties .note-property > span"
          : ".quick-capture-preview > span:first-child",
    fixture() {
      const data = fixtureData("tray-downloads");
      data.settings.lastTab = "notes";
      const notes = notesFixture().slice(0, 3);
      notes[2].value = {
        ...notes[2].value,
        title: "Groceries",
        kind: "checklist",
        body: "",
        color: "default",
        labels: ["Home"],
        items: [
          { id: "milk", text: "Oat milk", checked: false },
          { id: "coffee", text: "Coffee beans", checked: false },
        ],
      };
      data.notes = mode === "island-empty" ? [] : notes;
      return {
        data,
        responses: {
          get_activity_snapshot: snapshot,
          get_island_surface: {
            label: "island",
            generation: 1,
            state: "expanded",
            owner: "webview",
            shape: "island",
            reducedMotion: true,
            width: 680,
            height: 336,
            snapshot,
            keyboard: { id: 1, target: "notes" },
          },
          get_island_drop: null,
          list_island_pins: [],
          get_notes_state: { cards: data.notes, scope: null, readOnly: mode === "island-readonly" },
          tack_sync_snapshot: {
            state: "upToDate",
            scope,
            pending: 0,
            conflicts: 0,
            referenceIssues: 0,
            lastSynced: "2026-11-26T09:00:00.000Z",
            error: null,
            nextAttemptMs: null,
          },
        },
        failures:
          mode === "island-error" ? { capture_note: "Fixture database unavailable" } : undefined,
      };
    },
    async ready(page) {
      const input = page.getByRole("textbox", { name: "Note title", exact: true });
      if (mode === "island-readonly") {
        await input.waitFor();
        await page.getByText("Read-only workspace. Your capture is preserved.").waitFor();
        return audit(page, mode);
      }
      await input.waitFor();
      await page.waitForFunction(
        () => !globalThis.document.querySelector("[data-note-capture]").disabled,
      );
      if (island)
        assert.equal(
          await input.evaluate((el) => el === globalThis.document.activeElement),
          true,
          "Native Notes target focuses capture after lazy mount",
        );
      if (mode !== "island-empty") await input.fill("Ship beta build tomorrow 9am #nabbit !now");
      if (mode === "island-references") {
        await input.fill("@alice +nabbit Ship tomorrow 9am #nabbit !now");
      }
      if (mode === "island-error") {
        await input.press("Enter");
        await page.getByRole("alert").waitFor();
        assert.equal(await input.inputValue(), "Ship beta build tomorrow 9am #nabbit !now");
      }
      if (mode === "tray-editor" || mode === "tray-checklist") {
        await input.press(mode === "tray-checklist" ? "Shift+Enter" : "Tab");
        await page.getByRole("dialog", { name: "Note editor", exact: true }).waitFor();
        const field = mode === "tray-checklist" ? "Checklist item 1" : "Note title";
        await page.waitForFunction(
          (name) => globalThis.document.activeElement?.getAttribute("aria-label") === name,
          field,
        );
        await page.getByRole("button", { name: "Close editor", exact: true }).focus();
        const calls = await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot().calls);
        assert(
          !calls.some((c) =>
            ["capture_note", "create_note_card", "get_note_editor"].includes(c.command),
          ),
          "Opening a new editor performs no write or persisted-card read",
        );
      } else {
        await input.blur();
      }
      return audit(page, mode);
    },
  };
});
cases.push({
  name: "compact-saved",
  suite: "notes",
  entry: "island.html",
  surface: "island",
  label: "island",
  viewport: { width: 720, height: 460 },
  transparent: true,
  selector: ".island-morph",
  font: ".island-compact > span",
  figmaNode: "7:96",
  caret: "initial",
  fixture() {
    const value = globalThis.structuredClone(snapshot);
    value.views[0].primary = {
      id: "note:fixture",
      category: "result",
      event: { kind: "noteSaved", cardId: "fixture", destination: "this PC · Inbox" },
      alert: false,
      bubbleOnly: false,
    };
    return {
      data: fixtureData("island-idle"),
      responses: {
        get_activity_snapshot: value,
        get_island_surface: {
          label: "island",
          generation: 1,
          state: "live",
          owner: "native",
          shape: "island",
          reducedMotion: true,
          width: 272,
          height: 32,
          snapshot: value,
        },
      },
    };
  },
  async ready(page) {
    await page.getByText("Saved on this PC · Inbox", { exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        globalThis.document
          .querySelector(".island-host")
          ?.getAttribute("data-island-visibility") === "visible",
    );
    const rect = await page.locator(".island-morph").boundingBox();
    assert.equal(rect.width, 272);
    assert.equal(rect.height, 32);
    return audit(page, "compact-saved");
  },
});
async function audit(page, mode) {
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready;
    await Promise.all(
      globalThis.document.getAnimations().map((animation) => animation.finished.catch(() => {})),
    );
  });
  const typography = mode.startsWith("island-")
    ? await page.evaluate(() => {
        const selectors = [
          ".quick-capture-field input",
          ".island-recent-note .n-note-title",
          ".island-recent-note .n-note-open",
          ".island-recent-note .n-check-row",
          ".island-recent-note .n-note-body",
          ".island-recent-note .n-note-label",
        ];
        return selectors.flatMap((selector) => {
          const el = globalThis.document.querySelector(selector);
          if (!el) return [];
          const s = globalThis.getComputedStyle(el);
          return [
            {
              selector,
              size: s.fontSize,
              weight: s.fontWeight,
              lineHeight: s.lineHeight,
              justifyContent: s.justifyContent,
              leadingOffset:
                selector.endsWith(".n-note-open") && el.firstElementChild
                  ? el.firstElementChild.getBoundingClientRect().left -
                    el.getBoundingClientRect().left
                  : null,
            },
          ];
        });
      })
    : [];
  for (const t of typography) {
    if (t.selector.endsWith("input")) {
      assert.equal(t.size, "13px");
      assert.equal(t.weight, "400");
    }
    if (t.selector.endsWith(".n-note-title")) {
      assert.equal(t.size, "13px");
      assert.equal(t.weight, "500");
    }
    if (t.selector.endsWith(".n-note-open")) assert.equal(t.leadingOffset, 0);
    if (t.selector.endsWith(".n-check-row") || t.selector.endsWith(".n-note-body")) {
      assert.equal(t.size, "12px");
      assert.equal(t.weight, "400");
    }
    if (t.selector.endsWith(".n-note-label")) {
      assert.equal(t.size, "11px");
      assert.equal(t.weight, "400");
    }
  }
  await page.addScriptTag({ content: axe });
  const accessibility = await page.evaluate(async () => {
    const r = await globalThis.axe.run(globalThis.document, {
      resultTypes: ["violations", "incomplete"],
    });
    return {
      violations: r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
      incomplete: r.incomplete.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          checks: [...n.any, ...n.all, ...n.none].map((check) => ({
            id: check.id,
            message: check.message,
            data: check.data,
          })),
        })),
      })),
    };
  });
  assert.deepEqual(accessibility.violations, [], JSON.stringify(accessibility));
  assert.deepEqual(accessibility.incomplete, [], JSON.stringify(accessibility));
  const assets = await page.locator("img[data-asset-slot]").evaluateAll((images) =>
    images
      .filter((img) => img.getBoundingClientRect().width > 0)
      .map((img) => ({
        slot: img.dataset.assetSlot,
        width: img.getBoundingClientRect().width,
        height: img.getBoundingClientRect().height,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      })),
  );
  for (const a of assets) {
    assert(a.naturalWidth > 0 && a.naturalHeight > 0);
    assert.equal(a.width, a.naturalWidth, a.slot);
    assert.equal(a.height, a.naturalHeight, a.slot);
  }
  const mono =
    mode.includes("parsed") || mode === "tray-narrow"
      ? await auditFont(page, ".quick-capture-preview .capture-mono", "Geist Mono")
      : null;
  return {
    mode,
    accessibility,
    assets,
    mono,
    typography,
    automaticDownload: false,
    hotkeyFixture: mode.startsWith("island-"),
  };
}
const report = await captureSuite(
  root,
  { milestone: "M9", prefix: process.argv[2] ?? "v46-capture", suite: "all", repeatCheck: true },
  cases,
);
globalThis.console.log(
  `Verified ${report.captures.length} capture screenshots with exact repeats, original asset geometry, bundled fonts and default axe.`,
);
