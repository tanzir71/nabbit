# Nabbit Privacy Statement

Nabbit is local-first.

Battery status is read locally at startup and in response to Windows power notifications. Current charge, power source and charging state stay in memory; Nabbit stores no battery history and does not sync this data. Brief change notifications dismiss automatically, and unknown levels stay unknown. Reading status and registering notifications never change Windows power settings.

The mic/camera indicator watches Windows ConsentStore activity and checks matching running processes, including their executable paths, package identities and creation times, to reject stale entries after a crash. It reads bounded executable description metadata for app names. These checks stay in memory; only current app names and capability state reach the island. Nabbit never opens a microphone/camera, records audio/video, stores a usage history or syncs this data. Detection depends on the activity Windows reports; amber means microphone use and lime means camera use, including virtual cameras.

Now playing subscribes to Windows media-session events. Titles, artists, playback state and bounded 96 px artwork stay in memory on this PC; Nabbit does not fetch artwork URLs, keep listening history or sync this data. Playback, seeking, session selection, mute and system-volume changes happen only through your controls or pill gestures. Scroll changes system volume by two percentage points, or one with Shift; middle-click toggles the selected media session.

The focus timer stores its settings, UTC deadline, paused time and session history in local SQLite so it can survive sleep and restarts. An optional card link retains its card ID and workspace identity; the displayed title/reference comes only from the current accessible Notes workspace. Linking or timing does not edit a Tack card or upload time records. Tack time logging remains a future feature.

The Shelf stores local file paths and order in SQLite. Adding a file permits presence/size checks and a bounded in-memory preview for supported images; previews are not stored as file copies. Copy paths writes path text only after an explicit action. Dragging out hands the selected original paths to the operating system in copy mode. Remove and Clear delete Shelf references, never the original files. Shelf data is not synced or used for telemetry.

- Clipboard history is stored in a SQLite database in the operating system app-data directory.
- Clipboard history stays on this device and is not synced or used for telemetry. With link auto-detection enabled, a web URL found in accepted clipboard text is staged and sent to yt-dlp to fetch metadata from the site. Excluded apps, protected clipboard formats and enabled sensitive-text filters are checked first. Pause or disable link detection to stop these automatic metadata requests.
- Nabbit does not include analytics in v1.
- Clipboard links, dropped links, browser deep links and pasted links can fetch metadata without downloading media. Downloads require an explicit action, including Ctrl+Alt+D, which reads the current clipboard URL and uses that site's remembered preset. Deno runs yt-dlp's JavaScript helper locally; ffmpeg merges or converts the requested media locally.
- Once per day, the engine health check probes a fixed public Creative Commons YouTube sample without downloading media. This check never reads your clipboard or browser profiles. Offline or timed-out checks are recorded as skipped.
- Engine update checks contact GitHub. When engine auto-update is enabled, or you choose Repair or a different channel, verified yt-dlp/Deno binaries can be downloaded from their upstream projects. Windows ffmpeg uses pinned BtbN (FFmpeg-Builds/FFmpeg-Builds) static GPL builds; repair prefers the matching executable already shipped with Nabbit before downloading the pinned archive. There is no Nabbit telemetry service.
- SponsorBlock marking/cutting is off by default. When you choose it for a download, yt-dlp requests segment information from SponsorBlock for the selected video. Browser sign-in selection applies only to that job. Nabbit does not save a cookie file or include browser sign-in in remembered site presets.
- Password-manager exclusions are seeded for 1Password, Bitwarden, KeePass, LastPass, and Dashlane where source-app detection is available.
- Optional sensitive-text heuristics can skip likely OTPs, credit-card numbers, and high-entropy secrets.
- Clearing clipboard history deletes stored clipboard rows from the local database.
- In the island Clipboard tab, clicking a history row, pressing 1–9 or Ctrl+C copies its stored text. Enter also attempts to restore the app that opened the island and send paste. If that destination is unavailable, Nabbit reports that the item was copied and leaves the panel open. File entries copy path text; image capture/copy remains unavailable. History search and filters do not read the current clipboard or open the stored paths.

Users are responsible for complying with YouTube's Terms of Service and applicable copyright law. Nabbit is intended for content the user has the right to download.

## Pins and file operations

Pins persist local target paths, labels, shortcut slots and move preferences in
SQLite. Removing a pin never changes its target. Folder peeks list at most six
recent entries by metadata; a nonrecursive local watcher exists only while the
peek is visible. Network folders are not watched. Windows known-folder and sync
root metadata are read locally to respect redirection and explain cloud move-out.
Browsing and previewing cloud-only placeholders does not read their contents or
request hydration; cached thumbnails or file icons are used instead.

An explicit drop or destination action permits the requested move/copy through
Windows Shell. The local `file_ops` journal stores source/destination metadata,
result paths, content hashes/identities and the affected Shelf/pin/download/tool
references for Undo. Before a possible replacement, Nabbit stores a complete
backup of the existing destination in app-data, including supported Windows file
metadata and alternate streams. Backups and operation records are currently
retained; unused Keep both/skip backups are retained too. This is additional
local file content, not just path history. Undo checks the recorded results and
uses native transfers/Recycle Bin; it refuses edited/replaced results and occupied
original paths. No file journal or backup is synced or transmitted.

Cloud-root move-out, network destinations and batches over 50 require an extra
confirmation. An explicit transfer may download a cloud placeholder as part of
the Windows operation. Shell dialogs, app opening, Copy path and outgoing drag
follow explicit user actions. No tidy rules or background file moves run.

## File tool jobs and Search

File tools run only after an explicit action. Inputs are read locally; they are
not uploaded. The local SQLite queue stores input/output paths, the chosen
preset, progress/status, sizes and an output content hash/file identity for
Undo. Outputs get separate names; original content is kept. Cancel keeps the
queue record and removes the tool's temporary output. Retry creates a new job
using the previous options. Completed results persist across restarts. Undo
moves the matching new file to the Windows Recycle Bin and refuses edited or
replaced outputs.

Media review reads the selected local file's stream descriptions with the
verified ffmpeg. The queue also stores media options, stream information and
size-attempt reports (encoder, bitrate/dimensions, sizes and original-content
hash). Exact mode needs no GPU test. Selecting Fast can encode a one-second
synthetic test clip locally; the probe cache records adapter identities and
driver versions against the engine hash. It contains no uploaded media.
Temporary pass logs and staging files are removed when their operation ends.
Metadata removal clears container/stream tags and chapters; it does not change
visible or audible information. Physical created/modified dates remain copied.
Cloud recall/offline inputs are rejected from metadata before a content open.

Search reads the registered tools, accessible active notes/bookmarks in the
current Tack scope, stored pins, Shelf references and clipboard history. It
does not scan the filesystem, browser profiles, current selection or current
OS clipboard. Note/link navigation includes the original scope guard. Change
subscriptions are installed before reading scoped results; lost subscriptions
fail closed. No JavaScript polling runs while the island is collapsed.

The third-party licence screen reads bundled notices and configure lines
offline. Conversion invokes the verified ffmpeg executable as a separate
process; Nabbit does not link libav libraries or bundle HEVC Store codecs.

## Links and bookmark imports

Saving a link explicitly requests its page title with a cookie-free HTTP GET (5-second timeout, 512 KB body cap, at most five redirects), or reuses metadata already fetched for that URL. Nabbit never loads page scripts, favicons or subresources for Links. The saved address is preserved; tracking parameters and fragments are removed only when comparing duplicates. Clean link copies a separate address without tracking parameters.

Import bookmarks scans only the known Chrome, Edge, Brave and Vivaldi profile roots for Local State and Bookmarks, and Firefox Profiles for places.sqlite and its WAL. Firefox is queried from a temporary private copy, restricted to bookmarked URLs and their folders; browsing-history-only rows are not imported. The import sheet lists the exact files read. An HTML export is read only after choosing it in the native picker. Browser cookies, passwords and other files are never read. Temporary copies are removed after parsing. Imported links stay on this PC unless you explicitly connect a Tack workspace or upload local notes.

Ctrl+Alt+N uses the existing clipboard exclusions before offering Save link for a URL. Ctrl+Alt+S reads one selected URL through Windows UI Automation only after an explicit shortcut, rejecting password fields and excluded apps. There is no simulated-copy fallback or background selection collection. Both shortcuts open an unsaved editor; saving is explicit.
