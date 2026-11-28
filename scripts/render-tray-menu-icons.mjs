// Tauri's native menu takes pixels. Rasterize the original Figma SVGs at their
// intrinsic optical dimensions; never redraw their paths or capture a desktop.
import { chromium } from "playwright";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";
import process from "node:process";
const folder = fileURLToPath(new URL("../src/assets/tray/menu/", import.meta.url));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const rows = [];
  for (const file of (await readdir(folder)).filter((name) => name.endsWith(".svg")).sort()) {
    const svg = await readFile(resolve(folder, file));
    const result = await page.evaluate(
      async (source) => {
        const image = new globalThis.Image();
        image.src = source;
        await image.decode();
        const canvas = globalThis.document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext("2d").drawImage(image, 0, 0);
        return { width: canvas.width, height: canvas.height, url: canvas.toDataURL("image/png") };
      },
      `data:image/svg+xml;base64,${svg.toString("base64")}`,
    );
    const png = Buffer.from(result.url.split(",")[1], "base64");
    const output = resolve(folder, file.replace(/\.svg$/u, ".png"));
    if (process.argv.includes("--check")) {
      if (!png.equals(await readFile(output))) throw new Error(`Stale native menu export: ${file}`);
    } else await writeFile(output, png);
    rows.push({ file, width: result.width, height: result.height, bytes: png.length });
  }
  process.stdout.write(`${JSON.stringify(rows)}\n`);
} finally {
  await browser.close();
}
