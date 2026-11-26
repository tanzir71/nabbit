import { fileURLToPath, URL } from "node:url";
import { captureSuite } from "./screenshots/harness.mjs";
import { scenarios } from "./screenshots/scenarios.mjs";
const report = await captureSuite(
  fileURLToPath(new URL("../", import.meta.url)),
  { milestone: "M4", prefix: "v24", suite: "surfaces", repeatCheck: true },
  scenarios
    .filter((scenario) => scenario.name === "island-idle")
    .map((scenario) => ({
      ...scenario,
      async ready(page) {
        await scenario.ready(page);
        await page.waitForFunction(
          () => globalThis.document.querySelector("main").dataset.islandState === "idle",
        );
      },
    })),
);
globalThis.console.log(`Captured ${report.captures.length} activity-connected idle PNGs.`);
