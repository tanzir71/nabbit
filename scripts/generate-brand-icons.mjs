import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import console from "node:console";

// Rasterize the original Figma exports with the already installed Tauri CLI.
// Small sizes use their own optical variant, never a downsampled large tile.
const folder = "src-tauri/icons";
const check = process.argv.includes("--check");
function emit(path, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (check) {
    if (!readFileSync(path).equals(bytes)) throw new Error(`Stale brand asset: ${path}`);
  } else writeFileSync(path, bytes);
}
mkdirSync(folder, { recursive: true });
const images = new Map();
for (const variant of ["app", "tray"]) {
  const sizes = variant === "app" ? [16, 24, 32, 64, 128, 256, 512, 1024] : [16, 24];
  for (const size of sizes) {
    const sourceSize = Math.min(size, 128);
    const source = `src/assets/brand/${variant}-${sourceSize}.svg`;
    const output = resolve(".tools/brand-icons", `${variant}-${size}`);
    const result = spawnSync(
      process.execPath,
      ["node_modules/@tauri-apps/cli/tauri.js", "icon", source, "--png", `${size}`, "-o", output],
      { windowsHide: true, encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message);
    const png = readFileSync(resolve(output, `${size}x${size}.png`));
    images.set(`${variant}-${size}`, png);
    const name = variant === "app" ? `${size}x${size}.png` : `tray-${size}.png`;
    emit(`${folder}/${name}`, png);
  }
}
emit(`${folder}/128x128@2x.png`, images.get("app-256"));
emit(`${folder}/icon.png`, images.get("app-512"));

// ICO PNG frames are supported on every targeted Windows version (10 1809+).
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
// 48 px uses the 24 px optical variant rendered at 2x, not a resized bitmap.
const result = spawnSync(
  process.execPath,
  [
    "node_modules/@tauri-apps/cli/tauri.js",
    "icon",
    "src/assets/brand/app-24.svg",
    "--png",
    "48",
    "-o",
    ".tools/brand-icons/app-48",
  ],
  { windowsHide: true, encoding: "utf8" },
);
if (result.status !== 0) throw new Error(result.stderr || result.error?.message);
images.set("app-48", readFileSync(".tools/brand-icons/app-48/48x48.png"));
emit(`${folder}/48x48.png`, images.get("app-48"));
const directory = Buffer.alloc(6 + 16 * icoSizes.length);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(icoSizes.length, 4);
let offset = directory.length;
const frames = icoSizes.map((size, i) => {
  const png = images.get(`app-${size}`);
  const entry = 6 + 16 * i;
  directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(png.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += png.length;
  return png;
});
emit(`${folder}/icon.ico`, Buffer.concat([directory, ...frames]));

// Standard PNG-backed ICNS types, preserving the corresponding small variants.
const icnsFrames = Object.entries({
  icp4: 16,
  icp5: 32,
  icp6: 64,
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
}).map(([type, size]) => {
  const png = images.get(`app-${size}`);
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([header, png]);
});
const header = Buffer.alloc(8);
header.write("icns", 0, "ascii");
header.writeUInt32BE(8 + icnsFrames.reduce((total, frame) => total + frame.length, 0), 4);
emit(`${folder}/icon.icns`, Buffer.concat([header, ...icnsFrames]));
emit("docs/assets/favicon.svg", readFileSync("src/assets/brand/app-32.svg"));
emit("docs/assets/favicon.ico", Buffer.concat([directory, ...frames]));

const nodes = {
  "app-16": "12:457",
  "app-24": "12:460",
  "app-32": "12:463",
  "app-64": "12:466",
  "app-128": "12:469",
  "tray-16": "12:472",
  "tray-24": "12:475",
};
const sources = Object.entries(nodes).map(([name, node]) => ({
  file: `${name}.svg`,
  node,
  size: Number(name.split("-")[1]),
  sha256: createHash("sha256")
    .update(readFileSync(`src/assets/brand/${name}.svg`))
    .digest("hex"),
}));
emit(
  "src/assets/brand/manifest.json",
  JSON.stringify(
    {
      figmaFile: "tBm7NNhh1Y9aTQPJ3WxY5v",
      component: "12:478",
      sources,
      renderer: "Tauri CLI (locked in package-lock.json); unchanged SVG sources",
      trayDark:
        "White RGB with original alpha; taskbar SystemUsesLightTheme, independent of app appearance",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `${check ? "Verified" : "Generated"} desktop app icons, optical tray glyphs and site favicons.`,
);
