// Shared setup: every sidecar body must match its checked-in SHA-256 pin.
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { readFile, mkdir, writeFile, rename, rm, mkdtemp, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pins = JSON.parse(await readFile(join(root, "scripts/engine-pins.json"), "utf8"));
const target = process.argv[2];
const force = process.argv.includes("--force");
if (!pins.targets[target]) throw Error(`Unsupported sidecar target: ${target}`);
const bin = join(root, "src-tauri/binaries");
await mkdir(bin, { recursive: true });
for (const [name, asset] of Object.entries(pins.targets[target])) {
  const ext = target.includes("windows") ? ".exe" : "";
  const output = join(bin, `${name}-${target}${ext}`);
  const archive = await globalThis.fetch(asset.url, {
    signal: globalThis.AbortSignal.timeout(180000),
  });
  if (!archive.ok) throw Error(`Download failed for ${name}: ${archive.status}`);
  const bytes = Buffer.from(await archive.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw Error(`${name} checksum mismatch; existing sidecar kept`);
  const temp = await mkdtemp(join(bin, ".engine-"));
  try {
    const staged = join(temp, `${name}${ext}`);
    if (name === "deno" || name === "ffmpeg") {
      const zip = join(temp, asset.url.endsWith(".zip") ? "archive.zip" : "archive.tar.xz");
      await writeFile(zip, bytes);
      if (name === "ffmpeg") {
        const entries = execFileSync("tar", ["-tf", zip], { encoding: "utf8", windowsHide: true })
          .trim()
          .split(/\r?\n/);
        const entry = entries.find((p) => p.endsWith(`/bin/ffmpeg${ext}`));
        if (!entry) throw Error("ffmpeg executable missing from archive");
        const executable = execFileSync("tar", ["-xOf", zip, entry], {
          maxBuffer: 180_000_000,
          windowsHide: true,
        });
        if (
          asset.executableSha256 &&
          createHash("sha256").update(executable).digest("hex") !== asset.executableSha256
        )
          throw Error("ffmpeg executable checksum mismatch; existing sidecar kept");
        await writeFile(staged, executable);
      } else {
        if (process.platform === "win32") {
          execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Expand-Archive -LiteralPath $env:NABBIT_SETUP_ARCHIVE -DestinationPath $env:NABBIT_SETUP_DEST",
            ],
            {
              env: { ...process.env, NABBIT_SETUP_ARCHIVE: zip, NABBIT_SETUP_DEST: temp },
              windowsHide: true,
              stdio: "inherit",
            },
          );
        } else execFileSync("unzip", ["-q", zip, `deno${ext}`, "-d", temp], { stdio: "inherit" });
      }
    } else await writeFile(staged, bytes);
    await chmod(staged, 0o755);
    const existing = await readFile(output).catch(() => null);
    if (!force && existing?.equals(await readFile(staged))) {
      globalThis.console.log(`Verified existing ${name}-${target}${ext}`);
      continue;
    }
    // Same-volume rename replaces atomically; no unlink of the working sidecar.
    await rename(staged, output);
    globalThis.console.log(`Installed verified ${name}-${target}${ext}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
if (!pins.targets[target].ffmpeg) {
  // Preserve the existing macOS setup path; Tauri needs a suffixed sidecar
  // even when a native ffmpeg is already installed on PATH.
  const output = join(bin, `ffmpeg-${target}`);
  if (process.platform === "darwin") {
    const source = execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
    const architecture = target.startsWith("aarch64") ? "arm64" : "x86_64";
    execFileSync("lipo", ["-verify_arch", architecture, source]);
    const temp = await mkdtemp(join(bin, ".engine-"));
    try {
      const staged = join(temp, "ffmpeg");
      const bytes = await readFile(source);
      await writeFile(staged, bytes);
      await chmod(staged, 0o755);
      if (!(await readFile(staged)).equals(bytes)) throw Error("ffmpeg copy did not match");
      await rename(staged, output);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    globalThis.console.log(`Copied native ffmpeg-${target} from PATH`);
  } else {
    await readFile(output); // Cross builds must already have a target ffmpeg.
  }
}
