import assert from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
const [endpoint, cursorPath, control, folder, prefix, ownerProcessId] = process.argv.slice(2);
let browser = await chromium.connectOverCDP(endpoint);
const checks = [],
  captures = [],
  errors = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const wait = async (fn, label) => {
  for (let i = 0; i < 200; i++) {
    const value = await fn();
    if (value) return value;
    await setTimeout(50);
  }
  throw new Error(`Timed out: ${label}`);
};
const request = async (fields) => {
  const id = randomUUID(),
    path = resolve(control, "island-request.json");
  await writeFile(`${path}.surface`, JSON.stringify({ id, ...fields }));
  await rename(`${path}.surface`, path);
  return wait(async () => {
    try {
      const result = JSON.parse(await readFile(resolve(control, "island-response.json"), "utf8"));
      if (result.id !== id) return false;
      assert.equal(result.error, null);
      assert.equal(result.snapshot.lastError, null);
      return result;
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  }, "fixture response");
};
let page;
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const selectPage = async () => {
  page = await wait(async () => {
    if (!browser.isConnected()) {
      try {
        browser = await chromium.connectOverCDP(endpoint, { timeout: 1000 });
      } catch {
        return false;
      }
    }
    return browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes("island.html"));
  }, "island WebView");
  page.on("pageerror", (error) => errors.push(error.message));
  await wait(
    async () =>
      page.evaluate(() =>
        Boolean(
          globalThis.__TAURI_INTERNALS__ && globalThis.document.querySelector(".island-morph"),
        ),
      ),
    "page ready",
  );
};
const screenshot = async (name) => {
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready;
    await Promise.all([...globalThis.document.images].map((img) => img.decode()));
    // Layout observers can replace an in-flight height transition. Wait for
    // replacements too, then capture the settled design state, not a fade frame.
    for (let pass = 0; pass < 5; pass++) {
      const active = globalThis.document
        .getAnimations()
        .filter((a) => a.playState === "running" || a.pending);
      await Promise.all(active.map((a) => a.finished.catch(() => undefined)));
      await new Promise(globalThis.requestAnimationFrame);
      if (!globalThis.document.getAnimations().some((a) => a.playState === "running" || a.pending))
        break;
    }
  });
  const geometry = await page.locator(".island-morph").boundingBox();
  const shape = await page.evaluate(() => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
    scale: globalThis.devicePixelRatio,
    state: globalThis.document.querySelector("main").dataset.islandState,
    opacity: globalThis.getComputedStyle(globalThis.document.querySelector(".island-content"))
      .opacity,
  }));
  assert.equal(geometry.width, { peek: 400, expanded: 680, drop: 640 }[shape.state]);
  assert(geometry.height <= 420);
  assert.equal(shape.opacity, "1");
  // WebView2's CDP capture coordinates precede page zoom. Capture the full
  // physical host, as in verify-native-handoff; never resize the resulting PNG.
  const session = await page.context().newCDPSession(page);
  let bytes;
  try {
    await session.send("Emulation.setDefaultBackgroundColorOverride", {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
    const shot = await session.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: shape.width * shape.scale,
        height: shape.height * shape.scale,
        scale: 1,
      },
    });
    bytes = Buffer.from(shot.data, "base64");
  } finally {
    await session.send("Emulation.setDefaultBackgroundColorOverride", {});
    await session.detach();
  }
  assert.equal(bytes.readUInt32BE(16), Math.round(shape.width * shape.scale));
  assert.equal(bytes.readUInt32BE(20), Math.round(shape.height * shape.scale));
  assert(bytes.length <= 300000);
  const file = `${prefix}-${name}.png`;
  await writeFile(resolve(folder, file), bytes, { flag: "wx" });
  captures.push({ file, bytes: bytes.length, sha256: hash(bytes), geometry, ...shape });
};
try {
  await selectPage();
  const initial = await invoke("get_island_snapshot"),
    placement = initial.hosts[0].placement;
  const entry = await page.evaluate(async () => {
    const url = globalThis.document.querySelector('script[type="module"]').src;
    const bytes = new Uint8Array(await (await globalThis.fetch(url)).arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return {
      file: new globalThis.URL(url).pathname.split("/").pop(),
      bytes: globalThis.btoa(binary),
    };
  });
  const servedEntry = { file: entry.file, sha256: hash(Buffer.from(entry.bytes, "base64")) };
  assert.equal(servedEntry.sha256, hash(await readFile(resolve("dist/assets", entry.file))));
  const check = async (name) => {
    const value = await invoke("get_island_snapshot");
    assert.equal(value.lastError, null);
    assert.deepEqual(value.hosts[0].placement.bounds, placement.bounds);
    assert.equal(value.inputWatcher.ownForegroundEvents, 0);
    checks.push({ name, snapshot: value });
    return value;
  };
  await wait(
    async () =>
      page.evaluate(() => globalThis.document.querySelector("main").dataset.islandState === "peek"),
    "Peek paint",
  );
  assert.equal((await page.locator(".island-morph").boundingBox()).width, 400);
  await screenshot("peek");
  await check("peek-owner");
  await invoke("island_surface_request", { state: "expanded" });
  await page.getByRole("navigation", { name: "Island modules" }).waitFor();
  await wait(
    async () => Math.abs((await page.locator(".island-morph").boundingBox()).width - 680) < 0.1,
    "Expanded morph",
  );
  await screenshot("expanded-nab");
  await check("expanded-owner");
  for (const tab of ["Notes", "Clipboard", "Files", "Media", "Timer"]) {
    await page
      .getByRole("navigation", { name: "Island modules" })
      .getByRole("button", { name: tab, exact: true })
      .evaluate((button) => button.click());
    await wait(
      async () =>
        page
          .getByRole("navigation", { name: "Island modules" })
          .getByRole("button", { name: tab, exact: true })
          .getAttribute("aria-pressed")
          .then((value) => value === "true"),
      `${tab} tab`,
    );
  }
  await page
    .getByRole("button", { name: "Clipboard", exact: true })
    .evaluate((button) => button.click());
  for (let i = 0; i < 36; i++)
    await invoke("add_clipboard_text", {
      content: `Saved surface snippet ${String(i).padStart(2, "0")}`,
    });
  await page
    .getByRole("navigation", { name: "Island modules" })
    .getByRole("button", { name: "Nab", exact: true })
    .evaluate((button) => button.click());
  await page
    .getByRole("navigation", { name: "Island modules" })
    .getByRole("button", { name: "Clipboard", exact: true })
    .evaluate((button) => button.click());
  await wait(
    async () =>
      page
        .locator(".island-clipboard-copy")
        .count()
        .then((count) => count === 36),
    "clipboard event refresh",
  );
  await page
    .getByRole("button", { name: "Text", exact: true })
    .evaluate((button) => button.click());
  await page.getByRole("textbox", { name: "Search clipboard", exact: true }).fill("Saved surface");
  await page.locator(".island-module-scroll").evaluate((element) => {
    element.scrollTop = 260;
    element.dispatchEvent(new globalThis.Event("scroll"));
  });
  await wait(
    async () =>
      page.evaluate(
        () =>
          JSON.parse(globalThis.localStorage.getItem("nabbit.island.ui.v1.island")).scroll
            .clipboard === 260,
      ),
    "scroll memory",
  );
  await screenshot("expanded-clipboard");
  await page
    .getByRole("button", { name: "Search", exact: true })
    .evaluate((button) => button.click());
  await page
    .getByRole("combobox", { name: "Search island", exact: true })
    .fill("remember this query");
  await wait(
    () =>
      page.evaluate(() => {
        const memory = JSON.parse(globalThis.localStorage.getItem("nabbit.island.ui.v1.island"));
        return memory.searchText === "remember this query" && memory.filters.searchOpen === "true";
      }),
    "persisted Search memory",
  );
  const memory = await page.evaluate(() =>
    JSON.parse(globalThis.localStorage.getItem("nabbit.island.ui.v1.island")),
  );
  await check("tab-filter-search-scroll");
  await writeFile(`${cursorPath}.surface`, JSON.stringify({ x: 1500, y: 900, leftDown: false }));
  await rename(`${cursorPath}.surface`, cursorPath);
  await invoke("island_surface_request", { state: "live" });
  await wait(async () => page.isClosed(), "WebView destruction after compact paint");
  let closed = await wait(async () => {
    const s = (await request({})).snapshot;
    return s.webviews === 0 && s;
  }, "zero compact WebViews");
  assert.equal(closed.surfaces.island.webOwner, false);
  checks.push({ name: "destroyed-on-collapse", snapshot: closed });
  await request({ surface: { label: "island", state: "expanded" } });
  await selectPage();
  await page.getByRole("combobox", { name: "Search island", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "Search island", exact: true }).inputValue(),
    memory.searchText,
  );
  await page
    .getByRole("button", { name: "Search", exact: true })
    .evaluate((button) => button.click());
  await page.getByRole("textbox", { name: "Search clipboard", exact: true }).waitFor();
  await wait(
    async () =>
      page
        .locator(".island-clipboard-copy")
        .count()
        .then((count) => count === 36),
    "restored clipboard",
  );
  assert.equal(
    await page.getByRole("textbox", { name: "Search clipboard", exact: true }).inputValue(),
    memory.filters.clipboardQuery,
  );

  await wait(
    async () =>
      page.locator(".island-module-scroll").evaluate((element) => element.scrollTop === 260),
    "restored scroll position",
  );
  assert.equal(
    await page.getByRole("button", { name: "Text", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  await check("restored-ui-memory");
  // Enter a drag with an injected physical cursor, never the user's mouse.
  await writeFile(
    `${cursorPath}.surface`,
    JSON.stringify({
      x: placement.bounds.x + 360 * placement.renderScale,
      y: placement.bounds.y + 80 * placement.renderScale,
      leftDown: true,
    }),
  );
  await rename(`${cursorPath}.surface`, cursorPath);
  await invoke("island_set_drag", { active: true });
  await invoke("island_surface_request", { state: "drop" });
  await page.locator("[data-drop-zone=shelf]").waitFor();
  await screenshot("drop");
  await check("drop-owner");
  await page.evaluate(() => {
    const input = globalThis.document.createElement("input");
    input.type = "file";
    input.id = "nabbit-owned-drop-fixture";
    input.style.display = "none";
    globalThis.document.body.append(input);
  });
  // WebView2 AdditionalObjects requires a disk-backed File, not Playwright's
  // memory-backed upload adapter. Use the same CDP seam as the V0 gate.
  const session = await page.context().newCDPSession(page);
  const { root: documentRoot } = await session.send("DOM.getDocument");
  const { nodeId } = await session.send("DOM.querySelector", {
    nodeId: documentRoot.nodeId,
    selector: "#nabbit-owned-drop-fixture",
  });
  await session.send("DOM.setFileInputFiles", {
    nodeId,
    files: [resolve(folder, `${prefix}-idle.png`)],
  });
  await session.detach();
  await page.evaluate(() => {
    const transfer = new globalThis.DataTransfer();
    transfer.items.add(globalThis.document.querySelector("#nabbit-owned-drop-fixture").files[0]);
    globalThis.document
      .querySelector("[data-drop-zone=note]")
      .dispatchEvent(
        new globalThis.DragEvent("dragenter", { bubbles: true, dataTransfer: transfer }),
      );
  });
  await page.locator("[data-drop-zone=note].is-over").waitFor();
  await page.evaluate(() => {
    const input = globalThis.document.querySelector("#nabbit-owned-drop-fixture"),
      data = new globalThis.DataTransfer();
    data.items.add(input.files[0]);
    const zone = globalThis.document.querySelector("[data-drop-zone=note]"),
      rect = zone.getBoundingClientRect();
    zone.dispatchEvent(
      new globalThis.DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      }),
    );
  });
  const draft = await wait(async () => {
    const value = await invoke("get_island_drop");
    return value?.payload?.files?.length && value;
  }, "native disk-backed file bridge");
  assert.equal(draft.zone, "note");
  assert.equal(
    draft.payload.files[0].toLowerCase(),
    resolve(folder, `${prefix}-idle.png`).toLowerCase(),
  );
  await check("disk-backed-file-selected-zone");
  await page.getByRole("heading", { name: "New note", exact: true }).waitFor();
  const text = "An isolated native drop note";
  const url = "https://example.invalid/dropped-video";
  for (const [kind, value, zone] of [
    ["text/plain", text, "note"],
    ["text/uri-list", url, "download"],
  ]) {
    // Enter through the real DOM listener so its drag/end latch follows the
    // same lifecycle as a user drag. A direct IPC-only true has no DOM latch.
    await page.evaluate(
      ({ kind, value }) => {
        const data = new globalThis.DataTransfer();
        data.setData(kind, value);
        globalThis.document
          .querySelector("main")
          .dispatchEvent(
            new globalThis.DragEvent("dragenter", { bubbles: true, dataTransfer: data }),
          );
      },
      { kind, value },
    );
    await page.locator(`[data-drop-zone=${zone}]`).waitFor();
    await page.evaluate(
      ({ kind, value, zone }) => {
        const data = new globalThis.DataTransfer();
        data.setData(kind, value);
        globalThis.document.querySelector(`[data-drop-zone=${zone}]`).dispatchEvent(
          new globalThis.DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: data,
          }),
        );
      },
      { kind, value, zone },
    );
    if (zone === "note") {
      await wait(
        async () => (await invoke("get_island_drop"))?.payload?.text === text,
        "native text draft",
      );
      await page.getByRole("heading", { name: "New note", exact: true }).waitFor();
    } else {
      await wait(
        async () => (await invoke("get_staged_url")) === url,
        "URL enters review without enqueue",
      );
      await page.getByRole("heading", { name: url, exact: true }).waitFor();
    }
    await check(zone === "note" ? "text-staged-for-note" : "URL-staged-for-review");
  }
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(folder, `${prefix}-webview.json`),
    JSON.stringify(
      {
        ownerProcessId: Number(ownerProcessId),
        servedEntry,
        checks,
        captures,
        memory,
        draft,
        errors,
        noDownloadsStarted: true,
        realCursorUntouched: true,
        source:
          "Actual release WebView2; native IPC, isolated SQLite and AdditionalObjects disk path",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  globalThis.console.log(
    `Verified ${checks.length} actual WebView2 ownership, tabs, memory and disk-file routing checks.`,
  );
} catch (error) {
  const detail =
    page && !page.isClosed()
      ? await page
          .evaluate(() => ({
            url: globalThis.location.href,
            notice: globalThis.document.querySelector(".island-notice")?.textContent,
            state: globalThis.document.querySelector("main")?.dataset.islandState,
            bridge: typeof globalThis.chrome?.webview?.postMessageWithAdditionalObjects,
            inputs: [...globalThis.document.querySelectorAll("input[type=file]")].map((input) =>
              [...input.files].map((file) => ({
                name: file.name,
                size: file.size,
                type: file.type,
              })),
            ),
          }))
          .catch(() => null)
      : null;
  await writeFile(
    resolve(folder, `${prefix}-failure.json`),
    JSON.stringify({ error: error.message, detail, checks, captures, errors }, null, 2) + "\n",
    { flag: "wx" },
  );
  throw error;
} finally {
  await browser.close();
}
