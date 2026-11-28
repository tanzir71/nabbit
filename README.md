# Nabbit

Nabbit is a tiny Tauri tray utility for two daily jobs:

- Stage YouTube links from the clipboard and download them with yt-dlp after one explicit click.
- Keep a local, searchable clipboard history with 30/60/90-day retention.

## Website & demo

- Landing page: https://tanzir71.github.io/nabbit/
- Simulated tray demo: https://tanzir71.github.io/nabbit/demo/

The public demo is canned browser state. It never reads the clipboard, contacts YouTube, launches yt-dlp/ffmpeg, or writes files.

It lives in the system tray, starts hidden, and opens as a small popover on a shortcut or tray click. Nothing leaves your machine except the downloads you explicitly trigger; see [PRIVACY.md](PRIVACY.md).

## Native file tools (v2 foundation)

Search and Shelf actions use one native registry for Fit under a size, To MP4,
precise local trim, MP3/M4A extraction, GIF, animated WebP, audio/video metadata
removal, and To JPG. Media tools open a separate review window; choose a local
file and run it explicitly. Files shows progress, Cancel, Retry, Reveal and Undo.
Cancelled jobs stay in the queue; interrupted work waits for Retry. Quitting
during a tool job shows a warning. Undo recycles the generated output only when
its identity and content still match the recorded result.

Fit reserves audio first and leaves 3% headroom. Exact uses libx264 two-pass;
Fast tests available GPU encoders on a one-second synthetic clip and shows the
first working encoder. Probe results are cached against the actual adapters,
driver versions and pinned engine; unknown driver versions disable cache reuse.
Oversized outputs get at most three attempts, always from the original. Video
resolution steps down only when the bitrate budget needs it. Audio shares the
same size presets. MP4 tries lossless remux before H.264/AAC conversion; GIF
uses a palette graph with a 720-pixel/15-fps cap. Animated WebP is available
when the bundled engine provides its encoder.

Outputs are created beside the input as `<name> (<Preset>).<ext>`, then ` 2`,
` 3`, and so on for name clashes. Publication never replaces another file;
modified and created dates are copied where supported. Settings → Files stores
editable share limits: Discord 20 MB, email 25 MB, Outlook 10 MB and WhatsApp
100 MB. Drop suggestions prefer To MP4 for MOV/MKV and Fit for Discord for
other videos over the saved Discord cap. Cloud-only inputs are rejected before
opening or hashing their contents. Remaining image/PDF/context tools belong to
the following handoff tasks and are not advertised as runnable entries yet.

Windows conversions use only the pinned BtbN static GPL `ffmpeg.exe` as a
separate process. The setup script installs no ffprobe, ffplay or libav DLL.
Settings → About → Third-party licences includes the generated dependency
notices, GPL text, source offer and original x64/ARM64 configure lines.

Development verification requires cargo-deny 0.22.2 on PATH, or the verified
Windows x64 helper installed with `node scripts/fetch-cargo-deny.mjs`.
`npm run verify` includes `npm run verify:licenses`: it checks the locked crate
graph and negative GPL/AGPL/LGPL/libav-binding fixtures. After dependency or
sidecar pin changes, run `python scripts/generate-licenses.py` to regenerate the
offline notice catalogue. No installer, administrator access or signing key
is used for these checks.

## Files and Pins

The Files island tab keeps the Shelf above eight visible file/folder Pins. Search
finds additional pins; Alt+1–9 opens assigned slots while expanded. Pin actions
include Open, Reveal, Copy path, Open With, and installed Terminal/VS Code.
Removing a pin removes its reference. Hover a folder for about 350 ms to see its
six newest entries; click holds the peek open. Local metadata watches exist only
while visible; network folders refresh when opened and are never watched.

Drop files on a folder pin or choose **Move to…** from selected Shelf items or a
finished download. Same-volume operations move, other volumes copy; Shift forces
move, Ctrl forces copy (Ctrl wins together), and a pin can default to Always move.
Only cloud-root move-out, network destinations, or batches over 50 ask for an
extra confirmation. Recent extension/site destinations precede pins and the
folder picker. Windows handles transfers and conflict dialogs through
`IFileOperation` on Nabbit's shared Shell STA worker.

The eight-second Moved/Copied pill and File history offer journal-backed Undo,
including after a restart. Undo checks result identity and content before
reversing an operation. Existing destination files are backed up inside local
app-data before native conflict resolution; these backups and operation records
are currently retained, including unused backups after Keep both/skip. They can
contain complete file contents. Edited results or occupied original paths produce
an error rather than an overwrite. Clipboard copies, opening apps, and moving
files always follow explicit actions.

Known folders respect Windows redirection. Pin browsing reads metadata only;
cached Shell thumbnails are preferred and cloud-only items use icons without
hydration. Rust file I/O uses verbatim paths, with an embedded long-path manifest
and a clear error when Windows long paths are disabled. See the
[V5.8 evidence](progress/v2/M10/README.md) and [privacy statement](PRIVACY.md).

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
- `yt-dlp`, `ffmpeg` and `deno` sidecars in `src-tauri/binaries`, or available on `PATH`

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

The script provisions all three Windows sidecars from `scripts/engine-pins.json`, verifies SHA-256 before replacing files and selects native x64/ARM64 assets. Both setup wrappers use `scripts/fetch-engines.mjs`; the shell wrapper also supports Linux and macOS targets. macOS keeps the existing ffmpeg-on-PATH/custom-sidecar requirement. Release binaries stay gitignored.

Settings shows **Download engine** health, Check now, Stable/Nightly and Repair. Rust checks all three versions and runs a bounded 3-second simulated extraction of the fixed Creative Commons sample daily. It pushes cached results to the card and a single island Error state; no collapsed JavaScript polling or automatic media downloads. Offline/time-out samples are skipped. Updates verify upstream asset digests, probe staged replacements, atomically swap each binary and re-probe. Island acceptance launches disable this worker; legacy download acceptance runs local version probes with network/update work disabled. See [the engine evidence](progress/v2/M6/README.md) and [privacy statement](PRIVACY.md).

## Run

```bash
npm run tauri:dev
```

Nabbit starts hidden by default. Use the tray icon or the configured shortcut to open the popover.

## Verification

The v2 screenshot harness captures seven mocked UI scenarios in light/dark at
1×/1.5×, with PNGs and a manifest under `progress/v2/M<n>/`. Install the locked
Chromium once with `npm run screenshots:install`, then use a fresh output prefix:

```powershell
npm run screenshots -- --milestone M2 --prefix local-proof --repeat-check
```

See [harness usage and extension points](scripts/screenshots/README.md). Captures
use isolated browser fixtures; they never launch the native app or access the
real clipboard, downloader or OS preferences. Run `npm run build` afterwards to
restore the default production entries.

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

To build signed updater artifacts locally (with the signing key variables above set):

```powershell
.\scripts\build-release.ps1 -Target x86_64-pc-windows-msvc
```

For Unix runners:

```bash
./scripts/build-release.sh x86_64-unknown-linux-gnu
```

The GitHub release workflow builds Windows, macOS Intel, macOS Apple Silicon, and Linux artifacts through `tauri-apps/tauri-action`. Configure repository secrets `TAURI_SIGNING_PRIVATE_KEY` and optionally `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` before publishing. Apple/Windows code-signing certificates are still required for a production-trusted release.
