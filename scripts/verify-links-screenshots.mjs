import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { fixtureData } from "./screenshots/fixtures.mjs";
import { notesFixture } from "./screenshots/notes-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const pins = JSON.parse(
  await readFile(new URL("../progress/v2/M9/v49-assets.json", import.meta.url), "utf8"),
).assets;
for (const p of pins) {
  const b = await readFile(new URL(`../${p.file}`, import.meta.url));
  assert.equal(createHash("sha256").update(b).digest("hex"), p.sha256);
  assert.equal(b.length, p.bytes);
}
const modes = [
  "links",
  "selected",
  "empty",
  "import",
  "import-error",
  "import-readonly",
  "import-result",
  "clipboard",
  "video",
  "island",
];
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
  syncState: "localOnly",
};
const cases = modes
  .filter((mode) => !process.argv[3] || mode === process.argv[3])
  .map((mode) => {
    const island = mode === "island",
      importing = mode.startsWith("import"),
      clipboard = ["clipboard", "video"].includes(mode);
    return {
      name: `links-${mode}`,
      suite: "links",
      entry: island ? "island.html" : "index.html",
      surface: island ? "island" : "tray",
      label: island ? "island" : "main",
      notesSync: island,
      caret: "initial",
      figmaNode: importing ? "45:362" : clipboard ? "45:568" : "45:452",
      viewport: { width: island ? 720 : 460, height: island ? 460 : 680 },
      transparent: island,
      selector: island ? ".island-morph" : ".tray-popover",
      font: importing
        ? ".bookmark-import header h2"
        : clipboard
          ? ".clipboard-link-buttons button"
          : ".links-search input",
      fixture() {
        const data = fixtureData("tray-downloads");
        data.settings.lastTab = clipboard ? "clipboard" : "notes";
        const titles = [
          "Atoll — macOS notch companion",
          "Fraunces variable font",
          "Windows context menu docs",
          "Tiny tray app in 20 minutes",
        ];
        const urls = [
          "https://github.com/atoll-app/atoll",
          "https://fonts.google.com/specimen/Fraunces",
          "https://learn.microsoft.com/windows",
          "https://www.youtube.com/watch?v=fixture",
        ];
        data.notes =
          mode === "empty"
            ? []
            : titles.map((title, i) => ({
                ...notesFixture()[3],
                editToken: `fixture-${i}`,
                value: {
                  ...notesFixture()[3].value,
                  id: `link-${i}`,
                  title,
                  url: urls[i],
                  priority: "later",
                  labels: i === 1 ? ["design", "fonts"] : ["design"],
                  pinned: false,
                  createdAt: "2026-11-26T08:00:00.000Z",
                },
              }));
        if (clipboard) {
          data.clipboard = [
            {
              ...data.clipboard[1],
              content: mode === "video" ? urls[3] : urls[0],
              preview: urls[0],
              pinned: false,
            },
          ];
        }
        const sources = ["Chrome", "Edge", "Firefox", "Brave"].map((browser, i) => ({
          id: browser,
          name: `${browser} — ${i === 1 ? "Work" : "Personal"}`,
          browser,
          files: [`C:\\Fixture\\${browser}\\Bookmarks`],
          links: [1248, 84, 116, 32][i],
          folders: 12,
          skipped: 0,
          error: null,
        }));
        return {
          data,
          responses: {
            take_notes_intent: {
              navigation: clipboard
                ? null
                : { id: "fixture-nav", intent: { kind: importing ? "import" : "links" } },
              shortcutError: null,
            },
            get_notes_state: {
              cards: data.notes,
              scope: null,
              readOnly: mode === "import-readonly",
            },
            bookmarks_discover: {
              sessionId: "fixture-session",
              sources,
              readFiles: sources.flatMap((s) => s.files),
            },
            bookmarks_preview: {
              planId: "fixture-plan",
              eligible: 1364,
              duplicates: 112,
              skipped: 0,
              total: 1476,
              files: sources.flatMap((s) => s.files),
              scope: null,
            },
            bookmarks_commit: {
              id: "fixture-plan",
              imported: 1364,
              duplicates: 112,
              skipped: 0,
              undoAvailable: true,
              firstCardId: "fixture-first",
            },
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
          },
          failures:
            mode === "import-error"
              ? {
                  bookmarks_discover:
                    "The bookmark file is unavailable. Rescan sources to try again.",
                }
              : undefined,
        };
      },
      async ready(page) {
        if (island) {
          await page.getByRole("textbox", { name: "Note title", exact: true }).waitFor();
          await page.getByRole("button", { name: /^Links \d+$/ }).click();
        }
        if (importing) {
          await page.getByRole("dialog", { name: "Import bookmarks", exact: true }).waitFor();
          if (mode === "import-error") await page.getByRole("alert").waitFor();
          else {
            const button = page.getByRole("button", {
              name: mode === "import-readonly" ? "Import 0 links" : "Import 1,364 links",
              exact: true,
            });
            await button.waitFor();
            if (mode === "import-result") {
              await button.click();
              await page.getByRole("heading", { name: "Imported 1,364 links" }).waitFor();
            }
          }
          await page.getByRole("button", { name: "Close bookmark import", exact: true }).focus();
        } else if (clipboard) {
          await page.getByRole("region", { name: "Copied link actions" }).waitFor();
          await page.getByRole("button", { name: "Save link", exact: true }).focus();
        } else {
          await page.getByRole("region", { name: "Saved links" }).waitFor();
          if (mode === "selected") {
            await page.getByRole("checkbox", { name: /Select Atoll/ }).check();
            await page.getByRole("checkbox", { name: /Select Fraunces/ }).check();
          }
          await page.getByRole("button", { name: "Import bookmarks", exact: true }).focus();
        }
        await page.mouse.move(0, 0);
        await page.addScriptTag({ content: axe });
        const accessibility = await page.evaluate(async () => {
          const r = await globalThis.axe.run();
          return {
            violations: r.violations.map((v) => ({
              id: v.id,
              nodes: v.nodes.map((n) => ({ target: n.target, detail: n.failureSummary })),
            })),
            incomplete: r.incomplete.map((v) => ({
              id: v.id,
              nodes: v.nodes.map((n) => ({ target: n.target, detail: n.failureSummary })),
            })),
          };
        });
        assert.deepEqual(accessibility, { violations: [], incomplete: [] });
        const geometry = await page.evaluate(() => ({
          overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
          assets: [
            ...globalThis.document.querySelectorAll(
              ".links-panel img[data-asset],.bookmark-import img[data-asset],.clipboard-link-context img[data-asset]",
            ),
          ].map((e) => ({
            file: e.dataset.asset,
            width: e.getBoundingClientRect().width,
            height: e.getBoundingClientRect().height,
            loaded: e.complete && e.naturalWidth > 0,
          })),
          sheet:
            globalThis.document.querySelector(".bookmark-import")?.getBoundingClientRect().width ??
            null,
        }));
        assert.equal(geometry.overflow, false);
        if (importing) assert.equal(geometry.sheet, 440);
        for (const a of geometry.assets) {
          const pin = pins.find((p) => p.file === `src/assets/${a.file}`);
          if (pin) {
            assert.equal(a.width, pin.width);
            assert.equal(a.height, pin.height);
          }
          assert(a.loaded);
        }
        return { accessibility, geometry, fixtureOnly: true };
      },
    };
  });
const report = await captureSuite(
  root,
  { milestone: "M9", prefix: process.argv[2] ?? "v49-links", suite: "all", repeatCheck: true },
  cases,
);
globalThis.console.log(`Verified ${report.captures.length} link/import captures.`);
