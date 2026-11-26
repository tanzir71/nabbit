# Nabbit Privacy Statement

Nabbit is local-first.

- Clipboard history is stored in a SQLite database in the operating system app-data directory.
- Clipboard contents are not uploaded, synced, analyzed remotely, or used for telemetry.
- Nabbit does not include analytics in v1.
- Your video URLs are sent to yt-dlp only when you explicitly start a download or probe metadata for a staged link. Deno runs yt-dlp's JavaScript helper locally; ffmpeg merges or converts the requested media locally.
- Once per day, the engine health check probes a fixed public Creative Commons YouTube sample without downloading media. This check never reads your clipboard or browser profiles. Offline or timed-out checks are recorded as skipped.
- Engine update checks contact GitHub. When engine auto-update is enabled, or you choose Repair or a different channel, verified yt-dlp/Deno binaries can be downloaded from their upstream projects. A missing Windows ffmpeg can be restored from yt-dlp's FFmpeg Builds project. There is no Nabbit telemetry service.
- SponsorBlock marking/cutting is off by default. When you choose it for a download, yt-dlp requests segment information from SponsorBlock for the selected video. Browser sign-in selection applies only to that job. Nabbit does not save a cookie file or include browser sign-in in remembered site presets.
- Password-manager exclusions are seeded for 1Password, Bitwarden, KeePass, LastPass, and Dashlane where source-app detection is available.
- Optional sensitive-text heuristics can skip likely OTPs, credit-card numbers, and high-entropy secrets.
- Clearing clipboard history deletes stored clipboard rows from the local database.

Users are responsible for complying with YouTube's Terms of Service and applicable copyright law. Nabbit is intended for content the user has the right to download.
