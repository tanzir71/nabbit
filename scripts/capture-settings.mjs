import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { captureSuite } from "./screenshots/harness.mjs";
import { settingsExtraScenarios, settingsScenarios } from "./screenshots/settings-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v61-settings-b";
assert(/^[a-z0-9-]+$/.test(prefix));
await mkdir(new URL("../progress/v2/M11/", import.meta.url), { recursive: true });
const axeSource = await readFile(
    new URL("../node_modules/axe-core/axe.min.js", import.meta.url),
    "utf8",
  ),
  scans = [];
const cases = [...settingsScenarios, ...settingsExtraScenarios].map((scenario) => ({
  ...scenario,
  async ready(page) {
    const assertions = await scenario.ready(page);
    await page.evaluate(axeSource);
    const result = await page.evaluate(async () => {
      const result = await globalThis.axe.run();
      return {
        version: globalThis.axe.version,
        url: globalThis.location.pathname,
        theme: globalThis.document.documentElement.dataset.theme,
        scale: globalThis.devicePixelRatio,
        violations: result.violations.map(({ id, impact, nodes }) => ({
          id,
          impact,
          nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
        })),
        incomplete: result.incomplete.map(({ id, impact, nodes }) => ({
          id,
          impact,
          targets: nodes.map(({ target }) => target),
          nodes: nodes.map(({ target, failureSummary, any, all, none }) => ({
            target,
            failureSummary,
            any,
            all,
            none,
          })),
        })),
        passes: result.passes.length,
      };
    });
    scans.push({ scenario: scenario.name, ...result });
    assert.equal(
      result.violations.length,
      0,
      `Whole-document default axe: ${JSON.stringify(result.violations)}`,
    );
    assert.equal(
      result.incomplete.length,
      0,
      `Whole-document default axe incomplete: ${JSON.stringify(result.incomplete)}`,
    );
    return { ...assertions, axe: result };
  },
}));
try {
  await captureSuite(
    root,
    {
      milestone: "M11",
      prefix,
      suite: "surfaces",
      repeatCheck: true,
      deterministicCompositor: true,
    },
    cases,
  );
} finally {
  await writeFile(
    new URL(`../progress/v2/M11/${prefix}-axe.json`, import.meta.url),
    JSON.stringify(
      {
        scope: "Whole-document axe.run() with defaults; no exclusions, tags or disabled rules",
        scans,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
