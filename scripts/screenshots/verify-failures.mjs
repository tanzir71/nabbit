import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";
import { captureSuite } from "./harness.mjs";
import { scenarios } from "./scenarios.mjs";
import { outputOptions } from "./policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: {
    milestone: { type: "string", default: "M2" },
    prefix: { type: "string", default: "v16" },
  },
});
const config = outputOptions(root, values);
const scenario = {
  ...scenarios[0],
  name: "runtime-failure",
  async ready(page) {
    await page.getByRole("heading", { name: "Nabbit", exact: true }).waitFor();
    await page.evaluate(async () => {
      globalThis.console.error("Intentional screenshot-harness failure fixture");
      try {
        await globalThis.fetch("https://example.invalid/blocked-by-harness");
      } catch {
        /* expected route abort */
      }
    });
  },
};
let failure;
try {
  await captureSuite(
    root,
    { milestone: config.milestone, prefix: `${config.prefix}-failure-probe`, suite: "surfaces" },
    [scenario],
  );
} catch (error) {
  failure = error;
}
assert(failure, "A faulty scenario must fail");
assert.match(failure.message, /runtime-failure \(light@1x\)/);
assert.match(failure.message, /runtime\/network failures/);
assert.match(failure.cause.message, /Intentional screenshot-harness failure fixture/);
assert.match(failure.cause.message, /Unexpected network/);
for (const name of [
  `${config.prefix}-failure-probe-screenshots.json`,
  `${config.prefix}-failure-probe-runtime-failure-light@1x.png`,
]) {
  await assert.rejects(access(resolve(config.folder, name)), { code: "ENOENT" });
}
await writeFile(
  resolve(config.folder, `${config.prefix}-failure-check.json`),
  JSON.stringify(
    {
      consoleErrorsRejected: true,
      outboundRequestBlockedAndRejected: true,
      failedSuitePublishesNoEvidence: true,
      scenarioThemeAndScaleInError: true,
      browserContextsBrowserAndPreviewClosed: true,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
globalThis.console.log(
  "Verified runtime/network failure propagation, no failed evidence publication and complete owned-resource cleanup.",
);
