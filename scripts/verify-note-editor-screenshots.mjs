import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { fixtureData } from "./screenshots/fixtures.mjs";
import { notesFixture } from "./screenshots/notes-fixtures.mjs";
import { auditFont } from "./font-audit.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const states = [
  "localOnly",
  "upToDate",
  "syncing",
  "offline",
  "signedOut",
  "recoveryPending",
  "workspaceChanged",
  "storageFull",
  "conflict",
  "rateLimited",
];
const modes = [
  "editor",
  "note",
  "bookmark",
  "reminders",
  "history",
  "narrow",
  "readonly",
  "conflict",
  "deleted",
  "reminder-conflict",
  ...states.map((s) => `state-${s.toLowerCase()}`),
];
const cases = modes.map((mode) => ({
  name: `notes-${mode}`,
  suite: "notes",
  entry: "index.html",
  surface: "tray",
  label: "main",
  font: mode.startsWith("state-")
    ? ".tack-settings .note-sync-title strong"
    : ["conflict", "deleted", "reminder-conflict"].includes(mode)
      ? ".note-conflict-header h2"
      : ".note-editor-properties .note-property > span",
  caret: "initial",
  figmaNode: mode.startsWith("state-")
    ? "19:346"
    : ["conflict", "deleted", "reminder-conflict"].includes(mode)
      ? "19:301"
      : "19:182",
  viewport: { width: mode === "narrow" ? 360 : 460, height: 680 },
  selector: mode.startsWith("state-") ? ".tack-settings .note-sync" : ".note-dialog",
  fixture() {
    const data = fixtureData("tray-downloads");
    data.settings.lastTab = "notes";
    const note = notesFixture()[0];
    note.scope = null;
    note.editToken = "fixture-opened";
    note.localOnly = true;
    Object.assign(note.value, {
      kind: mode === "note" ? "note" : mode === "bookmark" ? "bookmark" : "task",
      title: "Launch checklist",
      body: "Keep the first release small and useful. Island first, then notes sync.",
      ref: "tck-24",
      priority: "now",
      color: "green",
      labels: ["build", "nabbit"],
      pinned: false,
      items: [
        { id: "a", text: "Verify island at 150% DPI", checked: true },
        { id: "b", text: "Record demo GIF", checked: false },
        { id: "c", text: "Write release notes", checked: false },
      ],
      url: "https://example.com/notes",
    });
    data.notes = [note];
    const state = mode.startsWith("state-")
      ? states.find((s) => mode === `state-${s.toLowerCase()}`)
      : ["conflict", "deleted", "reminder-conflict"].includes(mode)
        ? "conflict"
        : "upToDate";
    const workspace = {
      id: "personal",
      name: "Personal",
      role: mode === "readonly" ? "guest" : "owner",
      displayName: "",
      userId: "fixture",
      sessionEpoch: 1,
    };
    const connection = {
      checked: true,
      baseUrl: "https://fixture.invalid/tack/",
      user: { id: "fixture", username: "fixture" },
      workspace,
      workspaces: [workspace],
      ready: true,
      requiresLogin: false,
      recoveryPending: false,
      error: null,
    };
    const scope = { key: "fixture", epoch: 1 };
    const conflict = {
      scope,
      table: mode === "reminder-conflict" ? "reminders" : "cards",
      id: note.value.id,
      token: "conflict-token",
      local:
        mode === "reminder-conflict"
          ? { id: "r", at: "2026-11-28T09:00:00Z", repeat: "daily" }
          : {
              title: "",
              body: "Ship beta build Friday. Record demo GIF first.",
              updatedAt: "2026-11-27T10:42:00Z",
            },
      remote: {
        table: "cards",
        id: note.value.id,
        version: 7,
        value:
          mode === "deleted"
            ? null
            : mode === "reminder-conflict"
              ? { id: "r", at: "2026-11-29T10:00:00Z", repeat: "weekly" }
              : {
                  title: "",
                  body: "Ship beta build Thursday after the DPI pass.",
                  updatedAt: "2026-11-27T10:47:00Z",
                },
      },
    };
    return {
      data,
      responses: {
        get_notes_state: { cards: [note], scope: null, readOnly: mode === "readonly" },
        get_note_editor: {
          note,
          attachments: [],
          reminders: [
            {
              editToken: "reminder-token",
              value: {
                id: "reminder",
                revision: 2,
                entityId: note.value.id,
                entityType: "card",
                at: "2026-11-28T09:00:00.000Z",
                timeZone: "UTC",
                repeat: "weekdays",
                anchorDay: 28,
                snoozedUntil: null,
                lastCompletedAt: null,
                enabled: true,
              },
            },
          ],
          revisions: [
            {
              value: { body: "An earlier version kept after conflict resolution." },
              reason: "used-tack-version",
              savedAt: "2026-11-27T10:30:00Z",
            },
          ],
        },
        tack_snapshot: connection,
        tack_profile: {
          baseUrl: connection.baseUrl,
          username: "fixture",
          localCount: 1,
          preferences: { showTasks: true, filterLabels: false, labels: [] },
          labels: ["build", "nabbit"],
          readOnly: mode === "readonly",
        },
        tack_sync_snapshot: {
          state,
          scope: state === "localOnly" ? null : scope,
          pending: ["upToDate", "localOnly"].includes(state) ? 0 : 3,
          conflicts: state === "conflict" ? 1 : 0,
          referenceIssues: 0,
          lastSynced: "2026-11-27T12:00:00.000Z",
          error: null,
          nextAttemptMs: null,
        },
        tack_conflicts: [conflict],
      },
    };
  },
  async ready(page) {
    if (mode.startsWith("state-")) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.locator(".tack-settings .note-sync").scrollIntoViewIfNeeded();
    } else if (["conflict", "deleted", "reminder-conflict"].includes(mode)) {
      await page.getByRole("button", { name: "Review conflicts", exact: true }).click();
      await page.locator(".note-conflict-version").first().waitFor();
    } else {
      await page.getByRole("button", { name: "Launch checklist", exact: true }).click();
      await page.locator(".note-editor-ref").waitFor();
      await page.waitForFunction(
        () =>
          !globalThis.document.querySelector('.note-editor input[aria-label="Note title"]')
            .disabled ||
          globalThis.document.querySelector(".note-editor-body").textContent.includes("Read-only"),
      );
      if (mode === "reminders") await page.getByRole("button", { name: "Edit reminders" }).click();
      if (mode === "history")
        await page.getByRole("button", { name: "History", exact: true }).click();
    }
    await page.evaluate(() => {
      const dialog = globalThis.document.querySelector(".note-dialog");
      (
        dialog?.querySelector(".n-icon-button:not(:disabled)") ??
        globalThis.document.querySelector(".tack-settings .n-button")
      )?.focus();
    });
    const target = page.locator(this.selector);
    const geometry = await target.evaluate((e) => ({
      width: e.getBoundingClientRect().width,
      height: e.getBoundingClientRect().height,
      overflow: e.scrollWidth > e.clientWidth,
    }));
    assert(!geometry.overflow);
    const assets = await target.locator("img[data-asset]").evaluateAll((images) =>
      images
        .filter((img) => globalThis.getComputedStyle(img).visibility !== "hidden")
        .map((img) => ({
          file: img.dataset.asset,
          src: img.currentSrc,
          width: img.getBoundingClientRect().width,
          height: img.getBoundingClientRect().height,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          x: img.getBoundingClientRect().x,
          y: img.getBoundingClientRect().y,
          slot: img.closest(".note-editor-toolbar")
            ? "toolbar"
            : img.closest(".note-editor-items")
              ? "checklist"
              : img.closest(".note-editor-properties")
                ? "properties"
                : img.closest(".note-editor-footer")
                  ? "editor-footer"
                  : img.closest(".note-conflict-header")
                    ? "conflict-header"
                    : img.closest(".note-conflict-version")
                      ? "conflict-version"
                      : img.closest(".note-sync")
                        ? "sync-state"
                        : "unknown",
        })),
    );
    for (const asset of assets) {
      const original = await readFile(
        new URL(
          `../src/assets/${asset.file.startsWith("notes-editor/") || asset.file.startsWith("tack/") ? asset.file : `components/${asset.file}`}`,
          import.meta.url,
        ),
      );
      assert(original.length);
      assert.notEqual(asset.slot, "unknown", asset.file);
      const expected =
        asset.src.startsWith("data:") && !asset.src.includes(";base64,")
          ? Buffer.from(
              original
                .toString()
                .trim()
                .replaceAll(/>\s+</g, "><")
                .replaceAll('"', "'")
                .replaceAll(/\s+/g, " "),
            )
          : original;
      const actual = asset.src.startsWith("data:")
        ? Buffer.from(
            asset.src.includes(";base64,")
              ? asset.src.slice(asset.src.indexOf(",") + 1)
              : decodeURIComponent(asset.src.slice(asset.src.indexOf(",") + 1)),
            asset.src.includes(";base64,") ? "base64" : "utf8",
          )
        : Buffer.from(await (await globalThis.fetch(asset.src)).arrayBuffer());
      assert.equal(sha(actual), sha(expected), asset.file);
      assert.equal(asset.width, asset.naturalWidth, asset.file);
      assert.equal(asset.height, asset.naturalHeight, asset.file);
      asset.sha256 = sha(original);
      delete asset.src;
    }
    const fonts = await auditFont(
      page,
      mode.startsWith("state-")
        ? ".tack-settings .note-sync-title strong"
        : ["conflict", "deleted", "reminder-conflict"].includes(mode)
          ? ".note-conflict-header h2"
          : ".note-editor-properties .note-property > span",
      "Geist",
    );
    await page.addScriptTag({ content: axe });
    const accessibility = await page.evaluate(async () => {
      const r = await globalThis.axe.run(globalThis.document, {
        resultTypes: ["violations", "incomplete"],
      });
      return {
        violations: r.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
        })),
        incomplete: r.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
      };
    });
    assert.deepEqual(accessibility.violations, [], JSON.stringify(accessibility.violations));
    assert.deepEqual(accessibility.incomplete, [], JSON.stringify(accessibility.incomplete));
    return {
      mode,
      geometry,
      assets,
      fonts,
      accessibility,
      fixture:
        "Synthetic Figma card/conflict/protocol snapshots; behavior is verified separately against Rust",
      noExternalNetwork: true,
    };
  },
}));
const report = await captureSuite(
  root,
  { milestone: "M9", prefix: process.argv[2] ?? "v45-editor", suite: "all", repeatCheck: true },
  cases,
);
globalThis.console.log(
  `Verified ${report.captures.length} Notes captures, exact repeats, explicit asset/font/default axe audits.`,
);
