import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { filesFixture } from "./screenshots/files-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const registry = JSON.parse(
  await readFile(new URL("../src/features/tools/catalog.fixture.json", import.meta.url), "utf8"),
);
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const slots = JSON.parse(
  await readFile(new URL("../src/assets/island/slots.json", import.meta.url), "utf8"),
);
const modes = [
  "files-top",
  "files-pins",
  "pin-peek",
  "pin-actions",
  "pin-edit",
  "pin-search",
  "pin-missing",
  "move-to",
  "move-confirm",
  "drop-pin",
  "drop-copy",
  "drop-tools",
  "moved-compact",
  "moved-peek",
  "download-done",
].filter((mode) => !process.argv[3] || mode === process.argv[3]);
const report = await captureSuite(
  root,
  { milestone: "M10", prefix: process.argv[2] ?? "v58-files", suite: "all", repeatCheck: true },
  modes.map((mode) => ({
    name: `files-${mode}`,
    suite: "files",
    entry: "island.html",
    surface: "island",
    label: "island",
    shelf: true,
    files: true,
    pageClip: true,
    cdpCapture: true,
    caret: "initial",
    naturalMotion: true,
    retainFailures: true,
    figmaNode: mode.startsWith("drop")
      ? "43:692"
      : mode.startsWith("moved")
        ? "33:518"
        : mode === "pin-peek"
          ? "43:755"
          : mode === "download-done"
            ? "33:580"
            : mode.startsWith("move")
              ? "34:897"
              : "10:249",
    viewport: { width: 720, height: 520 },
    transparent: true,
    selector: mode === "pin-peek" ? ".files-pin-peek" : ".island-morph",
    font:
      mode === "pin-peek"
        ? ".files-pin-peek strong"
        : mode === "moved-compact"
          ? ".island-compact strong"
          : mode === "moved-peek" || mode === "download-done"
            ? ".island-peek-content strong"
            : mode.startsWith("drop")
              ? ".island-drop-content strong"
              : mode.startsWith("move")
                ? ".files-move-sheet h2"
                : mode === "pin-edit"
                  ? ".files-pin-editor h2"
                  : ".files-heading > span",
    fixture: () => {
      const fixture = filesFixture(mode);
      if (mode.startsWith("drop")) fixture.responses.tool_catalog = registry.tools;
      return fixture;
    },
    async ready(page) {
      if (!mode.startsWith("moved") && mode !== "download-done") {
        await page.locator('[data-island-tab="files"]').click();
        await page.getByRole("region", { name: "Pins", exact: true }).waitFor();
        await page.getByRole("button", { name: /^Invoices / }).waitFor();
        if (mode === "files-pins" || mode === "pin-missing")
          await page.locator(".files-pins .files-pin-grid li").last().scrollIntoViewIfNeeded();
        if (mode === "pin-peek") await page.getByRole("button", { name: /^Invoices / }).click();
        if (mode === "pin-actions" || mode === "pin-edit") {
          await page.getByRole("button", { name: "Actions for Invoices", exact: true }).click();
          if (mode === "pin-edit") {
            await page.getByRole("button", { name: "Edit", exact: true }).click();
            await page
              .getByRole("button", { name: "Save pin", exact: true })
              .scrollIntoViewIfNeeded();
          } else
            await page
              .getByRole("region", { name: "Invoices actions", exact: true })
              .scrollIntoViewIfNeeded();
        }
        if (mode === "pin-search") {
          await page.getByRole("searchbox", { name: "Find a pin" }).fill("Archive reports");
          await page.getByRole("button", { name: /^Archive reports / }).waitFor();
        }
        if (mode.startsWith("move")) {
          await page.getByRole("button", { name: /Select hero-mock/ }).click();
          await page.getByRole("button", { name: "Move to…", exact: true }).click();
          if (mode === "move-confirm")
            await page
              .getByRole("region", { name: "Move to folder" })
              .getByRole("button", { name: "Invoices", exact: true })
              .click();
          await page.getByRole("region", { name: "Move to folder" }).scrollIntoViewIfNeeded();
          if (mode === "move-confirm")
            await page
              .getByRole("button", { name: "Confirm copy", exact: true })
              .scrollIntoViewIfNeeded();
        }
        if (mode.startsWith("drop")) {
          await page.evaluate(
            (ctrl) =>
              globalThis.__NABBIT_CAPTURE__.emit("nabbit://native-drop", {
                kind: "enter",
                payload: { files: ["C:\\Fixture\\hero-mock@2x.png"] },
                x: 0,
                y: 0,
                shift: false,
                ctrl,
              }),
            mode === "drop-copy",
          );
          await page.getByRole("region", { name: "Drop on a pin" }).waitFor();
          const target = await page
            .locator('.island-drop-content [data-drop-zone="pin:pin-2"]')
            .boundingBox();
          await page.evaluate(
            ({ target, ctrl }) =>
              globalThis.__NABBIT_CAPTURE__.emit("nabbit://native-drop", {
                kind: "over",
                payload: { files: ["C:\\Fixture\\hero-mock@2x.png"] },
                x: (target.x + target.width / 2) * globalThis.devicePixelRatio,
                y: (target.y + target.height / 2) * globalThis.devicePixelRatio,
                shift: false,
                ctrl,
              }),
            { target, ctrl: mode === "drop-copy" },
          );
          await page.locator('.island-drop-content [data-drop-zone="pin:pin-2"].is-over').waitFor();
          if (mode === "drop-tools") {
            const summary = await page.locator(".files-drop-tools summary").boundingBox();
            await page.evaluate(
              (target) =>
                globalThis.__NABBIT_CAPTURE__.emit("nabbit://native-drop", {
                  kind: "over",
                  payload: { files: ["C:\\Fixture\\hero-mock@2x.png"] },
                  x: (target.x + target.width / 2) * globalThis.devicePixelRatio,
                  y: (target.y + target.height / 2) * globalThis.devicePixelRatio,
                  shift: false,
                  ctrl: false,
                }),
              summary,
            );
            await page.locator(".files-drop-tools[open]").waitFor();
            const expected = registry.tools.filter((tool) =>
              tool.accepts.filetypes.includes("png"),
            );
            assert.equal(await page.locator('[data-drop-zone^="tool:"]').count(), expected.length);
          }
        }
      }
      if (mode === "pin-peek") await page.getByRole("button", { name: /invoice-118/ }).waitFor();
      if (mode === "download-done")
        await page.getByRole("button", { name: "Move to Courses", exact: true }).waitFor();
      await page.mouse.move(
        mode.includes("peek") || mode === "moved-compact" || mode === "download-done" ? 0 : 350,
        mode.includes("peek") || mode === "moved-compact" || mode === "download-done" ? 0 : 22,
      );
      await page.evaluate(async () => {
        globalThis.document.activeElement?.blur();
        await globalThis.document.fonts.ready;
        await Promise.all([...globalThis.document.images].map((image) => image.decode()));
      });
      await page.addScriptTag({ content: axe });
      await page.waitForTimeout(1200);
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.document
              .getAnimations()
              .filter((animation) => ["running", "pending"].includes(animation.playState)).length,
        ),
        0,
      );
      const accessibility = await page.evaluate(async (mode) => {
        const result = await globalThis.axe.run(
          mode === "pin-peek"
            ? globalThis.document.querySelector(".files-pin-peek")
            : globalThis.document,
          {
            resultTypes: ["violations", "incomplete"],
          },
        );
        return {
          violations: result.violations.map((item) => ({
            id: item.id,
            nodes: item.nodes.map((node) => ({
              target: node.target,
              summary: node.failureSummary,
            })),
          })),
          incomplete: result.incomplete.map((item) => ({
            id: item.id,
            nodes: item.nodes.map((node) => ({
              target: node.target,
              summary: node.failureSummary,
            })),
          })),
        };
      }, mode);
      assert.deepEqual(accessibility, { violations: [], incomplete: [] });
      const assets = await page.locator("[data-asset-slot]").evaluateAll((nodes) =>
        nodes
          .filter((node) => node.getBoundingClientRect().width > 0)
          .map((node) => ({
            slot: node.dataset.assetSlot,
            loaded: node.complete && node.naturalWidth > 0,
            width: node.getBoundingClientRect().width,
            height: node.getBoundingClientRect().height,
          })),
      );
      for (const asset of assets) {
        const [group, name] = asset.slot.split("/");
        const svg = await readFile(
          new URL(`../src/assets/island/${slots[group][name]}`, import.meta.url),
          "utf8",
        );
        assert(asset.loaded);
        assert.equal(asset.width, Number(svg.match(/\bwidth="([\d.]+)"/)[1]));
        assert.equal(asset.height, Number(svg.match(/\bheight="([\d.]+)"/)[1]));
      }
      const geometry = await page
        .locator(mode === "pin-peek" ? ".files-pin-peek" : ".island-morph")
        .boundingBox();
      if (mode === "pin-peek") {
        assert.equal(geometry.width, 360);
        assert.equal(
          geometry.height,
          274,
          JSON.stringify(
            await page.locator(".files-pin-peek").evaluate((root) =>
              [...root.children].map((node) => ({
                tag: node.tagName,
                class: node.className,
                rect: node.getBoundingClientRect().toJSON(),
                font: globalThis.getComputedStyle(node).font,
                gap: globalThis.getComputedStyle(node).gap,
                children: [...node.children].map((child) => ({
                  tag: child.tagName,
                  rect: child.getBoundingClientRect().toJSON(),
                  font: globalThis.getComputedStyle(child).font,
                  height: globalThis.getComputedStyle(child).height,
                })),
              })),
            ),
          ),
        );
      }
      if (mode === "moved-compact") {
        assert.equal(geometry.width, 312);
        assert.equal(geometry.height, 32);
      }
      if (mode.startsWith("drop")) assert.equal(geometry.width, 640);
      const calls = await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot().calls);
      assert(
        !calls.some((call) =>
          [
            "files_execute",
            "files_undo",
            "files_pin_action",
            "files_save_pin",
            "files_remove_pin",
            "start_download",
            "tool_start",
            "shelf_copy_paths",
            "plugin:drag|start_drag",
          ].includes(call.command),
        ),
      );
      return {
        mode,
        accessibility,
        geometry,
        assets,
        noFilesystemClipboardOrShellSideEffects: true,
      };
    },
  })),
);
globalThis.console.log(
  `Verified ${report.captures.length} Files/Pins/peek/move/drop/result captures.`,
);
