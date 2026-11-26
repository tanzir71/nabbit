import assert from "node:assert/strict";
import { fileURLToPath, URL } from "node:url";
import { captureSuite } from "./screenshots/harness.mjs";
const cases = [];
for (const width of [460, 800]) {
  for (const variant of ["default", "specific", "disconnected"]) {
    cases.push({
      name: `island-settings-${width}-${variant}`,
      suite: "surfaces",
      entry: "settings.html",
      surface: "settings",
      label: "settings",
      viewport: { width, height: 900 },
      selector: ".island-settings",
      font: "#island-settings-title",
      figmaNode: "22:146",
      async ready(page) {
        await page.getByRole("button", { name: "Notch", exact: true }).waitFor();
        if (variant !== "default") {
          await page.getByRole("button", { name: "Notch", exact: true }).click();
          await page.getByRole("button", { name: "Large", exact: true }).click();
          await page.getByLabel("Monitor", { exact: true }).selectOption("specific");
          await page.getByLabel("Specific monitor", { exact: true }).selectOption("primary");
          if (variant === "disconnected") {
            await page.evaluate(() =>
              globalThis.__NABBIT_CAPTURE__.emit("nabbit://island-config", {
                supported: true,
                desktop: { monitors: [] },
                lastError: null,
              }),
            );
            await page
              .getByText("Disconnected. Using the primary display until it returns.")
              .waitFor();
          }
          assert.equal(
            await page
              .getByRole("button", { name: "Notch", exact: true })
              .getAttribute("aria-pressed"),
            "true",
          );
          assert.equal(
            await page
              .getByRole("button", { name: "Large", exact: true })
              .getAttribute("aria-pressed"),
            "true",
          );
        }
        const dimensions = await page
          .locator(".island-settings")
          .evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth }));
        assert.equal(
          dimensions.content,
          dimensions.width,
          "Settings must not overflow horizontally",
        );
        // The original 14×14 Figma chevron stays unscaled at its call site.
        const icon = page.locator(".island-settings .n-select-arrow img").first();
        const box = await icon.boundingBox();
        assert.deepEqual([box.width, box.height], [14, 14]);
      },
    });
  }
}
const report = await captureSuite(
  fileURLToPath(new URL("../", import.meta.url)),
  { milestone: "M4", prefix: "v21", suite: "surfaces" },
  cases,
);
globalThis.console.log(`Captured ${report.captures.length} Shape and Place screenshots.`);
