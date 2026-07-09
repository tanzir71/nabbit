# Nabbit — Codex Build Handoff

> **What this document is.** A complete, self-contained specification for building **Nabbit**, a minimal cross-platform tray utility that (1) downloads YouTube videos with zero-friction link auto-detection and (2) keeps a searchable, time-limited clipboard history. This doc is written to be executed by **Codex in an iterative loop**: each pass, Codex reads this file, finds the next unchecked task in the **Build Loop**, implements it, self-verifies against the acceptance criteria, checks the box, commits, and repeats until every box is checked and the Definition of Done passes.

---

## 0. How to run this in a loop (read first, every pass)

Codex, on each iteration do exactly this:

1. **Read** this whole file, then read `PROGRESS.md` (create it if missing — see §12).
2. **Select** the first task in the **Build Loop (§10)** whose checkbox is unchecked and whose dependencies are all checked.
3. **Implement** only that task. Do not skip ahead. Keep diffs small and focused.
4. **Self-verify**: run the task's acceptance checks (build, lint, typecheck, tests, and manual assertions listed). If anything fails, fix it in the same pass before checking the box.
5. **Check the box** (`[ ]` → `[x]`) in this file and append a short entry to `PROGRESS.md` (what changed, files touched, how verified, any new decisions/questions).
6. **Commit** with a message `nabbit: <phase>.<task> <summary>`.
7. **Stop the pass.** The loop will re-invoke you for the next task.

**Rules for the whole loop**

- Never mark a box `[x]` unless build + typecheck + lint + the task's tests all pass.
- If a task is blocked, leave it unchecked, write the blocker in `PROGRESS.md` under "Blockers", and move to the next *unblocked* task.
- Prefer boring, well-supported APIs over clever ones. This is a background utility; reliability and low resource use beat features.
- Keep the binary small and idle CPU near zero. Every dependency must earn its place.
- When a spec detail is ambiguous, pick the simplest option that satisfies the acceptance criteria, record the decision in `PROGRESS.md` → "Decisions", and continue.
- **Definition of Done for the whole project** is in §13. The loop ends when every Build Loop box is checked and §13 passes.

---

## 1. Product summary

**Nabbit** is a lightweight, always-available desktop companion that lives in the system tray / menu bar. It does two small things exceptionally well:

1. **Nab videos** — Detects a YouTube URL the moment it lands on your clipboard (or is pasted into the app), shows a ready-to-go download card, and waits. You press **Download**. That's the whole interaction. It handles quality selection, audio-only extraction, playlists, and merging high-res streams under the hood.
2. **Nab clipboard** — Remembers everything you copy for a retention window **you** choose (30, 60, or 90 days), with instant fuzzy search, previews, one-click re-copy, and privacy controls (app exclusions, sensitive-content skipping, manual clear).

It is **minimal by design**: no account, no cloud, no telemetry by default. Data lives locally. The main window is a small popover from the tray; the app otherwise stays out of the way.

**Tagline candidates:** "Nab it. Keep it." / "Grab videos, keep your clipboard."

### 1.1 Name & branding

**Chosen name: Nabbit** — a coined, ownable spin on "nab it" (to grab/catch). It fits both features (grabbing videos, catching clipboard items), is short, friendly, verbable ("just Nabbit"), and pronounceable everywhere.

- **Product name:** Nabbit
- **Binary / bundle id:** `com.nabbit.app` (adjust org later if trademarking)
- **Alternates if a conflict is found:** *Stashly*, *Snagbox*, *Klipp*. Before shipping, verify name/domain/trademark availability (`nabbit.app`, `getnabbit.com`, app-store name collisions, USPTO/EUIPO quick search). Record the outcome in `PROGRESS.md`.
- **Visual identity (starter):** a rounded "hook/pin" glyph; single accent color `#4F46E5` (indigo) on neutral gray UI; supports light + dark. Tray icon must be monochrome/template-style so it adapts to OS light/dark menu bars.

---

## 2. Competitor analysis

Research was done to position Nabbit against the tools people actually use in 2026. The strategic thesis: **existing tools do one of these two jobs, and the good ones are either single-platform or feature-bloated. Nabbit wins on "two everyday micro-jobs, one tiny always-there app, radically minimal UX, private by default."**

### 2.1 YouTube downloaders

| Tool | Platforms | Strengths | Weaknesses / gaps Nabbit exploits |
|---|---|---|---|
| **4K Video Downloader+** | Win / macOS / Linux | Polished UI; playlists, channels, subtitles; 4K/8K; MP4/MKV, MP3/M4A | Free tier limits playlist/channel counts (paywall nag); heavier full-window app; not a background auto-detector |
| **JDownloader 2** | Win / macOS / Linux | Free, open-source; huge batch handling; auto link-grabbing from clipboard; multi-site | Dated, cluttered Java UI; installer has historically bundled adware/extras; overkill for "just grab this one video" |
| **yt-dlp (CLI)** | All | Gold-standard engine; best format control; scriptable; always up to date | Command line only — no GUI, no auto-detect, inaccessible to non-technical users |
| **ClipGrab / online sites** | Varies / web | Simple; no install (web) | Ads, sketchy redirects, quality caps, privacy risk, unreliable as YouTube changes |

**Key insight:** The best *engine* (yt-dlp) has no friendly always-on GUI, and the best *GUIs* aren't zero-friction background catchers. JDownloader proves clipboard auto-grab is loved but its UX is heavy and its installer reputation is poor. **Nabbit = yt-dlp reliability + a one-tap, auto-detecting, tray-native, ad-free, clean UX.**

### 2.2 Clipboard managers

| Tool | Platforms | Strengths | Weaknesses / gaps Nabbit exploits |
|---|---|---|---|
| **Paste** | macOS / iOS / iPadOS | Beautiful timeline, thumbnails, iCloud sync; private (device + user's iCloud) | Mac/Apple only; $29.99/yr subscription; more than many people need |
| **Maccy** | macOS | Free/open-source; fastest keyboard-first search; tiny footprint | Mac only; no image previews/timeline; limited organization; no time-based retention control |
| **Ditto** | Windows | Free/open-source; 20+ yrs mature; text/images/files/HTML; SQLite search; type filters | Windows only; dated UI |
| **CopyQ** | Win / macOS / Linux | Cross-platform; tabs, scripting, tagging, deep power features | Powerful-but-complex; developer-oriented; not minimal; no first-class "keep for N days" retention model |

**Key insight:** No widely-loved clipboard manager is simultaneously **cross-platform, minimal, and built around a user-chosen time-based retention window (30/60/90 days)** with privacy-first defaults. Power tools (CopyQ) overwhelm; the elegant ones (Paste) are Apple-locked and subscription. **Nabbit's clipboard = cross-platform, minimal, retention-window-first, private by default, free.**

### 2.3 Positioning statement

> For people who regularly grab web videos and copy-paste all day, **Nabbit** is a single tiny tray app that auto-detects YouTube links for one-tap download and remembers your clipboard for exactly as long as you want — cross-platform, private, no accounts, no clutter. Unlike bloated download managers or Apple-only clipboard tools, Nabbit does two everyday jobs with near-zero friction and near-zero footprint.

### 2.4 Differentiators to protect (do not compromise these)

1. **One-tap download after auto-detect** — no forms, no wizard.
2. **Time-window retention (30/60/90)** as the core clipboard mental model, not entry-count.
3. **Radically minimal, tray-native UX** — popover, not a big window.
4. **Private by default** — local storage, no telemetry, password-manager/sensitive exclusion out of the box.
5. **Cross-platform parity** — same experience on macOS, Windows, Linux.
6. **Tiny footprint** — Tauri build; idle CPU ≈ 0, small binary.

---

## 3. Target users

- **Primary:** Non-technical-to-intermediate desktop users who (a) save YouTube videos for offline/reference and (b) copy-paste heavily (writers, designers, researchers, students, developers, support agents).
- **Secondary:** Power users who want yt-dlp reliability without the CLI, and privacy-conscious users who refuse cloud clipboard tools.

Nabbit must be usable with **zero documentation** for the two core flows.

---

## 4. Scope

### 4.1 In scope (v1)

- Cross-platform tray/menu-bar app (macOS, Windows, Linux).
- YouTube (and yt-dlp-supported site) download with auto-detect + one-tap.
- Quality/format selection, audio-only extraction, playlist support, progress, queue.
- Clipboard history with 30/60/90-day retention, search, preview, re-copy, pin, delete, clear-all.
- Privacy: app exclusions, sensitive-content skip, no telemetry.
- Settings window. Launch-at-login. Global hotkeys. Auto-update of app and of the yt-dlp binary.

### 4.2 Out of scope (v1 — record as backlog)

- Cloud sync / multi-device.
- Accounts / login.
- Mobile apps.
- Non-YouTube DRM-protected services (Netflix etc. — never).
- Cloud clipboard, team sharing.
- Browser extension (nice-to-have later).

### 4.3 Explicit non-goals

- No ads, no bundled third-party software, no dark-pattern upsells.
- No collection of clipboard contents off-device, ever.

---

## 5. Legal & ethical guardrails (build these in)

- On first run, show a one-time notice: users are responsible for complying with YouTube's Terms of Service and applicable copyright law; Nabbit is intended for content the user has the right to download (e.g., their own content, Creative Commons, or where permitted). Require acknowledgment.
- Do **not** attempt to bypass DRM or paywalled/members-only protected streams. yt-dlp's default capabilities only.
- No downloading is initiated automatically — detection only *prepares* a download; the user must press Download. (This is both a UX and an ethical stance.)
- Clipboard contents never leave the device. No analytics/telemetry in v1. If added later, it must be strictly opt-in and never include clipboard/URL contents.
- Ship a clear privacy statement in-app and in the repo (`PRIVACY.md`).

---

## 6. Tech stack & high-level architecture

**Locked decisions (do not re-litigate):**

- **Framework:** **Tauri v2** (Rust core + web frontend). Chosen for tiny binaries (~a few MB to ~10MB range), low memory, native tray, and true cross-platform support.
- **Frontend:** **React + TypeScript + Vite**. Styling with **Tailwind CSS**. State with a small store (Zustand) — no heavy state libs. Keep the UI tiny.
- **Backend/core:** **Rust** (Tauri commands, background clipboard watcher, download orchestration, DB access).
- **Download engine:** **yt-dlp** bundled as a **Tauri sidecar** (`externalBin`), with **ffmpeg** also bundled as a sidecar for merging video+audio and audio extraction.
- **Process spawning:** `tauri-plugin-shell` (`ShellExt` / `Command` / `CommandEvent`) to run the yt-dlp sidecar and stream progress.
- **Clipboard read/write:** `tauri-plugin-clipboard-manager` (setting/getting clipboard contents).
- **Clipboard monitoring (history):** the core plugin does **not** watch for changes, so use the **`clipboard-master`** Rust crate, which implements the same native per-OS strategy that real clipboard managers use (see §8.2): polls `NSPasteboard.changeCount` on macOS, `AddClipboardFormatListener`/`WM_CLIPBOARDUPDATE` on Windows, XFixes/`wlr-data-control` on Linux. If `clipboard-master` is missing a capability on a target OS, fall back to a manual `changeCount`-style poll on that OS only. Record the choice in `PROGRESS.md`.
- **Storage:** **SQLite** (via `sqlx` or `rusqlite`) in the app data dir. Clipboard entries, download history, pins, settings.
- **Tray:** `tauri::tray::TrayIconBuilder` (Tauri v2 tray API). Left-click opens the popover window; right-click (or menu) shows quick actions + quit.
- **Global shortcuts:** `tauri-plugin-global-shortcut`.
- **Autostart:** `tauri-plugin-autostart`.
- **Updater:** `tauri-plugin-updater` for the app; a separate self-update routine for the yt-dlp binary (§7.4).
- **Single instance:** `tauri-plugin-single-instance` (only one Nabbit runs; second launch focuses the popover).

**Why not Electron:** larger binary and RAM for a background utility; Tauri is the better fit for "tiny, always-on." (Electron remains a fallback only if a hard blocker appears — record it as a Decision if so.)

**Why not native Swift (macOS-only):** the elegant Mac clipboard tools (Maccy, Paste, Pastebot) are Swift/AppKit and get direct access to `NSPasteboard`. But going native would forfeit Windows + Linux, which is a hard requirement. Crucially, the clipboard-watching technique is identical regardless of language — on macOS you poll `NSPasteboard.changeCount` whether you're in Swift or Rust — so Tauri/Rust loses nothing on Mac behavior while keeping one cross-platform codebase (see §8.2). **Stack decision after native-app research: unchanged — Tauri v2 + Rust + React/TS.**

### 6.1 Component diagram (textual)

```
┌────────────────────────── Nabbit (Tauri app) ──────────────────────────┐
│                                                                         │
│  Frontend (React/TS/Tailwind)          Rust core                        │
│  ┌───────────────────────┐             ┌────────────────────────────┐   │
│  │ Tray popover UI        │  invoke →   │ Tauri commands             │   │
│  │  - Download card       │  ← events   │  - detect_url / start_dl   │   │
│  │  - Clipboard list      │             │  - clipboard queries       │   │
│  │  - Settings window     │             │  - settings get/set        │   │
│  └───────────────────────┘             ├────────────────────────────┤   │
│                                          │ Clipboard watcher (thread)│   │
│                                          │  - poll → hash → store     │   │
│                                          │  - emit "clipboard:new"    │   │
│                                          │  - URL sniff → emit        │   │
│                                          ├────────────────────────────┤   │
│                                          │ Download manager           │   │
│                                          │  - queue, concurrency      │   │
│                                          │  - spawn yt-dlp sidecar    │   │
│                                          │  - parse progress → emit   │   │
│                                          ├────────────────────────────┤   │
│                                          │ Retention/GC job (timer)   │   │
│                                          │  - purge entries > window  │   │
│                                          ├────────────────────────────┤   │
│                                          │ SQLite (rusqlite/sqlx)     │   │
│                                          └────────────────────────────┘   │
│                                          Sidecars: yt-dlp, ffmpeg         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Suggested repository structure

```
nabbit/
├─ NABBIT_HANDOFF.md          # this file (source of truth)
├─ PROGRESS.md                # Codex loop log (create in Phase 0)
├─ PRIVACY.md
├─ README.md
├─ package.json
├─ vite.config.ts
├─ tailwind.config.js
├─ tsconfig.json
├─ index.html
├─ src/                       # React frontend
│  ├─ main.tsx
│  ├─ App.tsx
│  ├─ store/                  # zustand stores
│  ├─ views/
│  │  ├─ Popover.tsx          # tray popover root (tabs: Download | Clipboard)
│  │  ├─ DownloadCard.tsx
│  │  ├─ DownloadQueue.tsx
│  │  ├─ ClipboardList.tsx
│  │  └─ Settings.tsx
│  ├─ components/             # Button, Input, Tabs, Toggle, etc.
│  ├─ lib/ipc.ts              # typed wrappers around invoke()/listen()
│  └─ styles/index.css
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json         # externalBin, tray, permissions, updater
│  ├─ build.rs
│  ├─ binaries/               # yt-dlp + ffmpeg sidecars (per-target suffix)
│  ├─ capabilities/           # permissions (shell, clipboard, fs, etc.)
│  └─ src/
│     ├─ main.rs
│     ├─ lib.rs               # app builder, plugins, tray, single-instance
│     ├─ commands/            # #[tauri::command] handlers
│     │  ├─ download.rs
│     │  ├─ clipboard.rs
│     │  └─ settings.rs
│     ├─ clipboard/
│     │  ├─ watcher.rs        # polling watcher + URL sniffer
│     │  └─ sensitive.rs      # sensitive/password detection + exclusions
│     ├─ download/
│     │  ├─ manager.rs        # queue + concurrency
│     │  ├─ ytdlp.rs          # sidecar invocation + progress parsing
│     │  └─ probe.rs          # list formats (yt-dlp -J)
│     ├─ db/
│     │  ├─ mod.rs            # connection, migrations
│     │  └─ models.rs
│     ├─ retention.rs         # GC timer
│     └─ util.rs
└─ tests/                     # rust integration + frontend unit (vitest)
```

---

## 7. Feature spec — YouTube downloader

### 7.1 Auto-detection

- The clipboard watcher (§8.2) inspects every new clipboard text entry for a supported video URL (YouTube first; also accept youtu.be, YouTube Shorts, playlist URLs; the engine additionally supports many yt-dlp sites, but v1 UI copy focuses on YouTube).
- URL match via a robust regex + host allowlist. Normalize (strip tracking params, keep `v=`/`list=`).
- On detect while the app is **not** focused: show a subtle, dismissible tray/toast affordance ("YouTube link detected — open Nabbit to download"), and pre-load a **Download card** in the popover. **Do not** start downloading.
- On detect while popover is open: the Download card fills in instantly at the top.
- The user may also paste/type a URL manually into the Download input; same card appears.
- Debounce: ignore a URL identical to the one already staged; don't spam toasts (rate-limit notifications).
- Setting: "Auto-detect links from clipboard" (on by default) and "Show notification on detect" (on by default).

### 7.2 The Download card (the core one-tap moment)

When a URL is staged, show a compact card with:

- Thumbnail, title, channel, duration (fetched via `yt-dlp -J`/`--dump-json`, cached).
- **Quality selector** defaulting to the user's saved default (e.g., "Best up to 1080p"). Options: Best available, 2160p/4K, 1440p, 1080p, 720p, 480p, Audio only (MP3), Audio only (M4A).
- Container/format shown (MP4 preferred; MKV fallback when needed).
- A single prominent **Download** button. Optional secondary: "⌄" to reveal advanced (subtitles, playlist range, output folder override, filename template).
- If the URL is a **playlist**, show item count and a toggle: "Whole playlist" vs "This video only", plus a range input when whole-playlist.
- Pressing Download enqueues the job and switches the card to a progress row in the **Queue**.

**Acceptance:** From a fresh clipboard copy of a YouTube URL to a finished MP4 on disk, the only required user action is a single click on **Download**.

### 7.3 Download execution & queue

- Downloads run through the **yt-dlp sidecar** spawned via `tauri-plugin-shell`, streaming stdout/stderr; parse progress (`--newline`, `--progress-template` or `-J` for metadata; parse `[download]  x.x%` lines or use `--progress-template '%(progress._percent_str)s ...'`). Prefer `--progress-template` for stable machine-readable progress.
- Use ffmpeg sidecar for merging separate video+audio streams (needed for ≥1080p) and for audio extraction (`-x --audio-format mp3`). Pass `--ffmpeg-location` pointing at the bundled ffmpeg sidecar path.
- Queue with configurable **max concurrent downloads** (default 2). Others wait.
- Each queue row: thumbnail, title, %, speed, ETA, size; controls: Pause/Resume (where supported), Cancel, Open file, Reveal in folder, Retry on failure.
- On success: move to **History**, show a toast, optionally reveal in folder (setting).
- On failure: clear error message + Retry. Common cases: network error, unavailable/private video, format unavailable → fall back to next best format automatically once before surfacing error.
- Persist queue/history in SQLite so it survives restart (in-flight jobs resume or are marked interrupted).
- Default output dir: OS Downloads/Nabbit (configurable). Filename template default: `%(title)s [%(id)s].%(ext)s` (sanitized, cross-platform-safe).

### 7.4 yt-dlp / ffmpeg management

- Bundle yt-dlp and ffmpeg as sidecars via `externalBin` with the required target-triple suffixes for each platform (Tauri renames e.g. `yt-dlp-x86_64-pc-windows-msvc.exe`). Provide a script `scripts/fetch-binaries.(sh|ps1)` to download the correct binaries per target into `src-tauri/binaries/` during setup/CI.
- **yt-dlp self-update:** because YouTube changes often, add a background check (on launch, throttled to ~once/day) that updates the yt-dlp binary (either `yt-dlp -U` if the bundled build supports it, or download the latest release to app-data and prefer that copy over the bundled one). Never block the UI on it. Setting: "Keep downloader engine up to date" (on by default).
- Handle the case where a download fails due to an outdated engine by prompting/triggering an engine update then offering Retry.

### 7.5 YouTube downloader acceptance criteria

- [x] Copying a YouTube URL anywhere stages a Download card without starting a download.
- [x] One click on Download produces a correctly-merged MP4 (≥1080p uses ffmpeg merge) in the output folder.
- [x] Audio-only MP3 extraction works.
- [x] Playlist detected; "this video only" and "whole playlist (with range)" both work.
- [x] Progress %, speed, ETA update live; Cancel and Retry work; concurrency limit respected.
- [x] History persists across app restart.
- [x] Engine self-update runs in background without freezing UI.

---

## 8. Feature spec — clipboard manager

### 8.1 Data captured

- Text (plain + rich where feasible), URLs (flagged), and images (v1: store text always; images behind a setting, default on, with a size cap e.g. 10MB and a preview thumbnail). Files/paths: store the path text in v1.
- Each entry: `id`, `content_type`, `content` (or blob ref for images), `preview`, `hash`, `source_app` (best-effort, platform-dependent), `pinned`, `created_at`, `last_used_at`.
- De-duplicate consecutive identical copies via `hash`; if the same content is copied again, update `last_used_at` and move to top rather than duplicating.

### 8.2 Clipboard watcher (Rust background thread)

**How real clipboard managers do this (design reference — follow it):** the OSes differ, so use each platform's native mechanism (the `clipboard-master` crate abstracts all three; prefer it):

- **macOS:** there is **no** clipboard change event, notification, or KVO. Every native Mac manager — **Maccy, Flycut, Jumpcut, ClipMenu, Pastebot, Paste** — runs a timer (~0.5–1s) that reads the cheap integer `NSPasteboard.general.changeCount`; only when it increments does it read the actual contents. Reading the counter is near-free, so idle CPU/RAM stay negligible. This is the accepted, industry-standard approach on macOS — not a hack.
- **Windows:** event-based via `AddClipboardFormatListener` → the app receives `WM_CLIPBOARDUPDATE`; the process sleeps on the OS message queue and wakes only on a real change → ~0% idle CPU. (Ditto uses this.) Do **not** poll on Windows.
- **Linux:** event-based via X11 XFixes selection-notify; on Wayland use `wlr-data-control` where the compositor supports it, else fall back to polling.

**Implementation:**

- On a detected change: read contents once, hash it, and if the hash differs from the last stored entry, create an entry, persist, and emit `clipboard:new` to the frontend. Also run the **URL sniffer** here to feed §7.1.
- On macOS the changeCount poll interval is a tuned constant (default ~500ms). On Windows/Linux there is no polling loop — react to the OS event.
- Idle cost must be negligible: only a counter read (macOS) or a blocked message wait (Windows/Linux) when nothing changed.
- Respect exclusions and sensitive detection (§8.5) **before** persisting.
- Record which mechanism was used per OS in `PROGRESS.md` → Decisions.

### 8.3 Retention window (core differentiator)

- Setting: **Retention = 30 / 60 / 90 days** (default 30). Single, prominent control.
- A **retention GC job** (§ timer, runs on launch and then every few hours) deletes entries whose `created_at` is older than the window **unless pinned**. Pinned items never expire.
- Changing the window applies immediately (shortening triggers a GC pass; lengthening simply keeps future items longer — it cannot resurrect already-deleted items).
- Show, in Settings, current stored count and approximate DB size, with a "Clear all history now" button (with confirm).

### 8.4 Clipboard UI (in the popover, second tab)

- Reverse-chronological list; each row: type icon, preview (1–2 lines / thumbnail), source app (if known), relative time.
- **Instant fuzzy search** box at top (keyboard-first: focus search on open).
- Row actions: **click = copy back to clipboard** (and close popover, optional setting "paste on select"); pin/unpin; delete; "copy" explicitly; for URLs, a "Download" affordance that hands off to the YouTube feature if it's a supported video link.
- Keyboard nav: arrow up/down, Enter to copy, Cmd/Ctrl+F focus search, Delete to remove, number keys 1–9 to copy the Nth item.
- Empty state and privacy reassurance ("History stays on this device").

### 8.5 Privacy & security

- **App exclusions:** user list of apps whose clipboard events are ignored (default-seed common password managers: 1Password, Bitwarden, KeePass, LastPass, Dashlane where detectable). Source-app detection is best-effort per OS; where unavailable, rely on sensitive-content heuristics + the concealed-type flag.
- **Sensitive-content skip:** respect the OS "concealed"/"transient"/"org.nspasteboard.ConcealedType" clipboard hints (macOS `org.nspasteboard.ConcealedType`, Windows `ExcludeClipboardContentFromMonitorProcessing` / `CanIncludeInClipboardHistory`); skip anything flagged. Also a heuristic toggle to skip strings that look like OTP/credit-card/long high-entropy secrets (off by default to avoid false negatives; document clearly).
- **No cloud, no telemetry.** DB is local. Offer optional at-rest encryption of the SQLite DB as backlog (record, don't build in v1 unless trivial).
- **Panic/clear:** global "Clear clipboard history" action available from tray menu and settings.

### 8.6 Clipboard acceptance criteria

- [x] Copying text creates a searchable history entry within ~1s; duplicates de-dupe.
- [x] Retention 30/60/90 selectable; GC removes expired non-pinned items; pinned survive.
- [x] Fuzzy search filters instantly; click re-copies; keyboard nav works.
- [x] Excluded apps and OS-concealed/sensitive copies are NOT stored (verify with a password manager copy).
- [x] "Clear all" wipes history and blobs.
- [x] Idle CPU stays near zero (watcher does not busy-spin).

---

## 9. App-level spec — tray, windows, settings

### 9.1 Tray / menu bar

- `TrayIconBuilder` with a template (monochrome) icon that adapts to light/dark menus.
- **Left-click:** toggle the popover window anchored near the tray icon.
- **Right-click / menu:** items — Open Nabbit, Paste last item, Clear clipboard history, Downloads folder, Settings, Pause auto-detect, Quit.
- The app has **no dock/taskbar presence by default** (menu-bar/tray only). On macOS set activation policy to Accessory; on Windows hide from taskbar; provide a setting to also show a normal window if desired.

### 9.2 Popover window

- Small, frameless, rounded, always-on-top when shown; dismiss on blur (setting to pin open).
- Two tabs: **Download** and **Clipboard**. Remember last tab.
- Fast to open (<150ms perceived). Pre-warm the webview so first open isn't slow.

### 9.3 Settings window

- General: launch at login (autostart), start hidden, show/hide dock icon, global hotkeys.
- Downloads: default quality, output folder, filename template, max concurrent, reveal-after-download, engine auto-update.
- Clipboard: retention (30/60/90), capture images on/off + size cap, paste-on-select, app exclusions list, sensitive-skip toggle, clear-all.
- Privacy: link to `PRIVACY.md`, "clear all data", telemetry (off; show it's off).
- About: version, yt-dlp version, licenses, update check.

### 9.4 Global shortcuts (defaults, all configurable)

- Toggle popover: `Cmd/Ctrl+Shift+V`.
- Quick-download staged URL: `Cmd/Ctrl+Shift+D`.
- Open clipboard search: `Cmd/Ctrl+Shift+C`.

### 9.5 Cross-platform & lifecycle

- Single-instance enforced; second launch focuses popover.
- Autostart via plugin.
- App auto-update via `tauri-plugin-updater` (signed).
- Graceful handling when sidecars missing/corrupt: show a recoverable error + "repair/download engine".

---

## 10. Build Loop (Codex works through these top-to-bottom)

> Each task: implement, verify against its checks, then tick the box. Phase-level "Definition of Done" must hold before moving to the next phase. Every phase must keep `npm run build`, `cargo build`, typecheck, and lint green.

### Phase 0 — Scaffold & tooling
- [x] **0.1** Create `PROGRESS.md` with sections: Log, Decisions, Blockers, Open Questions. *Check: file exists, committed.*
- [x] **0.2** Scaffold Tauri v2 app with React+TS+Vite; add Tailwind; configure `tauri.conf.json` (identifier `com.nabbit.app`, product name Nabbit). *Check: `npm run tauri dev` launches an empty window; `cargo build` succeeds.*
- [x] **0.3** Add tooling: ESLint + Prettier + TypeScript strict; `cargo fmt`/`clippy`; Vitest; a `npm run verify` script running typecheck+lint+build. *Check: `npm run verify` passes on empty app.*
- [x] **0.4** Add plugins to the project (not yet wired): shell, clipboard-manager, global-shortcut, autostart, single-instance, updater. *Check: `cargo build` compiles with plugins registered.*

**DoD P0:** app runs, verify script green, plugins compile.

### Phase 1 — Tray-only skeleton
- [x] **1.1** Implement tray icon (template) + left-click toggles a frameless popover window; right-click menu with Quit. *Check: tray appears; popover toggles; quit works on all dev OS available.*
- [x] **1.2** Hide from dock/taskbar (accessory mode); enforce single-instance (second launch focuses popover). *Check: no dock icon; second launch focuses.*
- [x] **1.3** Popover UI shell with two tabs (Download | Clipboard) and a Settings entry; dark/light aware. *Check: tabs switch; remembers last tab.*

**DoD P1:** minimal always-there tray app with empty tabs, no dock presence, single instance.

### Phase 2 — Storage & settings core
- [x] **2.1** SQLite setup + migrations (tables: `clipboard_entries`, `downloads`, `settings`, `app_exclusions`). *Check: DB created in app-data; migration test passes.*
- [x] **2.2** Settings get/set commands + typed frontend store; Settings window with all §9.3 controls (wired to real persistence). *Check: change persists across restart; unit test on settings command.*
- [x] **2.3** Autostart + global-shortcut registration from settings. *Check: toggling launch-at-login and a hotkey works.*

**DoD P2:** settings fully persist; DB and migrations solid.

### Phase 3 — Clipboard manager
- [x] **3.1** Rust clipboard watcher via `clipboard-master` (native per-OS mechanism per §8.2: changeCount poll on macOS, format-listener on Windows, XFixes on Linux) + hash de-dupe, storing entries and emitting `clipboard:new`. *Check: copying text creates one entry; duplicates don't multiply; idle CPU ~0 in a 5-min observation on each available OS.*
- [x] **3.2** Clipboard list UI: reverse-chron, previews, relative time, click-to-recopy, pin/delete. *Check: acceptance §8.6 rows 1 and (partial) 3.*
- [x] **3.3** Instant fuzzy search + full keyboard nav (arrows/Enter/Delete/1–9/Cmd+F). *Check: search filters live; all keys work.*
- [x] **3.4** Retention window 30/60/90 + GC job (launch + interval); pinned survive; "clear all". *Check: acceptance §8.6 retention + clear.*
- [x] **3.5** Privacy: app-exclusions list (seed password managers) + OS concealed/sensitive skip. *Check: copying from a password manager does NOT store an entry.*
- [x] **3.6** Images capture (setting + size cap + thumbnail) — optional if time; else backlog with note. *Check: image copy stored with preview OR documented as deferred.*

**DoD P3:** clipboard manager fully meets §8.6.

### Phase 4 — YouTube downloader
- [x] **4.1** Bundle yt-dlp + ffmpeg sidecars via `externalBin`; `scripts/fetch-binaries` for each target; verify spawn from Rust. *Check: `yt-dlp --version` runs via sidecar on the dev OS.*
- [x] **4.2** URL sniffer in watcher → emit `url:detected`; staging logic + "link detected" notification (rate-limited); settings toggles. *Check: copying a YouTube URL stages a card, starts NO download, notifies once.*
- [x] **4.3** Metadata probe (`yt-dlp -J`) → Download card with thumbnail/title/duration + quality selector + playlist handling. *Check: card renders correct metadata; playlist detected.*
- [x] **4.4** Download execution via sidecar with `--progress-template`, ffmpeg merge/extract, output dir + filename template. *Check: one-tap → merged MP4 ≥1080p; MP3 extraction works.*
- [x] **4.5** Queue + concurrency + pause/cancel/retry + live progress/speed/ETA; persist to DB; history survives restart. *Check: acceptance §7.5 rows for queue/history.*
- [x] **4.6** Auto-fallback to next-best format on format error; friendly error messages. *Check: force a format error → auto-retry once then clear message.*
- [x] **4.7** yt-dlp background self-update (throttled, non-blocking) + "update engine then retry" on engine-related failures. *Check: update routine runs without freezing UI.*

**DoD P4:** YouTube downloader fully meets §7.5.

### Phase 5 — Polish, hardening, packaging
- [x] **5.1** Global shortcuts for popover/quick-download/search; tray quick actions (paste last, clear history, downloads folder, pause auto-detect). *Check: all shortcuts + menu items work.*
- [x] **5.2** First-run legal/privacy acknowledgment + `PRIVACY.md` + in-app About (versions, licenses). *Check: first run shows notice; About shows yt-dlp version.*
- [x] **5.3** Error/edge handling pass (§11) — offline, missing sidecar/repair, corrupt DB recovery, huge clipboard items, permission prompts. *Check: each edge case degrades gracefully.*
- [x] **5.4** Performance pass: idle CPU ≈ 0, memory sane, popover opens <150ms (pre-warm webview). *Check: measured and recorded in PROGRESS.md.*
- [x] **5.5** App auto-updater configured + signed; build/bundle for macOS (.dmg/.app), Windows (.msi/.exe), Linux (.AppImage/.deb). CI script to fetch binaries + build all targets. *Check: installers produced for available targets; app launches from installed build.*
- [x] **5.6** README with build/run instructions and a screenshots/GIF placeholder. *Check: a fresh clone + documented steps builds the app.*

**DoD P5:** installable, signed-updatable, hardened, documented.

### Phase 6 — Test suite & final verification
- [x] **6.1** Rust unit/integration tests: URL detection/normalization, retention GC, de-dup hashing, settings, progress parsing. *Check: `cargo test` green.*
- [x] **6.2** Frontend unit tests (Vitest): store logic, search filtering, keyboard nav, IPC wrappers (mocked). *Check: `npm test` green.*
- [x] **6.3** End-to-end manual test script (documented in `tests/manual-e2e.md`) covering both acceptance lists; run it and record results. *Check: all §7.5 and §8.6 boxes verified checked.*
- [x] **6.4** Final Definition of Done pass (§13). *Check: every box in this file checked; §13 all pass.*

**DoD P6 = project done.**

---

## 11. Edge cases & failure handling (must be covered by Phase 5.3)

- No network / flaky network mid-download → pause + retry, clear messaging.
- Video unavailable / private / age-restricted / region-locked / members-only → explain; never attempt DRM bypass.
- Format/merge failure → auto-fallback once, then surface.
- Missing/corrupt/quarantined sidecar (esp. macOS Gatekeeper) → "repair engine" flow that re-fetches binary; document macOS notarization/`xattr` considerations.
- Very large clipboard payloads / images over cap → skip or truncate with a marker; never OOM.
- Rapid successive copies → debounce; don't flood DB or notifications.
- Clock changes / DST around retention boundaries → use UTC timestamps.
- DB locked/corrupt → recover (backup + recreate) without losing app usability.
- Multiple displays / tray on secondary monitor → popover anchors correctly.
- Permissions: macOS may prompt for accessibility/automation for paste-on-select; degrade gracefully if denied.
- Long-running app: watcher/GC must not leak memory over days.

---

## 12. PROGRESS.md format (Codex maintains this)

```markdown
# Nabbit Progress Log

## Log
- 2026-07-09 P0.1 Created PROGRESS.md. Files: PROGRESS.md. Verified: exists.
- ...

## Decisions
- Chose polling clipboard watcher @500ms (no reliable cross-OS event crate). 

## Blockers
- (none)

## Open Questions
- Confirm code-signing certs for macOS/Windows before Phase 5.5.
```

---

## 13. Definition of Done (whole project)

The loop ends only when ALL of the following hold:

1. Every checkbox in §10 (Build Loop) is `[x]`.
2. Both acceptance lists pass in full: §7.5 (downloader) and §8.6 (clipboard).
3. `npm run verify` (typecheck + lint + build), `cargo build --release`, `cargo test`, and `npm test` are all green.
4. App runs as a tray-only, single-instance, no-dock background app on at least the current dev OS, with installers produced for available targets.
5. Idle CPU ≈ 0 and popover opens quickly (measured, recorded in PROGRESS.md).
6. Privacy guarantees verified: password-manager/concealed copies are not stored; no network calls carry clipboard/URL contents; no telemetry.
7. First-run legal/privacy notice present; `PRIVACY.md`, `README.md` complete.
8. Name/trademark/domain availability for "Nabbit" checked and recorded (or an alternate chosen and applied).

---

## 14. Nice-to-haves backlog (do NOT build in v1; record ideas)

- Optional at-rest DB encryption; cloud/multi-device sync (opt-in, E2E); browser extension to grab links; more sites beyond YouTube surfaced in UI; smart snippets/templates in clipboard; OCR on copied images; format presets; scheduled downloads; system share-sheet integration.

---

## 15. Sources (competitor & technical research)

- 4K Video Downloader vs JDownloader / best downloaders 2026 — https://slashdot.org/software/comparison/4k-Video-Downloader-Pro-vs-JDownloader/ , https://screenapp.io/blog/top-youtube-downloaders , https://www.winxdvd.com/streaming-video/jdownloader-alternatives.htm
- Best clipboard managers 2026 (Maccy, Paste, Ditto, CopyQ) — https://www.techwench.com/best-clipboard-managers-2026/ , https://pasteapp.io/blog/best-clipboard-manager-for-mac , https://alternativeto.net/software/copyq/
- Tauri v2 sidecar / tray / clipboard / shell — https://v2.tauri.app/develop/sidecar/ , https://v2.tauri.app/learn/system-tray/ , https://v2.tauri.app/plugin/clipboard/ , https://v2.tauri.app/start/migrate/from-tauri-1/
- Clipboard monitoring internals — macOS has no clipboard event, poll `NSPasteboard.changeCount` — https://fedevitale.medium.com/watch-for-nspasteboard-fad29d2f874e , https://clipgate.github.io/blog/macos-clipboard-history-what-leaks/
- Cross-platform clipboard monitor crate (`clipboard-master`) — https://github.com/DoumanAsh/clipboard-master , https://crates.io/crates/clipboard-master
- Windows event-based clipboard (`AddClipboardFormatListener` / `WM_CLIPBOARDUPDATE`) — https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-addclipboardformatlistener , https://www.mking.net/blog/winforms-clipboard-monitoring
