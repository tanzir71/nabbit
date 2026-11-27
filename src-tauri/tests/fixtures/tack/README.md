# Tack API v4 fixtures

The in-process Rust fixture server binds only to an ephemeral `127.0.0.1` port and is compiled only for tests. `source-pins.json` records the upstream commit, exact Git blobs and permanent source links. No request is made to a hosted Tack installation or a user account.

`auth.json` records the request/response contract for status, login, pending recovery, stale/current confirmation, sync, workspace switching, workspace guards, logout and an expired session. Placeholders replace the synthetic password, CSRF, recovery code and workspace shapes. The wire replay test compares complete fixture bodies after expanding those placeholders; no tokens enter assertion output. Fault tests separately cover 401/403/409/413/428/429/503, numeric and HTTP-date Retry-After, malformed identities and redirects. Rate limits, CSRF/workspace guards, the mutation limit and storage rollback are enforced by the fake itself.

`merge.json` contains **100 golden results produced by the actual pinned PHP `merge_fields` and `merge_protocol_write` functions**, using PHP 8.2.30 with `-n`. Cases include disjoint/overlapping human edits, Unicode and ECMAScript whitespace, CRLF, inserts/deletes, labels, unknown fields, field removal, missing bases, large/high-distance edits, deterministic random edits and agent completion races. The Rust fake's merge port must match them exactly. PHP is needed only to regenerate fixtures, not to run the tests:

```powershell
python scripts/generate-tack-merge-fixtures.py --merge <pinned-merge.php> --sharing <pinned-sharing.php>
cargo test --manifest-path src-tauri/Cargo.toml tack:: -- --test-threads=1
```

The generator validates the supplied files against their Git blob IDs, runs them in a disposable directory with fixed `canonical`/`stamp` helpers and writes no credentials or persistent PHP settings. The extra final LF added by the connector is accepted explicitly; other source changes fail validation.

The fake models the Nabbit transport surface: account/session rotation, recovery-code rotation and confirmation, two member workspaces, full JSON cards/reminders/settings, versions, stable reference reservations, field/protocol merges, success-body conflicts, cursor paging (200 scanned rows / 3,000,000 value bytes), hidden-row cursor progress, unrelated read tables, 50 unique mutations, 3 MB record and 8 MiB request bounds, storage transactions, reference counters and representative activity records. Requested valid references are reserved; otherwise the first label/tag supplies up to three ASCII letters, falling back to `tck`. Deletion never reuses a reservation.

This is not a clone of Tack's sharing, role/guest ACLs, attachments, onboarding, agent execution, label-catalog administration or complete activity history. Those APIs are outside Nabbit's V4.2 client. Seeded unrelated/hidden rows test that the transport does not assume every cursor row is a card. Transactional outbox replay and both conflict resolutions are V4.3/V4.8 acceptance, not claimed here. The optional complete local Tack/PDO-SQLite suite was not run in V4.2; standalone PHP merge verification was run.

Production exposes HTTPS installation URLs only. The HTTP loopback constructor, fake credentials, injected memory/failing vaults and fault responses are test-only. Production uses Windows Credential Manager; no plaintext fallback exists. The native roundtrip test creates and deletes only its own unique `.invalid` installation entry.

## V4.3 sync and rank coverage

V4.3 adds the real durable client-side loop against this fake. Sixteen sync tests cover full-card/checklist/reminder edits, both conflict choices with losing-body history, coalescing, 56-card batches, 32 large records with full merge bases and bounded actual request bytes, all cursor pages, hidden/unrelated rows, interrupted paging and lost write acknowledgements across restart. Faults exercise malformed-page and injected SQL rollback, edits arriving during HTTP, stale epochs/tokens and workspace partitions, offline startup reauthentication, streaming signout export, failed-export durable pause, one-time local uploads, a sleeping/stoppable worker and network-free local-only mode. A change-revision regression ensures empty syncs and unrelated pages do not trigger Notes reloads. Four scheduler tests verify debounce, focus/visibility periods, retry floors, network regain and preservation of queued edit/request/retry deadlines across visibility changes. The Windows connectivity registration/cancellation test uses the actual API without changing network state.

`rank-source.json` pins Tack's locked **fractional-indexing 4.0.0** tarball integrity and source SHA-256, and the exact upstream rank wrapper blob at the same Tack commit. `ranks.json` has **515 golden cases executed by the verified npm implementation**. `rank-tack.json` has **36 golden cases executed by the actual pinned Tack TypeScript wrapper**, after mechanically removing type annotations and replacing only its package import. These cover nonce suffixes and IEEE754 legacy numeric ranks, including negative zero and extreme finite values. The Rust port uses the same default alphabet and bounded 4,096-character keys. CC0 attribution is in `licenses/fractional-indexing.txt`; no npm runtime dependency is added.

```powershell
node scripts/generate-tack-rank-fixtures.mjs <pinned-fractional-indexing-4.0.0.tgz> <pinned-Tack-src-rank.ts>
cargo test --manifest-path src-tauri/Cargo.toml tack:: -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml notes:: -- --test-threads=1
```

Final V4.3 evidence and eight freshly checked upstream blobs are retained in `progress/v2/M8/v43-*`; nine V4.2 source pins remain historical evidence. The complete suite has **39 Tack tests and eight Notes tests**. Connection UI, conflict/editor UI and broad end-to-end Notes acceptance remain V4.4/V4.5/V4.8. The optional complete local Tack/PDO-SQLite suite was not run; the existing 100 actual PHP merge reference cases still pass. No hosted Tack or user account was used.

## V4.4 connection acceptance

`scripts/verify-tack-flow.mjs` launches an explicitly ignored, test-only Rust bridge with its own SQLite directory, in-memory vault, ephemeral loopback endpoints and origin/token guards. The browser uses the real connection components and typed invoke wrappers. Only the IPC boundary is forwarded; the actual production Service/client/transactions call this Rust fake. A reserved `https://fixture.invalid/tack/` alias maps to the owned loopback endpoint inside that bridge, preserving frontend HTTPS validation. Production has no bridge, alias override, test endpoint or plaintext vault. This is not a native Tauri IPC or OS clipboard test.

Five flow cases cover pre-network HTTPS rejection, login/password clearing, mandatory recovery confirmation, stale-code rotation, protected-copy seam, no sync before explicit workspace confirmation, task/label scope, unchecked one-time upload, real server refs, reopening/reload without duplication, signout/hints, 503/429, keyboard focus restoration, local-only selection without HTTP, cached-card retention and live pushed updates. Bridge events flush explicitly because tiny_http's generic chunk encoder buffers small bodies. Test requests and capture receipts redact password/code fields; no hosted Tack or user account is used.

Five connection Rust tests plus the protected-copy seam test bring the focused Tack suite to **45 passing tests**. They additionally verify guest membership pulling without uploads, write rejection/rollback, fresh account/server guards, preference validation/partitioning and restart. The bridge is the third opt-in ignore in the default suite and is separately invoked automatically by the flow driver. The two earlier opt-in ignores remain unchanged.

```powershell
node scripts/verify-tack-flow.mjs v44-local-flow
node scripts/verify-tack-screenshots.mjs v44-local-captures
```

Use fresh prefixes; evidence files are exclusive. The authoritative receipts are `v44-verified-flow.json` and `v44-verified-screenshots.json`. Their scope and retained earlier attempts are documented in `progress/v2/M8/README.md`. Full editor/conflict/sync-state UI and broad §8.8 acceptance remain V4.5/V4.8.
