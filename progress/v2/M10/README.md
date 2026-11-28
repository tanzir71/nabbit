# M10 — Modules, file tools and pins

## V5.1 — Clipboard island tab

The always-dark island Clipboard tab reuses the v0.1 history and fuzzy search. It provides All/Text/Links/Images/Files/Pinned, persisted query/filter/list scroll, pin/delete, arrow selection, 1–9 pick/copy, Ctrl+F, Ctrl+C and Enter paste. Link-row Nab opens explicit review; the V4.9 Save/Clean/Open/video context row remains. Clipboard changes and retention GC push updates across surfaces.

Paste restores the original external app only through the current focus lease. Missing/stale destinations, denied activation or input failure return copied-only and keep the panel open. A typed file record copies its path text. The existing watcher/classifier is unchanged: new image/file payload capture belongs to later work. Image records can be filtered/pinned and show a bounded raster data preview when available; unsupported image copying is rejected before writes. Stored local/remote preview paths are never opened.

Authoritative evidence:

- [Receipt and exact Git source/artifact pins](v51-acceptance.json), [requirements](v51-requirements.json), [checks and original log archives](v51-checks.json).
- [11 browser-to-Rust checks](v51-delivery-flow.json): actual Clipboard UI and typed API through a test-only forwarding seam into production SQLite and the shared pick core, with recording copy/focus/paste providers.
- [Three owned native checks and capture](v51-native-delivery-scene.json): current custom-protocol release, real Tauri read/add/pin/event IPC, isolated SQLite/WebView2 and a repeat-exact DPR2 image. The Windows clipboard/input adapter is never invoked in automation.
- [40 visual captures](v51-clipboard-e3-screenshots.json): ten states, light/dark and1x/1.5x, exact repeats, bundled Geist and default axe with zero violations/incompletes. [Figma comparison](v51-figma-reference.json) and [15 fresh original SVG pins](v51-assets.json). [Baseline](v51-clipboard-e3-clipboard-all-light@1x.png), [copied-link context](v51-clipboard-e3-clipboard-context-dark@1.5x.png), [native](v51-native-delivery-clipboard@2x.png).
- [Independent PNG decode/size audit](v51-png-audit.json): **41 PNGs**, all ≤300,000 bytes (largest **100,111**). [Entry graph](v51-entry-bundles.json): initial island JS **91,407/120,000 gzip bytes**; no new dependency or sidecar.
- [Failure-harness proof](v51-delivery-failure-check.json), [failed/superseded attempts](v51-earlier-attempts.json) and retained raw deterministic gzip logs. No accessibility exclusions or secret-scan waivers were added.

`npm run verify` passes **436 tests/38 files**; fmt/default+spike all-target Clippy and **257 serial Rust tests** pass, with three documented opt-in ignores. No real clipboard/selection/global keys, user browser profile, hosted Tack/account, OS display/theme setting, installer or signing is used. Prior platform/focus/performance limits remain. See [privacy](../../../PRIVACY.md).

V5.1 is a local task commit on main with skip-ci. No PR or task push; publication waits for M10. V5.2 Shelf is next.


## V5.2 — Shelf and drag out

The Files island now has a persistent, path-only Shelf with canonical dedupe and input order. Drop files to add them; select cards for Copy paths/Remove or drag a selected group into another app. Clear removes Shelf references. Missing files stay grey and removable. Originals are never rewritten, moved or deleted by Shelf operations. Supported image previews are bounded and live only in memory.

Ctrl+A selects all; Ctrl+C copies selected/all path text; Delete removes selected references. State is remembered, and pushed changes/focus refresh replace polling. Native drag uses the validated current path list in copy mode. The source view stays alive through held input and releases after cancel/drop; hidden/fullscreen policy still wins.

Authoritative evidence:

- [Receipt and exact Git source/artifact pins](v52-acceptance.json), [requirements](v52-requirements.json), [checks and original log archives](v52-checks.json).
- [Eight browser-to-Rust checks](v52-delivery-flow.json): the actual file-drop router, production Shelf SQLite, canonical dedupe, bounded preview, path copying, selected drag plan, missing-file recovery, keyboard flow and Clear. Clipboard/drag providers record intent; no interactive drag or OS clipboard write.
- [Four native checks/two captures](v52-native-e1-scene.json): current custom-protocol release, real Tauri drop/add/remove/clear, consumed staging draft, local metadata/preview and exact path/drag-plan IPC. All three available originals remain byte-identical. [Native Shelf](v52-native-e1-shelf@2x.png) and [missing-file state](v52-native-e1-missing@2x.png).
- [28 final visual captures](v52-shelf-e2-screenshots.json): seven states in light/dark at1x/1.5x, always-dark island, exact repeats, bundled Geist, default axe zero violations/incompletes and27 visible original SVG slots measured. [Figma comparison](v52-figma-reference.json), [fresh exports](v52-assets.json), [normal](v52-shelf-e2-shelf-files-light@1x.png), [selection](v52-shelf-e2-shelf-selected-dark@1.5x.png).
- [Dependency/source audit](v52-dependencies.json): drag Rust2.1.1/JS2.1.0, the published archive checksum and every vendor file hash. The two Windows Shell data-object unwraps now return the existing failed-drag error; original MIT/Apache licences remain. No new sidecar. [Patch](../../../src-tauri/vendor/drag/NABBIT_PATCH.md).
- [Independent PNG audit](v52-png-audit.json): all **99 retained M10 PNGs** decode and stay ≤300,000 bytes (largest **100,111**). [Entry graph](v52-entry-bundles.json): initial island JS **93,039/120,000 gzip bytes**.
- [Failure-harness proof](v52-delivery-failure-check.json) and [failed/superseded attempts](v52-earlier-attempts.json). Original V5.1 evidence is unchanged; only the named V5.2 reports establish current acceptance.

`npm run verify` passes **446 tests/40 files**; fmt/default+spike all-target Clippy and **264 serial Rust tests** pass, with three documented opt-in ignores. No user file/profile/account, hosted Tack, real clipboard/selection/global keys, interactive OS drag, external receiving app, OS setting, installer or signing is used. Prior platform/focus/performance limits remain. The drag plugin compiles; recording providers establish intended payloads, not an observed interactive Windows drop.

This pass matches the Shelf/selection regions. Permanent Pins and the complete Files layout are V5.8; registry-driven conversion and Move-to actions are V5.7–V5.10. Supported Copy/Remove/Deselect controls work now; no fake pins or inactive conversion controls are presented. See [privacy](../../../PRIVACY.md).

V5.2 is a local skip-ci task commit directly on main. No PR or push; publication waits for M10. V5.3 Now playing is next.

## V5.3 — Now playing and pill gestures

Now playing discovers Windows GSMTC sessions through a subscribed `MediaProvider`, caches 96 px stream artwork in memory and pushes typed state to the island. Session chips, previous/play-pause/next, supported seeking, mute and system volume are wired. Paused sessions remain selectable; absent timelines are omitted. Scroll changes volume by two percentage points, or one with Shift; middle-click toggles the selected session. Native compact hosts and WebViews share the production media service.

Authoritative evidence:

- [Receipt and exact Git pins](v53-acceptance.json), [requirements/API boundaries](v53-requirements.json), [checks and original logs](v53-checks.json).
- [Nine browser-to-Rust checks](v53-flow-e-flow.json): production validation/arbitration, session changes/removal, capability gates, seek, volume/mute and middle-click through recorded hardware. 23 pushed events; idle causes no extra IPC.
- [Five native checks/three captures](v53-native-c-scene.json): actual release Tauri IPC, native rounded-pill/hidden gates, half-detent accumulation, exact steps, middle-click and chips. The smoke checks embedded JS and stylesheet names. [Native compact](v53-native-c-compact@1x.png), [expanded Media](v53-native-c-media@2x.png), [no timeline](v53-native-c-no-timeline@2x.png).
- [28 final visual captures](v53-media-f-screenshots.json): seven states, light/dark at1x/1.5x, always-dark island, exact repeats, Geist, zero default axe violations/incompletes and17 original SVG slots at intrinsic dimensions. [Figma comparison](v53-design.json), [expanded](v53-media-f-media-expanded-light@1x.png), [peek](v53-media-f-media-peek-dark@1.5x.png), [paused](v53-media-f-media-paused-dark@1x.png).
- [Independent PNG audit](v53-png-audit.json): all161 retained M10 PNGs decode and remain <=300000 bytes (largest100111). [Entry graph](v53-entry-bundles.json):95636/120000 initial island gzip bytes.
- [Failure-harness proof](v53-delivery-failure-check.json) and [retained attempts/raw archives](v53-earlier-attempts.json). `v53-media-e` and `v53-native-b` are preserved interim views; only the named final reports above establish current acceptance. Earlier V5.1/V5.2 evidence is unchanged.

`npm run verify` passes453 tests/42 files; fmt, default+spike all-target Clippy and270 serial Rust tests pass, with three existing opt-in ignores. No new sidecar or crate version. Identical generated motion CSS is left untouched to avoid unnecessary Windows writes; generated bytes are unchanged.

All acceptance playback/audio actions use recorded hardware. Live GSMTC/Core Audio callbacks, actual output-device switching, real player acknowledgement and an OS sleep cycle are not exercised under section0.2. No user files/profile/account, hosted Tack, real clipboard/global input, OS setting, installer or signing is used; previous platform/focus/performance limits remain. See [privacy](../../../PRIVACY.md).

V5.3 is a local skip-ci task commit directly on main. No PR or push; publication waits for M10. V5.4 Focus timer is next.


## V5.4 — Focus timer and scoped card links

Focus has25/5,50/10,90 and custom presets, explicit focus/break rounds, pause/resume/stop and Ctrl+Alt+T toggle. UTC deadlines and exact paused milliseconds persist with local session history. Sleep/restart/clock changes recompute remaining time and finish once at the original deadline. The Rust worker pushes visible1Hz updates; hidden/idle timers have no renderer clock or read polling.

Link a current Notes/Tack card, display its actual reference/title and open/unlink it through the picker. Scope changes hide old metadata while the timer continues. Local cards are supported without inventing a Tack reference. Timer actions leave card JSON and the Tack outbox untouched. Time logging is disabled and labeled v2.1, as required by the handoff. Completed alerts obey the existing fullscreen-alert preference.

Authoritative evidence:

- [Receipt and exact staged Git pins](v54-acceptance.json), [requirements/story](v54-requirements.json), [checks and original logs](v54-checks.json).
- [Nine browser-to-Rust checks](v54-flow-c-flow.json): actual timer UI/API, production worker/SQLite/scoped card lookup/arbitration,30 pushed events and no idle read polling.
- [Five native checks/four captures](v54-native-a-scene.json): current custom-protocol executable and matching embedded entry/stylesheets, actual Tauri commands, shortcut dispatch, pause/resume, owned-process restart, native wake and fullscreen queue/exception. [Native Focus](v54-native-a-focus@2x.png), [paused](v54-native-a-paused@2x.png), [compact](v54-native-a-compact@1x.png), [completion](v54-native-a-ended@1x.png).
- [40 final visual captures](v54-timer-h-screenshots.json): ten states in light/dark at1x/1.5x, always-dark island, exact repeat hashes, Geist, default axe zero violations/incompletes and18 original SVG slots at intrinsic dimensions. [Figma comparison](v54-design.json), [expanded](v54-timer-h-timer-running-light@1x.png), [peek](v54-timer-h-timer-peek-dark@1.5x.png), [custom](v54-timer-h-timer-custom-light@1x.png).
- [Independent PNG audit](v54-png-audit.json): all205 retained M10 PNGs decode and stay <=300000 bytes (largest100111). [Entry graph](v54-entry-bundles.json):100675/120000 initial island gzip bytes. No new dependency or sidecar.
- [Failure-harness proof](v54-delivery-failure-check.json) and [failed/superseded logs with exact original archives](v54-earlier-attempts.json). Earlier V5.1–V5.3 evidence remains unchanged. The initial Link→Start stale-generation race was fixed in the production hook and regression-tested; no accessibility rule was excluded.

`npm run verify` passes460 tests/43 files; final lint, fmt, default+spike all-target Clippy and280 serial Rust tests pass, with three existing opt-in ignores. Tests cover both DST transitions, rollback, hidden scheduling, covered native hosts, scoped links, generation conflicts and completion-write failure/retry. A2px background inset encloses Geist Mono font bounds without moving visible text. Fractional-root original SVG edges allow only Chromium's2/64px geometry quantization; integer-root exports remain exact.

Clock/power/fullscreen facts are injected. No real OS sleep/timezone/clock/global-key delivery, user profile/account, hosted Tack, clipboard/audio, OS setting, installer or signing is used. The native result proves the production handler/service/SQLite/render path, with prior platform/focus/performance limits retained. See [privacy](../../../PRIVACY.md).

V5.4 is a local skip-ci task commit directly on main. No PR or task push; publication waits for M10. V5.5 Mic/camera dot is next.


## V5.5 — Mic/camera indicator

The island follows Windows ConsentStore activity through a subscribed PrivacyProvider. It walks microphone/webcam records, including NonPackaged desktop paths and packaged/nested entries, then checks an exact live executable/package identity and creation time. Process-exit waits remove crash-stale zero-stop entries without polling. The worker refreshes on resume and releases registry/process registrations on stop. Only current app names and capability state reach the UI; no device is opened and no usage history is stored.

The compact pill keeps Figma's232x32 capsule,16px mic,12/16 label and8px original amber dot. Camera use supplies signal lime on the same original silhouette; both capabilities have an accessible label. Long app names use the available width with a full tooltip. Read-only Peek lists each capability separately. Existing priority, disabled-activity and fullscreen-silence policy remains authoritative.

Authoritative evidence:

- [Receipt and exact Git pins](v55-acceptance.json), [requirements/story and limits](v55-requirements.json), [checks and original logs](v55-checks.json).
- Nine new Rust tests cover packaged/NonPackaged/Teams/virtual-camera snapshots, crash/stopped/relaunched processes, full identity/creation time, timestamp types, bounded names, cache-only reads and arbitration. Disposable Nabbit HKCU keys and an owned child exercise real notification/re-arm/new subtree/deletion, idle read count, resume, process exit and PID-identity validation.
- [Five native checks/four final captures](v55-native-b-scene.json): current custom-protocol executable and matching embedded JS/styles, actual Tauri provider/service/arbitration, exact amber/lime pixels, pushed Peek,100 cache reads, stale clearing, error recovery, disabled privacy and zero-alpha hidden frame. [Mic](v55-native-b-mic@1x.png), [camera](v55-native-b-camera@1x.png), [both](v55-native-b-both@1x.png), [Peek](v55-native-b-peek@2x.png).
- [28 final visual captures](v55-privacy-d-screenshots.json): mic,camera,both,long,split,peek,off in light/dark at1x/1.5x, always-dark island, exact repeats, Geist and default axe zero violations/incompletes. [Fresh Figma comparison and independent color/alpha audits](v55-design.json), [mic](v55-privacy-d-privacy-mic-light@1x.png), [camera](v55-privacy-d-privacy-camera-dark@1.5x.png), [long title](v55-privacy-d-privacy-long-dark@1x.png). Native232x32 body bounds use alpha>=128 to separate the capsule from its original32%-opacity shadow; full shadow bounds and untouched pixels are retained.
- [Independent PNG audit](v55-png-audit.json): all268 retained M10 PNGs decode and stay <=300000 bytes (largest100111). [Entry graph](v55-entry-bundles.json):100889/120000 initial island gzip bytes. Existing Windows-sys0.59 adds Appx/ToolHelp feature gates; no new package/version, lockfile change or sidecar.
- [Failure-harness proof](v55-delivery-failure-check.json) and [failed/superseded attempts/original archives](v55-earlier-attempts.json). Native-a's three pre-timeout captures and interim privacy-c remain; only the named final reports establish acceptance. No accessibility exclusion, lint allowance or secret-scan waiver was added.

`npm run verify` passes463 tests/44 files; final lint, fmt, default+spike all-target Clippy and289 serial Rust tests pass, with three existing opt-in ignores. The first Peek smoke reached its normal leave deadline; the final smoke holds only its fixture cursor inside the owned Peek. No production policy was relaxed.

No real ConsentStore, microphone/camera, call, user app/profile/account, hosted Tack, clipboard/global keys, OS setting/clock/power, installer or signing is exercised. Actual registry/process APIs use owned disposable resources; native app facts are recorded fixtures. Detection is best effort; absence does not prove hardware is unused. Prior platform/focus/performance limits remain. See [privacy](../../../PRIVACY.md).

V5.5 is a local skip-ci task commit directly on main. No PR or task push; publication waits for M10. V5.6 Battery/charging is next.


## V5.6 — Transient battery and charging notifications

Battery status now comes from GetSystemPowerStatus in response to registered AC/DC and percentage notifications, legacy status changes and resume. The existing native control HWND owns/revokes both registrations. Current charge/source/charging state stays in memory; snapshot reads never sample the provider. Unknown percentages/source and no-battery/error states are preserved honestly.

Startup/recovery establishes a quiet baseline. Confirmed plug/unplug or charging transitions and changed low percentages<=20 when AC is not known online notify briefly. Healthy/known-AC charging percentage drift stays quiet. Charging, Plugged in, On battery, Battery low and Battery labels reflect known facts; an unknown level uses an em dash and unavailable tooltip. Every power activity expires4s from its change, including while hidden/queued/disabled. Duplicates never reset or revive it. There is no permanent battery widget or JavaScript polling loop.

Authoritative evidence:

- [Receipt and exact Git pins](v56-acceptance.json), [requirements/story and limits](v56-requirements.json), [checks and original logs](v56-checks.json).
- Nine new power tests cover raw status sentinels, quiet baseline, source/charging transitions, inclusive20%, cache/duplicate behavior,4s scheduling, hidden queues/disabled policy, failure/absence/recovery, message filtering and actual registration/unregistration on an owned hidden HWND.
- [Five native checks/four final captures](v56-native-b-scene.json): current custom-protocol executable and matching embedded JS/styles, actual Tauri provider/service/shared native notification handler,100 cache reads, charging/healthy-unplug/low state, actual automatic visible/hidden expiry, errors/no battery/unknown levels and pushed Peek. [Charging](v56-native-b-charging@1x.png), [unplugged](v56-native-b-unplugged@1x.png), [20% warning](v56-native-b-low@1x.png), [Peek](v56-native-b-peek@2x.png). The normal4s deadline is never frozen or extended.
- [32 final visual captures](v56-power-a-screenshots.json): charging,unplugged,low20,full,unknown,peek,idle,split in light/dark at1x/1.5x, always-dark island, exact repeats, Geist and default axe zero violations/incompletes. [Fresh Figma export/comparison/native geometry](v56-design.json), [charging](v56-power-a-power-charging-light@1x.png), [low](v56-power-a-power-low-dark@1.5x.png), [unknown](v56-power-a-power-unknown-dark@1x.png). The original16px asset/232x32 capsule/type/gaps are unchanged; native body alpha>=128 separates the capsule from its original shadow, which remains intact.
- [Independent PNG audit](v56-png-audit.json): all307 retained M10 PNGs decode and stay <=300000 bytes (largest100111). [Entry graph](v56-entry-bundles.json):101028/120000 initial island gzip bytes. Existing Windows-sys0.59 enables Win32_System_Power only; no new package/version, Cargo.lock change or sidecar.
- [Failure-harness proof](v56-delivery-failure-check.json) and [failed/superseded logs/original archives](v56-earlier-attempts.json). Native-a's three pre-Peek captures remain; the final selector is scoped to Battery status to distinguish the normal outgoing compact layer. Earlier V5.1–V5.5 evidence is unchanged. No accessibility/lint exclusion, secret-scan waiver or production deadline relaxation was added.

`npm run verify` passes466 tests/45 files; final lint, fmt, default+spike all-target Clippy and298 serial Rust tests pass, with three existing opt-in ignores. The previous permanent fixture behavior is replaced with timed change notifications; explicit PowerRemoved also handles recovery/absence/errors.

No actual AC/battery/sleep or OS power-setting change, user profile/account, hosted Tack, real clipboard/global input, installer or signing is used. Production status sampling compiles; acceptance uses raw fixtures, an owned registration HWND and an isolated native release. Prior platform/focus/performance limits remain. See [privacy](../../../PRIVACY.md).

V5.6 is a local skip-ci task commit directly on main. No PR or task push; publication waits for M10. V5.7 Tool registry/presets/job runner/Search/licences/ffmpeg swap is next.


## V5.7 — Tool registry, jobs, Search and licences

Two supported base tools, To JPG and To MP4, now run through one metadata registry and durable native queue. Search and selected Shelf actions open explicit review; choosing a file never starts conversion. Settings → Files stores validated result-named share limits. Jobs retain cancel/failure history, retry with the original preset snapshot and warn on active quit. Output staging/publication never replaces a source or collision, copies dates when supported and journals identity/hash for crash recovery. Results and queue show actual sizes/progress with Reveal and guarded Recycle Bin Undo.

Search includes current accessible active notes, saved links/bookmarks, pins, Shelf, clipboard and registry tools. It subscribes before reads and guards generations/workspace/IME navigation. Explicit file review and result-to-queue navigation clear remembered Search. Full Pins/moves/drop-to-file, media/image catalog and context/Send To integrations remain their separate V5.8–V5.11 tasks.

Authoritative evidence:

- [Receipt and exact staged Git pins](v57-acceptance.json), [requirements and complete story](v57-requirements.json), [checks and original logs](v57-checks.json).
- [36 tool/result/Search/queue captures](v57-tools-final-screenshots.json) and [eight Files/offline licence captures](v57-settings-final-screenshots.json): light/dark at1x/1.5x, exact repeats, default axe zero violations/incompletes. [Fresh Figma assets](v57-figma-assets.json), [comparison and capture method](v57-design.json), [Search](v57-tools-final-tools-search-pdf-dark@1x.png), [review](v57-tools-final-tools-tool-sheet-dark@1x.png), [presets](v57-settings-final-tools-settings-presets-light@1x.png).28 original visible SVG slots;16 exports byte-exact and one differs only in generated clip ID.
- [Four native checks/four captures](v57-native-a-scene.json): actual isolated production Tauri/SQLite conversions, numbered collision, scoped notes/link/pin/Shelf Search, explicit review, result-to-queue, injected guarded Reveal/Undo and durable restart. [Result](v57-native-a-result@1x.png), [Peek](v57-native-a-peek@2x.png), [Search](v57-native-a-search@2x.png), [queue](v57-native-a-queue@2x.png). All59 embedded manifest assets and the complete1049-notice licence payload match current build bytes/semantic hash.
- [Sidecar/source/protocol audit](v57-sidecars.json): both pinned BtbN GPL x64/ARM64 archives/executables and original configure lines, exact PE machines, only ffmpeg.exe installed. x64 exposes libx264, libwebp/libwebp_anim, h264_mf/NVENC/QSV/AMF; libass enabled in both configure lines. Actual hardware encoding is not claimed. Owned ffmpeg test exercises real child cancellation/retry/progress and verified offline repair of an old app-data binary. Local-only conversion rejects an owned playlist without any HTTP request; permissive loopback control proves the fixture can request a local segment.
- [Negative licence policy fixtures](v57-license-negatives.json): GPL/AGPL/LGPL crates and even permissively declared ffmpeg-next fail; actual locked/offline core passes cargo-deny0.22.2. Licence UI lazily serves original GPL, source offer, both configure lines and1049 Rust/JS/font notices.57 packages lack published licence text files; retain source/declaration metadata without invented text.
- [Independent PNG audit](v57-png-audit.json): all489 retained M10 PNGs decode and stay<=300000 bytes (largest138007). [Entry graph](v57-entry-bundles.json):101395/120000 initial island gzip bytes. [Failure-harness proof](v57-delivery-failure-check.json), [retained attempts/diagnostics/original archives](v57-earlier-attempts.json).

`npm run verify` passes477 tests/47 files; final lint, fmt, default+spike all-target Clippy and306 serial Rust tests pass, with four opt-in ignores. The owned real-ffmpeg test passes separately. The unchanged privacy registry fixture transiently aborted once; isolated and full direct reruns and final e/f suites pass with its failure retained. Capture raster mismatches retained unchanged visible DOM; final CDP transparency/explicit device metrics repeat exactly without product-state/time/CSS freezes. The older Clear history button contrast3.88 is recorded outside new Files/licence capture scope; no default axe rule was disabled.

No real clipboard/selection/global input, user files/profile/account, hosted Tack, Explorer/Recycle Bin, OS setting, installer or signing is used. Picker/quit/Shell production calls compile; acceptance uses guarded owned providers. ARM64 binaries are inspected, not run; Windows10/macOS/Linux, GPU availability and prior platform/focus/performance limits remain unclaimed. No task PR or push; commit directly to main with skip-ci. V5.8 Files/Pins/IFileOperation moves/drop-to-file is next; publication waits for M10.


## V5.8 — Files, Pins and journalled moves

The Files island keeps the Shelf above a permanent mixed file/folder pin grid. Eight pins are visible in two rows; search finds the rest and Alt+1–9 opens assigned slots while expanded. Open/Reveal/Copy path/Open With, installed Terminal/VS Code, edit/remove and outgoing drag use validated targets. Removing a pin changes only its reference.

Folder hover opens a six-item metadata peek after350ms; click holds it. Local nonrecursive notify watches are scoped to a visible owner/token. Late opens cannot replace a newer watch; collapse, hidden/fullscreen policy, destruction and shutdown revoke natively. Network folders refresh on open and never get a watch.

Drop files on a folder or choose Move to from Shelf/finished download. Same-volume operations move and other volumes copy; Shift forces move, Ctrl forces copy and wins together/over a pin's Always move. Only cloud-root move-out (logical size), network destination and more than50 files ask for extra confirmation. Recent3 extension/site destinations precede pins and the native picker. Download actions enter expanded review so the expiring result cannot close the form; selecting a tool does not run it.

Production uses IFileOperation with ADDUNDORECORD/NOMINIMIZEBOX and actual-result progress callbacks on a shared sleeping message-pumped Shell STA. The file_ops journal guards metadata, result identity/primary-stream hash, original-path vacancy and duplicate execution. It checkpoints partial Undo and updates specific Shelf/pin/download/tool references transactionally. Existing targets get native CopyFileW backups before conflict resolution, preserving supported dates, attributes and alternate streams. **Backups and journal records are currently retained, including unused Keep both/skip backups.** They contain full local file content; no cleanup or adversarial ADS-edit integrity guarantee is claimed. The native eight-second Moved/Copied pill, Peek and history share Undo after restart.

KFM-aware known folders, verbatim Rust I/O, clear long-path-disabled errors and the actual longPathAware manifest cover path policy. Cloud-only previews stay inside metadata/cache/icon paths; the content-read closure is guarded. Own-process OLE targets preserve disk paths, Unicode text/URLs, physical coordinates/modifiers, drag leases and stale-window safety. No Explorer window is injected into or automated.

Authoritative evidence:

- [Receipt and exact staged Git pins](v58-acceptance.json), [requirements](v58-requirements.json), [12 passing gates/raw archives](v58-checks.json), [dependency checksums/notices](v58-dependencies.json) and [four negative licence fixtures](v58-license-negatives.json).
- [Six native release checks/six captures](v58-native-i-scene.json): real Tauri/SQLite Pins, six-row notify refresh/cleanup, actual owned Shell IDataObject callbacks and Ctrl hover, guarded pin copy, PID/class-verified application-only native compact Undo, Shelf numbered move, actual eight-second expiry, completed tool/download reference updates, expanded review beyond expiry and restart Undo. Four WebView2 DPR2 pairs repeat exactly; two native DirectComposition frames are separate. All64 embedded manifest entry/CSS hashes and the full1056-notice payload match the final executable. [Native Files](v58-native-i-files@2x.png), [pin peek](v58-native-i-pin-peek@2x.png), [Ctrl copy](v58-native-i-drop-copy@2x.png), [Moved](v58-native-i-moved-compact@1x.png).
- A separate [owned actual IFileOperation test](v58-shell-native-a-log.txt) moves and Undoes unique no-conflict temporary files through the real Shell adapter after reopening the service. Ordinary native acceptance transfers/conflicts/recycle use canonical-owned providers; copied outputs are quarantined without the real Recycle Bin. No real conflict/picker/Open With/quit dialog is driven.
- [56 final visual captures](v58-files-final3-screenshots.json):14 states, light/dark at1x/1.5x, exact repeats, bundled glyphs and44 original visible SVG slots measured. All default axe rules pass: whole document in ordinary scenes, captured pin-popup component over the separately verified expanded frame. [Figma comparison](v58-design.json), [47 byte-exact fresh exports](v58-figma-assets.json), [full pins](v58-files-final3-files-files-pins-dark@1.5x.png), [pin peek](v58-files-final3-files-pin-peek-light@1x.png), [download done](v58-files-final3-files-download-done-dark@1x.png).
- [Independent PE resource audit](v58-manifest-canonical.json) extracts RT_MANIFEST1 as data, confirming longPathAware=true and Common-Controls6. [Independent PNG audit](v58-png-audit.json): all **643 retained M10 PNGs** decode <=300000 bytes (largest **138007**). [Entry graph](v58-entry-bundles.json): island **102770/120000 gzip bytes**.
- [Interim/failure records](v58-earlier-attempts.json) retain originals and their deterministic gzip archives. Metadata-fixture RFC3339 errors, a native lease bug, review-expiry regression, accessibility/geometry findings and native raster settling are resolved. One initial repeat failure retained hashes/log only; the improved native harness writes both failed pair images and DOM diagnostics. The final [failure-harness proof](v58-delivery-final-failure-check.json) confirms runtime/network rejection and cleanup. No accessibility exclusion or new secret waiver.

`npm run verify` passes **487 tests/48 files**. fmt, default/spike strict Clippy and **329 serial Rust tests** pass; five opt-in ignores include the real owned Shell test, which also passes separately. Pinned notify8.2.0 adds seven locked packages and generated notices total1056. The earlier ffmpeg pins are unchanged.

Real user files/profiles/accounts, clipboard/global input/cursor changes, hosted Tack, cloud/network paths/placeholder hydration, Explorer/Recycle Bin/dialog automation, OS settings, Windows10/ARM64 execution/macOS/Linux, installers/signing and new performance measurements are outside this acceptance scope. See [privacy](../../../PRIVACY.md). V5.8 is a local main skip-ci task commit with no PR or push. V5.9 is next; publication waits for M10.


## V5.9 — Size targets and quick media jobs

- [Acceptance/exact staged pins](v59-acceptance.json), [requirements](v59-requirements.json), [passing gates/original logs](v59-checks.json), [unchanged dependencies/engine](v59-dependencies.json).
- [12 real size targets and six quick jobs](v59-owned-media.json):1080p testsrc2+sine10/60/180s under20/25MB in Exact and working NVENC, original hashes per attempt, several Fast second tries. Verification-only ffprobe checks codecs, duration±0.1s, GIF caps and removed tags. [Five edge cases](v59-owned-edges.json) assert dates, clash numbering, MP4 fallback, audio Fit, Pillow-decoded WebP and restart.
- [Four native checks/four captures](v59-native-d-scene.json): Search review/estimate, explicit Run/live native pill/cancel/retry, Shelf trim, guarded owned-output Undo and restart. All68 embedded entry/CSS hashes and full1056 notices match. Three static WebView2 DPR2 pairs repeat exactly; the live native frame is separate. [Fit](v59-native-d-fit-review@2x.png), [fully visible trim fields](v59-native-d-local-trim@2x.png), [live native](v59-native-d-running-native@1x.png).
- [60 review/running captures](v59-media-final5-screenshots.json) and [eight drop/Shelf captures](v59-entry-c-screenshots.json): light/dark1x/1.5x, island always dark, exact repeats, all default axe rules with zero violations/incompletes. [Figma comparison](v59-design.json), [five fresh export comparisons](v59-figma-assets.json). Default Fit440x533, original glyphs/30px chips/34x20 toggles/32px primary; running300x32.
- [Independent PNG audit](v59-png-audit.json): all1042 retained M10 PNGs decode <=300000 bytes, largest138270. [Entry graph](v59-entry-bundles-final.json):102783/120000 initial island gzip bytes. [Actual PE manifest](v59-manifest-final.json) retains longPathAware/Common-Controls6. [Negative harness proof](v59-delivery-failure-check.json) rejects runtime/network faults.
- [Earlier/superseded findings and original archives](v59-earlier-attempts.json) retain AAC pass-log, form/encoding, contrast/asset-path, border raster, native paint/closed-page and loaded-trim sizing findings. Final sizing includes scroll content and DOM changes. No new secret waiver, disabled axe rule, user file/profile/account, real clipboard/global input/cursor, OS setting, real Shell/Recycle Bin dialog, installer/signing, PR or task push. V5.10/V5.11/V5.12 remain separate.


## V5.10 — Image and document tools

- [Acceptance/exact staged pins](v510-acceptance.json), [requirements](v510-requirements.json), [passing gates and original logs](v510-checks.json), [dependencies/HEIC probe](v510-dependencies.json).
- WIC HEIC; convert, resize, Make smaller and shared image size presets; EXIF/capture-date/RGB-profile retention; lossless location/camera removal with a result-card review chip. Reorderable PDF merge, page/range split, images→PDF, Windows software PDF rendering, user-language file OCR and file QR encode/decode.
- [Native checks](v510-native-c-scene.json): 13 jobs, explicit privacy review/Run, measured 1 MB image output, blank OCR/no output, actual PDF/QR/OCR, physical dates, guarded Undo and restart. Read-only Shelf access is proven alongside rejected mutation. All 69 embedded assets and 1148 notices match. [Convert](v510-native-c-convert@2x.png), [image result action](v510-native-c-image-result@2x.png), [privacy review](v510-native-c-privacy-review@2x.png), [PDF](v510-native-c-make-pdf@2x.png).
- [52 exact-repeat browser captures](v510-image-doc-k-screenshots.json) use all default axe rules in light/dark 1x/1.5x with zero violations/incompletes. [Figma comparison](v510-design.json) retains original exported SVG geometry. [PNG audit](v510-png-audit.json): all 1419 retained M10 PNGs fully decode <=300000 bytes, largest 138270. Initial island 102791/120000 gzip.
- [Earlier findings and original archives](v510-earlier-attempts.json) retain partial-grid ffmpeg output, AVIF ICC association, AMD PDF teardown, CSS thumb/data-URL, authorization and stale-build findings. Grid fallback stays disabled; WIC decoded 3992×2992. The explicit WARP renderer exits cleanly. No new secret waiver, disabled axe rule, shipped executable/DLL, PR or task push. V5.11/V5.12 remain separate.


## V5.11 — Clipboard context and Explorer intake

- [Acceptance/exact staged pins](v511-acceptance.json), [requirements](v511-requirements.json), [passing gates/original logs](v511-checks.json), [dependencies](v511-dependencies.json).
- Privacy-first clipboard types/actions, owned image/file history, Unicode text tools and UIA selection; optional complete-format copy transaction; off-by-default Send To/HKCU verbs, fixed300ms Shelf batching, exact preset/all-input review and full-screen silence.
- [Native checks](v511-native-e-scene.json): original/result history, privacy flags/password-manager source, safe image saves/review, file/path actions, real owned UIA Bengali/emoji/password controls, quiet notification states, fake registration writes, batch/preset handoff and restart with no automatic tool jobs. 7 static DPR2 pairs repeat exactly. [Compiled uninstall hooks](v511-installers-e.json) include update guards and MSI cleanup before RemoveFiles; no installer is executed.
- [56 clipboard captures](v511-context-d-screenshots.json) plus [16 integration captures](v511-integration-b-screenshots.json), light/dark1x/1.5x with exact repeats and all default axe rules: zero violations/incompletes. [Figma comparison](v511-design.json), [original glyphs](v511-figma-assets.json), [independent browser raster audit](v511-browser-raster.json).
- [PNG audit](v511-png-audit.json): all 1516 retained M10 PNGs fully decode <=300000 bytes, largest 138270. Initial island102823/120000 gzip. [Actual PE manifest](v511-manifest-b.json) retains longPathAware/Common-Controls6. [Negative harness](v511-delivery-failure-check.json) rejects runtime/network faults.
- [Earlier findings and original archives](v511-earlier-attempts.json) retain API/fixture/contrast/installer findings and the interrupted non-embedded release build. No real clipboard/global input/cursor, OS setting/registration, user profile/account, installer execution, signing, new binary/DLL, secret waiver, PR or task push. V5.12 remains separate.

## V5.12 — Native tools acceptance

- [All eleven acceptance rows](v512-requirements.json), [required checks](v512-checks.json), and [exact staged-blob receipt](v512-acceptance.json).
- [All 24 default preset executions](v512-registry-a-scene.json) plus actual JPEG GPS retention/removal, accepted file/image registry matrix, full-screen guards, independent PDF PNG decode, original hashes/dates and restart: 26 real tool jobs.
- [Owned real media](v512-owned-media.json): 12 size cases (10/60/180 s at 1080p), 20/25 MB, CPU and available GPU, original-source retries and six quick jobs. [Media edges](v512-owned-edges.json), [WIC HEIC/AVIF](v512-heic-avif-a-log.txt), [owned Shell undo](v512-shell-a-log.txt).
- [Native context](v512-native-context-a-scene.json) verifies privacy, hidden owned UIA, batching, exact review presets and quiet states. The Rust suite checks complete synthetic format restoration; [compile-only uninstall hooks](v512-installers-a.json), [actual PE manifest](v512-manifest-final.json). No installer or real registration is executed.
- [Design comparison](v512-design.json). 136 whole-document default-axe captures, light/dark 1x/1.5x, zero violations/incompletes and exact repeats; 11 native static DPR2 pairs. [All M10 PNGs](v512-png-audit.json) fully decode <=300000 bytes. [Earlier attempts and original gzip logs](v512-earlier-attempts.json) remain immutable.
- No real user clipboard/input/cursor/files/profile/account or hosted Tack, OS settings/registration, Store launch, installer execution/signing, new binary/DLL, lock/pin/workflow edit or secret waiver. This task is local on main; M10 publication remains a separate milestone pass.

## M10 publication readiness

All twelve V5 tasks are implemented. [Task audit](m10-task-audit.json) checks 29,877 source/artifact blobs at their original commits and verifies that the current 734 runtime inputs, manifest and executable match V5.12 aggregate acceptance. [Required checks](m10-checks.json), [readiness receipt](m10-readiness.json), and [all PNGs](m10-png-audit.json) preserve the delivery boundary.

The landing changes only milestone metadata, M10 Done/link and M11 In progress. [Eight status captures](m10-status-checks.json) repeat exactly, preserve default page geometry and retain original icon/font geometry. [Accessibility/keyboard results](m10-final-accessibility.json) include eight contexts and 24 default axe scans; indeterminate gradient contrast has explicit conservative proofs without rule exclusions. [Source assets](m10-site-assets.json) and [exact local HTTP bodies](m10-site-http.json) pass at 419,508/500,000 bytes excluding fonts.

[Prepublication state](m10-prepublication.json) confirms public main/docs Pages, twelve unpublished skip-ci task commits, no releases and unchanged repository workflow IDs. Live publication proof is now recorded below; M10 is checked. No app runtime, sidecar/lock pin, workflow or existing evidence changes are part of this milestone; clipboard/input/registry/installer/platform/performance boundaries remain those of the task receipts.

## M10 published

Milestone commit `4b44200` is public. [Live-body proof](m10-live-check.json) verifies M10 Done/M11 In progress, 103 exact source bodies, the nested custom 404 and all 1703 public PNG hashes. Built-in Pages run `46114840941` succeeded; repository workflow IDs stayed unchanged. [Push confirmation](m10-push-confirmation.json) records independent remote completion before the stalled local transport was closed. [Publication bookkeeping](m10-deployment.json) ties this proof to the immutable readiness inputs. M10 was checked after these checks; V6.1 is next.
