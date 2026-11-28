import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { fixtureData } from "./fixtures.mjs";
const catalog = JSON.parse(
  await readFile(new URL("../../src/features/tools/catalog.fixture.json", import.meta.url), "utf8"),
);
const order = [
  "privacy",
  "timerEnding",
  "download",
  "tool",
  "link",
  "result",
  "media",
  "timer",
  "power",
];
export function settingsFixture() {
  const data = fixtureData("settings");
  Object.assign(data.settings, {
    displayMode: "islandAndTray",
    restoreStickyNotes: true,
    islandShortcut: "Alt+Space",
    quickDownloadShortcut: "Ctrl+Alt+D",
    clipboardSearchShortcut: "Ctrl+Alt+V",
    selectedTextShortcut: "Ctrl+Alt+S",
    island: {
      ...data.settings.island,
      peekOnHoverMs: 180,
      fadeOverMaximized: true,
      hideOverFullscreen: true,
      scrollToChangeVolume: true,
    },
    islandActivity: {
      order,
      disabled: [],
      showAlertsOverFullscreen: false,
      focusMode: false,
      hiddenUntilMs: null,
    },
  });
  return {
    data,
    responses: {
      tool_presets: catalog.presets,
      files_pins: [],
      context_preferences: { sendTo: false, contextMenu: false, selectionCopyFallback: false },
    },
  };
}
const titles = [
  "General",
  "Island",
  "Widgets",
  "Downloads",
  "Notes & Tack",
  "Clipboard",
  "Files",
  "Shortcuts",
  "Privacy & about",
  "Live activities",
];
export const settingsScenarios = titles.map((title, index) => ({
  name: `settings-${["general", "island", "widgets", "downloads", "notes", "clipboard", "files", "shortcuts", "privacy", "activities"][index]}`,
  suite: "surfaces",
  entry: "settings.html",
  surface: "settings",
  label: "settings",
  viewport: { width: 980, height: 720 },
  font: "h1",
  retainFailures: true,
  cdpCapture: true,
  fixture: settingsFixture,
  async ready(page) {
    await page.getByRole("heading", { level: 1, name: "General", exact: true }).waitFor();
    if (title === "Live activities") {
      await page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "Island", exact: true })
        .click();
      await page.getByRole("button", { name: "Live activities", exact: true }).click();
    } else if (title !== "General")
      await page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: title, exact: true })
        .click();
    await page.getByRole("heading", { level: 1, name: title, exact: true }).waitFor();
    if (title === "Files") {
      await page
        .getByRole("button", { name: "Save file presets" })
        .and(page.locator(":enabled"))
        .waitFor();
      await page
        .getByRole("switch", { name: "Show Nabbit in Send To", exact: true })
        .and(page.locator(":enabled"))
        .waitFor();
    }
    if (title === "Downloads")
      await page
        .locator(".engine-health-version")
        .filter({ hasText: /^fixture$/ })
        .waitFor();
    if (title === "Notes & Tack")
      await page.getByRole("button", { name: "Import bookmarks", exact: true }).waitFor();
    assert.equal(await page.locator(".settings-sidebar nav button").count(), 9);
    return {
      page: title,
      sidebarWidth: await page
        .locator(".settings-sidebar")
        .evaluate((node) => node.getBoundingClientRect().width),
    };
  },
}));

function variant(index, suffix, { seed, ready, viewport } = {}) {
  const base = settingsScenarios[index];
  return {
    ...base,
    name: `${base.name}-${suffix}`,
    ...(viewport ? { viewport } : {}),
    fixture() {
      const fixture = settingsFixture();
      seed?.(fixture);
      return fixture;
    },
    async ready(page) {
      const initial = await base.ready(page);
      return { ...initial, ...(await ready?.(page)) };
    },
  };
}
export const settingsExtraScenarios = [
  ...[0, 1, 7].map((index) => variant(index, "minimum", { viewport: { width: 820, height: 600 } })),
  variant(7, "migrated", {
    seed: ({ data }) =>
      Object.assign(data.settings, {
        togglePopoverShortcut: "Ctrl+Alt+F8",
        quickDownloadShortcut: "",
        clipboardSearchShortcut: "Ctrl+Alt+F7",
        selectedTextShortcut: "",
      }),
  }),
  variant(1, "disconnected", {
    seed: ({ data }) =>
      Object.assign(data.settings.island, {
        monitorMode: "specific",
        monitorId: "owned-disconnected-display",
      }),
    ready: async (page) => {
      await page
        .getByText("Disconnected. Using the primary display until it returns.", { exact: true })
        .waitFor();
      return { disconnectedPreferenceKept: true };
    },
  }),
  variant(1, "behaviour-off", {
    seed: ({ data }) => {
      Object.assign(data.settings.island, {
        peekOnHoverMs: null,
        fadeOverMaximized: false,
        hideOverFullscreen: false,
        scrollToChangeVolume: false,
      });
      data.settings.islandActivity.showAlertsOverFullscreen = true;
    },
  }),
  variant(9, "custom-priority", {
    seed: ({ data }) => {
      data.settings.islandActivity.disabled = ["media", "power"];
      data.settings.islandActivity.order = [
        "privacy",
        "download",
        "timerEnding",
        ...order.filter((kind) => !["privacy", "download", "timerEnding"].includes(kind)),
      ];
    },
  }),
  variant(3, "save-failed", {
    seed: (fixture) => {
      fixture.failures = { patch_settings: "Owned settings database unavailable" };
    },
    ready: async (page) => {
      const field = page.getByRole("textbox", { name: "Output folder", exact: true });
      await field.fill("D:\\Owned fixtures\\Retry downloads");
      await field.press("Tab");
      await page
        .getByRole("alert")
        .filter({ hasText: "Owned settings database unavailable" })
        .waitFor();
      assert.equal(await field.inputValue(), "D:\\Owned fixtures\\Retry downloads");
      await page.getByRole("heading", { level: 1, name: "Downloads", exact: true }).focus();
      return { failedEditRetained: true };
    },
  }),
  variant(5, "clear-confirmation", {
    ready: async (page) => {
      await page.getByRole("button", { name: "Clear clipboard history", exact: true }).click();
      await page.getByRole("group", { name: "Confirm clearing clipboard history" }).waitFor();
      return {
        clearCalls: await page.evaluate(
          () =>
            globalThis.__NABBIT_CAPTURE__
              .snapshot()
              .calls.filter(({ command }) => command === "clear_clipboard_history").length,
        ),
      };
    },
  }),
  ...[6, 7].map((index) =>
    variant(index, index === 6 ? "integrations" : "bottom", {
      ready: async (page) => {
        if (index === 6) {
          await page
            .getByRole("button", { name: "Save integration options", exact: true })
            .evaluate((node) => node.scrollIntoView({ block: "end" }));
          return { integrationFooterVisible: true };
        }
        await page
          .locator(".settings-content")
          .evaluate((node) => node.scrollTo(0, node.scrollHeight));
        return { scrolledToBottom: true };
      },
    }),
  ),
  variant(8, "statement", {
    ready: async (page) => {
      await page.getByText("Privacy statement", { exact: true }).click();
      return { statementExpanded: true };
    },
  }),
  variant(6, "pin-editor", {
    ready: async (page) => {
      await page.getByRole("button", { name: "Add pin…", exact: true }).click();
      await page.getByRole("form", { name: "Add pin", exact: true }).waitFor();
      return { pinEditorOpened: true, noFileDialog: true };
    },
  }),
  variant(0, "keyboard-focus", {
    ready: async (page) => {
      const button = page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "General", exact: true });
      await button.focus();
      await page.keyboard.press("Tab");
      assert.equal(
        await page
          .getByRole("button", { name: "Island", exact: true })
          .evaluate((node) => node === globalThis.document.activeElement),
        true,
      );
      return { sidebarKeyboardFocus: true };
    },
  }),
];
