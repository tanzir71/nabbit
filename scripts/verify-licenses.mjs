import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../", import.meta.url));
const local = join(root, ".tools/cargo-deny-0.22.2/cargo-deny.exe");
const deny = existsSync(local) ? local : "cargo-deny";
const run = (exe, args) =>
  execFileSync(exe, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8_000_000,
  });
run("python", ["-X", "utf8", "scripts/generate-licenses.py", "--check"]);
const config = join(root, "deny.toml");
const policy = readFileSync(config, "utf8");
assert(!/"(?:A?GPL|LGPL)-/.test(policy), "GNU copyleft licences must never be allowed");
const output = run(deny, [
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "--config",
  config,
  "--locked",
  "--offline",
  "check",
  "licenses",
  "bans",
]);
process.stdout.write(output);
const base = mkdtempSync(join(root, ".tools/v57-license-fixtures-"));
const outcomes = [];
for (const [name, license] of [
  ["gpl-fixture", "GPL-3.0-only"],
  ["agpl-fixture", "AGPL-3.0-only"],
  ["lgpl-fixture", "LGPL-2.1-only"],
  ["ffmpeg-next", "MIT"],
]) {
  const dir = join(base, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  const manifest = join(dir, "Cargo.toml");
  writeFileSync(
    manifest,
    `[package]\nname = "${name}"\nversion = "0.0.1"\nedition = "2021"\nlicense = "${license}"\n[workspace]\n`,
  );
  writeFileSync(join(dir, "src/lib.rs"), "pub fn fixture() {}\n");
  run("cargo", ["generate-lockfile", "--offline", "--manifest-path", manifest]);
  let rejected = false;
  try {
    run(deny, [
      "--manifest-path",
      manifest,
      "--config",
      config,
      "--locked",
      "--offline",
      "check",
      "licenses",
      "bans",
    ]);
  } catch (error) {
    const diagnostic = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    writeFileSync(join(dir, "diagnostic.txt"), diagnostic);
    rejected =
      error.status !== 0 &&
      (license === "MIT"
        ? diagnostic.includes("explicitly banned")
        : diagnostic.includes("not explicitly allowed"));
  }
  assert(rejected, `The policy must reject ${name} (${license})`);
  outcomes.push({ name, license, rejected });
}
process.stdout.write(
  `${JSON.stringify({ cargoDeny: run(deny, ["--version"]).trim(), generatedNotices: true, corePolicyPassed: true, negativeFixtures: outcomes })}\n`,
);
