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
