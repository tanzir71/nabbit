# Pre-publication audit

Audited on 2026-11-26 for handoff task P.1. No unresolved publication findings.
The repository remains private until P.2; this task does not publish or push.

## Scope and tools

- Fetched `origin` before scanning all local and remote refs: 17 commits through
  `d0793cea35340fa9ba8bd65cf1ed68a339244270`.
- Gitleaks 8.30.1, official Windows x64 release, unpacked in ignored `.tools/`.
  Archive SHA-256:
  `d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e`.
  This matches both the release checksum file and GitHub release asset digest.
- Ran `gitleaks detect --source . --log-opts="--all" --redact=100`.
  The report contains locations only; no secret values or raw patches are published.
- Supplementary search of `git log -p --all` covered private-key headers, signing-key
  assignments, GitHub token prefixes and base64 strings of at least 120 characters.
- Enumerated every reachable blob with `git rev-list --objects --all` and
  `git cat-file --batch-check`: 176 blobs, none above 5 MiB. The largest is
  `package-lock.json` at 211,384 bytes (text).
- Added the missing MIT `LICENSE`, matching `src-tauri/Cargo.toml`.
- Ignored `/Claude outputs/` and `/.tools/`; neither is staged or in history.
- Installed and exercised the local `.git/hooks/commit-msg` hook, which appends
  `[skip ci]` when missing and leaves an existing marker unchanged.

## Reviewed matches

1. Gitleaks flagged `stripe-access-token` at
   `ff2fc3ec4fcf8a46866fc27aec5d88d832e33b91`,
   `src-tauri/src/clipboard/sensitive.rs:76`. This is the synthetic string in
   `detects_common_sensitive_shapes`, with sequential digits and letters, used to
   test the clipboard secret heuristic. It is not a credential. `.gitleaksignore`
   exempts only that historical fingerprint; the Stripe rule remains enabled for
   every other occurrence.
2. The signing-key assignment in `scripts/build-release.sh:12` assigns the
   `$DEFAULT_KEY` file path, not key material. No private key is committed.
3. The long base64 string in `src-tauri/tauri.release.conf.json:7` decodes to a
   minisign **public** verification key (42-byte public-key payload). This is
   intentionally shipped for updater signature verification, not a secret.

The location-only raw scan summary is in `audit.json`. The final history scan
with the single reviewed fingerprint ignored and the staged-change scan both
passed with zero unresolved findings.

## Verification

- `npm run verify`: typecheck, lint, 5 frontend tests and production build passed.
- `npm run verify:site`: 6 contracts passed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`: passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1`: 22 passed.
- `git diff --cached --check`: passed.
- `npm audit --omit=dev`: zero production dependency advisories. Installation
  reported 19 existing development dependency advisories, left for a later pass.

Per the user's branch override, the task commit is on `main`. Pushes remain
reserved for milestones. No PR, tag, workflow dispatch or publication occurred.

## Repeat

Use the checksum-verified scanner at `.tools/gitleaks-8.30.1/gitleaks.exe`:

```powershell
.\.tools\gitleaks-8.30.1\gitleaks.exe detect --source . --log-opts="--all" --redact=100
.\.tools\gitleaks-8.30.1\gitleaks.exe protect --staged --redact=100
git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)'
```

Do not publish if a future scan has an unresolved finding. Do not rewrite history.
