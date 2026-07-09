# Nabbit

Nabbit is a tiny Tauri tray utility for two daily jobs:

- Stage YouTube links from the clipboard and download them with yt-dlp after one explicit click.
- Keep a local, searchable clipboard history with 30/60/90-day retention.

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

## Screenshots

Screenshots/GIF placeholder: add the popover, clipboard search, and active download queue captures before release packaging.
