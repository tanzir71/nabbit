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
