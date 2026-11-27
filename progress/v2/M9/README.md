# M9 — Notes complete (in progress)

## V4.5 — Notes editor, conflicts and sync states

Implemented Figma `19:182`, `19:301` and `19:346` in the existing app. V4.6–V4.9 and the M9 milestone remain unchecked. This task is committed locally on **main** with `[skip ci]`; there is no task push or PR.

The card editor opens lazily as a native HTML modal within the existing tray. Its card colour is the background. It edits title/body, stable-ID checklist rows, bookmark URL, priority, colours, labels, task status/completion, pins, archive/trash/restore and reminders. Save (or Ctrl+Enter) is explicit; Escape/close requires a decision when the draft is dirty. Errors and workspace changes retain the draft. Read-only workspaces can browse the editor. Pop-out is visibly disabled until the separate V4.7 sticky-window lifecycle.

Card and reminder writes use one SQLite transaction, the original workspace epoch/card content token, and independent full-value reminder tokens. A stale/foreign reminder rolls the card change back too. Full JSON and unknown nested fields survive; reminder repeats follow Tack's actual `none/daily/weekdays/weekly/monthly` schema. Dates are shown in this PC's zone; existing zone/snooze/completion metadata survives unrelated changes. Local-only reminders need no network. Once-only upload remaps both card/reminder IDs and the reminder's parent atomically. Reminder notifications remain v2.1.

Attachment data is pulled from Tack into the mirror, never uploaded by Nabbit. A one-time migration rewinds existing scope cursors so old attachments can be fetched. The editor shows read-only MIME-restricted thumbnails with Open in Tack, at most 100 candidates and 6 MB of preview payload; unavailable previews are explained. Conflict history remains full JSON in SQLite; the editor reads the latest 50 card revisions.

The conflict sheet shows both full texts, URLs/checklists, deleted versions and reminder JSON, with expandable complete fields. Both choices use the displayed scope/local token/remote version. Failed or stale choices preserve both versions and require reloading before another choice. The existing Rust resolver keeps the losing full value in `note_revisions`; both choices are verified through real fake-server HTTP clients.

Reusable sync UI covers all ten states: local only, queued/ready/synced, syncing, offline, signed out, recovery pending, workspace changed, storage full, conflict and rate limited. It does not claim queued changes are synced. Tray/settings actions reconnect, retry, open Tack or review conflicts. The editor has a compact footer and history. Expanded island Notes subscribes before its initial snapshot, rejects a late snapshot after a push, and removes late listeners on collapse. It uses Open Nabbit for follow-up actions; quick capture and real island Notes content are V4.6. No JavaScript polling was added.

### Automated evidence

- `npm run verify`: **208 tests / 32 files**, type/lint/assets checks, production build and four HTML entries. `v45-entry-bundles.json`: **90,648/120,000 initial island gzip bytes**, with editor/settings/store code deferred. This is 36 bytes above V4.4; no new performance claim.
- Rust fmt, default and island-spike all-target Clippy with warnings denied, **210 serial tests**, **three opt-in ignores**, and doc-tests. The browser bridge ignore is separately invoked and passes below; two ignores predate this task. New tests cover atomic rollback, stale/foreign reminders/cards/scopes, one-time local reminder upload, read-only editor writes and actual HTTP attachment reads while rejecting attachment uploads.
- `v45-accepted-flow.json`: **six** browser → typed API → test-only IPC forwarding seam → real Rust Service/client/SQLite → in-process Rust fake cases. These cover local-only edits/reminders with zero HTTP, dirty-draft decisions, once-only upload and echoed label-derived server ref, two-device text conflicts with both choices/losing history, reminder round trip/reload, synthetic secret absence from DB/logs, and live push events across reload. The bridge process exits successfully. This proves the forwarding seam, **not native Tauri IPC or OS clipboard writes**.
- `v45-accepted-screenshots.json`: **80** captures spanning editor variants, read-only/narrow, reminders/history, deleted/reminder conflicts and all ten sync states. `v45-island-accepted-screenshots.json`: **12** expanded-island states. Every capture repeats exactly, uses the final build manifest, and runs full default axe: **zero violations and zero incomplete results**. Light/dark at 1×/1.5×; the island stays dark. Original assets/fonts/positions are explicitly audited. All **21** Figma exports are covered; asset slot and intrinsic geometry are recorded for the editor/state matrix.
- `v45-verified-failure-check.json` verifies unchanged console/network rejection, no publication from failed suites and complete owned-resource cleanup. The expanded Notes harness exception allows exactly **one** initial `tack_sync_snapshot`; other island command restrictions remain. Final whole-repository lint passes after the verifier changes.

Five required Tack source blobs were freshly checked at `70d6608e4c4a4b9e4dd38b9bf2124187f6285893` (still current): `v45-tack-source.json`. Original Figma exports/root sizes and reference screenshots are pinned in `v45-figma-reference.json`. Shared Button/IconButton/PresetChip/Badge/DesignIcon components, tokens and bundled Geist fonts are reused. The full light export of the selected-green colour palette is used unchanged in that design state; other selections and dark swatches are data-driven from note tokens so selection stays truthful. Absolute last-sync times replace invented live ages, and absent author/device metadata is not fabricated.

### Visual review and retained attempts

Compared the light editor and conflict hierarchy with the two original Figma renders; inspected the final light editor, narrow dark editor, conflict and island output. Preserved original spacing, 48 px toolbar, coloured canvas, 40 px footer, property rows and every original icon at its intrinsic size. The editor footer was simplified after visual review. Added full-field/deletion/reminder/history/dirty-save UI where the behavior needs it. Readable secondary captions replace prototype tertiary text.

`v45-earlier-attempts.json` and deterministic `.original.txt.gz` archives retain earlier red and superseded green checks. The lazy editor required an asynchronous test wait; a test type option and bridge inference/lint were fixed. The first capture tried stale dist after the failed typecheck and is not authoritative. A Build-labelled card correctly receives a `bui-` server ref; the driver initially assumed `tck-`. Axe found duplicate Notes landmarks and a missing primary heading; visual review then caught the island stylesheet's absent screen-reader-only utility and native button default. These were fixed without disabling a rule. An event-counter assertion was corrected to account for page reload. A stale negative-harness progress selector was replaced by waiting for the current Nabbit heading before injecting the same faults. The attachment test now explicitly asserts the client's upload refusal before reading a seeded existing attachment over HTTP.

Only the **accepted** matrices/flow above bind to the final app build. Prior `second`, `final`, `verified` matrices remain historical; successful earlier images do not establish the latest layout. `v45-png-audit.json` independently decodes and hashes every retained PNG, including earlier captures and two reference renders. All are below **300,000 bytes**. Canonical logs remove console-only trailing whitespace; compressed originals retain the exact bytes.

### Reproduce

```powershell
npm run verify
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features island-spike -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
node scripts/verify-note-editor-screenshots.mjs <unique-prefix>
node scripts/verify-island-notes-sync.mjs <unique-prefix>
node scripts/verify-note-editor-flow.mjs <unique-prefix>
node scripts/screenshots/verify-failures.mjs --milestone M9 --prefix <unique-prefix>
```

Run build checks before captures so their manifest/served files cannot change mid-run. Do not run another Cargo job while a confirmed owned bridge/check is live. The screenshots use synthetic data; behavior is verified separately by the Rust flow. No hosted Tack/account, real browser profile, global keypress, OS clipboard, display change, installer, signing, new native performance run, release, PR or repository workflow was used. The optional complete local Tack/PDO-SQLite suite was not run. Existing V0/V2.7 limitations remain. Full Notes acceptance is V4.8; publication waits for M9.

Retained PNG audit: **346 files**, largest **105,144 bytes**. Final source/artifact Git blob pins and scan results are in `v45-acceptance.json`.
