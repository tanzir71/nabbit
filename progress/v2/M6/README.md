# M6 — Downloads core (in progress)

This folder starts with **V3.1: Deno and engine health**. M6 is not published yet; the live landing remains M5. Options, capture paths and the Nab redesign follow in V3.2–V3.4.

## V3.1 behavior

- Deno joins yt-dlp and ffmpeg in Tauri's sidecars. Both setup wrappers use the same SHA-256-pinned manifest: yt-dlp **2026.11.23**, Deno **2.9.8**, and FFmpeg Builds **autobuild-2026-11-25-23-12**. Windows x64/ARM64 and Linux x64/ARM64 select their native assets; macOS keeps the existing ffmpeg-on-PATH setup, with an architecture check before copying its suffixed sidecar. Binaries remain gitignored.
- Metadata probes and downloads pass `--ignore-config --no-js-runtimes --js-runtimes deno:<resolved path>` as separate arguments. Missing Deno produces the typed `MissingJsRuntime` error. Runtime syntax was checked against the pinned executable's help and the [upstream EJS guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS).
- Rust owns cached health and a blocked daily scheduler. It probes all three versions, then attempts a **3-second** simulated extraction of the existing Creative Commons sample. No media is downloaded. Getters read cached state; Rust pushes updates to the tray/settings card and a single reserved island Error activity. Version probes have a separate **10-second** deadline, accommodating the measured 8.669-second cold yt-dlp start.
- Stable is the default yt-dlp channel. Check now, Repair and Stable/Nightly controls use asynchronous commands; operation work is serialized. Updates verify upstream asset digests, probe staged executables, atomically replace each binary and re-probe. Invalid checksums/candidates preserve the existing executable. Windows probes own a kill-on-close job; Unix probes use an owned process group.
- Health/channel/timestamps persist in SQLite. The legacy `engine_last_update_check` key is preserved. Island/spike acceptance disables the worker; legacy download acceptance performs local version probes only, with update/network extraction disabled. Its existing timestamp smoke now describes that local check. The complete download smoke is not claimed as newly run in this task; V3.7 owns that broader acceptance.
- The Figma health card is available in settings and when the download engine needs attention. The island's **“Download engine needs an update — Fix”** opens its review, which includes the card. Daily network behavior is disclosed in settings, README and the privacy statement. Clipboard contents/browser profiles are not used by the fixed sample check.

## Verification

`v31-acceptance.json` records the source fingerprints, sidecar hashes, checks and PNG audit. Associated logs include both accepted checks and earlier failures.

- **102 frontend/script tests**, typecheck, lint, icon/font/token checks and production build pass. The existing UI test's 5-second deadline is unchanged; Vitest uses two workers to avoid contention on this shared runner.
- Rust formatting, default and `island-spike` all-target Clippy with warnings denied, and **103 serial Rust tests** pass. Coverage includes all three version fixtures, unsupported versions, missing runtime/path arguments, daily boundaries/clock rollback, persisted channel/cache with no jobs, offline/time-out classification, corrupt checksum/candidate preservation, atomic replacement, actual process timeout and native error drawing/recovery.
- The optional real-sidecar smoke passes: yt-dlp **2026.11.23**, Deno **2.9.8**, ffmpeg **N-129306-g35ef294f5d-20261125**. It validates the pinned help flags and probes an actual staged/atomically replaced Deno. The sample extraction reaches its 3-second limit and is **skipped**; no successful online extraction is inferred.
- Fresh pinned Windows sidecar setup verifies all three existing executable bodies against newly downloaded, checked archives. Setup uses dated release URLs rather than a moving `latest` archive. Current executable fingerprints are recorded separately from archive digests.
- Initial island JavaScript is **89,648 / 120,000 gzip bytes**; the health card stays out of that initial closure.
- **16 repeat-identical PNGs** cover healthy/missing/offline cards and the compact island Error, light/dark at 1×/1.5×. All independently decode below 300,000 bytes; the largest is **65,762 bytes**. All **12 card contexts** pass default-rule axe with zero violations or incomplete results, and actual Geist/Geist Mono glyphs are verified.

Visual comparison uses Figma **18:260**, with the original CPU/check/refresh exports (`18:262`, `18:278`, `I18:310;5:428`) at their natural 18/16px sizes and the existing shared icon theme treatment. The healthy card retains **420×342 CSS pixels**, spacing and control geometry. Caption/secondary text uses the readable secondary token; the additional warning badge uses ink text after the initial warning color failed AA at 4.36:1. Shared palette values and original SVG files are unchanged. The prior contrast failure, UI timeout, too-short version deadline and Clippy failure remain in the earlier-attempt logs.

## Scope and limits

Only x64 Windows sidecars were executed here; other target assets were checked against upstream release metadata. Actual non-Windows/ARM64 runs, installers and signing are outside this Windows task. The existing V0/native frame/focus limitations remain; these captures establish engine UI behavior rather than a new performance classification. Capture paths, options, full queue/error redesign and download acceptance remain with their named V3 tasks.

Automated capture reproduction (choose a new prefix):

```powershell
npm run verify
node scripts/verify-engine-health.mjs v31-local
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
```

The optional `online_engine_smoke` Rust test uses only isolated data and public sidecars/sample; the network result is never a gate. No PR, tag, release, workflow edit/dispatch or milestone push is part of V3.1.
