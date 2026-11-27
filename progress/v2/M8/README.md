# M8 — Notes · Tack

## V4.1 — Local Notes store and tray

V4.1 adds the shared `note_cards` table to the existing SQLite database, leaving clipboard and download data in place. New cards are local-only and use Tack's full JSON shape: UUID v4, revision zero, an empty server reference, inbox priority by default, a valid base62 rank before the previous first local card, and UTC timestamps with milliseconds. The full fractional between-key port remains V4.3. No Tack request, account or session is involved.

Edits patch known fields in a transaction with an expected revision. Unknown card fields and nested checklist-item fields survive. IDs, created dates, references and ranks cannot be overwritten by a normal edit. Stale saves fail with the draft retained; failed validation writes no row. Archive and Trash are soft changes and can be restored. Connected cards are kept out of this local-only mutation path until the atomic outbox path is implemented in V4.3.

The enabled tray Notes tab remembers its selection across restart. It reuses NoteCard, the original Figma icons, Geist, semantic colours, filter chips and existing tray geometry. The two-column masonry groups pinned cards first, then other cards. All/Inbox/Now/Next/Later, labels, search, archive/trash views and card actions are functional. A basic inline form creates and edits notes, checklists, bookmarks and tasks with priority, colour and labels. Checklist rows retain their IDs and checked state when another row is removed. The footer truthfully says **Local only · Saved on this device**. Open Tack is omitted until there is a connection. The dedicated editor, connection/sync, island parsing/hotkey, sticky windows and Links/import flow remain their named V4 tasks.

`v41-reference-sources.json` verifies all five required Tack source files against their exact fetched Git blobs. Current cards.ts includes optional `updatedBy` and `agentState`; those and future fields round-trip untouched. Figma **13:242** and **12:511** high-fidelity context and screenshots were reviewed. The two `v41-figma-*.png` files are reference renders only. Fifteen original SVG exports were audited: eight match existing assets exactly, six new assets are retained, and the unavailable Open Tack action is omitted. No Figma screenshot is used in the app.

`v41-final-screenshots.json` is the authoritative browser matrix: **32 repeat-identical captures**, light/dark at **1× and 1.5×**, covering the design fixture, empty state, inline draft, view/labels menu, Trash, search, 360px width and keyboard focus. Original asset source bytes, Vite's exact inline SVG serialization, root/rendered icon dimensions and actual custom font glyphs are checked. All 32 default-rule axe scans have zero violations. Sixteen indeterminate checks behind the open view menu have explicit opaque-background contrast proofs; every unrecognised incomplete fails. Menus dismiss with Escape or outside focus, and have no translucent shadow over covered card text. The completed text/reference colours use the existing readable secondary token. The local-only footer and dynamic bookmark path wrapping are intentional differences from the connected design fixture.

`v41-second-native-native.json` proves **five owned-release cases** through the real tray DOM, Tauri commands and SQLite. It creates local notes and a checklist, edits/checks items, preserves a remaining checked item's ID after removing its preceding row, creates a bookmark, rejects JavaScript URLs without inserting a row, and exercises pinning, priority/search filters and soft archive/trash/restore. After restart it checks the remembered Notes tab, theme and records. A concurrent write makes an open draft stale; the save is rejected without overwriting the newer value, the draft stays visible, and reopening/saving preserves seeded future card fields and `agentState`. Both native captures repeat exactly at the actual **460×680, 1×** device size. No download or clipboard row is created, and there is no Tack outbox or external browser request. The fixture profile, engine probes and command provider are isolated; real clipboard watching and OS shortcut/autostart configuration are disabled.

Fresh `npm run verify` passes **184 tests in 29 files**, type-checking, lint, icon/font/token checks, the production build and entry audit. Rust formatting, default/spike all-target Clippy with warnings denied, **157 serial tests** (two existing opt-in tests ignored) and doc-tests pass. The unsigned custom-protocol release build passes. Final lint also passes after native-verifier timing adjustments. Four production entries remain; the initial island graph is unchanged at **90,605/120,000 gzip bytes**, with Notes deferred to the tray tab. Browser/native manifests match the final production build. `v41-acceptance.json` pins current source, evidence and independently decoded PNGs.

The authoritative application captures are **32 browser + 2 native**. All **64 retained PNGs** include those, two Figma references and 28 earlier browser captures; all independently decode/hash below the strict **300,000-byte** cap. The earlier browser set was superseded when default and keyboard-focus evidence were separated and bookmark wrapping was aligned. `v41-earlier-attempts.json` retains all earlier failures and their resolution. The first native check stopped on Playwright's synchronous `check()` assumption, although its SQLite row was already checked; the final driver separately waits for the durable row and native DOM. No app assertion, pixel comparison or accessibility rule was relaxed.

V0/V2.7 performance/frame/focus limitations remain unchanged; these functional checks make no new idle-performance claim. This task commits locally on main with `[skip ci]`. Publication remains the M8 milestone procedure; the landing stays at M7. No PR, tag, release, repository workflow, hosted Tack, real browser profile, global keypress, installer/signing or OS display change is involved.

Automated reproduction, with fresh evidence prefixes:

```powershell
npm run verify
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features island-spike -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
node scripts/verify-notes.mjs v41-local-browser
cargo build --manifest-path src-tauri/Cargo.toml --release --features custom-protocol
node scripts/verify-notes-native.mjs src-tauri/target/release/nabbit.exe v41-local-native
```

For a bounded frontend worker count, set Vitest's max fork/thread environment variables to 2 and min to 1 for that command, restoring their prior values afterwards. The complete test suite remains selected. Native automation refuses to run if any Nabbit process already exists and cleans up only its owned process tree.

## V4.2 — Fake Tack and connection transport

Implemented the API v4 connection client and its in-process Rust fake, derived from Tack commit `70d6608e4c4a4b9e4dd38b9bf2124187f6285893`. Nine source files are pinned and their Git blob hashes independently verified. Status, login, recovery confirmation, workspace switching and logout use the actual wire shapes; authenticated requests carry account/workspace guards. Typed Tauri commands run serialized blocking workers. The service starts disconnected, and there is no startup request or background polling.

Production accepts HTTPS installation URLs only, refuses redirects, filters cookies to the configured installation's `tack_sid`, requires Secure/HttpOnly, and preserves absolute expiry when restoring a session. Cookie and CSRF are the only fields in a single Windows Credential Manager entry. Separate URL paths/ports have separate scopes. Passwords and recovery codes are request/dialog values with redacted diagnostics and zeroizing wrappers; they are not connection state or vault data. HTTP/network errors map to existing SyncStatus values with fixed client messages. Retry-After supports seconds and HTTP dates and blocks premature calls, including extreme integer values. Offline logout still removes the local session; a secure-storage failure never falls back to a file.

The fake binds an ephemeral `127.0.0.1` port and cleans up its owned server thread. It enforces session/CSRF rotation, recovery and workspace guards, rate limits, mutation uniqueness/50-count bounds, versions, full-JSON field and agent-completion merges, success-body conflicts, stable requested/server references, record/request/storage limits with rollback and cursor paging over hidden/unrelated rows. Reference prefixes follow the first label/tag, with `tck` as fallback. The fake's complete scope and exclusions are in `src-tauri/tests/fixtures/tack/README.md`.

Final checks pass:

- `npm run verify`: **184 tests / 29 files**, type/lint/token/font/icon checks, production build and bundle audit. Four HTML entries; initial island JS remains **90,605/120,000 gzip bytes**.
- Rust fmt, default and island-spike all-target Clippy with warnings denied, **175 serial tests**, two existing opt-in tests ignored, and doc-tests.
- **18 Tack tests**, including authentication/restart/logout, both cookie expiry forms, server and client mutation bounds, hidden-row paging, malformed/foreign/no-progress response rejection, merge/conflict/reference behavior, storage rollback, all error states, rate/backoff guards, redirect refusal, failing vault and native Windows Credential Manager roundtrip. The native test writes/reads/deletes only its own unique synthetic `.invalid` entry and verifies the two persisted JSON keys.
- **100 PHP golden merges** generated with the actual pinned merge/sharing functions on PHP 8.2.30 (`-n`), covering large/high-distance Unicode/text/structured cases and agent completion races. Regeneration checks source blob hashes. The optional complete local Tack/PDO-SQLite suite was not run; no hosted Tack or user account was contacted.

`v42-acceptance.json` pins final source and evidence bytes using Git's LF text representation. Canonical logs trim console-only trailing whitespace; `.original.txt.gz` retains their exact original bytes. `v42-earlier-attempts.json` retains early compiler/Clippy diagnostics, two cancelled redundant lock-waiting cargo processes, and earlier green suites superseded by expanded checks. No assertion or lint was disabled. The final full Rust run includes the last paging/version-zero regression guard.

Staged and evidence-archive Gitleaks scans have zero findings. The staged Git blob audit verifies every source/artifact hash; task logs are explicitly staged despite the repository's general log ignore. Console EOF whitespace is removed only from readable copies, with raw bytes retained in the compressed originals.

This is a backend-only task, so no UI screenshots or native app launch are claimed. Notes remain local-only in the current UI. Transactional mirror/outbox synchronization is V4.3; connection/recovery sheets are V4.4. V4.1 artifacts and all prior V0/V2.7 limitations remain. Commit directly to main with `[skip ci]`; publication waits for M8. No PR, push, tag, release or repository workflow invocation occurred in this pass.

Reproduce checks from the repository root:

```powershell
npm run verify
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features island-spike -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
```

## V4.3 — Transactional sync and fractional ranks

Added durable mirrors, coalescing outboxes, cursors and conflicts, scoped by installation, account and workspace. Local card/reminder writes and queue entries share a transaction. Complete response pages and their cursor commit together. Full JSON merge bases preserve future fields; pulling first recognizes lost successful responses. Frozen sent tokens let newer local edits survive an acknowledgement while retaining merged server text, references and unknown fields. Conflicts remain durable and exclude only affected records; either resolution retains the losing full JSON locally. Paired view snapshots, workspace epochs and content tokens reject stale drafts, including same-revision remote edits, while server-owned metadata echoes remain safe to edit over.

The Rust worker sleeps on a condition variable. It implements 1.5-second edit debounce, focus/network-regain wakeups, 60-second visible and five-minute hidden heartbeats, exponential offline backoff and Retry-After floors. Visibility changes alter heartbeat deadlines without postponing a queued save/request/retry. Native Windows connectivity notifications supply network regain without probe traffic or polling. Only an explicitly enabled scope resumes at startup; offline restoration retains its credentials and retries identity/status before uploading. Default local-only mode has no transport. Typed sync events report queue/conflict/error state; Notes refresh events require actual committed data changes, so status-only heartbeats do not reload hidden views.

Mutation batches obey 50-record and serialized-byte bounds, and all response pages drain before proceeding. Uploading local notes is atomic and once-only. Signout persists pause, streams an exclusive unsynced JSON export and flushes it before clearing credentials. Failed export preserves authentication, notes and queues with the durable pause intact. No SQLite transaction spans HTTP. Unknown/unrelated cursor rows advance the cursor without creating cards or a tight retry loop.

The rank port follows Tack's actual locked **fractional-indexing 4.0.0** default alphabet plus its nonce/legacy-rank wrapper. **515** verified npm golden cases and **36** actual Tack wrapper cases pass, including boundary intervals, randomized inserts, nonce collisions and extreme finite numeric encodings. Upstream source hashes, tarball SRI, licensing and regeneration are recorded in the fixture README and `v43-source-verification.log`. Eight source blobs were freshly verified at Tack `70d6608e4c4a4b9e4dd38b9bf2124187f6285893`; the nine V4.2 pins remain historical. Existing **100 PHP merge goldens** still pass. No npm runtime dependency was added.

Final checks:

- `npm run verify`: **187 tests / 29 files**, type/lint/assets checks, build and entry audit. Four entries and **90,607/120,000 initial island gzip bytes** (V4.2: 90,605); no new initial settings/editor/app-store import.
- Rust fmt, default/spike all-target Clippy with warnings denied, **199 passing serial tests**, two existing opt-in ignores and doc-tests. Includes **39 Tack tests**, **eight Notes tests**, real native connectivity registration/cancellation and the isolated Credential Manager roundtrip.
- Fake sync tests cover card/reminder round trips, server refs/future fields, 56-card batches, 32 large cards with full merge bases, cursor paging and interruption, lost acknowledgements/restart, both conflict choices/history, newer edits during HTTP, page/SQL rollback, stale workspace/draft guards, offline restore, once-only uploads, export failure, sleeping worker shutdown and network-free local-only mode.
- **32 Notes browser captures**, light/dark at 1×/1.5×, repeat exactly. Full default axe scans have zero violations, retaining the existing 16 explicit opaque-menu contrast proofs. Independent PNG decoding verifies all images below **300,000 bytes** with 26 images identical to accepted V4.1 pixels. Six historical comparisons differ by at most 25 pixels and 1/255 per RGB channel, with identical alpha. This also exercises the new paired-scope Notes IPC snapshot.

`v43-acceptance.json` pins source and evidence using Git's LF text representation. Canonical logs trim console-only trailing whitespace, while `.original.txt.gz` preserves exact console bytes. Earlier diagnostics and superseded suites remain in `v43-earlier-attempts.json` and its archives. The last new test initially failed because its second-device helper searched only the first page; the helper now follows all pages, with the regression assertions preserved. Review also added the visibility-deadline guard. The optional historical equality assumption initially stopped the receipt builder; the full comparison is now reported explicitly rather than claiming equality. Current repeat, geometry, default accessibility and behavioral assertions remain unchanged, with no lint allowance. Staged/evidence archive secret scans and staged Git blob audits complete the receipt.

No production TSX layout or CSS change, native application launch, new idle-performance claim, hosted Tack call or user account is involved. Existing V0/V2.7 limitations remain. The optional complete local Tack/PDO-SQLite suite remains unrun. V4.4 supplies the connection/recovery UI; V4.5 supplies conflict/editor UI and V4.8 owns broad §8.8 acceptance. Only the V4.3 build-loop box is checked. Commit directly to main with `[skip ci]`; no push, PR, tag, release or repository workflow invocation. Publication waits for M8.

Use the required commands shown above to reproduce the checks, plus a fresh Notes evidence prefix:

```powershell
node scripts/verify-notes.mjs v43-local-browser
```

## V4.4 — Connect Tack and Notes settings

Implemented the server/sign-in and workspace/scope screens from [19:5](https://www.figma.com/design/tBm7NNhh1Y9aTQPJ3WxY5v/Nabbit?node-id=19-5) and [19:102](https://www.figma.com/design/tBm7NNhh1Y9aTQPJ3WxY5v/Nabbit?node-id=19-102), with Notes-footer and Settings entry points. The dialog validates HTTPS/API v4, supports recovery-code confirmation and reconnect hints, and offers an unchecked once-only local-note upload. Password input clears before awaiting and is never shared state. Recovery state is confined to the mounted dialog, clears after confirmation/close/expiration, and requires a new saved confirmation after rotation. Protected copying registers Windows history/cloud/monitor exclusion formats before writing the text; automation uses its seam and leaves the OS clipboard untouched.

Authentication is staged until **Start syncing**. A fresh status/account/server/workspace check guards that action. Device/workspace task and label preferences persist independently of general settings, filter the view and preserve every cache/outbox record. Guest workspaces pull cards and reject edits, reminders and uploads transactionally. Local-only selection durably pauses HTTP while retaining cached Tack cards. Non-secret URL/username hints survive signout; session cookie/CSRF remain solely in Credential Manager. The specified 30-day desktop policy sends `remember:true`; its indicator is fixed. Board/focus-time controls are explicitly labelled v2.1 and disabled. Actual API membership names/roles replace sample data; card counts and registration status absent from the API are omitted. Captions use the existing readable secondary token.

Final proof:

- `npm run verify`: **197 tests / 30 files**, including **10 connection frontend tests**, plus type/lint/asset checks, build and entry audit. Current verifier lint also passes. Four entries and **90,612/120,000 initial island gzip bytes**, with no new initial settings/editor/app-store import.
- Rust fmt, default/spike all-target Clippy with warnings denied, **205 passing serial tests**, doc-tests and three opt-in ignores. **45 Tack tests** pass, including actual guest membership, readonly rollback, workspace preference partition/restart, stale setup and input guards, protected-copy seam and the existing PHP/rank goldens. Two ignores predate this task; the new ignored bridge is separately invoked and passes.
- `v44-verified-flow.json`: **five complete browser-to-Rust cases**, using real UI/typed wrappers → test-only IPC forwarding seam → production Rust Service/client/SQLite → in-process Rust fake → pushed events → rendered state. It proves recovery rotation/confirmation, no premature sync, explicit workspace/scope, one-time upload/ref/no duplicates, signout/hints, safe 503/429, Escape/focus, local-only/no HTTP/cached retention and live updates without a polling timer. This does **not** establish native Tauri IPC. The reserved HTTPS alias is confined to the test bridge. No hosted Tack, user account or OS clipboard is used.
- `v44-verified-screenshots.json`: **40 exact-repeat captures**, light/dark at **1×/1.5×**, covering server, sign-in, recovery, workspace, labels, upload, readonly, narrow, error and Settings. Every case explicitly invokes original-asset source/render geometry checks, actual custom-font glyph checks and all default axe rules. **Zero violations and zero incomplete results**; all **13 visible asset files** are covered. Capture request secrets are redacted.
- `v44-png-audit.json`: independent full PNG decoding/hashing, strict **300,000-byte** cap, **40 authoritative + 120 earlier + 2 original Figma reference PNGs**. Original exports and root dimensions are preserved. Supplied reference PNGs remain separate from implementation assets.

The acceptance builder caught an evidence bug: the screenshot harness calls `ready`, so the extra `inspect` hook in earlier runs never executed. Those earlier images prove only their recorded geometry/repeat checks and the harness's own font audit; their success messages do not establish asset/axe coverage. The corrected callback explicitly calls the audit and serializes its results. It then found an invalid ARIA name on `code`; a named group now contains the code. A missing expected font-family argument was also corrected. The authoritative manifest is required to contain the complete assertions, not merely a passing console message. No axe rule or assertion was disabled.

`v44-earlier-attempts.json` and exact original log archives retain those errors, the early type/lint/UTF-8 fixture issues, the radio target failure and buffered test-stream failure. Full-row transparent native radio inputs preserve the artwork and provide a 48px target; no forced click is used. The bridge now flushes each event packet, leaving production Tauri events unchanged. Earlier capture sets and flow failures remain immutable. `v44-acceptance.json` pins current source and all evidence using Git's LF text representation; readable logs trim console-only whitespace while compressed originals retain their exact bytes. Secret scans and staged Git-blob audits complete that receipt.

No native app launch, installer/signing, OS scaling change, global keypress or new idle-performance claim is made. Existing V0/V2.7 limitations remain. The optional complete local Tack/PDO-SQLite suite remains unrun; the 100 actual PHP merge goldens pass. V4.5 owns the full editor/conflict/sync-state UI and V4.8 owns broad Notes acceptance. Only V4.4 is checked. Commit directly to main with `[skip ci]`; no PR, push, tag, release or repository workflow invocation. **M8 publication is the next pass.**

Reproduce the required check commands above, then use fresh prefixes:

```powershell
node scripts/verify-tack-flow.mjs v44-local-flow
node scripts/verify-tack-screenshots.mjs v44-local-captures
```


## M8 — Tack sync milestone readiness

The milestone collects V4.1–V4.4 without changing app runtime, build helpers or repository workflows. `m8-task-audit.json` independently checks **2,106 original source/artifact pins** against each task's own commit and verifies **106 authoritative app captures** (34 V4.1 including two native, 32 V4.3, 40 V4.4). The current production build manifest exactly matches V4.4's authoritative captures. Only `v44-verified` supplies its complete asset/font/axe audit; prior V4.4 captures remain historical evidence with the narrower recorded checks. V4.3's six non-exact historical comparisons retain their tiny documented differences. The V4.4 browser flow uses an IPC forwarding seam into real Rust service/client/SQLite/fake HTTP, not native Tauri IPC or OS clipboard writes.

Fresh `m8-checks.json`/readiness evidence proves:

- `npm run verify`: **197 tests / 30 files**, assets/tokens/fonts/icons, typecheck, lint, production build and four-entry audit; **90,612/120,000 initial island gzip bytes**.
- Rust fmt, default and island-spike all-target Clippy with warnings denied, **205 serial tests**, three opt-in ignores and doc-tests. The bridge ignore is separately invoked and passing in V4.4's pinned receipt; the other two are pre-existing opt-in tests.
- Landing source/asset/meta/HTTP checks, **106 HTTP bodies**, **457,604/500,000 bytes excluding fonts**, unchanged exact OG, eight status browser contexts, eight accessibility contexts and **24 axe scans with zero violations**. Desktop/mobile status captures were visually inspected. Only M8/M9 rows and milestone metadata changed.
- **274 retained PNGs** independently decoded and SHA-256 pinned, each below **300,000 bytes**; largest **137,967 bytes**. This includes all original task/reference/earlier images and 16 new milestone status/keyboard images. Not every retained image is an authoritative functional capture.
- Prepublication public repository/main/docs Pages configuration, no releases and repository CI IDs **29048534241, 29225324035** unchanged. Unpublished task history secret scan has zero findings; staged/archive scans follow before the push.

Canonical `.txt` logs remove console-only trailing whitespace; deterministic `.original.txt.gz` files retain raw bytes. The first site check found a new evidence link using the wrong label; restored the existing Screenshots label and reran all site checks. Its failed log remains `m8-initial-site.original.txt.gz`. No assertions were weakened. `m8-readiness.json` pins current app inputs and every retained PNG.

Try locally with `npm run tauri:dev`, then Ctrl+Shift+V → Notes → Connect Tack, or Settings → Notes & Tack. Local-only requires no server. Automated acceptance used only the in-process fake, never a hosted Tack account. Dedicated editor/conflict UI is V4.5, full Notes acceptance/landing screenshot replacement is V4.8, and the optional complete local Tack suite remains unrun. Existing V0/V2.7 native performance/frame/focus limitations are unchanged. This metadata-only milestone makes no new native or performance claim.

Publication uses a fast-forward direct-main push with a skip-ci milestone head. M8 remains unchecked until the built-in Pages run, exact source bodies, nested custom 404 and all public PNG bytes are verified. The follow-up deployment receipt checks the box without amending published history. No PR, tag, release or repository workflow is created.

Final prepublication `m8-final-audit.json` verifies every readiness source/PNG pin against the Git index. Staged milestone and evidence/archive secret scans both passed with zero findings; their canonical logs are retained alongside the history scan. No app/runtime/helper/workflow file changed.

The final index audit caught five text files omitted from the receipt normalizer (three Python helpers, `.gitkeep` and `.gitattributes`). `m8-provenance-correction.json` records every before/after hash and `m8-readiness-initial.original.json.gz` retains the original receipt. Corrected LF pins passed the full audit of **619 source and 274 PNG index blobs**. No runtime input changed; the unpublished milestone commit was corrected before any push.


## Verified M8 publication

Milestone `f6272acbb513010cf78e8eadb7526321ebc152e3` was fast-forward pushed directly to main with `[skip ci]`. GitHub built-in Pages run [45964359173](https://github.com/tanzir71/nabbit/actions/runs/45964359173) succeeded. `m8-live-check.json` proves all **106** published source bodies, M8 Done/M9 In progress and the screenshot link, the nested custom 404 and all **274 public PNG bodies** match the milestone commit. Published transfer is **457,603/500,000 bytes excluding fonts**, versus 457,604 locally. Git text comparisons explicitly normalize CRLF to LF; all image bytes match exactly. Single stale rebuild requested: **False**.

`m8-deployment.json` retains Pages configuration/build plus a second verification of **619 source and 274 PNG pins** against the published commit. Repository workflow IDs remain **29048534241, 29225324035**; every new run is built-in dynamic Pages. M8 is checked only after this live proof, in an append-only skip-ci bookkeeping commit. Published history is not amended. **V4.5** is the next pass; all functional, native/performance and optional-suite limits above remain.
