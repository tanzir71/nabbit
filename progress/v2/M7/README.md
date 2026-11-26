# M7 — Downloads complete (in progress)

This folder starts with **V3.5: Options, Trim and Playlist sheets**. The live milestone remains M6. Full error mapping and download acceptance are V3.6/V3.7; M7 is a later, separate milestone push.

## V3.5 — Download sheets

Options, Trim and Playlist share an on-demand **460×680 CSS pixel** window, matching Figma **17:137**, **17:270** and **18:160**. Both tray and island controls open it. The window reuses the existing `index.html` entry, follows app light/dark preferences, loads download data without bootstrapping clipboard history, and destroys its WebView on close. It is opened and focused only from an explicit action. It adds no polling while the island is collapsed and keeps the four-entry build.

The Options sheet edits all six formats, probed quality/size/FPS, subtitle language and embed/file output, chapter markers/splitting, SponsorBlock off/mark/cut, thumbnail/metadata embedding, output folder, filename template, per-job browser choice and the Advanced speed limit. Change makes the output path editable in place. Remember for the canonical site uses the existing transactional preset service. Browser choice remains only in the sheet/runner's memory and is excluded from options, presets and history. Opening, editing, previewing or closing a sheet creates no download; its primary action or Ctrl+Enter is explicit. Unknown sizes stay unknown, including audio or incomplete playlist estimates.

Trim uses probe thumbnail(s), with the original gradient placeholders when no thumbnail is available. Its Play control explicitly opens the source website; YouTube previews include the current start timestamp. Two keyboard/pointer range handles snap to chapter boundaries within one second. Fields preserve millisecond `mm:ss(.f)` values and reject invalid, inverted or out-of-video ranges. Chapter chips toggle a union of ranges without filling gaps, and the length sums the selected sections. Downloaded range payloads contain only start/end values. Reset returns to the full video and turns Precise off. Advanced offers exact cuts and navigation back to Options; Options can enter Trim while retaining format/extras/browser choices. Range positions reflect actual duration and fractional timestamps, rather than the illustrative Figma percentages.

Playlist probing uses `--flat-playlist -J`, bounded to the first 1,000 entries, 8 MiB output and the existing owned-process deadline. The sheet shows the reported total, loaded entries, known/unknown estimates, original indices, durations and per-item availability. It supports Select all, none, sparse checkboxes and ranges such as `1–5` or `1,3,7`; invalid/unavailable selections cannot start a job. A truncated result explicitly states the loaded subset. All 18 fixture items remain reachable through the scrollable nine-row viewport. A bare playlist's First video action opens selection at item 1; a chosen range is carried into the picker.

The backend validates selection again and atomically persists **one independent job per selected video**, including each URL, title and options snapshot, before pumping the existing queue. A failed batch does not partially insert jobs or change its site preset. Individual failure/retry snapshots survive reopening SQLite, and other queued items remain independent. All actionable jobs are listed, including playlists larger than the old 200-row cap; only finished history is limited to 200 rows. The browser selection is injected per job in memory. Full fake/native runner and real-media acceptance remains V3.7.

Each modal traps Tab/Shift+Tab, supports Escape and Ctrl+Enter, and exposes native labeled controls. A busy guard prevents duplicate starts. A successful enqueue keeps its submitted guard even if closing fails. Pushed intents supersede delayed initial reads, and a completed older enqueue closes only its own intent, preserving a newer review.

A failed metadata probe keeps the single-link Options/browser chooser usable and shows the problem. It does not invent duration, playlist entries or size estimates, so missing data cannot enable Trim or playlist selection.

## Design and evidence

High-fidelity contexts and screenshots were fetched for all three requested Figma nodes. Eleven unmodified original SVG exports retain intrinsic geometry; the shared Toggle and Select reuse byte-identical original assets. Shared Button, IconButton, PresetChip, Field and Select components are composed rather than redrawn. Headings use bundled Geist 600/14px/20px; numeric values use actual Geist Mono. Scoped readable captions preserve shared palette tokens. The Options body's overflow is scrollable, allowing access to the clipped signed-in row and Advanced controls while the footer stays fixed.

The first captures exposed two unlabeled group roles and an indeterminate-checkbox contrast ambiguity; explicit group roles and a CSS mixed-state bar resolve them. A small select-label font mismatch was corrected to Figma's 13px. Earlier missing test-theme stubs, an ES2020 string-method mismatch, script lint errors and the chapter-title payload failure are retained separately from accepted checks. Historical captures are superseded evidence; only the final reports below bind to the accepted build.

Strict repeated Trim captures intermittently differed at 38 rounded-edge pixels, with a maximum channel delta of 2. Playwright's default `caret: "hide"` injects and removes inline input styles. Keeping `caret: "initial"` after focusing the dialog avoids that mutation: four isolated contexts and all sixteen sheet contexts passed five strict comparisons each. Renderer-flag experiments were rejected. The production harness accepts this policy only with non-text focus; its default remains unchanged. No image normalization, pixel tolerance, assertion weakening or timeout increase was used. The diagnostic hashes, pixel report, experimental source and rejected results are retained in `v35-capture-diagnosis.json` and `v35-earlier-attempts.json`. The overwritten temporary diagnostic PNG pair is not presented as the original pair.

Accepted checks: `npm run verify` (**149 tests**), Rust formatting, default and island-spike all-target Clippy with warnings denied, and **143 serial Rust tests** (two existing opt-in tests ignored). The final `v35-complete-screenshots.json` and `v35-nab-complete-screenshots.json` contain **32 repeat-identical PNGs**, covering light/dark and 1×/1.5× (island always dark). `v35-png-audit.json` independently decodes and verifies dimensions, hashes and the strict **300,000-byte** cap for these and all **120 retained V3.5 PNGs** (largest **169,766 bytes**). All sixteen sheet axe scopes have no violations or incompletes. Sixteen Nab scopes have no violations; four existing gradient-duration incompletes retain M6's measured 7.8668:1 worst-case contrast proof. This is scoped evidence, not a whole-app conformance claim.

`v35-acceptance.json` pins the checked sources, documents, build manifest, four-entry bundle budget (**90,409/120,000 initial island gzip bytes**) and local CLI parser proof. The pinned yt-dlp binary recognizes the bounded playlist flag without accessing any URL or profile. No real browser profile, media download, native sheet click, installer, signing, Tack account or display-setting change is claimed. Existing V0/V2.7 native frame/focus/performance limitations are retained.

## Automated reproduction

Use unused screenshot prefixes. These are automated checks, not manual acceptance steps.

```powershell
npm run verify
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features island-spike -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
node scripts/verify-download-sheets.mjs v35-local
node scripts/verify-nab-views.mjs v35-local-nab M7
```

V3.5 is committed directly to main with `[skip ci]`. No PR, tag, release, workflow edit/dispatch or push belongs to this task pass.
