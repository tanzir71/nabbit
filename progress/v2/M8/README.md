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
