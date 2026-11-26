import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { captureSuite } from "./screenshots/harness.mjs";
import { auditFont } from "./font-audit.mjs";
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
const pins = Array.from({ length: 9 }, (_, i) => ({
  id: `pin-${i + 1}`,
  kind: i === 0 ? "folder" : "file",
  path: `C:\\Fixture\\${i === 0 ? "PDF invoices" : `Invoice-${i + 1}.pdf`}`,
  label: i === 0 ? "PDF invoices" : `Invoice ${i + 1}.pdf`,
  slot: i + 1,
}));
const tab = (page, name) =>
  page
    .getByRole("navigation", { name: "Island modules" })
    .getByRole("button", { name, exact: true });
async function expanded(page) {
  await page.waitForFunction(
    () => globalThis.document.querySelector("main")?.dataset.islandState === "expanded",
  );
  await tab(page, "Nab").waitFor();
}
const openSearch = async (page, text = "pdf") => {
  await tab(page, "Nab").focus();
  await page.keyboard.type(text);
  await page.getByRole("combobox", { name: "Search island" }).waitFor();
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector("[role=listbox]")?.getAttribute("aria-busy") === "false",
  );
};
const cases = [
  [
    "ime-commit",
    async (page) => {
      await tab(page, "Nab").focus();
      await tab(page, "Nab").evaluate((element) =>
        element.dispatchEvent(
          new globalThis.CompositionEvent("compositionend", { data: "日本", bubbles: true }),
        ),
      );
      const input = page.getByRole("combobox", { name: "Search island", exact: true });
      await input.waitFor();
      assert.equal(await input.inputValue(), "日本");
      await input.fill("pdf");
      await page.waitForFunction(
        () => globalThis.document.querySelectorAll("[role=option]").length === 9,
      );
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector("[role=listbox]")?.getAttribute("aria-busy") ===
          "false",
      );
      await input.evaluate((element) =>
        element.dispatchEvent(
          new globalThis.KeyboardEvent("keydown", {
            key: "Enter",
            keyCode: 229,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      assert(
        !(await page.evaluate(() =>
          globalThis.__NABBIT_CAPTURE__
            .snapshot()
            .calls.some((c) => c.command === "island_open_pin"),
        )),
      );
    },
  ],
  [
    "tabs",
    async (page) => {
      for (let i = 1; i <= 6; i++) {
        await page.keyboard.press(`Control+${i}`);
        assert.equal(
          await tab(
            page,
            ["Nab", "Notes", "Clipboard", "Files", "Media", "Timer"][i - 1],
          ).getAttribute("aria-pressed"),
          "true",
        );
      }
      assert.equal(
        await tab(page, "Timer").evaluate((e) => e === globalThis.document.activeElement),
        true,
      );
    },
  ],
  [
    "search",
    async (page) => {
      await openSearch(page);
      assert.equal(await page.getByRole("combobox").inputValue(), "pdf");
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.getByRole("option").nth(1).getAttribute("aria-selected"), "true");
    },
  ],
  [
    "no-matches",
    async (page) => {
      await openSearch(page, "a-query-with-no-match");
      assert.equal(await page.getByRole("option").count(), 0);
      await page.getByRole("status").filter({ hasText: "No matches" }).waitFor();
    },
  ],
  [
    "editing",
    async (page) => {
      await page.keyboard.press("Control+3");
      const input = page.getByRole("textbox", { name: "Search clipboard", exact: true });
      await input.fill("saved draft");
      await page.keyboard.type(" remains");
      assert.equal(await page.getByRole("combobox").count(), 0);
      assert.equal(await input.inputValue(), "saved draft remains");
    },
  ],
  [
    "focus-wrap",
    async (page) => {
      await page.keyboard.press("Control+1");
      await tab(page, "Nab").focus();
      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await page
          .getByRole("button", { name: "Review", exact: true })
          .evaluate((e) => e === globalThis.document.activeElement),
        true,
      );
      await page.keyboard.press("Tab");
      assert.equal(
        await tab(page, "Nab").evaluate((e) => e === globalThis.document.activeElement),
        true,
      );
    },
  ],
  [
    "escape-reopen",
    async (page) => {
      await openSearch(page);
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => globalThis.document.querySelector("main").dataset.islandState === "idle",
      );
      await page.keyboard.press("Alt+Space");
      await expanded(page);
      assert.equal(await page.getByRole("combobox").inputValue(), "pdf");
      assert.equal(
        await page.getByRole("combobox").evaluate((e) => e === globalThis.document.activeElement),
        true,
      );
    },
  ],
].map(([name, run]) => ({
  name: `keyboard-${name}`,
  suite: "surfaces",
  entry: "island.html",
  surface: "island",
  label: "island",
  viewport: { width: 720, height: 460 },
  transparent: true,
  figmaNode:
    name === "search" || name === "no-matches" || name === "escape-reopen" ? "34:777" : "10:519",
  fixture: () => ({
    responses: {
      get_activity_snapshot: snapshot,
      get_island_surface: {
        label: "island",
        generation: 1,
        state: "expanded",
        owner: "webview",
        shape: "island",
        reducedMotion: true,
        width: 112,
        height: 26,
        snapshot,
        keyboard: { id: 1, target: "tab" },
      },
      list_island_pins: pins,
      get_island_drop: null,
    },
  }),
  async ready(page) {
    await expanded(page);
    await run(page);
    await page
      .locator(".island-module-body,.island-search-content,.island-timer-body")
      .first()
      .waitFor();
    await page.evaluate(async () => {
      await globalThis.document.fonts.ready;
      await Promise.all([...globalThis.document.images].map((img) => img.decode()));
      await new Promise(globalThis.requestAnimationFrame);
      await new Promise(globalThis.requestAnimationFrame);
    });
    const assets = await page.locator("img[data-asset-slot]").evaluateAll((images) =>
      images.map((img) => ({
        slot: img.dataset.assetSlot,
        natural: [img.naturalWidth, img.naturalHeight],
        actual: [img.getBoundingClientRect().width, img.getBoundingClientRect().height],
      })),
    );
    assert(assets.every((a) => a.natural[0] > 0 && a.natural.every((v, i) => v === a.actual[i])));
    const labels = await page
      .locator(".island-tabbar button,.island-peek-content .n-icon-button")
      .evaluateAll((buttons) =>
        buttons.map((b) => ({ label: b.getAttribute("aria-label"), tooltip: b.title })),
      );
    assert(labels.every((b) => b.label && b.tooltip));
    assert.equal(await page.locator(".island-notice").count(), 0);
    const geometry = await page.locator(".island-morph").boundingBox();
    assert.equal(geometry.width, 680);
    assert(geometry.height <= 420);
    const fonts = [];
    for (const selector of [
      ".island-search-group",
      '.island-tabbar button[aria-pressed="true"]',
      ".island-empty",
    ]) {
      if (await page.locator(selector).count()) {
        fonts.push(...(await auditFont(page, selector, "Geist")));
        break;
      }
    }
    assert(fonts.length > 0);
    return { geometry, assets, labels, fonts, keyboardOnly: true };
  },
}));
cases.push(
  ...[false, true].map((conflict) => ({
    name: conflict ? "shortcut-conflict" : "shortcut-remap",
    suite: "surfaces",
    entry: "settings.html",
    surface: "settings",
    label: "settings",
    viewport: { width: 460, height: 680 },
    font: ".n-field:has([data-island-shortcut]) label",
    figmaNode: "22:474",
    fixture: () => ({
      failures: conflict
        ? { save_settings: "The island shortcut conflicts with another Nabbit shortcut" }
        : undefined,
    }),
    async ready(page) {
      const input = page.getByRole("textbox", { name: "Island shortcut", exact: true });
      await input.waitFor();
      await input.fill("Ctrl+Alt+F9");
      await input.press("Enter");
      if (conflict)
        await page.waitForFunction(
          () =>
            globalThis.document
              .querySelector("[data-island-shortcut]")
              .getAttribute("aria-invalid") === "true",
        );
      else
        await page.waitForFunction(
          () =>
            globalThis.__NABBIT_CAPTURE__.snapshot().state.settings.islandShortcut ===
            "Ctrl+Alt+F9",
        );
    },
  })),
);
const report = await captureSuite(
  fileURLToPath(new URL("../", import.meta.url)),
  {
    milestone: "M5",
    prefix: process.argv[2] ?? "v26-keyboard",
    suite: "surfaces",
    repeatCheck: true,
  },
  cases,
);
globalThis.console.log(
  `Captured ${report.captures.length} keyboard, search and shortcut control states.`,
);
