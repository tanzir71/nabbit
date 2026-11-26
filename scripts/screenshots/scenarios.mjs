import assert from "node:assert/strict";

// Add later UI states here; common browser/IPC/capture policy stays in harness.
export const scenarios = [
  {
    name: "tray-downloads",
    suite: "surfaces",
    entry: "index.html",
    surface: "tray",
    label: "main",
    viewport: { width: 460, height: 680 },
    font: "h1",
    async ready(page) {
      await page.getByRole("heading", { name: "Creative Commons sample", exact: true }).waitFor();
      // Exercise the same pushed-event path as native progress updates.
      await page.evaluate(() => {
        const fixture = globalThis.__NABBIT_CAPTURE__;
        const jobs = fixture.snapshot().state.jobs;
        jobs[0].progress = 68;
        fixture.patch({ jobs });
        fixture.emit("download:updated", jobs[0]);
      });
      await page.getByText("68% - 4.2 MiB/s - ETA 00:12", { exact: true }).waitFor();
    },
  },
  {
    name: "tray-clipboard",
    suite: "surfaces",
    entry: "index.html",
    surface: "tray",
    label: "main",
    viewport: { width: 460, height: 680 },
    font: "h1",
    async ready(page) {
      await page.getByPlaceholder("Search clipboard").waitFor();
      await page.getByText("Keep useful things close.", { exact: true }).waitFor();
      assert(await page.getByText("5m", { exact: true }).isVisible());
    },
  },
  {
    name: "settings",
    suite: "surfaces",
    entry: "settings.html",
    surface: "settings",
    label: "settings",
    viewport: { width: 460, height: 680 },
    font: "h2",
    async ready(page) {
      await page.getByRole("group", { name: "Appearance", exact: true }).waitFor();
      assert(
        (await page
          .getByRole("button", { name: "System", exact: true })
          .getAttribute("aria-pressed")) === "true",
      );
    },
  },
  {
    name: "sticky-unbound",
    suite: "surfaces",
    entry: "sticky.html",
    surface: "sticky",
    label: "sticky",
    viewport: { width: 280, height: 208 },
    font: "h1",
    async ready(page) {
      await page.getByRole("heading", { name: "No note selected", exact: true }).waitFor();
    },
  },
  {
    name: "island-idle",
    suite: "surfaces",
    entry: "island.html",
    surface: "island",
    label: "island",
    viewport: { width: 720, height: 460 },
    transparent: true,
    figmaNode: "7:2",
    async ready(page) {
      await page.getByRole("main", { name: "Nabbit island" }).waitFor();
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector(".island-host").dataset.islandVisibility === "visible",
      );
      const box = await page.locator(".island-idle").boundingBox();
      assert.deepEqual(box, { x: 304, y: 6, width: 112, height: 26 });
    },
  },
  {
    name: "brand",
    suite: "foundations",
    entry: "components.html",
    label: "components",
    viewport: { width: 1420, height: 1000 },
    selector: "#brand-foundations",
    figmaNode: "12:478",
    async ready(page) {
      await page.locator("#brand-foundations img").last().waitFor();
      assert.equal(await page.locator("#brand-foundations img").count(), 7);
    },
  },
  {
    name: "controls",
    suite: "foundations",
    entry: "components.html",
    label: "components",
    viewport: { width: 1420, height: 1000 },
    selector: "#core-foundations",
    figmaNode: "5:408",
    font: "#core-foundations button",
    async ready(page) {
      await page.locator("#core-foundations").waitFor();
    },
  },
];
