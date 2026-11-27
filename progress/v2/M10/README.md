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
