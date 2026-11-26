// Optional public engine smoke: never loads config, cookies or a browser profile.
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const root = fileURLToPath(new URL("../", import.meta.url));
const prefix = process.argv[2] ?? "v37-online";
assert(/^[a-z0-9-]+$/.test(prefix));
const trial = resolve(root, `.tools/${prefix}-${randomUUID()}`);
await mkdir(trial, { recursive: true });
const binary = (name) => resolve(root, `src-tauri/binaries/${name}-x86_64-pc-windows-msvc.exe`);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const sample = "https://www.youtube.com/watch?v=e6rhUvwB5Y8";
const invocations = [];
function run(exe, args, timeout = 45000) {
  const started = Date.now();
  const value = spawnSync(exe, args, {
    cwd: trial,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 4000000,
  });
  const result = {
    executable: exe,
    args,
    exitCode: value.status,
    signal: value.signal,
    elapsedMs: Date.now() - started,
    stdout: value.stdout ?? "",
    stderr: value.stderr ?? "",
    error: value.error?.message ?? null,
  };
  invocations.push(result);
  return result;
}
const common = [
  "--ignore-config",
  "--no-playlist",
  "--socket-timeout",
  "12",
  "--retries",
  "0",
  "--extractor-retries",
  "0",
  "--no-js-runtimes",
];
const runtime = ["--js-runtimes", `deno:${binary("deno")}`];
const without = run(binary("yt-dlp"), [...common, "-F", sample]);
const withDeno = run(binary("yt-dlp"), [...common, ...runtime, "-F", sample]);
const formatCount = (result) =>
  result.exitCode === 0
    ? result.stdout.split(/\r?\n/).filter((line) => /^\S+\s+(?:mp4|webm|m4a|mhtml)\s/.test(line))
        .length
    : null;
const counts = { withoutDeno: formatCount(without), withDeno: formatCount(withDeno) };
let duration = null,
  outcome = "upstream-unavailable",
  reason;
const trimmed = run(
  binary("yt-dlp"),
  [
    ...common,
    ...runtime,
    "--ffmpeg-location",
    binary("ffmpeg"),
    "-f",
    "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]",
    "--merge-output-format",
    "mp4",
    "--download-sections",
    "*0-5",
    "--force-keyframes-at-cuts",
    "-o",
    resolve(trial, "sample.%(ext)s"),
    sample,
  ],
  120000,
);
if (trimmed.exitCode === 0) {
  const file = (await readdir(trial)).find((name) => name === "sample.mp4");
  assert(file, "Successful trim did not produce the requested MP4");
  const ffprobe = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", "(Get-Command ffprobe -ErrorAction Stop).Source"],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  const probe = run(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", resolve(trial, file)],
    15000,
  );
  assert.equal(probe.exitCode, 0);
  duration = Number(JSON.parse(probe.stdout).format.duration);
  assert(
    Number.isFinite(duration) && duration >= 4.5 && duration <= 5.5,
    `Trim duration ${duration} is outside 5±0.5 seconds`,
  );
  outcome = "passed";
} else {
  reason =
    "Public sample extraction/download was unavailable; retained exact process diagnostics. Optional, never an acceptance gate.";
}
const report = {
  outcome,
  reason,
  scope:
    "Pinned engine CLI with a public sample; native queue/IPC is verified separately with isolated fixtures",
  sample,
  trial,
  counts,
  duration,
  requestedDuration: 5,
  toleranceSeconds: 0.5,
  invocations,
  binaries: await Promise.all(
    ["yt-dlp", "deno", "ffmpeg"].map(async (name) => ({
      name,
      sha256: hash(await readFile(binary(name))),
    })),
  ),
  noConfig: true,
  noCookies: true,
  noBrowserProfile: true,
  optionalNeverGate: true,
};
await writeFile(
  resolve(root, `progress/v2/M7/${prefix}.json`),
  JSON.stringify(report, null, 2) + "\n",
  { flag: "wx" },
);
globalThis.console.log(
  `Optional public download: ${outcome}; format counts ${JSON.stringify(counts)}; duration=${duration}`,
);
