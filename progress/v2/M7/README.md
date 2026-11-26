# M7 — Downloads complete (in progress)

This folder contains **V3.5: Options, Trim and Playlist sheets** and **V3.6: error mapping and recovery**. The live milestone remains M6. Full downloader acceptance is V3.7; M7 is a later, separate milestone push.

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

## V3.6 — Plain-language download errors

`download/errors.rs` owns all nine ErrorKinds, titles, descriptions and recovery actions. Both loaded SQLite rows and pushed updates include that typed description; the activity bus uses the same classifier. The tray shows the full message and at most two actions. Expanded island rows share that component, and the compact Error surface names the problem with its existing Fix action. The reserved engine-health activity retains its own copy.

Twenty-one sanitized stderr fixtures cover sign-in/age/member restrictions, 403/nsig/PO-token failures, missing Deno, unavailable formats, DRM/encryption, disk/permissions/path limits, network failures, live/upcoming streams and unknown traces. Terminal errors take priority over unrelated warnings. A missing-runtime warning plus unavailable formats identifies the helper problem; a harmless PO-token warning does not mask an unrelated terminal error. DRM matching excludes incidental IDs and DRM-free copy. Fixtures are representative test inputs; they do not claim live account, browser-profile or media failures were induced for this task.

The UI never derives display text from the raw log. Copy details invokes a job-specific native clipboard writer only after its button is clicked. The runner stores decoded stderr text without whitespace trimming and drains it concurrently with stdout so a long failure cannot fill that pipe. The injected clipboard and SQLite tests check unmodified stored text, including line endings, without changing the system clipboard. Final UI inputs include an unknown error containing a traceback, which must stay absent from the rendered DOM.

Browser sign-in offers Chrome, Edge, Firefox and Brave explicitly for that job, with Chrome as the Figma default. Its choice remains in the manager's memory and reaches both the replay preflight and the downloader; ordinary metadata probes omit browser access. Pure argument tests cover all four choices without reading profiles. Retry, best available, folder changes and Options update the existing row and its validated options snapshot; they create no duplicate row and change no site preset. Choose opens the existing Options sheet with the original job ID and a Retry download action, omitting the remember-site control. Folder choice uses an inline path editor. Already active/completed jobs and DRM recovery are rejected in Rust. Format failures now wait for an explicit choice; the existing one-attempt merge fallback remains separate.

Update engine and Install Deno use the existing checksum/atomic repair service and retry the same job only after a successful result. Failed or incomplete repair shows a short status without exposing its log. Skip for now and DRM's sole OK action acknowledge the problem and dismiss its island activity; they do not attempt a workaround. Show fix can reopen the row's controls later, including after the helper is repaired elsewhere.

Offline recovery uses one Rust scheduler. With no deferred jobs it blocks indefinitely; with pending work it checks after 30 seconds. A bounded five-second HEAD request to that job's origin establishes connectivity from any HTTP response, including 403/405, without cookies, an external connectivity service or reading a response body. Cancel removes the pending request; automatic recovery revalidates eligibility under the manager lock. The local HTTP fixture checks HEAD-only/no-cookie behavior and disconnects, without public-network traffic. No collapsed JavaScript polling is added.

Download when it ends sets a job-only replay-wait option. Bounded metadata probes distinguish live/upcoming/processing from an ended/nonlive replay; missing status cannot start recording. The builder passes `--wait-for-video 30`, `--match-filter !is_live` and `--break-on-reject`. The pinned [yt-dlp extraction/wait implementation](https://github.com/yt-dlp/yt-dlp/blob/2026.11.23/yt_dlp/YoutubeDL.py) waits for scheduled availability, so the separate replay check is necessary. These flags are accepted by the actual pinned CLI's parser with no URL/profile/media access. The wait option is removed from remembered presets. Waiting remains cancellable and releases the queue slot between attempts.

Figma **18:330** supplied a full context and screenshot. Eleven unmodified original SVG exports retain their 16×16 or 14×14 geometry, with no byte-identical existing export to substitute. Shared Button, Select, Field and DesignIcon components render them. The 480px catalogue examples adapt to the actual 426px tray row; their kind label, 13/18 medium title, 12/16 caption, 10px gaps and 12px inset message padding are retained. The catalogue's raw-pattern documentation line is omitted from the product row. Both themes use shared tokens, with neutral messages for DRM/offline/live. The new browser selector supports the specified browser-specific action.

Final `npm run verify` passes **175 tests**. Rust formatting, default and island-spike all-target Clippy with warnings denied, and **152 serial Rust tests** pass (two existing opt-in tests ignored). Results are pinned in `v36-checks.json`.

`v36-checked-screenshots.json` contains **76 repeat-identical error/acknowledgement captures** (all nine tray kinds, all nine compact kinds and the acknowledged/reopened state × light/dark × 1×/1.5×). `v36-sheets-checked-screenshots.json` and `v36-nab-checked-screenshots.json` add **32 regressions**. All **108 final PNGs** and **284 retained PNGs** independently decode and match their dimensions/hashes under the strict **300,000-byte** cap (largest **169,766 bytes**). All reports bind to the same final build manifest. Initial island JavaScript is **90,605/120,000 gzip bytes**, with four HTML entries and no app-store import in the initial island graph.

The 76 error/acknowledgement and sixteen sheet axe scopes have no violations or incompletes. Sixteen Nab scopes have no violations; four existing gradient-duration incompletes retain M6's measured 7.8668:1 contrast bound. This is scoped evidence, not whole-app conformance. Original asset geometry and actual bundled fonts are audited in both scales/themes. The island remains dark in every theme context.

Earlier compiler/default errors and successful superseded runs are retained in `v36-earlier-attempts.json`. The first capture selection let a later classifier edge case replace the explicit unknown traceback example; final fixtures preserve the first example per kind. Acknowledgement reopening was added after the intermediate captures. The final checked reports, source/document fingerprints, local parser proof and independent image audit are authoritative in `v36-acceptance.json`.

The task uses unit/injected-provider and headless browser evidence. It does not claim native button clicks, real browser profiles, account sign-in, public-network media, installer/signing, display changes or a new native frame/focus/performance measurement. V3.7 owns full downloader/native fake-runner acceptance and the landing download visual. Existing V0/V2.7 limitations remain open. V3.6 is a local skip-ci task commit on main; M7 publication remains separate.

Automated reproduction (use new screenshot prefixes):

```powershell
npm run verify
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features island-spike -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
node scripts/verify-download-errors.mjs v36-local-errors
node scripts/verify-download-sheets.mjs v36-local-sheets
node scripts/verify-nab-views.mjs v36-local-nab M7
```


## V3.7 — Downloader acceptance and real landing captures

`v37-acceptance.json` is the task receipt. Nine native cases use the unsigned release executable with its packaged custom protocol, real SQLite/Tauri IPC, actual tray and playlist windows, and the v0.1 fake runner. Injected clipboard text enters the production consumer; synthetic DataTransfer drops enter the tray DOM; a second owned executable forwards a valid URI through the real single-instance/deep-link plugin. Malformed, non-web and JavaScript targets are rejected. Passive paths do not enqueue. Ctrl+Alt+D is the explicit remembered-preset download action established by §7.1 and the V3.3 decision.

The native flow saves a custom per-site preset, restarts the process, checks hotkey resolution, exercises rapid pause/resume/cancel/retry, selects playlist videos 1–5 in the real native sheet, retries only the failed third item without changing the other four rows/files, and verifies history after another restart. Job generations now guard old worker updates and cleanup. The native test exposed a synchronous sheet-constructor deadlock; creation now runs from an async command on a blocking worker, matching the [Tauri 2.12.7 Windows constructor guidance](https://docs.rs/tauri/2.12.7/tauri/webview/struct.WebviewWindowBuilder.html).

The extended PowerShell smoke passes fourteen checks, including retention, exclusions, sensitive input, deduplication, progress/speed/ETA, concurrency, cancel/retry, persistence and deep-link review without enqueue. It waits for the owned command consumer after restart rather than treating an old DB as readiness. The short progress predicate observes every field in one SQLite snapshot. The injected mode leaves the system clipboard and global keys untouched. The five-second legacy idle sample is not a new V0/V2.7 performance measurement.

`npm run verify` passes 175 tests; final lint passes after capture-tool changes. Rust fmt, default/spike all-target Clippy with warnings denied and 152 serial tests pass (two existing opt-in tests ignored). The pinned yt-dlp executable also accepts eight combined help-only option mappings with no URL, cookies or profile. Existing exact-argument tests cover every §7.3 row; all nine ErrorKinds and three engine-version fixtures/MissingJsRuntime are exercised by the fresh unit suites.

The optional public sample run succeeds with the pinned engines: ffprobe reports **5.0 seconds** for the requested five-second trim; `yt-dlp -F` lists **47 formats without Deno and 48 with Deno** in this run. `v37-online.json` retains exact arguments, process output and binary hashes. This is CLI media evidence, separate from the native fake-runner integration. No real browser profile or sign-in was used.

The landing downloads section now uses actual owned-release WebView2 captures: **920×1360 tray** and **864×280 Peek**, including the full Peek and its transparent margin. Both repeat exactly and have independently checked PNG headers. `docs/assets/download-capture.json` binds them to the executable and source reports; `generate-download-visual.py --check` proves decoded RGBA equality with the lossless WebPs. There is no raster resizing, redrawing or retouching. CSS follows Figma **27:499** (596×560 desktop stage, 0.78 tray) and **31:1036** (328px mobile Peek, 0.82 scale), within the existing site's gutters. The visible caption identifies fixture data. The original illustration and SVG bytes remain archived and hash-checked.

Eight landing contexts verify light/dark at 1×/1.5×, actual custom fonts, source-image bytes and geometry, keyboard disclosures and bookmarklet success/failure. Twenty-four axe scans retain all default rules; every incomplete has the existing explicit contrast proof, with no added exception. The mobile capture caption reserves 28px and has an opaque token background. Rendering the unchanged HEAD independently proves its real M5 hero was already 1003px and desktop page 7139px; only the verifier's old M3 assertion was stale. Desktop section geometry remains unchanged. The social preview was regenerated to refresh CSS provenance; its pixels remain the established design-preview card.

The independent audit covers **106 final PNGs**: two native captures, sixteen Nab regressions, eighty lossless landing tiles from eight repeat-identical full sources, and eight keyboard-focus receipts. Native/Nab repeats and full-source equality are strict; focus receipts separately prove keyboard state. All **107 retained PNGs** decode and match their actual dimensions/hashes below **300,000 bytes** (largest **277,700**). The earlier tray file labelled @2x was actually 1x; its report is explicitly superseded, not accepted or silently rewritten. Initial island JS remains **90,605/120,000 gzip bytes**, and the site uses **457,328/500,000 bytes excluding fonts**.

`v37-earlier-attempts.json` preserves failed/superseded diagnostics, including constructor deadlock, startup/cursor/exposure setup, font-node selection, DPR handling, stale OG/geometry checks and PowerShell evidence serialization. The final native, landing and smoke reports are authoritative. Installed shell association is not exercised because installation is off for v2; bundle registration and owned-executable plugin forwarding are covered. No hosted Tack, OS display change, installer/signing, real profile, global keypress, new performance claim, PR or push is part of this pass. M7 publication remains separate.

Automated reproduction (use fresh prefixes and evidence paths):

```powershell
npm run verify
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features island-spike -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
cargo build --manifest-path src-tauri/Cargo.toml --release --features custom-protocol
node scripts/verify-download-acceptance.mjs src-tauri/target/release/nabbit.exe v37-local-native
node scripts/capture-download-peek.mjs v37-local-peek
scripts/windows-acceptance-smoke.ps1 -InjectedClipboard -EvidencePath .tools/v37-local-smoke.json
python scripts/generate-download-visual.py --check
npm run verify:site
node scripts/verify-landing.mjs --prefix v37-local-landing --milestone M7
python scripts/split-landing-captures.py --prefix v37-local-landing --milestone M7
node scripts/verify-site-accessibility.mjs --prefix v37-local-site --milestone M7
```
