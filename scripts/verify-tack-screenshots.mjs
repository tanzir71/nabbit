import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { fixtureData } from "./screenshots/fixtures.mjs";
import { auditFont } from "./font-audit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const workspaces = [
  {
    id: "personal",
    name: "Personal",
    role: "owner",
    displayName: "",
    userId: "fixture",
    sessionEpoch: 1,
  },
  {
    id: "studio",
    name: "Studio",
    role: "member",
    displayName: "",
    userId: "fixture",
    sessionEpoch: 1,
  },
  {
    id: "client",
    name: "Client project",
    role: "guest",
    displayName: "",
    userId: "fixture",
    sessionEpoch: 1,
  },
];
const modes = [
  "server",
  "signin",
  "recovery",
  "workspace",
  "labels",
  "upload",
  "readonly",
  "narrow",
  "error",
  "settings",
];
const cases = modes.map((mode) => ({
  name: `tack-${mode}`,
  suite: "notes",
  entry: "index.html",
  surface: "tray",
  label: "main",
  font: mode === "settings" ? ".tack-settings strong" : ".tack-dialog h2",
  caret: "initial",
  figmaNode: ["server", "signin", "recovery", "narrow", "error"].includes(mode) ? "19:5" : "19:102",
  viewport: { width: mode === "narrow" ? 360 : 460, height: 680 },
  fixture() {
    const data = fixtureData("tray-downloads");
    data.settings.lastTab = "notes";
    data.notes = [];
    const ready = ["workspace", "labels", "upload", "readonly", "settings"].includes(mode);
    const connection = {
      checked: mode !== "server",
      baseUrl: mode === "server" ? null : "https://your-domain.com/tack/",
      user: ready ? { id: "fixture", username: "tanzir" } : null,
      workspace: ready ? workspaces[0] : null,
      workspaces: ready ? workspaces : [],
      recoveryPending: false,
      requiresLogin: !ready,
      ready,
      error: null,
    };
    const profile = {
      baseUrl: "https://your-domain.com/tack/",
      username: "tanzir",
      localCount: mode === "upload" ? 12 : 0,
      preferences: { showTasks: true, filterLabels: false, labels: [] },
      labels: ["nabbit", "ideas"],
      readOnly: false,
    };
    return {
      data,
      failures:
        mode === "error"
          ? {
              tack_login: {
                code: "rateLimited",
                state: "rateLimited",
                httpStatus: 429,
                retryAfterMs: 60000,
              },
            }
          : undefined,
      responses: {
        tack_snapshot: connection,
        tack_profile: profile,
        tack_workspace_profile: profile,
        tack_login: {
          connection: {
            ...connection,
            user: { id: "fixture", username: "tanzir" },
            workspace: workspaces[0],
            workspaces,
            recoveryPending: true,
            requiresLogin: false,
          },
          recoveryCode: "DEMO-RECOVERY-CODE-SYNTHETIC",
        },
      },
    };
  },
  async ready(page) {
    if (mode === "settings") {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page
        .getByRole("heading", { name: "Notes & Tack", exact: true })
        .scrollIntoViewIfNeeded();
      await page.locator(".tack-settings").waitFor();
    } else {
      await page
        .getByRole("button", {
          name: ["workspace", "labels", "upload", "readonly"].includes(mode)
            ? "Tack settings"
            : "Connect Tack",
          exact: true,
        })
        .click();
      await page.getByRole("dialog").waitFor();
      if (mode === "recovery") {
        await page.getByLabel("Password", { exact: true }).fill("sample-demo-42");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await page.getByRole("heading", { name: "Save your recovery code", exact: true }).waitFor();
        assert(
          await page
            .getByRole("button", { name: "I saved it — continue", exact: true })
            .isDisabled(),
        );
      }
      if (mode === "signin" || mode === "narrow")
        await page.getByLabel("Password", { exact: true }).fill("sample-demo-42");
      if (mode === "error") {
        await page.getByLabel("Password", { exact: true }).fill("synthetic-demo-password");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "limited attempts" }).waitFor();
        assert(await page.getByRole("button", { name: "Sign in", exact: true }).isDisabled());
      }
      if (mode === "labels") {
        await page.getByRole("button", { name: "Start syncing", exact: true }).waitFor();
        await page.getByRole("switch", { name: "Only cards with a label", exact: true }).click();
        await page.getByLabel("Labels to show", { exact: true }).fill("nabbit, ideas");
      }
      if (mode === "readonly") await page.getByRole("radio", { name: /Client project/ }).check();
      if (["workspace", "labels", "upload", "readonly"].includes(mode))
        await page.waitForFunction(
          () => !globalThis.document.querySelector('.tack-footer button[type="submit"]').disabled,
        );
    }
    await page.evaluate(() => globalThis.document.fonts.ready);
    await page.mouse.move(1, 1);
    await page.evaluate(() => globalThis.document.activeElement?.blur());
    const target = page.locator(mode === "settings" ? ".tack-settings" : ".tack-dialog");
    const geometry = await target.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        horizontalOverflow: element.scrollWidth > element.clientWidth,
      };
    });
    assert(!geometry.horizontalOverflow);
    if (mode !== "settings") {
      assert.equal(geometry.width, mode === "narrow" ? 360 : 460);
      assert.equal(geometry.height, 680);
    }
    return {
      mode,
      geometry,
      ...(await this.audit(page)),
      fixture: "Synthetic read-only Figma reference data; no account or hosted Tack",
      noExternalNetwork: true,
    };
  },
  async audit(page) {
    const target = page.locator(mode === "settings" ? ".tack-settings" : ".tack-dialog");
    const assets = await target.locator("img[data-asset]").evaluateAll((images) =>
      images.map((img) => ({
        file: img.dataset.asset,
        src: img.currentSrc,
        width: img.getBoundingClientRect().width,
        height: img.getBoundingClientRect().height,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      })),
    );
    for (const asset of assets) {
      const path = asset.file.startsWith("tack/")
        ? `src/assets/${asset.file}`
        : `src/assets/components/${asset.file}`;
      const original = await readFile(new URL(`../${path}`, import.meta.url));
      assert(original.length > 0);
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
      assert.equal(hash(actual), hash(expected), path);
      assert.equal(asset.width, asset.naturalWidth, path);
      assert.equal(asset.height, asset.naturalHeight, path);
      asset.sourceSha256 = hash(original);
      asset.renderedSha256 = hash(actual);
      delete asset.src;
    }
    const fonts = await auditFont(
      page,
      mode === "settings" ? ".tack-settings strong" : ".tack-dialog h2",
      "Geist",
    );
    await page.addScriptTag({ content: axe });
    const accessibility = await page.evaluate(async () => {
      const report = await globalThis.axe.run(globalThis.document, {
        resultTypes: ["violations", "incomplete"],
      });
      return {
        violations: report.violations.map((row) => ({
          id: row.id,
          nodes: row.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
        })),
        incomplete: report.incomplete.map((row) => ({
          id: row.id,
          nodes: row.nodes.map((node) => node.target),
        })),
      };
    });
    assert.deepEqual(accessibility.violations, [], JSON.stringify(accessibility.violations));
    assert.deepEqual(accessibility.incomplete, [], JSON.stringify(accessibility.incomplete));
    const recorded = await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot().calls);
    for (const call of recorded.filter((row) =>
      ["tack_login", "tack_confirm_recovery", "tack_copy_recovery"].includes(row.command),
    ))
      for (const key of ["password", "code"])
        if (Object.hasOwn(call.args, key)) assert.equal(call.args[key], "[redacted]");
    const calls = recorded.map((call) => call.command);
    assert(!calls.includes("tack_start_sync"));
    return { assets, fonts, accessibility, explicitStartRequired: true, commands: calls };
  },
}));
const report = await captureSuite(
  root,
  { milestone: "M8", prefix: process.argv[2] ?? "v44-tack", suite: "all", repeatCheck: true },
  cases,
);
globalThis.console.log(
  `Verified ${report.captures.length} Tack captures with exact repeats, original assets/fonts and full default axe rules.`,
);
