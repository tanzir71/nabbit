import assert from "node:assert/strict";
import { fileURLToPath, URL } from "node:url";
import { captureSuite } from "./screenshots/harness.mjs";
import { scenarios } from "./screenshots/scenarios.mjs";
const idle = scenarios.find((scenario) => scenario.name === "island-idle");
const cases = ["visible", "faded", "hidden"].map((mode) => ({
  ...idle,
  name: `island-${mode}`,
  figmaNode: mode === "faded" ? "15:489" : "7:2",
  async ready(page) {
    await idle.ready(page);
    await page.evaluate(
      (mode) =>
        globalThis.__NABBIT_CAPTURE__.emit("nabbit://island-visibility", {
          label: "island",
          mode,
          base: mode,
          reason: mode === "faded" ? "maximised" : mode === "hidden" ? "borderless" : "none",
          opacity: mode === "hidden" ? 0 : mode === "faded" ? 0.35 : 1,
          revision: 1,
        }),
      mode,
    );
    await page.waitForFunction(
      (mode) => globalThis.document.querySelector("main").dataset.islandVisibility === mode,
      mode,
    );
    const actual = await page.locator("main").evaluate((host) => {
      const style = globalThis.getComputedStyle(host),
        box = host.getBoundingClientRect();
      return {
        opacity: style.opacity,
        pointer: style.pointerEvents,
        width: box.width,
        height: box.height,
        display: style.display,
      };
    });
    assert.equal(actual.opacity, mode === "hidden" ? "0" : mode === "faded" ? "0.35" : "1");
    assert.equal(actual.pointer, mode === "visible" ? "auto" : "none");
    assert.deepEqual([actual.width, actual.height], [720, 460]);
    assert.notEqual(actual.display, "none");
  },
}));
const report = await captureSuite(
  fileURLToPath(new URL("../", import.meta.url)),
  { milestone: "M4", prefix: "v23", suite: "surfaces", repeatCheck: true },
  cases,
);
globalThis.console.log(
  `Captured ${report.captures.length} visibility PNGs with pushed mocked IPC.`,
);
