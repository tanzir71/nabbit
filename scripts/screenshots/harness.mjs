import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { chromium } from "playwright";
import { preview } from "vite";
import { auditFont } from "../font-audit.mjs";
import { fixtureData, captureTime } from "./fixtures.mjs";
import { installMockIpc } from "./mock-ipc.mjs";
import { outputOptions, pngInfo, themes, scales } from "./policy.mjs";
import { scenarios } from "./scenarios.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function captureSuite(root, options, cases = scenarios) {
  const config = outputOptions(root, options);
  const selected = cases.filter((item) => config.suite === "all" || item.suite === config.suite);
  assert(selected.length > 0, "No screenshot scenarios selected");
  assert.equal(
    new Set(selected.map((item) => item.name)).size,
    selected.length,
    "Scenario names must be unique",
  );
  for (const scenario of selected) {
    assert(
      !scenario.caret || ["initial", "hide"].includes(scenario.caret),
      "Unsupported caret capture policy",
    );
    assert(
      !scenario.query || scenario.query === "?download-sheet",
      "Only the local download sheet route is supported",
    );
    assert(/^[a-z][a-z0-9-]{0,63}$/.test(scenario.name), "Invalid scenario name");
    assert(
      /^[a-z][a-z0-9-]*\.html$/.test(scenario.entry),
      "Scenario must use a local root HTML entry",
    );
  }
  const outputNames = selected.flatMap((item) =>
    themes.flatMap((theme) =>
      scales.map((scale) => `${config.prefix}-${item.name}-${theme}@${scale}x.png`),
    ),
  );
  const reportName = `${config.prefix}-screenshots.json`;
  for (const name of [...outputNames, reportName]) {
    try {
      await access(resolve(config.folder, name));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`Evidence already exists: ${name}. Choose another --prefix.`);
  }
  for (const entry of new Set(selected.map((item) => item.entry))) {
    try {
      await access(resolve(root, "dist", entry));
    } catch {
      throw new Error(
        `Missing built ${entry}; run npm run screenshots (builds the component preview too).`,
      );
    }
  }

  const results = [],
    captures = [];
  let server, browser;
  try {
    server = await preview({
      configFile: resolve(root, "vite.config.ts"),
      root,
      preview: { host: "127.0.0.1", port: 0, strictPort: true, open: false },
      logLevel: "error",
    });
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
    for (const theme of themes)
      for (const scale of scales)
        for (const scenario of selected) {
          const context = await browser.newContext({
            viewport: scenario.viewport,
            colorScheme: theme,
            deviceScaleFactor: scale,
            reducedMotion: "reduce",
            locale: "en-US",
            timezoneId: "UTC",
            serviceWorkers: "block",
            acceptDownloads: false,
          });
          try {
            const problems = [];
            await context.route("**/*", (route) => {
              const request = route.request();
              if (new URL(request.url()).origin !== base || request.method() !== "GET") {
                problems.push(`Unexpected network: ${request.method()} ${request.url()}`);
                return route.abort();
              }
              return route.continue();
            });
            await context.routeWebSocket(/.*/, (socket) => {
              problems.push(`Unexpected WebSocket: ${socket.url()}`);
              socket.close();
            });
            const data = fixtureData(scenario.name);
            const seed = {
              theme,
              label: scenario.label,
              data,
              ...scenario.fixture?.(theme, scale),
            };
            await context.addInitScript(installMockIpc, seed);
            const page = await context.newPage();
            page.setDefaultTimeout(10000);
            page.on("pageerror", (error) => problems.push(`Page error: ${error.message}`));
            page.on("console", (message) => {
              if (message.type() === "error") problems.push(`Console error: ${message.text()}`);
            });
            page.on("requestfailed", (request) =>
              problems.push(`Failed request: ${request.url()}`),
            );
            page.on("response", (response) => {
              if (response.status() >= 400)
                problems.push(`HTTP ${response.status()}: ${response.url()}`);
            });
            page.on("download", async (download) => {
              problems.push("Unexpected browser download");
              await download.cancel();
            });
            page.on("dialog", async (dialog) => {
              problems.push(`Unexpected dialog: ${dialog.type()}`);
              await dialog.dismiss();
            });
            page.on("popup", async (popup) => {
              problems.push("Unexpected popup");
              await popup.close();
            });
            await page.clock.setFixedTime(new Date(captureTime));
            const response = await page.goto(`${base}/${scenario.entry}${scenario.query ?? ""}`, {
              waitUntil: "networkidle",
            });
            assert(response?.ok());
            const assertions = (await scenario.ready(page)) ?? null;
            if (scenario.surface)
              assert.equal(
                await page.locator("html").getAttribute("data-surface"),
                scenario.surface,
              );
            const resolvedTheme = scenario.surface === "island" ? "dark" : theme;
            await page.waitForFunction(
              (value) => globalThis.document.documentElement.dataset.theme === value,
              resolvedTheme,
            );
            await page.evaluate(async () => {
              await globalThis.document.fonts.ready;
              await Promise.all([...globalThis.document.images].map((img) => img.decode()));
            });
            const font = scenario.font ? await auditFont(page, scenario.font, "Geist") : null;
            const fixture = await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot());
            assert.deepEqual(
              fixture.unsupported,
              [],
              "Every IPC command must have an explicit fixture",
            );
            assert(
              !fixture.calls.some(({ command }) =>
                [
                  "start_download",
                  "start_playlist_download",
                  "start_download_with_preset",
                  "quick_download_staged",
                  "resume_download",
                  "retry_download",
                  "retry_download_with_browser",
                  "recover_download",
                ].includes(command),
              ),
              "A capture cannot start downloads",
            );
            if (scenario.suite === "foundations") assert.equal(fixture.calls.length, 0);
            else if (scenario.surface === "island") {
              assert(fixture.calls.some(({ command }) => command === "island_set_hitrect"));
              if (scenario.notesSync) {
                assert.equal(
                  await page.locator("main").getAttribute("data-island-state"),
                  "expanded",
                );
                assert.equal(
                  fixture.calls.filter(({ command }) => command === "tack_sync_snapshot").length,
                  1,
                  "Expanded Notes reads one initial snapshot, then uses pushed events",
                );
                assert.equal(
                  fixture.calls.filter(({ command }) => command === "get_notes_state").length,
                  1,
                  "Expanded Notes reads one atomic card snapshot, then uses pushed events",
                );
              }
              assert(
                fixture.calls.every(({ command }) =>
                  [
                    "island_set_hitrect",
                    "island_clear_hitrect",
                    "island_set_drag",
                    "get_island_snapshot",
                    "get_activity_snapshot",
                    "get_island_surface",
                    "island_surface_request",
                    "island_surface_ack",
                    "island_toggle_keyboard",
                    "island_keyboard_focus",
                    "island_keyboard_ready",
                    "list_island_pins",
                    "get_island_drop",
                    "island_review_url",
                    "list_clipboard_entries",
                    "get_engine_status",
                    "get_settings",
                    "get_captured_link",
                    "list_downloads",
                    "get_storage_stats",
                    "resolve_download_preset",
                    ...(scenario.notesSync ? ["tack_sync_snapshot", "get_notes_state"] : []),
                    ...(scenario.noteCapture ? ["notes_open", "capture_note"] : []),
                    ...(scenario.shelf ? ["shelf_list", "shelf_preview"] : []),
                    "plugin:event|listen",
                    "plugin:event|unlisten",
                  ].includes(command),
                ),
              );
            } else
              assert(
                fixture.calls.some(({ command }) => command === "plugin:window|theme"),
                "Exercise native theme IPC, not the browser fallback",
              );
            if (scenario.surface === "tray" || scenario.surface === "settings")
              assert(fixture.calls.some(({ command }) => command === "get_settings"));
            const target = scenario.selector ? page.locator(scenario.selector) : page;
            if (scenario.caret === "initial")
              assert(
                await page.evaluate(
                  () =>
                    !globalThis.document.activeElement?.matches(
                      "input,textarea,[contenteditable=true]",
                    ),
                ),
                "Initial caret captures require focus outside text controls",
              );
            const box = scenario.selector
              ? await target.boundingBox()
              : { x: 0, y: 0, ...scenario.viewport };
            assert(box);
            const screenshotOptions = {
              type: "png",
              animations: "disabled",
              caret: scenario.caret ?? "hide",
              scale: "device",
              omitBackground: scenario.transparent ?? false,
            };
            const bytes = await target.screenshot(screenshotOptions);
            const info = pngInfo(
              bytes,
              Math.round(box.width * scale),
              Math.round(box.height * scale),
            );
            if (options.repeatCheck) {
              const repeated = await target.screenshot(screenshotOptions);
              assert.equal(
                hash(repeated),
                hash(bytes),
                `Unstable capture: ${scenario.name}/${theme}/${scale}`,
              );
            }
            assert.deepEqual(problems, [], `${scenario.name} has runtime/network failures`);
            const file = `${config.prefix}-${scenario.name}-${theme}@${scale}x.png`;
            captures.push({ file, bytes });
            results.push({
              file,
              scenario: scenario.name,
              entry: scenario.entry,
              figmaNode: scenario.figmaNode ?? null,
              theme,
              resolvedTheme,
              scale,
              viewport: scenario.viewport,
              clip: box,
              ...info,
              sha256: hash(bytes),
              repeatMatches: options.repeatCheck ?? false,
              caret: scenario.caret ?? "hide",
              font,
              fixtureSha256: hash(JSON.stringify(seed)),
              assertions,
              ipc: fixture.calls,
              unsupported: fixture.unsupported,
              runtimeAndNetworkProblems: problems,
            });
          } catch (error) {
            throw new Error(`${scenario.name} (${theme}@${scale}x): ${error.message}`, {
              cause: error,
            });
          } finally {
            await context.close();
          }
        }
    const manifest = await readFile(resolve(root, "dist/.vite/manifest.json"));
    const report = {
      milestone: config.milestone,
      prefix: config.prefix,
      suite: config.suite,
      browser: browser.version(),
      playwright: JSON.parse(
        await readFile(resolve(root, "node_modules/playwright/package.json"), "utf8"),
      ).version,
      platform: process.platform,
      node: process.version,
      captureTime,
      buildManifestSha256: hash(manifest),
      screenshotScale: "device",
      pngBudgetBytes: 300 * 1024,
      isolatedContexts: true,
      mockedIpc: true,
      osPreferencesChanged: false,
      captures: results,
    };
    // Publish only once every scenario passes. Never overwrite historical evidence.
    await mkdir(config.folder, { recursive: true });
    for (const capture of captures)
      await writeFile(resolve(config.folder, capture.file), capture.bytes, { flag: "wx" });
    await writeFile(resolve(config.folder, reportName), JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
    });
    return report;
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      if (server)
        await new Promise((done, reject) =>
          server.httpServer.close((error) => (error ? reject(error) : done())),
        );
    }
  }
}
