import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { Buffer } from "node:buffer";
if (process.platform !== "win32" || process.arch !== "x64")
  throw Error("Install cargo-deny 0.22.2 on PATH for this platform.");
const name = "cargo-deny-0.22.2-x86_64-pc-windows-msvc.tar.gz";
const response = await globalThis.fetch(
  `https://github.com/EmbarkStudios/cargo-deny/releases/download/0.22.2/${name}`,
  { signal: globalThis.AbortSignal.timeout(180000) },
);
if (!response.ok) throw Error(`cargo-deny download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (
  createHash("sha256").update(bytes).digest("hex") !==
  "da696b3647f5a661d599807cadb13ed120e56fb421ee3ef113082c274194572c"
)
  throw Error("cargo-deny archive checksum mismatch");
const folder = fileURLToPath(new URL("../.tools/cargo-deny-0.22.2", import.meta.url));
await mkdir(folder, { recursive: true });
const archive = join(folder, name);
await writeFile(archive, bytes);
const entry = execFileSync("tar", ["-tf", archive], { encoding: "utf8", windowsHide: true })
  .split(/\r?\n/)
  .find((name) => name.endsWith("/cargo-deny.exe"));
if (!entry) throw Error("cargo-deny executable missing from archive");
await writeFile(
  join(folder, "cargo-deny.exe"),
  execFileSync("tar", ["-xOf", archive, entry], { maxBuffer: 30_000_000, windowsHide: true }),
);
globalThis.console.log("Installed checksum-verified cargo-deny 0.22.2 into .tools");
