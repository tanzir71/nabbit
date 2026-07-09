# Nabbit Manual E2E

Run on each available OS before release.

## 2026-07-10 partial run notes

- Windows release smoke launch passed earlier for `src-tauri/target/release/nabbit.exe`.
- Real clipboard watcher storage was verified earlier by copying a unique value and confirming a row in `%APPDATA%\com.nabbit.app\nabbit.sqlite3`.
- Downloader sidecar verification passed with a Creative Commons YouTube test video (`https://www.youtube.com/watch?v=e6rhUvwB5Y8`): direct yt-dlp probe returned a 250-second, CC-licensed, 2160p-capable source; direct 3-second 1080p MP4 section produced AAC audio and a 3,179,722-byte output; direct 3-second MP3 extraction produced an MP3 output.
- Direct progress-template verification passed: yt-dlp emitted `nabbit:100.0%|...` and Rust parser tests cover prefixed and bare machine progress lines.
- Unit coverage now includes source-app exclusions, Windows OS clipboard exclusion format, sensitive heuristics, huge clipboard skip, corrupt DB recovery, playlist range args, fallback format args, final MP3 output path detection, and corrupt engine probe failure.
- Windows release updater signing passed with `.\scripts\build-release.ps1 -Target x86_64-pc-windows-msvc -Bundles "msi,nsis"`; MSI/NSIS bundles and matching `.sig` files were produced under `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`.
- Windows packaged-app acceptance smoke passed with `.\scripts\windows-acceptance-smoke.ps1` against isolated disposable app data: release app launched hidden, real clipboard text was stored in 472ms, duplicate copy stayed one row, sensitive credit-card-shaped text was skipped, retention launch GC deleted an expired unpinned row while keeping pinned/fresh rows, a YouTube URL staged in 738ms without creating a download row, and idle CPU was 0 seconds over a 5-second sample.
- Full GUI acceptance below is not complete until each checkbox is manually exercised in the installed app.

## Clipboard

- Copy plain text. Confirm it appears in the Clipboard tab within about one second.
- Copy the same text twice. Confirm one row remains and moves to the top.
- Search by a fuzzy fragment. Confirm rows filter immediately.
- Use Arrow Up/Down, Enter, Delete, Cmd/Ctrl+F, and number keys 1-9.
- Pin an old row, set retention to 30 days, run retention GC, and confirm pinned rows survive.
- Clear all history from Settings and from the tray menu.
- Enable sensitive heuristics and copy an OTP-like value; confirm it is skipped.
- Copy from an excluded password manager where source app detection is available; confirm it is skipped.
- Observe idle CPU for five minutes with no clipboard changes.

## Downloads

- Copy a YouTube watch URL. Confirm a Download card is staged and no download starts.
- Probe metadata. Confirm title, thumbnail, duration/channel where yt-dlp returns them.
- Download one video at 1080p or higher. Confirm ffmpeg merges audio/video and the file lands in Downloads/Nabbit.
- Download audio-only MP3.
- Copy a playlist URL. Confirm video-only and playlist-with-range modes.
- Start multiple downloads. Confirm the concurrency setting is respected.
- Cancel a running download, then retry it.
- Restart Nabbit. Confirm completed/interrupted history persists.
- Temporarily remove yt-dlp/ffmpeg. Confirm missing-engine repair messaging.

## App

- Confirm tray icon appears and left click toggles the popover.
- Confirm right-click tray menu: open, paste last, clear history, downloads folder, pause auto-detect, quit.
- Confirm first-run acknowledgement appears once.
- Confirm no dock/taskbar presence when `showDockIcon` is disabled.
- Confirm second launch focuses the existing app.
