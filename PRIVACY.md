# Nabbit Privacy Statement

Nabbit is local-first.

Now playing subscribes to Windows media-session events. Titles, artists, playback state and bounded 96 px artwork stay in memory on this PC; Nabbit does not fetch artwork URLs, keep listening history or sync this data. Playback, seeking, session selection, mute and system-volume changes happen only through your controls or pill gestures. Scroll changes system volume by two percentage points, or one with Shift; middle-click toggles the selected media session.

The Shelf stores local file paths and order in SQLite. Adding a file permits presence/size checks and a bounded in-memory preview for supported images; previews are not stored as file copies. Copy paths writes path text only after an explicit action. Dragging out hands the selected original paths to the operating system in copy mode. Remove and Clear delete Shelf references, never the original files. Shelf data is not synced or used for telemetry.

- Clipboard history is stored in a SQLite database in the operating system app-data directory.
- Clipboard history stays on this device and is not synced or used for telemetry. With link auto-detection enabled, a web URL found in accepted clipboard text is staged and sent to yt-dlp to fetch metadata from the site. Excluded apps, protected clipboard formats and enabled sensitive-text filters are checked first. Pause or disable link detection to stop these automatic metadata requests.
- Nabbit does not include analytics in v1.
- Clipboard links, dropped links, browser deep links and pasted links can fetch metadata without downloading media. Downloads require an explicit action, including Ctrl+Alt+D, which reads the current clipboard URL and uses that site's remembered preset. Deno runs yt-dlp's JavaScript helper locally; ffmpeg merges or converts the requested media locally.
- Once per day, the engine health check probes a fixed public Creative Commons YouTube sample without downloading media. This check never reads your clipboard or browser profiles. Offline or timed-out checks are recorded as skipped.
- Engine update checks contact GitHub. When engine auto-update is enabled, or you choose Repair or a different channel, verified yt-dlp/Deno binaries can be downloaded from their upstream projects. A missing Windows ffmpeg can be restored from yt-dlp's FFmpeg Builds project. There is no Nabbit telemetry service.
- SponsorBlock marking/cutting is off by default. When you choose it for a download, yt-dlp requests segment information from SponsorBlock for the selected video. Browser sign-in selection applies only to that job. Nabbit does not save a cookie file or include browser sign-in in remembered site presets.
- Password-manager exclusions are seeded for 1Password, Bitwarden, KeePass, LastPass, and Dashlane where source-app detection is available.
- Optional sensitive-text heuristics can skip likely OTPs, credit-card numbers, and high-entropy secrets.
- Clearing clipboard history deletes stored clipboard rows from the local database.
- In the island Clipboard tab, clicking a history row, pressing 1–9 or Ctrl+C copies its stored text. Enter also attempts to restore the app that opened the island and send paste. If that destination is unavailable, Nabbit reports that the item was copied and leaves the panel open. File entries copy path text; image capture/copy remains unavailable. History search and filters do not read the current clipboard or open the stored paths.

Users are responsible for complying with YouTube's Terms of Service and applicable copyright law. Nabbit is intended for content the user has the right to download.

## Links and bookmark imports

Saving a link explicitly requests its page title with a cookie-free HTTP GET (5-second timeout, 512 KB body cap, at most five redirects), or reuses metadata already fetched for that URL. Nabbit never loads page scripts, favicons or subresources for Links. The saved address is preserved; tracking parameters and fragments are removed only when comparing duplicates. Clean link copies a separate address without tracking parameters.

Import bookmarks scans only the known Chrome, Edge, Brave and Vivaldi profile roots for Local State and Bookmarks, and Firefox Profiles for places.sqlite and its WAL. Firefox is queried from a temporary private copy, restricted to bookmarked URLs and their folders; browsing-history-only rows are not imported. The import sheet lists the exact files read. An HTML export is read only after choosing it in the native picker. Browser cookies, passwords and other files are never read. Temporary copies are removed after parsing. Imported links stay on this PC unless you explicitly connect a Tack workspace or upload local notes.

Ctrl+Alt+N uses the existing clipboard exclusions before offering Save link for a URL. Ctrl+Alt+S reads one selected URL through Windows UI Automation only after an explicit shortcut, rejecting password fields and excluded apps. There is no simulated-copy fallback or background selection collection. Both shortcuts open an unsaved editor; saving is explicit.
