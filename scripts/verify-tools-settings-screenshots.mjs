import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { captureSuite } from "./screenshots/harness.mjs";
import { fixtureData } from "./screenshots/fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  axe = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8"),
  notices = JSON.parse(
    await readFile(new URL("../third-party/notices.json", import.meta.url), "utf8"),
  );
const presets = [
  ["discord", "Fit for Discord", 20],
  ["email", "Fit for email", 25],
  ["outlook", "Fit for Outlook", 10],
  ["whatsapp", "Fit for WhatsApp", 100],
].map(([id, name, maxMb]) => ({ id, name, maxMb, quality: 85 }));
const report = await captureSuite(
  root,
  { milestone: "M10", prefix: process.argv[2] ?? "v57-settings", suite: "all", repeatCheck: true },
  ["presets", "licences"].map((mode) => ({
    name: `tools-settings-${mode}`,
    suite: "surfaces",
    entry: "settings.html",
    surface: "settings",
    label: "settings",
    viewport: { width: 980, height: 720 },
    font: "h1",
    selector: "body",
    pageClip: true,
    naturalMotion: true,
    retainFailures: true,
    figmaNode: null,
    fixture: () => ({
      data: fixtureData("settings"),
      responses: {
        tool_presets: presets,
        third_party_licenses: { ...notices, components: notices.components.slice(0, 2) },
      },
    }),
    async ready(page) {
      await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
      await page.getByLabel("Fit for Discord").waitFor();
      if (mode === "presets") {
        await page
          .getByRole("region", { name: "Files settings" })
          .evaluate((e) => e.scrollIntoView({ block: "start" }));
        assert.equal(await page.getByLabel("Fit for Discord").inputValue(), "20");
        assert.equal(await page.getByLabel("Fit for email").inputValue(), "25");
        assert.equal(await page.getByLabel("Fit for Outlook").inputValue(), "10");
        assert.equal(await page.getByLabel("Fit for WhatsApp").inputValue(), "100");
      } else {
        const details = page.getByText("Third-party licences", { exact: true });
        await details.click();
        await page.getByRole("heading", { name: "FFmpeg · separate GPL executable" }).waitFor();
        await details.scrollIntoViewIfNeeded();
        assert.equal(
          await page.getByText("GNU General Public License", { exact: true }).count(),
          1,
        );
      }
      await page.evaluate(async () => {
        await globalThis.document.fonts.ready;
        await Promise.all([...globalThis.document.images].map((i) => i.decode()));
      });
      await page.addScriptTag({ content: axe });
      const accessibility = await page.evaluate(async () => {
        const result = await globalThis.axe.run();
        const compact = (rows) =>
          rows.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
          }));
        return { violations: compact(result.violations), incomplete: compact(result.incomplete) };
      });
      assert.deepEqual(accessibility, { violations: [], incomplete: [] });
      return {
        mode,
        accessibility,
        fullGeneratedNoticeCount: notices.components.length,
        fixtureNoticeCount: mode === "licences" ? 2 : 0,
        noExternalLinkOrShellOpened: true,
      };
    },
  })),
);
globalThis.console.log(
  `Verified ${report.captures.length} Files settings/offline licence captures.`,
);
