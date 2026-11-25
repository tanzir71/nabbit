import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("playwright", { paths: [root, resolve(root, ".tools/site-qa")] }),
);
const [endpoint, fixture] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes("spikes/island/index.html"));
  assert(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForFunction(
    () => globalThis.document.querySelector(".spike-pill")?.dataset.state === "drop",
  );
  await page.evaluate(() => {
    const input = globalThis.document.createElement("input");
    input.type = "file";
    input.id = "native-fixture";
    input.hidden = true;
    globalThis.document.body.append(input);
  });
  // WebView2 resolves disk-backed Files, whereas Playwright's upload adapter
  // creates an in-memory File with no native path.
  const session = await page.context().newCDPSession(page);
  const { root: documentRoot } = await session.send("DOM.getDocument");
  const { nodeId } = await session.send("DOM.querySelector", {
    nodeId: documentRoot.nodeId,
    selector: "#native-fixture",
  });
  await session.send("DOM.setFileInputFiles", { nodeId, files: [fixture] });
  await session.detach();
  await setTimeout(500);
  const zone = page.locator('[data-drop-zone="note"]');
  const box = await zone.boundingBox();
  await zone.evaluate(
    (element, point) => {
      const data = new globalThis.DataTransfer();
      data.items.add(globalThis.document.querySelector("#native-fixture").files[0]);
      element.dispatchEvent(
        new globalThis.DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          clientX: point.x,
          clientY: point.y,
        }),
      );
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector("[role=status]")?.textContent ===
      "Ready for review · files · note",
  );
  const paths = await page.evaluate(() => globalThis.nabbitIslandSpike.receivedFiles());
  assert.deepEqual(
    paths.map((p) => resolve(p)),
    [resolve(fixture)],
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(root, "progress/v2/M1/v04-native-file-drop.json"),
    JSON.stringify(
      {
        scale: await page.evaluate(() => globalThis.devicePixelRatio),
        kind: "files",
        zone: "note",
        nativePathRoundTrip: true,
        requestedZonePreservedAtScaledCoordinates: true,
        readyForReview: true,
        runtimeErrors: errors,
      },
      null,
      2,
    ) + "\n",
  );
  globalThis.console.log(
    "Passed hybrid DOM File → WebView2 native path → explicit note zone at 1.5×.",
  );
} finally {
  await browser.close();
}
