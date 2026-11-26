# M6 — Downloads core (in progress)

This folder contains **V3.1: Deno and engine health** and **V3.2: download options and per-site presets**. M6 is not published yet; the live landing remains M5. Capture paths and the Nab redesign follow in V3.3–V3.4.

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

## V3.2 — Options builder and per-site presets

The queue now uses a pure, validated `download/options.rs` builder. It covers every §7.3 mapping: MP4/MKV/WebM height-capped selectors and merge formats; MP3 320K/M4A/Opus; subtitles; chapters; SponsorBlock; artwork/metadata; filenames; job-scoped browser sign-in; trim unions and precise cuts; playlist ranges/indices; and speed limits. No command shell is used. The probe returns estimated sizes per height from exact/approximate sizes or bitrates, includes separate audio where known, and leaves unknown totals empty. Storyboard and DRM formats are excluded from estimates.

Each new job stores its normalized options snapshot, including its folder/template. Pause, retry and restart retain that snapshot; old jobs without one still use the legacy quality/settings path. The runner consumes the builder and recognizes the final `after_move` filepath, including audio and non-MP4 outputs. Browser choice stays in the job's in-memory runner map, separate from serialized options/history/presets; no cookie-file output argument is added. Only argument strings are tested for browser modes—real browser profiles are never opened.

`download_presets` stores one reusable choice per canonical host. HTTP/HTTPS validation, one `www.` prefix and the known YouTube aliases define a site; other subdomains stay separate. Default choices are MP4 1080p, MP4 720p, MP3 320, M4A and Custom. Remembering strips the current video's ranges/precision, playlist selection and job folder. Saving a job and its remembered choice is transactional. Reading/remembering a choice cannot enqueue a job. The existing quick-download command/shortcut and a dedicated explicit-start command resolve the saved choice; the new Ctrl+Alt+D binding/capture path follows in V3.3. Typed frontend APIs and an isolated browser preview are available for the later Nab/sheet work.

Verification is recorded in `v32-acceptance.json` and the `v32-*` logs:

- **107 frontend/script tests**, typecheck, lint, icon/font/token checks and production build pass.
- Rust formatting, default/spike all-target Clippy with warnings denied and **124 serial Rust tests** pass. The two provisioned-engine/online tests remain opt-in; the new pinned-parser test is explicitly run and passes.
- **Eight generated option cases** are accepted by the actual pinned **yt-dlp 2026.11.23** executable in `--help` mode. The complete captured help, executable digest, argument arrays and [pinned upstream reference](https://github.com/yt-dlp/yt-dlp/blob/2026.11.23/README.md) are retained. This checks parser syntax without media transfer, network extraction, postprocessing or profile access; it does not replace V3.7's download acceptance.
- Exact argument-vector tests cover every mapping, both subtitle modes, all chapter/SponsorBlock modes, all four browser choices, fractional ranges, range union, filename/path spacing, safe multi-range names and height-capped fallback. Time fields support mm:ss(.f); malformed rates, ranges and templates are rejected before queue work.
- DB tests prove old-schema migration is repeatable without losing the existing job, presets survive reopen and remain site-isolated, option snapshots survive state updates/reopen, failed duplicate/invalid enqueues preserve the preset, and remembering itself creates no job.
- Initial island JavaScript is **89,643 / 120,000 gzip bytes**. This backend/API pass changes no TSX/CSS view, so it adds no screenshots. V3.1's 16 captures remain intact; Nab and options-sheet visuals are V3.4/V3.5.

Earlier compile/borrow, argument-order, transport-expectation and Clippy failures are retained separately from the accepted checks. Log trailing whitespace is normalized for Git; original log hashes are recorded. Source fingerprints use LF normalization only. SponsorBlock's opt-in network behavior and cookie-file/preset boundaries are reflected in the privacy statement. No performance gate, milestone, PR, tag, release or workflow state is reclassified by this task.
