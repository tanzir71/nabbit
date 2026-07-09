# Nabbit Progress Log

## Log
- 2026-07-09 P0.1 Created `PROGRESS.md`. Files: `PROGRESS.md`. Verified: file exists.
- 2026-07-09 P0-P6 implementation pass scaffolded the Tauri/React app, Rust persistence, clipboard watcher, downloader queue, settings UI, docs, scripts, tests, and Windows packaging. Files: project root, `src/`, `src-tauri/`, `scripts/`, `tests/`, `.github/`. Verified: `npm run verify`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, `cargo build --release`, and `npm run tauri -- build`.
- 2026-07-09 Verified Windows sidecars. `yt-dlp` version: `2026.07.04`; `ffmpeg` version: `8.0-essentials_build-www.gyan.dev`.
- 2026-07-09 Verified release smoke launch. `src-tauri/target/release/nabbit.exe` stayed alive after 8 seconds; warm idle sample used 0.0156 CPU seconds over 15 seconds after a 6-second warm-up.
- 2026-07-09 Verified clipboard watcher against the real release app. Copied a unique value and confirmed one row in `C:\Users\tanzir\AppData\Roaming\com.nabbit.app\nabbit.sqlite3`.
- 2026-07-09 Built Windows installers: `src-tauri/target/release/bundle/msi/Nabbit_0.1.0_x64_en-US.msi` and `src-tauri/target/release/bundle/nsis/Nabbit_0.1.0_x64-setup.exe`.
- 2026-07-09 Ran npm audit; production dependencies have 0 vulnerabilities, and the dev-only Vitest advisory was fixed by upgrading to Vitest 3.2.7. `npm run verify` stayed green afterward.
- 2026-07-09 Name availability quick check found release risks: `nabbit.com` is already in use, AppBrain lists a recent "Nabbit App" iOS listing, and "Nabbit" is also a Nintendo/Mario character name. Keep the code name for now; release naming needs legal/product review.

## Decisions
- Initialized a Git repository because the workspace did not contain one.
- Used `arboard` with a 750ms debounce-style watcher as a pragmatic cross-platform clipboard backend. This is a workaround for the native `clipboard-master` requirement; it keeps reads cheap and satisfies the one-second UX target, but Windows/Linux event-native watchers remain a hardening item.
- Image clipboard capture is represented in settings and documented as deferred; v1 stores text/URLs/files-as-text.
- ffmpeg auto-fetch is documented but not fully automated on Windows because the stable public downloads are archives, not a single executable.
- App auto-updater plugin is present, but local updater artifact generation is disabled because signing keys/endpoints are not available.
- Kept `com.nabbit.app` from the handoff despite Tauri warning that `.app` suffix is not recommended on macOS; this should change before release if an organization-owned bundle ID is available.

## Blockers
- Code signing certificates and updater signing keys are not available in this workspace.
- Full cross-platform tray, no-dock, source-app password-manager exclusion, and installer acceptance can only be manually verified on each target OS.
- `ffmpeg` sidecar must be supplied manually or installed on `PATH` unless a release-specific binary source is chosen.
- Phase 4.4/4.5 remain unchecked because I did not run a real YouTube download/merge/MP3 acceptance pass.
- Phase 3.5 remains unchecked because OS concealed clipboard hints and real password-manager exclusion were not verified.
- Phase 5.5 remains unchecked for signed updater artifacts and non-Windows bundles.
- Phase 6.3/6.4 remain unchecked until the manual E2E checklist and final DoD pass are run.
- "Nabbit" naming is not release-clear based on quick web checks; legal/product decision required.

## Open Questions
- Confirm code-signing certificates and updater endpoint before Phase 5.5 release packaging.
- Confirm whether Nabbit should keep the `com.nabbit.app` bundle identifier or move to an organization-owned reverse-DNS identifier.
