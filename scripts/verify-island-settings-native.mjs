import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { setTimeout } from "node:timers/promises";
const [endpoint, folder, prefix] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(endpoint);
try {
  // Native construction returns before WebView2 finishes its first navigation.
  let page;
  for (let attempt = 0; attempt < 100; attempt++) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find(
        (entry) => entry.url().includes("tauri.localhost") || entry.url().startsWith("tauri://"),
      );
    if (page) break;
    await setTimeout(100);
  }
  assert(page, "Lazy tray WebView2 missing");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Hidden WebView2 throttles animation frames. Drive DOM events only after
  // checking disabled state and await each persisted result without RAF polling.
  const wait = async (condition, description) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await condition()) return;
      await setTimeout(100);
    }
    throw new Error(`Timed out: ${description}`);
  };
  const invoke = (command) =>
    page.evaluate((name) => globalThis.__TAURI_INTERNALS__.invoke(name), command);
  const settingsButton = page.getByRole("button", { name: "Settings", exact: true });
  await wait(() => settingsButton.count(), "tray bootstrap");
  await settingsButton.evaluate((element) => element.click());
  const choose = async (name, field, expected) => {
    const button = page.getByRole("button", { name, exact: true });
    await wait(async () => (await button.count()) && (await button.isEnabled()), `${name} enabled`);
    await button.evaluate((element) => element.click());
    await wait(
      async () =>
        (await invoke("get_settings")).island[field] === expected &&
        (await button.getAttribute("aria-pressed")) === "true" &&
        (await button.isEnabled()),
      `${name} persisted`,
    );
  };
  await choose("Floating island", "shape", "island");
  await choose("Notch", "shape", "notch");
  await choose("Small", "size", "small");
  const monitor = page.getByLabel("Monitor", { exact: true });
  assert(await monitor.isEnabled());
  await monitor.evaluate((element) => {
    element.value = "all";
    element.dispatchEvent(new globalThis.Event("change", { bubbles: true }));
  });
  let snapshot;
  await wait(async () => {
    snapshot = await invoke("get_island_snapshot");
    return (
      snapshot.preferences.shape === "notch" &&
      snapshot.preferences.size === "small" &&
      snapshot.preferences.monitorMode === "all" &&
      snapshot.hosts.length === 2 &&
      snapshot.hosts.every(
        (host) => host.placement.shape === "notch" && host.placement.sizeScale === 0.9,
      )
    );
  }, "native configuration applied");
  assert.equal(snapshot.renderer, "native");
  assert.equal(snapshot.hosts.length, 2);
  assert.equal(snapshot.preferences.shape, "notch");
  assert.equal(snapshot.preferences.size, "small");
  assert.equal(
    await page
      .locator(".island-monitor-row .n-field-label")
      .first()
      .evaluate((element) => globalThis.getComputedStyle(element).fontSize),
    "13px",
    "Release must embed current settings CSS",
  );
  assert.equal(
    await page.getByRole("button", { name: "Notch", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(folder, `${prefix}-native-settings-ipc.json`),
    JSON.stringify({ snapshot, runtimeErrors: errors, hiddenTrayDOM: true }, null, 2) + "\n",
  );
  process.stdout.write(
    "Verified actual WebView2 settings → Rust IPC → SQLite → native host configuration.\n",
  );
} finally {
  await browser.close();
}
