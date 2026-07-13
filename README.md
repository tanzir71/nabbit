# Nabbit

Nabbit is a tiny Tauri tray utility for two daily jobs:

- Stage YouTube links from the clipboard and download them with yt-dlp after one explicit click.
- Keep a local, searchable clipboard history with 30/60/90-day retention.

## Website & demo

- 🌐 Landing page: https://nabbit-local.vercel.app/
- ▶️ Simulated tray demo: https://nabbit-local.vercel.app/demo/

The public demo is canned browser state. It never reads the clipboard, contacts YouTube, launches yt-dlp/ffmpeg, or writes files.

It lives in the system tray, starts hidden, and opens as a small popover on a shortcut or tray click. Nothing leaves your machine except the downloads you explicitly trigger; see [PRIVACY.md](PRIVACY.md).

## Architecture

```
        clipboard changes                     you press the shortcut
              │                                        │
              ▼                                        ▼
┌───────────────────────── Nabbit (Tauri v2) ─────────────────────────┐
│                                                                      │
│  Rust backend (src-tauri/)              Web UI popover (src/)        │
│  ├─ clipboard watcher ──► local SQLite  ├─ searchable history list   │
│  │   history + retention (30/60/90 d)   ├─ staged YouTube queue      │
│  ├─ YouTube link detector (stages,      │   with progress/cancel/    │
│  │   never auto-downloads)              │   retry                    │
│  └─ download engine: spawns yt-dlp +    └─ settings (hotkeys,        │
│      ffmpeg sidecar binaries                retention, formats)      │
│         │                                                             │
│         ▼                                                             │
│  ~ app-data dir: history DB · settings   (override: NABBIT_APP_DATA_DIR) │
└──────────────────────────────────────────────────────────────────────┘
```

Two deliberate design points: downloads happen **only after one explicit click** (the watcher just stages links), and yt-dlp/ffmpeg run as separate sidecar executables — so the media engine can be updated without rebuilding Nabbit.

## Requirements

- Node.js 20+
- Rust 1.80+
- Platform requirements for Tauri v2
- `yt-dlp` and `ffmpeg` sidecars in `src-tauri/binaries`, or available on `PATH`

## Setup

```bash
npm install
npm run verify
cargo build --manifest-path src-tauri/Cargo.toml
```

On Windows, fetch the downloader engine:

```powershell
.\scripts\fetch-binaries.ps1 -Target x86_64-pc-windows-msvc
```

The script downloads yt-dlp automatically. ffmpeg providers publish archives rather than a single stable executable, so extract `ffmpeg.exe` from the downloaded archive into `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe`, or install ffmpeg on `PATH`.

## Run

```bash
npm run tauri:dev
```

Nabbit starts hidden by default. Use the tray icon or the configured shortcut to open the popover.

## Verification

```bash
npm run verify
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Manual coverage lives in [tests/manual-e2e.md](tests/manual-e2e.md).

On Windows, after building `src-tauri/target/release/nabbit.exe`, run the packaged-app smoke:

```powershell
.\scripts\windows-acceptance-smoke.ps1
```

The smoke uses `NABBIT_APP_DATA_DIR` to point Nabbit at a disposable temporary app-data directory, so it does not touch the user's real clipboard history database. It also sets test-only acceptance env vars: `NABBIT_ACCEPTANCE_COMMAND_DIR` lets the running app execute acceptance checks such as clearing clipboard history and managing fake downloads, while `NABBIT_ACCEPTANCE_FAKE_DOWNLOAD` keeps queue/progress/cancel/retry checks deterministic without touching the network.

For opt-in real yt-dlp/ffmpeg media verification, run:

```powershell
.\scripts\windows-real-download-smoke.ps1
```

That script sets `NABBIT_ACCEPTANCE_DOWNLOAD_SECTION` so the running app downloads only a short section while still exercising the real 1080p MP4 merge, MP3 extraction, playlist detection, video-only, and playlist range paths.

## Release Builds

Normal local builds keep updater artifacts off so they do not require private signing material. Release builds use `src-tauri/tauri.release.conf.json`, which enables signed updater artifacts and points the updater at the GitHub Releases `latest.json` endpoint. Update that endpoint if the production repository is not `tanzir/nabbit`.

The updater public key is committed in the release config. Keep the private key out of Git and expose it only through one of these environment variables:

```bash
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PATH
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

On this machine, a local development updater key was generated at `~/.tauri/nabbit-updater.key`. To build signed updater artifacts locally:

```powershell
.\scripts\build-release.ps1 -Target x86_64-pc-windows-msvc
```

For Unix runners:

```bash
./scripts/build-release.sh x86_64-unknown-linux-gnu
```

The GitHub release workflow builds Windows, macOS Intel, macOS Apple Silicon, and Linux artifacts through `tauri-apps/tauri-action`. Configure repository secrets `TAURI_SIGNING_PRIVATE_KEY` and optionally `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` before publishing. Apple/Windows code-signing certificates are still required for a production-trusted release.

## Screenshots

Screenshots/GIF placeholder: add the popover, clipboard search, and active download queue captures before release packaging.
