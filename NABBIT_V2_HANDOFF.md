# Nabbit v2 — Codex Delta Handoff (Island · Tray · Widgets)

> **User override (2026-11-26):** Commit directly to `main`; do not create pull requests. Apply `main` wherever this handoff names `master` as the implementation branch, push target, Pages source branch or screenshot URL. Keep the per-task commits, milestone-only pushes and `[skip ci]` rules.

> **What this document is.** A delta on top of `NABBIT_HANDOFF.md` (v0.1, built and accepted on 2026-07-10, see `PROGRESS.md`). v0.1 stays as the reference for the clipboard watcher, the yt-dlp/ffmpeg engine, retention, packaging and the acceptance scripts. **Do not rebuild v0.1. Extend it.** v2 turns Nabbit from a tray popover into a Windows "Dynamic Island" with tray and widget modes, adds Tack-synced notes, and upgrades the downloader UX.
>
> **Working rules in one line:** make the repo public and publish the landing on GitHub Pages first (Phase P), commit every task, push to `origin/master` at each of the 13 milestones (§0.1), automated tests only with nothing that needs the user (§0.2), and never trigger the repo's GitHub Actions workflows (`[skip ci]` on every commit, no tags, no PRs, no workflow dispatch). The only Actions runs allowed are GitHub's own Pages deployments (§10b.4).
>
> **Design source of truth:** Figma file **Nabbit** → https://www.figma.com/design/tBm7NNhh1Y9aTQPJ3WxY5v/Nabbit (node links in §3). If something in this file disagrees with Figma about visuals, Figma wins. If it disagrees about behaviour, this file wins.

---

## 0. How to run this in a loop (read first, every pass)

Same protocol as v0.1 §0, with these changes:

1. **Read** this file, then `NABBIT_HANDOFF.md` §6–§9 (architecture you are extending), then `PROGRESS.md`.
2. **Select** the first unchecked task in the **Build Loop (§11)** whose dependencies are checked.
3. **Implement** only that task. Small diffs.
4. **Self-verify with automated checks only (§0.2):** `npm run verify`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test -- --test-threads=1`, plus the task's acceptance checks. **UI tasks** also capture automated screenshots (Playwright against the Vite preview with mocked IPC, device scale factor 1 and 1.5, light and dark; the island is always dark) and you compare them yourself against the referenced Figma node. There is no human review step.
5. **Check the box**, append to `PROGRESS.md` under a new heading `## v2 Log` (create it once; keep v0.1 entries untouched). Record decisions under `## Decisions` with a `v2:` prefix.
6. **Commit every task** as `nabbit-v2: <phase>.<task> <summary> [skip ci]`.
7. If the box you just checked is a **MILESTONE** line in §11, run the milestone push procedure (§0.1).
8. **Stop the pass.**

Rules carried over from v0.1: never check a box with red checks; record blockers and move on to the next unblocked task; prefer boring APIs; idle CPU ≈ 0; every dependency must earn its place; ambiguous → simplest option that satisfies acceptance, record it.

New v2 rules:

- **Phase V0 is a gate.** Do not start V2+ until V0's measurements are in `PROGRESS.md` and the go/no-go decision is recorded.
- **No polling from JavaScript while the island is collapsed.** Rust pushes typed events; the frontend reacts.
- **Never weaken v0.1 guarantees:** downloads start only after an explicit click or hotkey; sensitive clipboard content is still skipped; no telemetry.
- If Figma MCP tools are available, call `get_design_context` on the node IDs in §3 for exact values. Otherwise use the tokens in §4 and the screenshots.

### 0.1 Commits, milestone pushes and GitHub Actions

- Work on `master`, the repository's default branch (`origin` = `https://github.com/tanzir71/nabbit.git`). One commit per task; never squash tasks together; never amend, rebase or force-push anything that has already been pushed.
- **Every commit message ends with `[skip ci]`.** `.github/workflows/ci.yml` runs on every push and pull request, and GitHub skips push-triggered workflows only when the head commit of the push contains `[skip ci]`. Add a local `commit-msg` hook (`.git/hooks/commit-msg`, not committed) that appends ` [skip ci]` whenever it is missing.
- **Never invoke the repo's GitHub Actions workflows:** no `gh workflow run` or any other `workflow_dispatch`, no git tags of any kind (`release.yml` runs on `v*` tags), no pull requests, no `gh release` commands, and no edits to `.github/workflows/`. **One exception:** GitHub Pages always deploys through GitHub's built-in "pages build and deployment" run, even for a static `docs/` folder. That run is expected after pushes once Pages is enabled; it is not a repo workflow and is the only Actions activity allowed (§10b.4).
- **Milestone push procedure** (only at the MILESTONE lines in §11):
  1. All automated checks are green on the current HEAD.
  2. Update the `## v2 Milestones` table in `PROGRESS.md` (create it once): milestone, date, short commit hash, what is new and how to try it (`npm run tauri:dev`, which shortcut or tab to open), screenshot folder.
  3. Save the milestone screenshots under `progress/v2/M<n>/` (PNG, at most 300 KB each, descriptive names such as `island-expanded-nab@1.5x.png`). Never put them in `docs/`, which is the Vercel-hosted landing site.
  4. Update the landing's "Built in the open" list (`docs/index.html`, §10b.3): this milestone → Done with a link to `https://github.com/tanzir71/nabbit/tree/master/progress/v2/M<n>`, the next one → In progress, and set `<meta name="nabbit-milestone" content="M<n>">`.
  5. Commit `nabbit-v2: M<n> <milestone name> [skip ci]`. This commit is the head of the push, so the push cannot start the CI workflow.
  6. Confirm `git log -1 --format=%B` contains `[skip ci]`, then `git fetch origin` and `git push origin master` (fast-forward only). If `origin/master` has moved, run `git pull --rebase origin master` only when it applies cleanly and every check still passes; otherwise record a blocker and keep working locally.
  7. Once Pages is enabled (Phase P), verify the deploy within 10 minutes: `curl -s https://tanzir71.github.io/nabbit/` must contain `content="M<n>"`. If it does not, check `gh api repos/tanzir71/nabbit/pages/builds/latest`; if the latest build is older than the push, request one rebuild with `gh api -X POST repos/tanzir71/nabbit/pages/builds` and re-check once. Record the result in the milestone row; a failed deploy is a blocker note, not a stop.
  8. If the push fails (network, authentication, branch protection), record it under Blockers, continue with the next task, and retry at the next milestone. Never ask for credentials and never change remotes or git config beyond the local hook.

### 0.2 Testing policy: automated only

- Only checks you run yourself on this Windows machine, with nobody's involvement, count toward a box or a milestone. Do not write manual test steps; do not ask the user to try, look at, approve, install, sign in, click or supply hardware or credentials; never wait for a person.
- **Off for v2:** manual E2E checklists (do not extend or run `tests/manual-e2e.md`); real calls (Teams, Zoom); real browser sign-ins or `--cookies-from-browser` against real profiles; the user's hosted Tack or Tack account; second monitors, high-refresh panels, Windows 10 machines, or changing Windows display scaling or settings; installing the MSI/NSIS; signed release builds (the signing keys are the user's); anything that needs admin rights or a UAC prompt.
- Make platform logic testable through seams (traits or injected providers) and test it with fixtures and simulated input: monitor layouts and DPI, foreground and monitor rectangles, notification state, cursor positions, registry snapshots, GSMTC sessions, power events, clock jumps, yt-dlp stderr, Tack HTTP responses.
- Non-interactive smokes on this machine are fine, in the v0.1 style: launch the release exe with `NABBIT_APP_DATA_DIR` and acceptance env vars, read window styles with `GetWindowLongPtr`, sample CPU and memory, and inject cursor positions through an acceptance-only provider instead of moving the real cursor.
- Tests that need the public internet (the Creative Commons YouTube sample, engine downloads) may run when online but are never gates: on failure record `skipped: offline` and continue.
- If something cannot be automated, it is not a gate. List it once under `## v2 Not automated` in `PROGRESS.md` and move on.

---

## 1. What changes in v2

| Area | v0.1 (built) | v2 (this handoff) |
|---|---|---|
| Surfaces | One 460×680 tray popover | **Island** (top-centre, transparent overlay) + **tray popover** (full app) + **sticky-note windows** + **settings window**; desktop board in v2.1 |
| Modes | Tray only | Island + tray (default) · Tray only · Island only (Settings → General) |
| Downloader | Clipboard staging, quality picker, queue | Four capture paths (clipboard, drag onto the top edge, `nabbit://` deep link, hotkey), presets remembered per site, options sheet, trim and chapters, playlist picker, live activity, engine health with **Deno**, plain-language error fixes |
| Notes | none | **Windows client for the user's own Tack** (self-hosted on Namecheap). Tack cards = notes. Quick capture, Keep-style grid, checklists, colours, labels, pins, priorities, sticky pop-outs. Local-only mode without Tack |
| Clipboard | Popover tab | Also an island tab with filters and a first row that adapts to what was copied; unchanged store |
| New modules | — | Shelf (drop zone), Now playing (GSMTC), Focus timer, Mic/camera-in-use dot, Battery/charging |
| Native tools | — | **What browser extensions can't do** (§9b): Fit under N MB, To MP4 / trim / audio / GIF, HEIC → JPG, strip location data, PDF basics, text and QR from image files; **Pins** for folders and files with drop-to-file and Move to…; clipboard actions by type and act-on-selected-text; Explorer Send To. **Links**: save links to Tack and import every browser's bookmarks (§8.9). Screenshot and colour picker are left to browser extensions |
| Settings | Panel inside popover | Separate settings window (Mica on Windows 11) |
| Website | Vercel landing from `docs/` (private repo) | **Public repo**; new landing on **GitHub Pages** (`https://tanzir71.github.io/nabbit/`) from `master` `/docs`, with a "Built in the open" milestone list updated at every push (§10b) |
| Visual system | Tailwind slate + indigo | New tokens (§4): neutral greys, ink primary, lime "signal" only for live state; Geist + Geist Mono bundled |

Platforms: **Windows 10 1809+ and Windows 11, x64 + ARM64** are the v2 target. macOS/Linux builds must keep compiling (island features behind `cfg(windows)`), but island acceptance is Windows-only.

---

## 2. Locked product decisions

1. **Stay on Tauri v2 + WebView2** for every surface. A native Win32 + DirectComposition pill is the fallback only if the V0 spike fails its thresholds (§11 V0).
2. **The island window is never resized to animate.** One fixed-size transparent window per active monitor; the pill morphs in CSS inside it (§6).
3. **Notes sync = Tack's existing API.** No new server, no Nabbit cloud, no new account. Users point Nabbit at their Tack URL and sign in with their Tack account. Local-only mode exists for people without Tack.
4. **The island is always dark** (black surface, light content). Light/dark theme applies to the tray, sheets, sticky notes, the board and settings.
5. **Lime (`signal/base`) is reserved** for live state (progress, recording, timers) and the single primary action on the island. Everywhere else the primary action is ink. Do not use lime decoratively.
6. **No italics anywhere** (designer preference). Use weight and colour for emphasis.
7. **Non-goals for v2:** lock-screen widgets (no Windows equivalent), notifications mirror and Windows Widgets Board widget (need a signed sparse MSIX, see backlog), DRM circumvention (never), automatic downloads (never), lyrics.
8. **Native tools only.** Ship what a browser extension can't do and Windows/PowerToys doesn't already do well (§9b.1). Tools follow tooldeck's registry pattern, presets are named for the result ("Fit for Discord"), and outputs **never overwrite inputs**. Context from other apps is collected quietly and shown only when the user opens the island or presses a hotkey; no automatic popups.
9. **Naming:** "Nabbit" remains the codename. It is also a Nintendo character name (already flagged in `PROGRESS.md`). Do not add rabbit or character imagery anywhere; the mark is an island capsule with a live dot (Figma Foundations → Logo / Mark).

---

## 3. Figma map

File: `https://www.figma.com/design/tBm7NNhh1Y9aTQPJ3WxY5v/Nabbit` — append `?node-id=<id with - instead of :>`.

| Page | What | Node |
|---|---|---|
| Cover | Cover | `23:643` |
| 01 Brief | Principles, parity matrix, roadmap, decisions | `23:2` |
| 02 Foundations | Colour boards light / dark | `12:53`, `12:213` |
| | Type ramp · Radius & spacing | `12:373`, `12:411` |
| | Logo / Mark (component set) | `12:478` |
| | Note card (component set: Note, Checklist, Bookmark) | `12:511` |
| | Icon set (95 Lucide icons, stroke 1.75) | `5:2` |
| | Button · IconButton · Preset chip · Toggle · Kbd · Badge · Tab | `5:457` · `5:488` · `5:495` · `5:500` · `5:501` · `5:511` · `5:524` |
| 03 Island | **Island · Compact** (19 states, incl. the additions below) | `7:103` |
| | **Island · Peek** (link detected, downloading, now playing, timer) | `8:119` |
| | **Island · Expanded** (Nab, Notes, Clipboard, Files, Media, Timer, Search, Shelf actions) | `10:519` |
| | Island · Drop target (4 states, incl. `Over=Pin` `43:692`) · Pin peek | `8:192` · `43:755` |
| | Island · Notch shape | `8:200` |
| | Compact additions: Moved (Undo) · Result · Tool running · Agent run (v2.1) · Next event (v2.1) · System stats (v2.1) | `33:518` · `33:528` · `33:535` · `33:541` · `33:555` · `33:564` |
| | Peek additions: Download done (To MP4, Move to…) · Volume mixer (v2.1) | `33:580` · `33:598` |
| | Expanded: **Files** tab (Shelf + Pins) · **Search** results · **Shelf actions** (6 tabs + a search button; there is no Tools tab) | `10:249` · `34:777` · `34:897` |
| 04 Tray & widgets | Tray popover · Nab (light) · Notes (light) · Clipboard (dark) | `13:2` · `13:242` · `13:422` |
| | Tray right-click menu · Island submenu | `14:294` · `14:367` |
| | Widget · Sticky note (component set) | `14:531` |
| | Widget · Desktop board (component, v2.1) | `14:532` |
| | Modes on a desktop: island+tray, maximised, expanded, tray only, widgets | `15:443` · `15:489` · `15:530` · `15:747` · `15:860` |
| 05 Downloader | Capture paths | `17:5` |
| | Sheets: Download options · Trim and chapters · Playlist | `17:137` · `17:270` · `18:160` |
| | Engine health card · Error catalogue | `18:260` · `18:330` |
| 06 Notes · Tack | Connect: server + sign in · workspace + scope | `19:5` · `19:102` |
| | Note editor (Tack card) · Sync conflict · Sync states | `19:182` · `19:301` · `19:346` |
| 07 Settings | General · Island · Live activities · Shortcuts | `22:2` · `22:146` · `22:287` · `22:474` |
| 08 Specs for Codex | Window geometry + hit-rect · State machine · Motion · Timings | `23:479` · `23:495` · `23:526` · `23:585` |
| 09 Landing | **Landing · Desktop 1440** · **Landing · Mobile 390** | `27:220` · `31:933` |
| | Desktop sections: Nav · Hero · Live activities · Downloads · Notes · **Files** · Tools · Modes · Privacy · Progress · Final CTA · Footer (mobile Files section `49:1610`) | `27:221` · `27:246` · `27:404` · `27:470` · `27:605` · `49:1132` · `29:858` · `29:909` · `29:939` · `29:965` · `29:1072` · `29:1097` |
| | Composite visuals (export candidates): hero screen · downloads visual · notes visual | `27:273` · `27:499` · `27:607` |
| 10 Native tools | Catalog (tool → why a browser can't → placement → release) | `35:234` |
| | Fit under a size · HEIC → JPG sheet · Import bookmarks · Notes → Links · Clipboard link row · Clipboard text-tools menu + submenu | `45:282` · `36:410` · `45:362` · `45:452` · `45:568` · `36:505` · `36:539` |

---

## 4. Design tokens → code

### 4.1 Colour (CSS custom properties)

Replace the v0.1 Tailwind `accent` palette. Define on `:root` (light) and `[data-theme="dark"]`; map Tailwind colours to these variables (`theme.extend.colors`), e.g. `bg-surface`, `text-primary`, `border-subtle`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg/canvas` | `#F3F3F1` | `#0D0D0F` | Window backgrounds |
| `bg/surface` | `#FFFFFF` | `#161618` | Cards, inputs, footers |
| `bg/raised` | `#F7F7F5` | `#1F1F22` | Selected rows, nav active |
| `bg/sunken` | `#ECECE9` | `#0A0A0B` | Segmented track, settings content, chips |
| `border/subtle` | `#E5E4E0` | `#2A2A2E` | Dividers, card borders |
| `border/strong` | `#CFCEC9` | `#3A3A3F` | Inputs, unselected controls |
| `text/primary` | `#17171A` | `#F2F2F0` | |
| `text/secondary` | `#66666D` | `#A0A0A6` | |
| `text/tertiary` | `#9A9AA0` | `#6B6B72` | Placeholders, meta |
| `action/primary` | `#17171A` | `#F2F2F0` | Primary buttons, selected chips, toggles on |
| `action/on-primary` | `#FFFFFF` | `#17171A` | |
| `signal/base` | `#C6F24E` | `#C6F24E` | Live progress, rings, island primary action |
| `signal/strong` | `#4A6E0B` | `#C6F24E` | Success text/icons on surfaces |
| `signal/soft` | `#EEF8D3` | `#232C14` | Success backgrounds |
| `signal/on` | `#17171A` | `#17171A` | Text on lime |
| `danger/base` · `danger/soft` | `#D93F3F` · `#FDECEC` | `#FF6B6B` · `#3A1D1D` | |
| `warning/base` · `warning/soft` | `#A86200` · `#FFF4E0` | `#F5B33D` · `#3A2C14` | Mic dot, conflicts, shortcut clashes |
| `island/bg` | `#050506` | same | Island surface (mode-independent) |
| `island/raised` | `#1C1C1E` | same | Island buttons, cards, active tab |
| `island/track` | `#2C2C2F` | same | Progress tracks, dashed zones |
| `island/fg` · `island/muted` | `#F5F5F3` · `#8C8C92` | same | |
| `note/default…gray` | `#FFFFFF` `#E6EEFB` `#EFE9FB` `#E4F2E7` `#FBE7EF` `#EEEEEC` | `#1B1B1E` `#1B2433` `#251F33` `#1B2A21` `#331E28` `#242427` | Card fill per **Tack colour key** (`default, blue, purple, green, pink, gray`) |
| `note-accent/*` | `#8C8C92` `#3B6FD8` `#7A55D6` `#2F8F4E` `#C94B7D` `#7C7C82` | `#D8D8D4` `#6E9BF2` `#A88BF0` `#6CCB89` `#EE8DB3` `#A5A5AB` | Colour dots on the island, swatch rings |

Contrast: every text/background pair above meets WCAG AA at its size; never put `text/tertiary` on `bg/sunken` for body text.

### 4.2 Type

Bundle **Geist** and **Geist Mono** (SIL OFL) locally, e.g. via the `geist` npm package or `@fontsource/geist-sans` / `@fontsource/geist-mono`. No CDN (same rule as Tack). Fallback stack: `"Geist", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif`.

| Style | Font | Size/line | Tracking |
|---|---|---|---|
| Display | Geist SemiBold | 28/34 | −0.4 |
| Title | Geist SemiBold | 18/24 | −0.2 |
| Heading | Geist SemiBold | 14/20 | −0.1 |
| Body | Geist Regular | 13/18 | 0 |
| Body strong | Geist Medium | 13/18 | 0 |
| Caption | Geist Regular | 12/16 | 0 |
| Label | Geist Medium | 11/14 | +0.2 (uppercase only for section labels) |
| Mono | Geist Mono Medium | 12/16 | 0 — every number that changes (%, speed, ETA, timers, sizes, refs like `tck-24`, paths, keys) |
| Mono large | Geist Mono Medium | 15/20 | −0.2 |

### 4.3 Radius, spacing, elevation

- Spacing 4-pt: 4, 8, 12, 16, 20, 24, 32.
- Radius: 6 (kbd/inputs small), 8 (buttons, selects), 10 (cards, list containers), 12 (windows, tray popover), 14 (note cards), 16 (peek r24 and expanded r28 are island-specific), pills = height/2.
- Shadows: **Popover** `0 16 48 −8 rgba(0,0,0,.14), 0 1 2 rgba(0,0,0,.06)`; **Island** `0 10 30 −6 rgba(0,0,0,.32)`; **Card** `0 1 2 rgba(0,0,0,.05)`.
- Windows 11: settings window uses Mica (`window-vibrancy::apply_mica`); Windows 10 falls back to solid `bg/canvas`. The island never uses Mica or Acrylic (the effect would fill the whole transparent rectangle).

### 4.4 Icons

Keep `lucide-react` (already a dependency). Use `strokeWidth={1.75}`; sizes 13–16 in dense rows, 18–20 in headers. Icon names used in Figma are Lucide names (`download`, `sticky-note`, `clipboard-list`, `inbox`, `audio-lines`, `timer`, …).

### 4.5 Components to (re)build in `src/components/`

`Button` (Primary / Secondary / Ghost / Danger; md 32 / sm 28), `IconButton` (Ghost / Subtle / Island; 32 / 28), `PresetChip` (On/Off × Light/Island), `Toggle`, `Kbd`, `Badge` (Neutral / Signal / Danger / Warning), `Tab` (segmented), `NoteCard` (Note / Checklist / Bookmark; colour = Tack key), `ProgressRing` (track `island/track`, value `signal/base`, inner radius 70%), `Select`, `Field`. Update the existing `Button`, `IconButton`, `Segmented`, `Toggle`, `Field` rather than adding parallel ones.

### 4.6 Motion

No animation library. Use CSS transitions with spring curves expressed as CSS `linear()` easing (WebView2 is Chromium, which supports it). Generate the `linear()` stops at build time from the spring parameters below (write a tiny script in `scripts/`), and honour Windows "Animation effects" off / `prefers-reduced-motion` (crossfade 120 ms only).

| Transition | Spring / easing |
|---|---|
| Idle → Live (width + height) | stiffness 380, damping 32 (≈260 ms); content fades in after 60 ms over 120 ms |
| Live → Peek | stiffness 300, damping 28 (≈320 ms); radius 16 → 24 |
| Peek → Expanded | stiffness 260, damping 30 (≈380 ms); tabs stagger 20 ms |
| Collapse | 220 ms `cubic-bezier(0.2, 0, 0, 1)`; content fades out first (80 ms) |
| Alert in | scale 1 → 1.04 → 1, 400 ms, once |
| Fade over maximised | opacity 1 → 0.35, 200 ms linear; click-through toggles at the end |

---

## 5. Architecture delta

### 5.1 Windows (Tauri labels)

| Label | Kind | Config |
|---|---|---|
| `main` (exists) | Tray popover, the full app | 460×680, frameless, always-on-top, skip taskbar. **Destroy the webview on hide** after 60 s idle to cut memory; re-create on open (restore last tab from settings). |
| `island` (new) | Transparent overlay on the active monitor | Created once at startup: `transparent(true)`, `decorations(false)`, `shadow(false)`, `always_on_top(true)`, `skip_taskbar(true)`, `resizable(false)`, `focused(false)`, `focusable(false)` (WS_EX_NOACTIVATE), `no_redirection_bitmap(true)` (Tauri ≥ 2.12; avoids the white flash). Size **720×460 logical**, anchored top-centre of the monitor's **work area**, y = 0. Monitor modes "All monitors" create `island-<monitorId>` per monitor. |
| `settings` (new) | Normal window | 980×720, min 820×600, Mica on Windows 11, appears in taskbar while open. Replaces `SettingsPanel` inside the popover (keep the component, mount it in this window). |
| `sticky-<cardId>` (new) | Note pop-out | Frameless, resizable 220–480 wide, optional always-on-top (pin), opacity 60–100%. Position/size/opacity persisted per card per monitor. |
| `board` (v2.1) | Desktop board | `always_on_bottom(true)`, skip taskbar, never focus-steals; re-show after Win+D via a shell hook. |

Frontend: keep one Vite project but add **separate HTML entries** (`index.html` popover, `island.html`, `settings.html`, `sticky.html`) so the island bundle stays small. The island bundle must not import the clipboard list virtualisation, settings or editor code; lazy-load module bodies on expand.

### 5.2 Rust modules (new, under `src-tauri/src/`)

```
island/
  mod.rs          // window lifecycle, monitor placement, shape (island|notch), size (S/M/L)
  hitrect.rs      // receives hit-rects from the frontend, toggles set_ignore_cursor_events
  cursor.rs       // adaptive cursor watcher (GetCursorPos): 30–60 Hz within 120 px of the island, else event-driven
  fullscreen.rs   // SHQueryUserNotificationState + EVENT_SYSTEM_FOREGROUND hook + foreground-rect == monitor-rect
  maximized.rs    // detects a maximised window on the island's monitor → Faded state
  dragband.rs     // OLE drag detection in the top 48 px band → make hit-rect interactive, emit drag-enter
  activity.rs     // ActivityEvent enum + priority queue (§6.4), single source of truth for the pill
services/
  media.rs        // GSMTC: GlobalSystemMediaTransportControlsSessionManager (windows crate, Media_Control)
  privacy.rs      // CapabilityAccessManager ConsentStore watcher (microphone, webcam) via RegNotifyChangeKeyValue
  power.rs        // battery + AC/DC (GetSystemPowerStatus, RegisterPowerSettingNotification)
  timer.rs        // focus timer (wall-clock based, survives sleep; persists running state)
  shelf.rs        // shelf items (paths), drag-out
tack/
  client.rs       // HTTP client with cookie store + CSRF (§8.2)
  sync.rs         // mirror / outbox / cursor loop (§8.4)
  model.rs        // Card, Reminder, mapping to SQLite
  session.rs      // Credential Manager storage (keyring crate)
notes/
  store.rs        // local cards (local-only mode and Tack mirror share one table)
  capture.rs      // quick-capture parsing helpers shared with the frontend tests
download/         // exists: add presets.rs, options.rs (flag builder), errors.rs (error → fix mapping), engine.rs (Deno + health)
deeplink.rs       // nabbit:// handler
tools/
  registry.rs     // Tool trait + ToolMeta + presets (port the pattern from tooldeck src-tauri/src/registry.rs)
  jobs.rs         // job runner: progress events, cancel/retry, output naming, never-overwrite, date copy, result + undo
  encoders.rs     // lazy hardware-encoder probe (nvenc/qsv/amf/mf), cached per GPU + driver
  fit.rs          // Fit under N MB: bitrate maths, resolution step-down, retry from original
  media.rs        // ffmpeg jobs: To MP4 (remux first), trim, audio, GIF/WebP, metadata strip
  image.rs        // WIC decode (HEIC), image/fast_image_resize/oxipng/ravif/resvg encode, EXIF keep/strip
  pdf.rs          // lopdf merge/split/images→PDF; Windows.Data.Pdf render
  ocr.rs          // Windows.Media.Ocr for image files and clipboard images (no screen capture)
  qr.rs           // decode (rqrr) + encode (qrcode)
  text.rs         // pure functions for clipboard text tools (mirrored in TS for previews)
files/
  pins.rs         // pins (folders + files), slots, peek listing, thumbnails on the STA worker
  fileops.rs      // IFileOperation move/copy with undo record + file_ops journal; known folders; placeholders
context/
  clipboard.rs    // AddClipboardFormatListener, privacy formats, type classifier
  selection.rs    // UIA TextPattern.GetSelection; opt-in Ctrl+C fallback restoring every format
  explorer.rs     // Send To shortcut + HKCU verbs, single-instance batching
links/
  save.rs         // save link → Tack bookmark card; title fetch; URL normalisation
  import.rs       // Chromium Bookmarks JSON, Firefox places.sqlite copy, Netscape HTML; dedupe; batching
```

### 5.3 Event bus

One typed enum, serialised with serde, emitted on `nabbit://activity` and `nabbit://island`:

```rust
#[serde(tag = "kind", rename_all = "camelCase")]
enum ActivityEvent {
  LinkDetected { url: String, title: Option<String>, duration: Option<u32>, site: String },
  DownloadProgress { job_id: String, title: String, percent: f32, speed: Option<String>, eta: Option<String> },
  DownloadDone { job_id: String, path: String },
  DownloadFailed { job_id: String, error: ErrorKind },   // §7.7
  MediaChanged { session_id: String, title: String, artist: String, playing: bool, timeline: Option<Timeline>, art: Option<String> },
  TimerTick { id: String, remaining_s: u32, label: String },   // 1 Hz only while visible; else start/end only
  TimerEnded { id: String },
  PrivacyChanged { mic: Vec<String>, camera: Vec<String> },     // app display names
  PowerChanged { percent: u8, charging: bool },
  NoteSaved { card_id: String, destination: String },
  SyncState { state: SyncState },                               // §8.6
  Fullscreen { monitor: String, active: bool },
  Maximized { monitor: String, active: bool },
  DragEnter { kinds: Vec<DragKind> }, DragLeave,
  ToolJob { job_id: String, tool_id: String, label: String, percent: f32, state: JobState },  // Tool running pill
  ToolResult { job_id: String, path: String, before_bytes: u64, after_bytes: u64, note: Option<String> },  // Result pill
  FilesMoved { op_id: String, count: u32, destination: String, verb: MoveVerb, undoable: bool },        // Moved pill
  LinkSaved { card_id: String, title: String },
  // v2.1: AgentRun { card_ref: String, checks_done: u8, checks_total: u8, status: String }, NextEvent { title: String, starts_in_s: u32 }, Stats { cpu: u8, ram: u8, net_down: String }
}
```

The frontend keeps a Zustand `islandStore` reducer: `{ state: 'hidden'|'idle'|'faded'|'live'|'peek'|'expanded'|'drop', primary, bubble, queue, tab }`. No JS timers while `idle`/`faded`/`hidden`.

### 5.4 Data (SQLite migrations, keep the v0.1 DB file)

```sql
-- Tack / notes
CREATE TABLE note_cards (id TEXT PRIMARY KEY, value TEXT NOT NULL, local_only INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE tack_mirror (tbl TEXT, id TEXT, version INTEGER, value TEXT, PRIMARY KEY (tbl, id)); -- last server value + version (merge base)
CREATE TABLE tack_outbox (tbl TEXT, id TEXT, value TEXT, queued_at TEXT, attempts INTEGER DEFAULT 0, PRIMARY KEY (tbl, id));
CREATE TABLE tack_meta (key TEXT PRIMARY KEY, value TEXT); -- base_url, user_id, workspace_id, cursor, csrf, last_synced, scope
CREATE TABLE note_reminders (id TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Windows / widgets
CREATE TABLE sticky_windows (card_id TEXT PRIMARY KEY, monitor TEXT, x INT, y INT, w INT, h INT, pinned INT, opacity INT);
-- Shelf, presets, timers
CREATE TABLE shelf_items (id TEXT PRIMARY KEY, path TEXT NOT NULL, added_at TEXT, size INTEGER, kind TEXT);
CREATE TABLE download_presets (site TEXT PRIMARY KEY, preset TEXT NOT NULL, options TEXT NOT NULL); -- remembered per site
CREATE TABLE focus_sessions (id TEXT PRIMARY KEY, label TEXT, card_id TEXT, started_at TEXT, planned_s INT, ended_at TEXT);
-- Native tools, pins, links
CREATE TABLE tool_presets (id TEXT PRIMARY KEY, tool_id TEXT NOT NULL, name TEXT NOT NULL, options TEXT NOT NULL, builtin INT NOT NULL DEFAULT 0); -- e.g. Fit for Discord {target_mb:20}
CREATE TABLE pins (id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL, label TEXT, slot INT, sort TEXT NOT NULL, verb TEXT, added_at TEXT, last_used TEXT); -- kind: folder|file; verb: auto|move|copy
CREATE TABLE file_ops (op_id TEXT, seq INT, ts TEXT, kind TEXT, src TEXT, dst TEXT, file_id TEXT, state TEXT, PRIMARY KEY (op_id, seq)); -- undo journal
CREATE TABLE move_history (ext TEXT, site TEXT, destination TEXT, count INT, last_at TEXT, PRIMARY KEY (ext, site, destination)); -- Move to… suggestions
CREATE TABLE encoder_probe (gpu_key TEXT PRIMARY KEY, encoders TEXT NOT NULL, probed_at TEXT);
```

Store each Tack card as its full JSON `value` so unknown/new Tack fields round-trip untouched. Never drop fields you don't understand.

### 5.5 Dependencies (each must earn its place)

Add:
- `windows` crate features: `Media_Control`, `Foundation`, `Storage_Streams`, `Win32_UI_Shell`, `Win32_UI_WindowsAndMessaging`, `Win32_UI_Accessibility` (WinEvent hooks), `Win32_System_Registry`, `Win32_System_Power`, `Win32_Graphics_Gdi` (monitors). Replace the narrow `windows-sys` use where convenient.
- `tauri-plugin-deep-link` — `nabbit://` scheme.
- `keyring` — Tack session in Windows Credential Manager.
- `reqwest` feature `cookies` (already a dependency) — cookie store for the Tack session.
- `window-vibrancy` — Mica for the settings window only.
- `drag` (CrabNebula) or `tauri-plugin-drag` — dragging shelf files out to other apps.
- Native tools: `windows` features `Graphics_Imaging` (WIC), `Media_Ocr`, `Data_Pdf`, `Globalization`, `Win32_UI_Shell` (IFileOperation, SHOpenFolderAndSelectItems, IShellItemImageFactory, SHOpenWithDialog, known folders), `Win32_UI_Accessibility` (UI Automation), `Win32_System_DataExchange` (clipboard); crates `image`, `fast_image_resize`, `oxipng`, `ravif`, `resvg`, `img-parts`, `lopdf`, `qrcode`, `rqrr`, `notify` 9 + `notify-debouncer-full`, `clipboard-win`, `url` (normalisation). `webp` only if the ffmpeg build lacks libwebp. No Tesseract, no PDFium, no ML models, no new binaries in v2.0. `cargo deny` bans GPL/AGPL/LGPL crates (§9b.6).
- Frontend: `geist` fonts package only. **No** animation library, **no** CSS-in-JS, **no** CRDT library.

Sidecars: add **`deno`** next to `yt-dlp` and `ffmpeg` in `src-tauri/binaries/` (`deno-x86_64-pc-windows-msvc.exe`, `deno-aarch64-pc-windows-msvc.exe`) and update `scripts/fetch-binaries.ps1` / `.sh`. Pin versions and checksum them, like v0.1 does for yt-dlp. Switch the `ffmpeg` sidecar to **BtbN's GPL build** (win64 and winarm64, `ffmpeg.exe` only) because yt-dlp's own builds are meant for yt-dlp; record which encoders and libraries (libx264, libwebp, libass, Media Foundation) the pinned build includes in `PROGRESS.md`, and ship its licence, source offer and configure line (§9b.6).

---

## 6. Island shell

Figma: Compact `7:103`, Peek `8:119`, Expanded `10:519`, Drop `8:192`, Notch `8:200`, Specs `23:479` / `23:495` / `23:526` / `23:585`, desktop mocks `15:443`–`15:860`.

### 6.1 Geometry

- Transparent window 720×460 logical, top-centre of the active monitor's work area. Pill top offset **6 px** (floating island) or **0 px** (notch shape).
- Compact: idle **112×26** (r13); live **h32** (r16), width by content (232–348). Peek: **400** wide, r24, height by content. Expanded: **680** wide, r28, height by content, max 420 (scroll inside). Drop target: **640** wide.
- Size setting Small / Standard / Large = 0.9 / 1.0 / 1.15 scale on top of Windows display scaling.

### 6.2 Click-through protocol (hit-rects)

- The frontend measures the visible pill (`getBoundingClientRect` of the island root) after every layout change and sends `island_set_hitrect({x,y,w,h})` (logical px, +8 px padding).
- Rust keeps the window click-through (`set_ignore_cursor_events(true)`) and switches it off only while the cursor is inside the current hit-rect. The cursor watcher polls `GetCursorPos` at 30–60 Hz **only** within 120 px of the hit-rect, otherwise it sleeps and relies on `EVENT_SYSTEM_FOREGROUND` and a low-frequency check (≤ 2 Hz).
- **Drag-and-drop:** WebView2 registers its drop target only for windows that are visible and composited before the drag starts, so keep the island window shown (fully transparent when hidden) rather than hidden. When an OLE drag enters the top 48 px band (button down + cursor in band), make the hit-rect interactive for the whole drop target and emit `DragEnter`. Use Tauri `onDragDropEvent` for files and HTML5 `dataTransfer` for URLs/text from browsers.

### 6.3 State machine (`23:495`)

`hidden ⇄ idle ⇄ live ⇄ peek ⇄ expanded`, plus `faded` (idle over a maximised window), `drop` (from any visible state during a drag), and transient `alert` overlays on `live`.

- **hidden** ← fullscreen (`QUNS_RUNNING_D3D_FULL_SCREEN`, `QUNS_PRESENTATION_MODE`, `QUNS_BUSY`, or foreground window rect == monitor rect), user hide (Ctrl+Alt+H for 1 h), Focus mode. Queue alerts; show them when fullscreen ends unless "Show alerts over fullscreen" is on (timers ending and failed downloads only).
- **faded**: opacity 0.35 and fully click-through while a maximised window owns the monitor. Wakes on hovering the top band for 400 ms or Alt+Space.
- **peek**: after 180 ms hover intent over a live pill; closes 300 ms after leave.
- **expanded**: click, Alt+Space (remappable), or drag-over. Closes with Esc or click outside. **Remember tab, filters, search text and scroll position** across close/open.
- Exclusive-fullscreen games cannot be drawn over; that is expected.

### 6.4 Live activity priority

`mic/camera in use › timer ending (< 60 s) › download in progress › tool job › link detected › files moved / tool result / link saved (transient alerts with Undo or Reveal) › now playing › battery low/charging`; v2.1 adds `agent run` (after download) and `next event` (before now playing). At most **one primary pill + one bubble** (Figma "Split"); the rest wait. Users can reorder and disable activities in Settings → Island → Live activities (`22:287`); persist the order.

Durations: alert auto-dismiss 4 s (done, note saved); errors stay until dismissed; link detected stays 8 s, then shrinks to a bubble until the clipboard changes.

### 6.5 Monitors

Modes: Primary only · Follow mouse (default) · All monitors · Specific monitor. Recompute placement on `WM_DISPLAYCHANGE`, `WM_DPICHANGED`, taskbar moves (`SHAppBarMessage(ABM_GETTASKBARPOS)`); if the taskbar is at the top (Windows 10), place the island just below it. Atoll's issue tracker shows multi-monitor is the most bug-prone area, so the placement logic must be a pure function of (monitor list, DPI, work areas, taskbar position, cursor) and fully covered by the fixture-layout tests in §6.7. No real second monitor is needed.

### 6.6 Interactions

- Scroll on the pill: volume ±2 (1 with Shift) via Core Audio `IAudioEndpointVolume`.
- Middle-click the pill: play/pause the current GSMTC session.
- Ctrl+1–6 switch expanded tabs (Nab, Notes, Clipboard, Files, Media, Timer); Alt+1–9 opens pin 1–9; typing any character while expanded opens Search (`34:777`), which also finds pins and saved links; Esc collapses; every icon button has a tooltip and `aria-label`.

### 6.7 Acceptance (island shell, automated)

- [x] Idle budget: a PowerShell smoke launches the release exe with isolated app data, waits 20 s, samples 60 s and asserts 0.0% CPU across the app and its `msedgewebview2.exe` children; the working set is recorded in `PROGRESS.md`.
- [x] Click-through: unit tests cover the hit-rect state (cursor inside, outside, on the edge, rect updates mid-animation, faded = always click-through). The smoke injects cursor positions through an acceptance-only `NABBIT_ACCEPTANCE_CURSOR` provider and asserts the extended window styles flip accordingly.
- [x] Motion: in acceptance mode, enable the WebView2 remote-debugging port, trigger each morph and read frame timings over CDP; record this machine's refresh rate, scaling and dropped frames and compare with the V0 gate.
- [x] Fullscreen and maximised: unit tests feed notification states (`QUNS_*`) plus foreground and monitor rectangles and assert hidden, faded or visible.
- [x] Drag and drop: Vitest dispatches synthetic drag events with URL, file and text payloads (zone order and routing); Rust tests drive the band detector with simulated button and cursor states.
- [x] Monitors: unit tests over fixture layouts (two monitors at 100% and 150%, taskbar top, bottom or auto-hide, a monitor removed while expanded, DPI change mid-animation).
- [x] No focus steal: the smoke opens its own helper window, focuses it, pushes island updates and asserts `GetForegroundWindow()` never changes and the island window has `WS_EX_NOACTIVATE`.

V2.7 coverage and measured comparisons: `progress/v2/M5/V2.7.md`. The focused-helper activation denial and unavailable native DirectComposition/CDP attribution remain recorded under `PROGRESS.md` → `v2 Not automated`, per §0.2; neither is claimed as observed. Cold larger-WebView motion still exceeds V0’s two-drop comparison and retains the V0.4 native compact fallback.

---

## 7. Downloads v2

Figma: capture paths `17:5`, island Nab tab `10:519`, tray Nab `13:2`, sheets `17:137` / `17:270` / `18:160`, engine `18:260`, errors `18:330`.

### 7.1 Capture paths

1. **Clipboard** (exists): on a supported URL, emit `LinkDetected` with probed title/duration (probe async; show the pill immediately with the URL host, fill the title when ready). Never auto-download.
2. **Drag onto the top edge**: URL drops go to the Download zone by default.
3. **Deep link**: register `nabbit://nab?url=<encoded>` (single-instance forwards to the running app). Ship a bookmarklet on the landing page: `javascript:location.href='nabbit://nab?url='+encodeURIComponent(location.href)`. Validate and normalise the URL; never execute anything from the deep link other than opening the review.
4. **Hotkey** `Ctrl+Alt+D`: download the clipboard link with the remembered preset for that site (this counts as the explicit action). Paste into the tray field keeps working.

### 7.2 Presets

Default presets: `MP4 · 1080p`, `MP4 · 720p`, `MP3 · 320`, `M4A`, `Custom…`. Remember the last preset **per site** (`download_presets`), with the "Remember for <site>" toggle in the options sheet. The island Nab button and `Ctrl+Enter` use the remembered preset.

### 7.3 Options sheet → yt-dlp flags

Build flags in `download/options.rs` (unit-test every mapping). Confirm exact syntax against `yt-dlp --help` of the **pinned** version before checking this off.

| UI | yt-dlp |
|---|---|
| Format MP4/MKV/WebM | `-f "bv*[height<=H]+ba/b[height<=H]" --merge-output-format mp4|mkv|webm` |
| MP3 320 / M4A / Opus | `-x --audio-format mp3 --audio-quality 320K` / `m4a` / `opus` |
| Quality list with sizes | from the probe (`-J`), show estimated size per height |
| Subtitles | `--write-subs --write-auto-subs --sub-langs <lang> --embed-subs` (or write file) |
| Chapters: keep markers / split | `--embed-chapters` / `--split-chapters` |
| SponsorBlock: off / mark / cut | none / `--sponsorblock-mark all` / `--sponsorblock-remove sponsor` |
| Embed thumbnail and metadata | `--embed-thumbnail --embed-metadata` |
| Name files | `-o "<dir>\{template}"` (default `%(title)s [%(id)s].%(ext)s`) |
| Signed-in videos | `--cookies-from-browser chrome|edge|firefox|brave` (only for that job, never persisted to disk by Nabbit) |
| Trim | `--download-sections "*START-END"` (+ `--force-keyframes-at-cuts` when Precise is on) |
| Playlist range | `--yes-playlist -I 1-5` (or explicit indices) |
| Speed limit (Advanced) | `-r <rate>` |

### 7.4 Trim and chapters (`17:270`)

Filmstrip from the probe thumbnail(s); range handles snap to chapter boundaries when within 1 s; start/end fields accept `mm:ss(.f)`. Chapter chips toggle a union of ranges (multiple `--download-sections`).

### 7.5 Playlists (`18:160`)

Probe with `--flat-playlist -J`. Show count, total estimated size, selection with checkboxes, range field (`1–5`). Downloads enqueue per item so progress and retry work per video.

### 7.6 Engine health (`18:260`)

- Sidecars: `yt-dlp`, `ffmpeg`, **`deno`**. yt-dlp ≥ 2025.11.12 needs a JavaScript runtime for full YouTube support; only Deno is enabled by default and it must be on `PATH` or beside `yt-dlp.exe`. Ship Deno as a sidecar and pass its path explicitly (`--js-runtimes deno:<path>`; verify syntax against the pinned version and the yt-dlp EJS wiki).
- Daily background check: version probe of all three + a 3-second test extraction against the Creative Commons sample already used by `windows-real-download-smoke.ps1`. Results feed the card and the island `Error` state ("Download engine needs an update — Fix").
- Channels: Stable (default) / Nightly. Update = download, checksum, atomic swap, re-probe.

### 7.7 Error → fix mapping (`18:330`)

Implement `download/errors.rs` mapping stderr patterns to an `ErrorKind` with copy and actions. Never show stack traces; "Copy details" puts the raw log on the clipboard.

| ErrorKind | Typical stderr | Title (copy as in Figma) | Actions |
|---|---|---|---|
| `SignInRequired` | "Sign in to confirm you're not a bot", age-gate, members-only | YouTube wants you signed in | Use <browser> sign-in (re-run with `--cookies-from-browser`) · Retry |
| `SiteChanged` | HTTP 403, nsig/signature, PO-token errors | YouTube changed something | Update engine · Copy details |
| `MissingJsRuntime` | no supported JavaScript runtime | The engine needs its helper | Install Deno · Skip for now |
| `FormatUnavailable` | "Requested format is not available" | <q> isn't offered for this video | Use <best available> · Choose… |
| `Drm` | DRM / encrypted | This media is protected | OK (no workaround, ever) |
| `Disk` | no space, access denied, path too long | Not enough space on <drive> | Choose folder · Retry |
| `Offline` | DNS / connection on all retries | You're offline | Cancel (auto-resume when online) |
| `Live` | is_live / upcoming | This is still live | Download when it ends (`--wait-for-video`) · Cancel |
| `Unknown` | anything else | Download failed | Retry · Copy details |

### 7.8 Acceptance (downloads, automated)

- [x] Capture paths: tests drive the clipboard event, synthetic drops, the deep-link handler (valid, malformed, non-http and `javascript:` URLs) and the hotkey command. Passive capture opens review without a job; `Ctrl+Alt+D` explicitly enqueues the remembered preset, per §7.1 and the recorded V3.3 decision.
- [x] Presets: the remembered preset per site survives a restart (DB test) and `Ctrl+Alt+D` resolves to it.
- [x] Options builder: every row of §7.3 has a unit test asserting the exact argument list for the pinned yt-dlp version.
- [x] Queue, playlist range 1–5 and per-item retry run against the v0.1 fake runner (`NABBIT_ACCEPTANCE_FAKE_DOWNLOAD`).
- [x] Each `ErrorKind` has a unit test with a captured stderr fixture; Vitest checks the island compact Error state and the full tray-row copy.
- [x] Engine: a missing Deno yields `MissingJsRuntime`; the health check parses version-output fixtures for all three sidecars.
- [x] `windows-acceptance-smoke.ps1` still passes and gains a deep-link check (`start nabbit://nab?url=…` → review open, no download row).
- [x] Online only, never a gate: a real trimmed-section download of the Creative Commons sample with an ffprobe duration check, and a comparison of `yt-dlp -F` format counts with and without the Deno runtime.


V3.7 evidence: `progress/v2/M7/v37-acceptance.json`. The protocol route is exercised by forwarding the URI through a second owned executable; installed shell association is exempt under §0.2 and recorded in `PROGRESS.md`. The optional public run uses the pinned engine CLI; native queue/IPC uses isolated fixture providers.

---

## 8. Notes · Tack

Figma: island Notes tab `10:519`, tray Notes `13:242`, connect `19:5` / `19:102`, editor `19:182`, conflict `19:301`, states `19:346`, sticky `14:531`, board `14:532`.

Tack (github.com/tanzir71/tack, `project-priority/`) is the user's own browser-local planner with a PHP + SQLite API, deployed on Namecheap. **Read `project-priority/backend/index.php`, `bootstrap.php`, `src/sync.ts`, `src/cards.ts` and `src/capture.ts` before implementing this phase; the summary below was taken from them on 2026-11-25. If they changed, follow the code.**

### 8.1 Modes

- **Local only** (default until connected): cards live in `note_cards` with `local_only=1`, same JSON shape as Tack cards.
- **Tack**: the user enters their Tack URL (e.g. `https://their-domain/tack/`), signs in, picks a workspace. On first connect, offer "Upload 12 local notes to this workspace" (creates them as new cards).

### 8.2 Protocol (Tack API v4)

Endpoint: `<base>/api/index.php?action=<action>`. JSON bodies. HTTPS required (session cookie is `Secure`).

1. `GET ?action=status` → `{ available, version, user, requiresLogin, recoveryPending, workspace, workspaces, csrf, … }`. This also creates the `tack_sid` session cookie. Keep `csrf`.
2. `POST ?action=login` body `{ username, password, remember: true }`, header `X-CSRF-Token: <csrf>`. Response `{ user, workspace, workspaces, csrf, recoveryCode }`. **Replace `csrf` with the new value.** Session lasts 30 days (`remember`).
   - If `recoveryCode` is non-null, the account has not confirmed its recovery code and every sync returns **428**. Show the code once in a secure dialog ("Save this recovery code — Tack needs it to reset your password") with Copy and an "I saved it" checkbox, then `POST ?action=recovery-confirm` `{ saved: true, code }`.
   - Rate limits: 10 attempts / 15 min per account, 60 / 15 min per IP. Respect `Retry-After` on 429.
3. Every POST after login sends: `X-CSRF-Token`, `X-Workspace-User: <user.id>`, `X-Tack-Workspace: <workspace.id>`.
4. `POST ?action=workspace-switch` `{ id }` (send the **current** workspace in `X-Tack-Workspace`) → `{ workspace, workspaces }`.
5. `POST ?action=sync` `{ cursor, mutations: [...] }` (≤ 50 mutations, unique `table:id`) →
   `{ changes: [{ table, id, version, value }], cursor, more, conflicts: [{ table, id, version, value }], referenceIssues, access, accessReset, userId, workspaceId, … }`. Loop with the returned cursor while `more` is true. Apply only tables Nabbit uses (`cards`, `reminders`; read `settings` key for the label catalogue if needed) but **always advance the cursor**.
6. `POST ?action=logout` on sign-out; then wipe the cookie and CSRF from Credential Manager.

Mutation shape (one per changed record):

```json
{ "table": "cards", "id": "<uuid>", "baseVersion": 7, "baseValue": { "…last server value…" }, "value": { "…full card…" } }
```

- `baseVersion` = `tack_mirror.version` (0 for new); `baseValue` = `tack_mirror.value` (null for new). The server three-way merges fields when versions differ and only reports a conflict when it cannot.
- `value: null` deletes permanently. **Trash** is `trashedAt` set, **archive** is `archived: true`; use those for normal deletes (Tack shows Trash and Archive).

Status codes → `SyncState`: 401/403 → `signedOut`; 409 with workspace details → `workspaceChanged`; 413 → `storageFull` (100 MB workspace limit); 428 → `recoveryPending`; 429 → back off per `Retry-After`; 503/network → `offline` (keep the outbox, retry with exponential backoff up to 5 min).

### 8.3 Card shape (Tack `cardSchema`)

`{ id, revision, assigneeId|null, status?, priority: "inbox"|"now"|"next"|"later", ref, doneWhen, frontmatter, kind: "note"|"checklist"|"bookmark"|"task", title (≤300), body (≤200000), url, labels[], items[{id,text,checked}], attachmentIds[], pinned, archived, trashedAt|null, completed, color: "default"|"blue"|"purple"|"green"|"pink"|"gray", rank (fractional-index string), projectId|null, createdAt, updatedAt, sourceId|null }`

New card from Nabbit: `id` = UUID v4, `revision: 0`, `ref: ""` (**the server allocates `tck-N`**; read it back from the echoed change), `priority: "inbox"` unless capture says otherwise, `rank` = a fractional key before the current first card (port `generateKeyBetween` from the `fractional-indexing` package that Tack uses; keys are base-62 strings), timestamps ISO-8601 UTC with milliseconds. On every local edit: `revision += 1`, `updatedAt = now`.

UI mapping: Tack `task` renders as Checklist with its status/completed; `bookmark` shows the URL row; `attachmentIds` images are read-only in v2 (show a thumbnail, open in Tack to edit). Reminders are a separate table (`{ id, entityId, entityType: "card", at, timeZone, repeat, anchorDay, snoozedUntil, lastCompletedAt, enabled }`); v2 reads and edits them in the editor; toasts for due reminders are v2.1.

### 8.4 Sync algorithm

- Local edits write `note_cards` and upsert `tack_outbox` (coalesce per card). Debounce 1.5 s, then sync; also sync on app focus, on network regain and every 60 s while any window is open (5 min otherwise).
- Batch the outbox into ≤ 50 mutations. After each response: apply `changes` (update `tack_mirror` and `note_cards` unless that card is in the outbox with newer local edits), drop outbox rows that the server accepted (their `table:id` appear in `changes` with the new version, or the canonical value matches), keep rows listed in `conflicts`.
- **Conflict** UI (`19:301`): show both texts. "Keep this PC's" → resend with `baseVersion`/`baseValue` from the conflict record. "Use Tack version" → discard the outbox row and keep the server value. Keep the losing body in a local `note_revisions` history.
- Signing out deletes the session but **not** unsynced local edits: export them to `Nabbit/unsynced-<date>.json` first, like Tack does.

### 8.5 Session storage

Store the cookie jar (only `tack_sid`) and CSRF in Windows Credential Manager via `keyring` (service `Nabbit/Tack/<host>`). **Never store the password.** On 401 show "Signed out" with a Sign in button that reopens `19:5` pre-filled with the URL and username.

### 8.6 Quick capture

Island Notes tab and `Ctrl+Alt+N`: one-line field. Port Tack's capture parsing (`src/capture.ts`) to the Nabbit frontend so behaviour matches: `#label`, `!now|!next|!later|!inbox`, natural dates such as `tomorrow 9am` → reminder; a parsed task becomes `kind: "task"`. Show the parsed chips under the field before saving (`10:519` Notes). Enter saves; Shift+Enter starts a checklist; Tab opens the full editor. Show the `Note saved` compact state (`7:103`).

### 8.7 Views

- Tray Notes (`13:242`): capture bar, filter chips All / Inbox / Now / Next / Later / Links (§8.9), labels menu, Pinned then Others, two-column masonry of `NoteCard`s, footer sync status + "Open Tack" (opens `<base>` in the browser).
- Editor (`19:182`): card colour as the window background, toolbar (pop out, pin, reminder, archive, trash, close), title, body, checklist items with add row, properties (priority, colour, labels, reminder), footer sync line.
- Sticky (`14:531`): one card per window, edits sync like any other edit.
- Settings → Notes & Tack: connection, workspace, scope toggles from `19:102` (show tasks too; only cards with chosen labels; pinned cards on the board; log focus time to Tack (v2.1)).

### 8.8 Acceptance (notes, automated)

- [x] **Fake Tack server** (Rust dev-dependency, in-process on 127.0.0.1) that mirrors `backend/index.php` for the actions Nabbit uses: `status`, `login` (including `recoveryCode`), `recovery-confirm`, `workspace-switch`, `logout`, and `sync` with cursor paging (`more`), the 50-mutation limit, versions, server ref allocation, three-way field merge, conflicts and the 401/403/409/413/428/429 responses. Derive its behaviour from Tack's code and keep request/response fixtures in `src-tauri/tests/fixtures/tack/`.
- [x] Against the fake: create, edit, check items, recolour, label, pin, archive, trash, a two-device conflict (both resolutions), offline queue replay, batches above 50 mutations, cursor paging, and every error → `SyncState`.
- [x] A new card gets a server-allocated `tck-N` ref that Nabbit reads back; unknown fields added on the server survive a Nabbit edit.
- [x] Local-only mode works with no network; "Upload local notes" migrates once with no duplicates.
- [x] Grep test: the password never appears in the DB, logs or crash output; Credential Manager holds only the session cookie and CSRF token.
- [x] Optional, never a gate: if PHP 8.1+ with pdo_sqlite is already on `PATH` (or a portable PHP unpacks into a gitignored `.tools/` without admin rights), build Tack's hosting zip from a temporary clone of `https://github.com/tanzir71/tack`, serve it on 127.0.0.1, register a throwaway account and run the same suite; otherwise record it as skipped. **Never call the user's hosted Tack or use their account.**

**V4.8 evidence:** `progress/v2/M9/v48-acceptance.json` and its requirement matrix. The optional PHP suite is **skipped**: PHP 8.2.30 is on PATH but has no `pdo_sqlite` (`v48-php.json`); no runtime was installed and no hosted/user Tack account was contacted.

### 8.9 Links and bookmarks (Tack bookmark cards)

Figma: clipboard link row `45:568`, Notes → Links `45:452`, Import bookmarks `45:362`.

Links are Tack cards with `kind: "bookmark"` and `url` (§8.3), so they sync, get labels and priorities, and show in Tack like any other card. Local-only mode stores them the same way.

- **Save a link** from: the clipboard link row ("Save link"), dropping a link on the island's New note zone (`8:168`; a dropped URL becomes a bookmark card, while the Download zone still downloads), `Ctrl+Alt+N` with a URL (Tack's capture parsing already turns a URL into `kind: "bookmark"`), or the act-on-selection hotkey when the selection is a URL. Title: fetch the page with `reqwest` (GET, 5 s timeout, 512 KB cap, no cookies, follow ≤ 5 redirects) and read `og:title`, then `<title>`; fall back to the host. For sites yt-dlp supports, reuse the downloader probe's title. Normalise for duplicate checks: lowercase scheme and host, drop the fragment, `utm_*`, `fbclid`, `gclid`, `mc_eid` and a trailing slash. Show the `Note saved` pill with "Saved to Tack · Links".
- **Import bookmarks** (`45:362`, Settings → Notes & Tack → Import bookmarks, and the Notes overflow menu). A browser extension can only read its own browser's bookmarks; Nabbit reads all of them locally and read-only:
  - Chromium family (Chrome, Edge, Brave, Vivaldi): the `Bookmarks` JSON file in each profile folder under `%LOCALAPPDATA%` (`Google\Chrome\User Data`, `Microsoft\Edge\User Data`, `BraveSoftware\Brave-Browser\User Data`, `Vivaldi\User Data`); profile display names from `Local State` (`profile.info_cache`). Walk `roots.bookmark_bar`, `roots.other`, `roots.synced`; `date_added` is microseconds since 1601-01-01.
  - Firefox: copy `places.sqlite` (and `-wal` if present) from each profile in `%APPDATA%\Mozilla\Firefox\Profiles` to a temp folder, open the copy read-only with `rusqlite`, read `moz_bookmarks` (type 1) joined to `moz_places`; `dateAdded` is microseconds since 1970. Works while Firefox is open.
  - Any browser's HTML export (Netscape bookmark format): port Tack's `src/import/bookmarks.ts` so behaviour matches (H3 folders → labels, `ADD_DATE` seconds → `createdAt`).
  - Never read history, cookies, passwords or anything except these bookmark files; the sheet names the exact files it read.
- **Import rules:** http(s) only (skip `javascript:`, `place:`, `chrome://`, `file:`); folder path → labels, dropping root names ("Bookmarks bar", "Other bookmarks", "Mobile bookmarks", "Bookmarks Menu", "Bookmarks Toolbar"); skip links already in the workspace by normalised URL (default on, count shown); priority **Later** by default (Inbox optional) so imports don't flood the inbox; `createdAt` from the bookmark's add date; title ≤ 300 chars; send as sync mutations in batches of ≤ 50 with a progress pill; one import = one undo group (trash the imported cards).
- **Organise** (`45:452`): a **Links** filter in the tray and island Notes views (kind = bookmark), label chips, search by title or domain, bulk Label / Later / Archive / Open all, favicon letter tiles (no favicon fetching in v2.0). Video links keep a Download button.
- **v2.1:** dead-link check (HEAD then GET, concurrency 4, opt-in), duplicate review, export to HTML for browsers.
- **Acceptance (automated):** fixture `Bookmarks` JSON (nested folders, a bookmarklet, a duplicate), a `places.sqlite` built in the test, and an HTML export all import to the same card set; labels, dates, priority and dedupe match; batching above 50 hits the fake Tack's limit correctly; the title fetch runs against a local fixture server (no internet); no file outside the listed bookmark paths is opened (assert via a path allow-list in the importer).

---

## 9. Other modules (MVP)

| Module | Implementation | Figma | Automated acceptance |
|---|---|---|---|
| Clipboard tab | Reuse the v0.1 store and `ClipboardList` logic; island variant with search, filters (All, Text, Links, Images, Files, Pinned), number-key pick, Enter pastes, link rows get a Nab button | `10:519`, `13:422` | v0.1 clipboard tests stay green; Vitest covers the island tab keyboard flow and filters |
| Shelf | Paths only (no copies) in `shelf_items`; drop files to add, drag out with the drag plugin, Copy paths, Clear; missing files shown greyed with "Remove". Lives at the top of the **Files** tab above Pins (§9b.4); selecting items shows Shelf actions (`34:897`) | `10:249` Files | Unit tests: add, dedupe, missing file, Copy paths text; the drag-out command builds the right file list (no interactive drag) |
| Now playing | GSMTC session manager behind a `MediaProvider` trait, subscribed to session/media/playback/timeline events; artwork from the thumbnail stream (cached, 96 px); "no timeline" variant when the player doesn't publish timeline data; session chips to switch | `7:103`, `8:119`, `10:519` Media | Recorded session fixtures map to the right pill/peek/expanded states; a test asserts subscription only, no polling |
| Focus timer | Presets 25/5, 50/10, 90, custom; wall-clock based (survives sleep); optional link to a Tack card (shows `tck-N`); ends with an alert even over fullscreen if enabled | `10:519` Timer, `8:119` | Injected-clock tests: sleep/resume jump, DST change, restart with a running timer; `Ctrl+Alt+T` command toggles |
| Mic/camera dot | ConsentStore registry watch behind a provider trait (`LastUsedTimeStop == 0` ⇒ in use; walk `NonPackaged` too); check the process is still alive to avoid stale entries; amber dot for mic, lime for camera; app name in the pill | `7:103` Mic in use | Registry-snapshot fixtures (packaged, `NonPackaged`, Teams-style key, stale 0 with a dead PID) produce the right in-use list |
| Battery | `GetSystemPowerStatus` + power notifications; show on plug/unplug and ≤ 20% | `7:103` Charging | Fake power events: shown only on change, never permanently |

---

## 9b. Native tools, pins and context

Figma page `10 Native tools`: catalog `35:234`, Fit under a size `45:282`, HEIC → JPG sheet `36:410`, Import bookmarks `45:362`, Notes → Links `45:452`, clipboard link row `45:568`, text-tools menu `36:505` / `36:539`. Island: Files tab `10:249`, Shelf actions `34:897`, Search `34:777`, drop target `Over=Pin` `43:692`, pin peek `43:755`, compact Moved `33:518` / Result `33:528` / Tool running `33:535`, peek Download done `33:580`.

Research behind this section: Project doc `claude/nabbit-native-tools-research.md` (Nov 2026). Read its v2.0 table and its "traps" section before starting Phase V5.

### 9b.1 Scope rule

Ship only what a browser extension cannot do and Windows or PowerToys does not already do well. **Screenshots, colour pickers and screen-region OCR are out**: browser extensions, PowerToys (Color Picker, Text Extractor) and Snipping Tool cover them, and their old shortcuts (Ctrl+Alt+S/O/C) are reassigned (§10). The full "do not build" list is in §9b.8.

### 9b.2 Rules every tool follows

- **Registry pattern (from tooldeck `src-tauri/src/registry.rs`):** each tool is one entry `{ id, name, category, icon, keywords, accepts (file types | text | link | image), presets, form schema, run(input) -> Job }`. Search, the Files tab, Shelf actions, drop suggestions, Send To and the clipboard menu are generated from the registry.
- **Presets are named for the result**, not the format: "Fit for Discord", "Fit for email", "To JPG", "To MP4", "Make smaller", "Make PDF". Every preset keeps editable numbers because limits change (Settings → Files). Defaults: Discord 20 MB, email 25 MB, Outlook/Exchange 10 MB (shown as an alternative), WhatsApp 100 MB.
- **Outputs never overwrite inputs.** Write `<name> (<Preset>).<ext>` next to the original; on a clash append ` 2`, ` 3`. Keep the original's modified and created dates on the output where the format allows it (browsers cannot set file dates; this is a native-only nicety).
- **One primary action per sheet**; everything else under a collapsed Advanced row (`36:410`, `45:282`).
- **Jobs** run through one runner: progress as `ToolJob` events (Tool running pill `33:535`), cancel that keeps the job in the queue, retry, and a warning when quitting mid-job. Each finished job shows a **result card** (`33:528`: "42 MB → 19.6 MB · Fits Discord") with Reveal and Undo; Undo moves the new file to the Recycle Bin.
- **Drop suggestions:** when a drag enters the island, show one primary suggestion for the file type (HEIC → To JPG, MOV/MKV → To MP4, video over the default cap → Fit for Discord, several images → Make PDF, PDF over the email cap → Fit for email in v2.1), then Add to shelf, then folder pins (`43:692`). Transforming actions come first; plain launchers never lead.

### 9b.3 v2.0 tools (no new binaries: bundled ffmpeg, pure-Rust crates, Windows APIs)

| # | Tool | Implementation | Placement |
|---|---|---|---|
| 1 | **Fit under N MB** (video first; images and audio use the same preset) | ffmpeg. Video kbps = (target kilobits × 0.97 − audio kbps × duration) ÷ duration. Set audio first (128 kbps AAC; 64–96 kbps mono for long clips). Step 1080p → 720p → 480p only when bits per pixel get too low. "Exact size" = libx264 two-pass. "Fast (GPU)" = the first working encoder of `h264_nvenc`, `h264_qsv`, `h264_amf`, `h264_mf` (probe each lazily with a 1-second `testsrc2` encode and a timeout, cache per GPU and driver), with a retry loop of up to 3 tries that **always restarts from the original**. Reimplement the idea; do not copy code from the GPL projects 8mb or ffmpeg4discord. | Sheet `45:282`; island drop suggestion for videos over the default cap; Shelf; Send To "Fit for Discord" |
| 2 | **Quick video jobs**: To MP4 (try `-c copy` remux first), trim (reuse the §7.4 trim sheet), extract audio (MP3/M4A), To GIF (`palettegen` + `paletteuse` in one filter graph, `diff_mode=rectangle`, capped 720 px / 15 fps with a size warning), animated WebP if the build has libwebp | ffmpeg | Island drop (MOV/MKV → To MP4), Shelf, download-done peek `33:580` |
| 3 | **Images**: HEIC → JPG, convert PNG/JPG/WebP/AVIF, resize, Make smaller | Decode HEIC through **WIC** (`windows` crate, `Graphics_Imaging`); if the decoder can't be created, show a one-click prompt to the HEIF + HEVC Store extensions (explain the HEVC one may cost $0.99). Keep EXIF and capture dates by default; apply orientation before any metadata change. Encode with `image`, `fast_image_resize`, `oxipng`, `ravif` (speed 6+, never 1–2), lossy WebP through ffmpeg `libwebp` if present, else the `webp` crate. `resvg` for SVG → PNG. **Test whether the bundled ffmpeg decodes HEIC tile grids**; if it does, use it as the fallback when WIC fails and record it. No HEIC encoding. | Sheet `36:410`; island drop; Shelf; Send To "To JPG" |
| 4 | **Strip location and camera data** | `img-parts` lossless segment removal for JPEG/PNG/WebP; ffmpeg `-map_metadata -1 -map_chapters -1 -c copy` for audio/video | Shelf action; chip on image result cards |
| 5 | **PDF basics**: merge (Shelf order, reorderable), split (every page or ranges), images → PDF, PDF → images | `lopdf` for merge/split/build; `Windows.Data.Pdf` (WinRT, 0 MB) to render pages for PDF → images; encrypted PDFs → clear error | Shelf; dropping several images suggests Make PDF |
| 6 | **Text and QR from image files and clipboard images** | `Windows.Media.Ocr` (user's language; "No text found" handled), `rqrr` decode, `qrcode` encode. No screen capture. | Clipboard image row; Shelf |
| 7 | **Pins and Move to…** | §9b.4 | Files tab `10:249`, drop targets `43:692`, pin peek `43:755`, download-done peek `33:580` |
| 8 | **Context**: clipboard actions by type, act on selected text, Send To | §9b.5 | Clipboard tab, text tools menu, Explorer |
| 9 | **Links and bookmarks** | §8.9 | Clipboard link row `45:568`, Notes → Links `45:452`, import `45:362` |

### 9b.4 Pins and drop-to-file (folders and files)

The desktop fills up because Windows 11 has no always-visible place that holds both folders and files (taskbar toolbars were removed; Explorer splits folder pins into Quick access and file pins into Home "Favorites"). Pins are that place, and dropping a file on a folder pin files it.

- **Files tab** (`10:249`): the Shelf (files in transit) on top and **Pins** (permanent) below, up to 8 visible in a 2 × 4 grid with type-to-search for the rest. Folders and files in one list; Alt+1–9 opens pin 1–9 while the island is expanded. Each pin: Open (`ShellExecuteEx`), Reveal (`SHOpenFolderAndSelectItems`, call `CoInitializeEx` first), Copy path, Open With (`SHOpenWithDialog`), Open in Terminal (`wt -d`) and VS Code (`code`) only when installed, drag out (`tauri-plugin-drag`). Removing a pin never touches the file.
- **Pin peek** (`43:755`): hovering a folder pin for about 350 ms opens the 6 newest items (directory listing by modified time, no file reads); click keeps it open; items drag out. Watch the folder with `notify` only while the peek is visible. Never watch network paths (they "may emit no events"); refresh them when the peek opens.
- **Drop to file**: dropping on a folder pin follows Explorer's rules: move on the same volume, copy across volumes, **Shift forces move, Ctrl forces copy**; the target shows the live verb ("Move here", "Copy · other drive"). Each pin may override ("Always move"). Run moves and copies through **`IFileOperation`** with `FOFX_ADDUNDORECORD` (Windows conflict dialogs, Recycle Bin, Explorer's session undo) plus `FOFX_NOMINIMIZEBOX` (restores the progress dialog that some 24H2 builds hide). Also log every operation in Nabbit's own `file_ops` journal so the **Undo** on the Moved pill (`33:518`, 8 s) works even after Explorer restarts. Confirm only when: moving out of a cloud sync root (forces a download; show the size), network destinations, more than 50 items.
- **Move to…** on Shelf items (`34:897`) and on the download-done peek (`33:580`): top three suggestions from Nabbit's journal (last destination for this extension/site), then pins, then a folder picker.
- **Paths done right:** resolve Desktop, Downloads and Documents with `SHGetKnownFolderPath` (OneDrive Known Folder Move redirects them). Never hydrate cloud-only placeholders (`FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`): thumbnails use `IShellItemImageFactory` with `SIIGBF_INCACHEONLY` first, `SIIGBF_ICONONLY` for placeholders, and a cloud badge. All shell COM calls run on one STA worker thread, never on the UI thread. Ship the `longPathAware` manifest, use `\\?\` paths in Rust, and show a clear error when the system long-path setting is off.
- **Not in v2.0:** importing desktop `.lnk` shortcuts and Quick access pins, tidy rules, Tack project folder sets, the taskbar jump list (all v2.1, §14).

### 9b.5 Context from other apps (quiet by default)

Context is collected in the background but only shown when the user opens the island or presses a hotkey. No automatic popups (Windows' own "Suggested actions" was deprecated in Dec 2024 for appearing rarely and wrongly). Everything goes silent while `SHQueryUserNotificationState` reports full-screen, Direct3D exclusive or presentation mode.

- **Clipboard by type** (`45:568`): `AddClipboardFormatListener` (`clipboard-win` monitor). Before classifying, skip content carrying `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory = 0` or `CanUploadToCloudClipboard = 0`, plus a default exclusion list of password managers (keeps v0.1's sensitive-content skip). The first clipboard row adapts: link → Save link, Clean link (strip `utm_*`, `fbclid`, `gclid`, `mc_eid`), QR, Open; video link → Download first; JSON → Format; image → Save as file, Text, Decode QR; files copied in Explorer → Add to Shelf, Convert; path → Reveal, Pin.
- **Text tools menu** (`36:505`, `36:539`): unchanged (approved design). Results are copied and added as a new clipboard item; the original stays.
- **Act on selected text** (Ctrl+Alt+S): read the selection with UI Automation `TextPattern.GetSelection` on the focused element (Nabbit's own ~100-line implementation; do not use the archived GPL `selection` crate). Opt-in fallback (off by default): simulated Ctrl+C that saves and restores **every** clipboard format, never in password fields, excluded apps or elevated windows. The hotkey opens the text tools with the selection loaded; a selected URL offers Save link first.
- **Explorer**: a per-user Send To shortcut (`shell:sendto\Nabbit.lnk`) and verbs under `HKCU\Software\Classes\*\shell\Nabbit` with a preset submenu and `MultiSelectModel=Player`. No admin. The single-instance plugin collects incoming paths for 300 ms and treats them as one batch, which lands on the Shelf with suggestions. The Windows 11 top-level menu needs a signed sparse package and waits (§14).

### 9b.6 Licence and platform guardrails

- **ffmpeg stays a separate process.** User-facing conversion switches the sidecar to **BtbN's GPL builds** (win64 and winarm64; ship `ffmpeg.exe` only) because yt-dlp's builds are meant for yt-dlp. Ship the GPL text, a source offer and the build's configure line in the third-party licences screen. Never link libav* into nabbit.exe (no `ffmpeg-next` with a GPL build).
- **`cargo deny`** rejects GPL, AGPL and LGPL crates. Known traps: `imagequant` (GPL/commercial), `gifski` (AGPL), `jpegli-rs` (AGPL), MuPDF and Ghostscript (AGPL), the pot-app `selection` crate (GPL, archived). Generate a third-party licences screen.
- **HEIC** depends on Store codecs (§9b.3, #3). Detect, explain, link; never bundle HEVC.
- **No shell extensions, no Explorer injection** in v2.0 (Fences' crash history is the warning). Everything runs in Nabbit's own process.
- **Sign every build** (x64 and ARM64): a background app that moves files on the Desktop looks ransomware-adjacent to SmartScreen and antivirus.

### 9b.7 Automated acceptance (§0.2 rules apply)

- [x] Registry: every tool appears in search, Shelf actions, drop suggestions, Send To and the clipboard menu according to `accepts`; ids unique; every preset runs with defaults.
- [x] Fit under N MB: `testsrc2` + `sine` fixtures of 10 s, 60 s and 3 min at 1080p land under 20 MB and 25 MB targets within 3 tries in both modes available on this machine; each retry starts from the original (assert the input hash); audio budget and resolution step-down follow the table in code.
- [x] Video jobs, GIF caps, audio extract, metadata strip: fixture assertions with ffprobe (codec, duration ±0.1 s, dimensions, no `location`/`creation_time` tags after strip).
- [x] Images: generated PNG/JPEG/WebP/AVIF round-trips; a JPEG with EXIF GPS keeps it by default and loses it with strip; WIC HEIC decode runs when a HEIC fixture and the codec are present, otherwise records `skipped: no HEIF codec` and asserts the Store prompt state.
- [x] PDF: merge/split page counts, images → PDF page sizes, PDF → PNG via `Windows.Data.Pdf`.
- [x] Outputs never overwrite inputs (input hashes unchanged, `(Preset)` names, clash numbering), and dates are copied where supported.
- [x] Pins and moves on temp directories: same-volume move, cross-volume copy (use a second temp volume if available, else a mocked volume id), Shift/Ctrl overrides, name conflict, undo from the journal after the operation, cloud-placeholder attribute fixture is never read, long path error.
- [x] Clipboard: classification table tests; the three exclusion formats and the password-manager list suppress the row; restore-every-format test for the opt-in fallback using synthetic formats.
- [x] Selection: UIA read against a test window with a selectable edit control (no real apps).
- [x] Send To / HKCU verbs: registration writes only under HKCU and is removed on uninstall; batching collects N invocations into one Shelf batch.
- [x] Full-screen silence: notification-state fixtures suppress clipboard rows, drop suggestions and peeks.

### 9b.8 Not building (and why)

Screenshot and screen-recording GIFs (browser extensions; Snipping Tool); colour picker and ruler (extensions; PowerToys); screen-region OCR (PowerToys Text Extractor, Snipping Tool); bulk rename as its own tool (PowerRename); file-lock finder, spacebar preview, new-file templates (PowerToys); plain zip/7z/tar and unencrypted RAR extraction (Windows 11 24H2); background removal (File Explorer AI actions); full transcoder or editor (HandBrake, Clipchamp); Office → PDF (needs Word or LibreOffice; unattended Office automation is unsupported); ebook conversion (Calibre, Send to Kindle takes EPUB); "secure delete" (ineffective on SSDs; offer Delete permanently only); HEIC encoding (GPL x265, patents); desktop icon fences, quick-hide, taskbar toolbar restoration (Fences, Windhawk); global file search (Everything, Command Palette); automatic popups on copy or selection; system-wide drag-start detection (DynamicWin dropped it for performance).

---

## 10. Tray mode, tray menu, settings window

- **Mode switch** (Settings → General `22:2`, tray menu): Island + tray / Tray only / Island only. Tray only: no island window at all; progress shows as a tray icon badge and a Windows toast on completion. Island only: tray icon hidden; settings reachable from the island gear and the shortcut.
- **Tray popover** (`13:2`, `13:242`, `13:422`): header with mark, "Island on/off" badge, search, settings, close; segmented tabs Nab / Notes / Clipboard / Files (Shelf + Pins); footers show engine status, sync status or clipboard retention.
- **Tray menu** (`14:294`, `14:367`): Open Nabbit (Alt+Space), New note (Ctrl+Alt+N), Download link on clipboard (Ctrl+Alt+D), Clipboard history (Ctrl+Alt+V), Island ▸ (show, hide over fullscreen, fade over maximised, shape, monitor), Widgets ▸, Pause clipboard capture, Settings, Check for updates, Quit.
- **Tray glyph**: monochrome island capsule (`12:478` Tray glyph), light/dark taskbar aware; replace the v0.1 icon set (`src-tauri/icons/`) with the new mark (App tile variant) for app icons.
- **Settings window** (`22:2`, `22:146`, `22:287`, `22:474`): nav General, Island, Widgets, Downloads, Notes & Tack (incl. Import bookmarks), Clipboard, Files (preset limits, pins, Send To and right-click entries on/off), Shortcuts, Privacy & about. The Files section follows the existing settings layout; it has no separate Figma frame. Shortcut recorder detects conflicts (`RegisterHotKey` failure) and shows the Conflict badge instead of silently failing.

Default global shortcuts: Alt+Space (island), Ctrl+Alt+N (quick note), Ctrl+Alt+D (download clipboard link), Ctrl+Alt+V (clipboard), Ctrl+Alt+T (focus timer), Ctrl+Alt+H (hide island 1 h), Ctrl+Alt+S (act on selected text). Ctrl+Alt+O and Ctrl+Alt+C are no longer used. Keep the v0.1 settings keys working (migrate `togglePopoverShortcut` etc.).

---

## 10b. Landing page and GitHub Pages

Figma: `09 Landing` — desktop `27:220`, mobile `31:933`.

### 10b.1 Publishing setup (Phase P)

- **Make the repository public** after an automated pre-publication audit (P.1): scan the full history with `gitleaks detect --source . --log-opts="--all"` (download the release binary into a gitignored `.tools/` folder; no admin rights), plus a grep for `BEGIN .*PRIVATE KEY`, `TAURI_SIGNING_PRIVATE_KEY=`, `ghp_`, `github_pat_` and long base64 blobs in `git log -p --all`. Also confirm a `LICENSE` file exists (MIT, matching `Cargo.toml`; add it if missing) and no binaries larger than 5 MB are in history. **Any finding blocks P.2**: record it under Blockers and continue with V0; never rewrite history and never publish with a finding open.
- P.2: `gh repo edit tanzir71/nabbit --visibility public --accept-visibility-change-consequences`. If `gh` is not signed in or lacks admin rights, record a blocker and continue; do not ask for credentials.
- P.3: enable Pages from **`master` → `/docs`** (keep `docs/.nojekyll` so there is no Jekyll build): `gh api -X POST repos/tanzir71/nabbit/pages -f "source[branch]=master" -f "source[path]=/docs"` (use `-X PUT repos/tanzir71/nabbit/pages` with the same fields if Pages already exists). Do not choose the "GitHub Actions" source and do not add a Pages workflow.
- P.4: point the existing v0.1 landing at the new home: canonical, `og:url`, `docs/llms.txt` and README links → `https://tanzir71.github.io/nabbit/`; make every asset URL relative so the `/nabbit/` base path works; add `docs/404.html`. Leave `vercel.json` untouched.

### 10b.2 Build (Phase L, after foundations)

- **Static site, no build step:** `docs/index.html`, `docs/assets/site.css`, at most one small `docs/assets/site.js` (mobile menu, copy-to-clipboard for the bookmarklet). No framework, no analytics, no third-party requests, no CDN fonts.
- **Tokens and type:** generate `docs/assets/tokens.css` from the app's token source (§4.1) so the site and app never drift; self-host Geist and Geist Mono `woff2` (Latin subset) in `docs/assets/fonts/`. Landing sizes: H1 60/64 (mobile 40/44), H2 40/46 (mobile 28/34), H3 18/24, lead 18/28, body 16/26. No italics.
- **Sections** in Figma order: Nav, Hero, Live activities, Downloads (add the bookmarklet as a Secondary sm button "Send to Nabbit" with the bookmark icon under the bullets), Notes · Tack, Files (pins, drop-to-file, Fit under 20 MB, HEIC → JPG, Send To), Tools, Modes, Privacy (the only dark band), Built in the open, Final CTA, Footer. Content width 1120, side padding 160 desktop / 20 mobile; breakpoints 1200, 900, 600.
- **Visuals:** island pills and peeks are HTML/CSS replicas using the same tokens (they are small and stay crisp). For the three large composites (`27:273`, `27:499`, `27:607`) use 2× WebP exports from Figma if Figma access is available, otherwise HTML/CSS replicas; from M5 on, replace them with real screenshots from the Playwright harness. Every image has width/height and meaningful `alt`.
- **Pre-release state (nothing in v2 is built yet).** Until a v2 release exists on GitHub Releases: the hero eyebrow reads "FOR WINDOWS 10 AND 11 · OPEN SOURCE · BUILDING IN PUBLIC"; the line under the hero buttons reads "In development · first v2 release after milestone M12 · No account, no telemetry"; every primary CTA (nav, hero, final) reads **"Follow the build"** and links to the "Built in the open" list (`#progress`) in the nav and hero, and to the repository in the final CTA; the secondary stays "View source on GitHub". Feature copy describes what v2 does; never add screenshots of features that aren't built (use the Figma composites, then real harness screenshots as milestones land). Keep a single `data-download-cta` attribute on each primary CTA so the release switch is one change: when `gh release list` shows a v2 release, switch them to "Download for Windows" → `https://github.com/tanzir71/nabbit/releases/latest` and remove the "In development" line. Never create releases or tags.
- **Meta:** title, description, canonical `https://tanzir71.github.io/nabbit/`, Open Graph/Twitter tags, `docs/assets/og.png` (1200×630) rendered by Playwright from a `docs/og.html` source page, favicon from the mark (`12:478`), `<meta name="nabbit-milestone">`.
- Keep `docs/demo/` (the v0.1 simulated tray) linked from the footer until V7.5, then replace it with a deterministic island simulation or remove the link.

### 10b.3 "Built in the open" list

Thirteen rows, M0–M12, with the milestone names from §11. **Starting state (shown in Figma):** M0 In progress, M1–M12 Planned, no Screenshots links. States: Done (signal badge + "Screenshots" link to `progress/v2/M<n>/` on GitHub), In progress (warning badge), Planned (neutral). Plain HTML updated by the milestone push procedure (§0.1 step 4); no JavaScript.

### 10b.4 Pages deploys and Actions

GitHub Pages always deploys through GitHub's built-in "pages build and deployment" run (dynamic trigger), even from a branch with `.nojekyll`. That run is allowed. Everything else in §0.1 still holds: `[skip ci]` keeps `ci.yml` from running on pushes, and nothing may dispatch workflows, push tags or open pull requests.

### 10b.5 Automated checks (Phase L)

- Playwright screenshots of `docs/index.html` at 1440 and 390 wide (served locally under a `/nabbit/` base path) compared against `27:220` / `31:933`; saved to `progress/v2/M3/`.
- axe scan: no serious or critical issues; keyboard walk of nav, CTAs and the mobile menu; visible focus rings.
- `npm run verify:site` (extend `scripts/verify-site.mjs`): every internal link and asset resolves under the base path, no external requests other than links, total transfer ≤ 500 KB excluding fonts.
- After push: the §0.1 step 7 deploy check.

---

## 11. Build Loop

Commit after every task (§0.1). Lines marked **MILESTONE** are tasks of their own: run the milestone push procedure, then check them. Milestone numbers match the landing's "Built in the open" list.

### Phase P — Public repository and Pages (first)
- [x] P.1 Pre-publication audit (§10b.1): gitleaks + grep over full history, `LICENSE` present, no large binaries. Add `Claude outputs/` to `.gitignore` (local copies of design research; never commit or publish them) and commit `NABBIT_V2_HANDOFF.md` itself in this task. Findings block P.2.
- [x] P.2 Make the repository public with `gh repo edit … --visibility public --accept-visibility-change-consequences`.
- [x] P.3 Enable GitHub Pages from `master` `/docs` (no Actions source, no Pages workflow).
- [x] P.4 Re-point the existing landing to `https://tanzir71.github.io/nabbit/` (canonical, OG, `llms.txt`, README), relative asset URLs, `docs/404.html`, initial "Built in the open" list with M0 in progress, and the pre-release CTA rule from §10b.2 (no "Download" button while no release exists); `npm run verify:site`.
- [x] **MILESTONE M0 — Public repository and Pages** (push, then confirm the site serves `content="M0"`).

### Phase V0 — Spike and gate
- [x] V0.1 Create `spikes/island/` (throwaway Tauri window inside the app behind a dev flag): 720×460 transparent window, `focusable(false)`, `no_redirection_bitmap(true)`, CSS-morphing pill (idle → live → peek → expanded) using `linear()` springs.
- [x] V0.2 Hit-rect click-through with the adaptive cursor watcher; drag-enter while click-through; fullscreen hide.
- [x] V0.3 Measure with an automated script and record in `PROGRESS.md`: idle CPU over 60 s, total working set (app + WebView2 children), dropped frames per morph via CDP frame timing, plus this machine's Windows version, refresh rate and scaling. Measure only what this machine has; never change display settings.
- [x] V0.4 **Gate:** go if idle CPU = 0.0%, each morph drops ≤ 2 frames at this machine's refresh rate, and the island adds ≤ 60 MB working set; otherwise record the failure and implement only the collapsed/compact pill natively (Win32 layered window + DirectComposition) while keeping peek/expanded in the webview. Record the decision.
- [x] **MILESTONE M1 — Island spike and measurements.**

### Phase V1 — Foundations
- [x] V1.1 Tokens (§4.1) as CSS variables + Tailwind mapping, light/dark, `[data-theme]` driven by the Windows theme with an override; also emit `docs/assets/tokens.css` for the site.
- [x] V1.2 Bundle Geist + Geist Mono; remove Inter from the font stack.
- [x] V1.3 Rebuild/extend core components (§4.5) on a components preview page; compare against Foundations `5:408`.
- [x] V1.4 Multi-entry Vite build (`index`, `island`, `settings`, `sticky`); island bundle budget ≤ 120 KB gzipped JS (record it).
- [x] V1.5 New mark and icons (`12:478`): app icons, monochrome tray glyph for light/dark taskbars, site favicon.
- [x] V1.6 Playwright screenshot harness: Vite preview with mocked IPC, scale 1 and 1.5, light and dark, writing to `progress/v2/M<n>/`.
- [x] **MILESTONE M2 — Design foundations.**

### Phase L — Landing page
- [x] L.1 Build the new `docs/index.html` from `27:220` / `31:933` (§10b.2): all sections, tokens, self-hosted fonts, HTML/CSS island replicas, composite visuals (including the Files section `49:1132`), bookmarklet button, pre-release CTA rule (§10b.2).
- [x] L.2 Meta, OG image via `docs/og.html`, favicon, `404.html`, updated `llms.txt`.
- [x] L.3 Automated checks §10b.5.
- [x] **MILESTONE M3 — New landing page** (push, confirm the deploy).

### Phase V2 — Island shell
- [x] V2.1 Island window lifecycle, placement, monitor modes, shape (island/notch), size setting.
- [x] V2.2 Hit-rect protocol + cursor watcher (from V0), drag band.
- [x] V2.3 Fullscreen/maximised detection → hidden/faded states.
- [x] V2.4 `ActivityEvent` bus + priority queue + `islandStore` reducer with unit tests for every transition in §6.3.
- [x] **MILESTONE M4 — Island plumbing.**
- [x] V2.5 Compact states (`7:103`), Peek (`8:119`), Expanded shell with tabs (`10:519`), Drop target (`8:192`), motion (§4.6).
- [x] V2.6 Keyboard: Alt+Space, Ctrl+1–6, Alt+1–9 (pins), type-to-search, Esc, focus management, tooltips/aria labels.
- [x] V2.7 Island acceptance §6.7; swap the landing hero visual to a real harness screenshot.
- [x] **MILESTONE M5 — Island interface.**

### Phase V3 — Downloads v2
- [x] V3.1 Deno sidecar + fetch scripts + engine health (daily check, card `18:260`, island Error state).
- [x] V3.2 Options builder (§7.3) with unit tests; presets per site.
- [x] V3.3 Capture paths: drag, deep link (`tauri-plugin-deep-link`), hotkey; link-detected pill + peek.
- [x] V3.4 Island Nab tab and tray Nab redesign (`10:519`, `13:2`), queue rows with progress/pause/cancel/open/reveal.
- [x] **MILESTONE M6 — Downloads core.**
- [x] V3.5 Options sheet `17:137`, Trim `17:270`, Playlist `18:160`.
- [x] V3.6 Error mapping (§7.7) with stderr fixtures; error rows and actions.
- [x] V3.7 Downloads acceptance §7.8; extend the PowerShell smoke; swap the landing downloads visual to a real screenshot.
- [x] **MILESTONE M7 — Downloads complete.**

### Phase V4 — Notes · Tack
- [x] V4.1 Notes store, local-only mode, NoteCard + tray Notes view (`13:242`).
- [x] V4.2 Fake Tack server for tests (§8.8), then the Tack client: status/login/recovery-confirm/workspace-switch/logout, Credential Manager session, error → `SyncState`.
- [x] V4.3 Sync loop (§8.4): mirror/outbox/cursor, batching, paging, conflicts; fractional rank port with tests.
- [x] V4.4 Connect flow (`19:5`, `19:102`) and settings section, tested end to end against the fake Tack.
- [x] **MILESTONE M8 — Tack sync.**
- [x] V4.5 Editor (`19:182`), conflict sheet (`19:301`), sync state UI (`19:346`).
- [x] V4.6 Quick capture (island Notes tab, Ctrl+Alt+N) with ported Tack parsing.
- [x] V4.7 Sticky windows (`14:531`) with persistence per card per monitor.
- [x] V4.8 Notes acceptance §8.8 against the fake Tack (the real local Tack suite is optional); swap the landing notes visual to a real screenshot.
- [x] V4.9 Links and bookmarks (§8.9): Save link (clipboard row `45:568`, drop, Ctrl+Alt+N), Links filter (`45:452`), Import bookmarks (`45:362`) from Chromium JSON, Firefox places copy and HTML; acceptance in §8.9.
- [x] **MILESTONE M9 — Notes complete.**

### Phase V5 — Modules, file tools and pins
- [x] V5.1 Clipboard island tab.
- [x] V5.2 Shelf (+ drag out).
- [x] V5.3 Now playing (GSMTC) + scroll-volume + middle-click.
- [x] V5.4 Focus timer (+ Tack card link).
- [x] V5.5 Mic/camera dot.
- [x] V5.6 Battery/charging.
- [x] V5.7 Tool registry, presets, job runner (cancel/retry/quit warning, never-overwrite naming, date copy), result card with Reveal/Undo (`33:528`), Search everything (`34:777`) including pins and links; `cargo deny` licence rules; BtbN ffmpeg sidecar swap.
- [x] V5.8 Files tab (`10:249`): Shelf + Pins, pin peek (`43:755`), IFileOperation moves with the `file_ops` journal and Moved pill (`33:518`), drop target `Over=Pin` (`43:692`), Move to… on Shelf actions (`34:897`) and the download-done peek (`33:580`).
- [x] V5.9 Media tools: Fit under N MB (`45:282`) with encoder probe and retry loop, To MP4, trim, extract audio, To GIF, metadata strip; Tool running pill (`33:535`).
- [x] V5.10 Image and document tools: HEIC → JPG via WIC with the Store prompt, convert / Make smaller (`36:410`), PDF basics, text and QR from image files; drop suggestions per file type.
- [x] V5.11 Context: clipboard classifier and first row (`45:568`) with privacy formats, text tools menu (`36:505`, `36:539`), act on selected text (Ctrl+Alt+S), Send To + HKCU verbs with single-instance batching, full-screen silence.
- [x] V5.12 Native tools acceptance (§9b.7).
- [x] **MILESTONE M10 — Modules, file tools and pins.**

### Phase V6 — Modes, tray, settings
- [x] V6.1 Settings window (Mica on 11) with all sections; migrate v0.1 settings.
- [x] V6.2 Mode switch (island+tray / tray only / island only) incl. tray badge + toasts in tray-only.
- [x] V6.3 Tray menu + submenus (add Pins ▸ listing pins 1–9); tray popover redesign for Notes/Clipboard/Files tabs.
- [x] V6.4 Shortcut recorder with conflict detection.
- [ ] **MILESTONE M11 — Modes, tray and settings.**

### Phase V7 — Hardening and wrap-up
- [ ] V7.1 Edge cases (§12) covered by automated tests; anything that cannot be automated goes under `## v2 Not automated`.
- [ ] V7.2 Accessibility, automated: Playwright keyboard-only walk of every surface in the preview, axe scans in light and dark with no serious or critical issues, visible focus rings in screenshots, `aria-label`s on every icon button, reduced-motion variant.
- [ ] V7.3 Performance: idle budget re-measured on the release build; popover webview destroyed after idle.
- [ ] V7.4 Packaging: build unsigned local MSI/NSIS for x64 with all three sidecars (`npm run tauri -- build`), and ARM64 too if the `aarch64-pc-windows-msvc` target is already installed or installs without admin rights. Deep-link registration lives in the bundle config. Do not run signed release builds, install the packages, publish releases or create tags.
- [ ] V7.5 Update `README.md`, `PRIVACY.md` (Tack sync is opt-in, cookies-from-browser is per job), landing copy and visuals, replace or remove `docs/demo/`; final DoD (§13).
- [ ] **MILESTONE M12 — v2 complete.**

---

## 12. Edge cases (must be handled)

- Island: monitor unplugged while expanded; DPI change mid-animation; taskbar on top (Windows 10) or auto-hide; RDP session; Explorer restart (re-create tray icon and re-assert topmost); another always-on-top app at the top centre; screen readers (island content exposed via UI Automation names).
- Hover/drag: drag cancelled outside the band; drop of unsupported payload (show "Can't use this here"); very long titles (truncate with ellipsis, full title in tooltip).
- Fullscreen: borderless windowed games (rect check), PowerPoint presenter mode, video players that only maximise.
- Downloads: clipboard link changes during probe; duplicate link already queued; disk fills mid-download; yt-dlp update while a job runs (finish with the old binary, swap after).
- Tack: base URL with/without trailing slash or `index.html`; HTTP (not HTTPS) URL → refuse with explanation; redirects to the login page; server clock skew (trust server versions, not timestamps); card deleted on the server while open in a sticky (keep draft, offer "Save as new card"); workspace access revoked; 50-mutation limit; records > 3 MB rejected (413) → keep local, show error; guest/read-only workspace → editor read-only.
- Notes: very long checklists (virtualise > 200 items); emoji and RTL text; colour key unknown to this version → render as default.
- Privacy dot: stale ConsentStore entries after crashes; virtual cameras.
- Sleep/resume: timers, sync backoff, cursor watcher restart, GSMTC session re-subscription.
- Files: OneDrive-redirected Desktop/Documents; cloud-only placeholders (never hydrate for previews); moving out of a sync root (confirm with size); cross-volume drops (copy, Shift overrides); name conflicts; files open in other apps; paths over 260 characters with long paths off; a pinned path that no longer exists (greyed, Locate or Remove); network pins that are offline; HEIC with no codec; partially downloaded files (`.crdownload`, `.part`, `.tmp`, size still changing).
- Links: imports of 10,000+ bookmarks (stream, batch, progress, cancel); bookmarklets and `place:` URLs skipped; Firefox database locked (always read a copy); the same link in several folders (one card, union of labels); title fetch timeouts and non-HTML responses.

---

## 13. Definition of Done (v2)

1. The repository is public and the landing is live at `https://tanzir71.github.io/nabbit/`, matching `27:220` / `31:933`, with the "Built in the open" list showing M0–M12 as Done.
2. Every Build Loop box, including every MILESTONE, is checked and pushed to `origin/master`, and none of the repo's workflows ran (every pushed head commit carries `[skip ci]`; no tags, no pull requests, no workflow dispatches). GitHub's own Pages deployments are the only Actions runs.
3. All automated checks are green: `npm run verify`, `npm run verify:site`, `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, the Playwright screenshot and accessibility runs, `windows-acceptance-smoke.ps1` and the v2 smokes.
4. Idle budget on the release build: **0.0% CPU** over 60 s with the island idle and the tray closed; working set recorded and ≤ the V0 figure + 15%.
5. Island (§6.7), downloads (§7.8), notes (§8.8), links (§8.9) and native tools (§9b.7) automated acceptance are green on this machine; no tool ever overwrote an input file and every move was undoable.
6. v0.1 guarantees intact: explicit-click downloads, sensitive clipboard skipping, retention GC, no telemetry.
7. Screenshots of every Figma screen, light and dark, are committed under `progress/v2/`.
8. No password or session secret on disk outside Credential Manager; `PRIVACY.md` updated.
9. Anything that could not be automated is listed under `## v2 Not automated` and does not block Done.

---

## 14. Backlog (do not build in v2.0)

- v2.1 native tools (see `35:234` and the research doc): Downloads watcher with quiet "Convert? Move?" prompts (`notify` + settle check), actions after a download (run a preset, move to a pin), PDF compress / Fit for email and known-password removal (PDFium via `pdfium-render` + qpdf sidecar, both Apache/BSD), password-protected archives (`zip` AES, `sevenz-rust2`; `unrar` extract-only with its licence shown), audio loudness and voice-memo cleanup, subtitle extract/convert/burn-in, hash verify (`sha2`, `blake3`), Explorer-selection hotkey (IShellWindows, only when Explorer is in front), tabs that follow the foreground app.
- v2.1 pins: import desktop `.lnk` shortcuts (`IShellLink::Resolve` with no UI/search/update) and Quick access pins (read-only), opt-in preview-first tidy rules for Desktop and Downloads with one-click revert, recent destinations, a taskbar jump list (`ICustomDestinationList`, links routed through `nabbit://open-pin?id=`), folder sets linked to Tack projects (validate with the user first).
- v2.1 links: dead-link check, duplicate review, export to HTML.
- v2.1 live activities: Tack agent runs (`33:541`), next calendar event from a secret ICS URL (`33:555`), system stats (`33:564`), per-app volume mixer (`33:598`), snippets, log focus timers as Tack time records, Bluetooth battery.
- v2.1: Volume/brightness HUD (opt-in hiding of the native OSD with automatic restore on exit/crash; Core Audio + WMI brightness events); Desktop board widget (`14:532`, optionally a read-only Downloads portal); Tack reminders as Windows toasts.
- Later: Windows 11 top-level context menu + Share target + NPU OCR via one signed sparse package (Windows 10 2004+ only; keep Send To as the fallback); watch-folder rules with revert; scanned PDF → searchable PDF; opt-in selection bubble with app exclusions; optional libheif decoder pack; spring-loaded subfolders on drop; watch folders and bulk rename for downloads; lyrics; game stats strip.
- Optional Tack-side improvement (separate Tack task, not required): a "connected apps" device token so desktop clients don't depend on the 30-day browser session.

---

## 15. Sources

- Atoll (macOS reference): https://github.com/Ebullioscopic/Atoll — README feature list; issues #641/#690/#825/#853 (energy), #374/#836/#877 (multi-monitor), #832/#723 (hover).
- Windows island landscape (Nov 2026): https://notchpixel.com/guides/dynamic-island-for-windows (competitor-written roundup), https://github.com/FlorianButz/DynamicWin, https://fluentflyout.com/, https://github.com/unchihugo/FluentFlyout/pull/1229, https://github.com/soumyamahunt/ModernFlyouts.
- Tauri click-through hit-rect pattern: https://github.com/tauri-apps/tauri/issues/13070; transparent drag-and-drop shelf on Windows: https://dev.to/devrayat000/building-a-transparent-drag-and-drop-shelf-for-windows-with-tauri-the-engineering-war-stories-3c8c; Tauri window API: https://v2.tauri.app/reference/javascript/api/namespacewindow/.
- Widgets Board requires packaged apps: https://learn.microsoft.com/en-us/windows/apps/develop/widgets/widget-provider-manifest.
- ConsentStore mic/camera detection: https://www.windowsforensics.app/en/artifacts/capability-access-manager.
- yt-dlp JavaScript runtime requirement: https://github.com/yt-dlp/yt-dlp/wiki/EJS (and yt-dlp issue #15012).
- Google Keep API is Workspace-admin only: https://developers.google.com/workspace/keep/api/guides.
- Tack: https://github.com/tanzir71/tack (`project-priority/backend/index.php`, `bootstrap.php`, `src/sync.ts`, `src/cards.ts`, `src/capture.ts`).
- tooldeck (registry pattern and tool catalog carried over in §9b): https://github.com/tanzir71/tooldeck (`TOOLDECK_CODEX_HANDOFF.md` §15–§16, `src-tauri/src/registry.rs`).
- Native tools research (Nov 2026): Project doc `claude/nabbit-native-tools-research.md` (ranked tools, browser limits, PowerToys/Windows overlap, licences, Pins and context sources) plus the folder-shortcut research shown in the Nabbit project chat.
- Competitor features carried over: NotchX (command palette, OCR, Word↔PDF, snippets), NotchPixel (snip, coding-agent status), V-Notch (search launcher), Isle Notch and FluentFlyout (per-app volume) — from the competitor research summarised on Figma `01 Brief`.
- GitHub Pages deploys always run as a GitHub Actions workflow run, including branch publishing: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site; skipping push-triggered workflows with `[skip ci]`: https://docs.github.com/en/actions/managing-workflow-runs/skipping-workflow-runs.
