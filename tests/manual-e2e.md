# Nabbit Manual E2E

Run on each available OS before release.

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
