# M11 — Modes, tray and settings

## V6.1 — Settings window and migration

The tray and island gears open one normal settings window. It has all nine settings sections, persistent native island behaviour and activity preferences, safe field-level saves and an in-place v0.1 settings migration. Closing the window releases its WebView; the native background app remains available.

Windows 11 build 26300 reports Mica on the owned settings HWND. Light/dark captions and material, taskbar styles, native size constraints, reuse, close/reopen, tray-less island entry and restart persistence were verified automatically. Windows 10 uses the solid CSS canvas when Mica is unavailable; a physical Windows 10 run is outside this machine.

| Evidence | Result |
| --- | --- |
| Frontend / native tests | 570 frontend; 380 Rust passed, 8 existing opt-in tests ignored |
| Browser views | 96 light/dark, 1x/1.5x views; exact repeated PNGs |
| Default whole-document axe | 0 violations, 0 incomplete results in all 96 views |
| Native captures | 8 exact DPR2 pairs across General, Island, activities and Shortcuts |
| Initial island JS | 103,826 / 120,000 gzip bytes |
| Assets | 27 exact original exports, 18 newly added SVG files |

The final browser matrix is [v61-settings-n-screenshots.json](v61-settings-n-screenshots.json) with [v61-settings-n-axe.json](v61-settings-n-axe.json). The native run also walks the remaining sections and saves, reads back and removes an owned temporary-folder pin through the settings editor. Native evidence is [v61-native-e-scene.json](v61-native-e-scene.json). [Requirements](v61-requirements.json), [design notes](v61-design.json), [checks](v61-checks-current.json), [PNG audit](v61-png-audit-current.json), [log index](v61-logs.json), [supplementary logs](v61-logs-supplement.json), [final logs](v61-logs-final.json) and [staged-blob receipt](v61-acceptance.json) preserve the proof. Failure logs, original gzip bytes and diagnostic captures remain alongside the successful runs.

| Page | Light | Dark |
| --- | --- | --- |
| General | [1x](v61-settings-n-settings-general-light@1x.png) | [1x](v61-settings-n-settings-general-dark@1x.png) |
| Island | [1x](v61-settings-n-settings-island-light@1x.png) | [1x](v61-settings-n-settings-island-dark@1x.png) |
| Activities | [1x](v61-settings-n-settings-activities-light@1x.png) | [1x](v61-settings-n-settings-activities-dark@1x.png) |
| Files | [1x](v61-settings-n-settings-files-light@1x.png) | [1x](v61-settings-n-settings-files-dark@1x.png) |

Native PNGs preserve the WebView's transparency and do not include the DWM wallpaper material. The HWND attributes prove Mica independently. Capture-only compositor scheduling is documented in [Chrome's tooling guidance](https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md#rendering--gpu); six-frame before/after diagnostics remain in `v61-raster-*.json`. Runtime preferences, rendering rules and axe rules are unchanged by the capture setup.

Only owned app/WebView/control profiles, generated files and isolated registry fixture subtrees were used. No real clipboard/global input/cursor, user files/profiles/accounts, hosted Tack, shell/autostart/hotkey registration, Store action, installer execution/signing or OS/display-setting change. No new performance or other-platform claim.

Mode lifecycle/badges/toasts, the tray redesign and shortcut recorder/conflict treatment remain V6.2–V6.4. This task retains functional legacy shortcut editors. M11 publication occurs after those tasks; this is a direct local `main` task commit with `[skip ci]` and no PR or task push.

## V6.2 — Modes, tray progress and completion notifications

General and the native Mode submenu switch between Island + tray, Tray only and Island only. Tray only removes the island host and its WebView and routes Alt+Space to the tray popover. Island only requests a hidden tray; Alt+Space and the island gear remain available. Both saved modes survive a process restart.

Download events drive the original monochrome tray glyph with a progress bar, queued dot or paused mark. Queue publication happens under the queue lock before a worker can overtake it; native updates coalesce. Only new active completions in tray-only route to the Windows toast adapter, with no historical replay or extra notification in island modes. Activating `nabbit://downloads` opens Downloads without probing or enqueueing a job.

| Evidence | Result |
| --- | --- |
| Frontend / Rust | 571 frontend; 386 Rust passed, 8 existing opt-in ignores |
| Browser | 24 exact light/dark 1x/1.5x views at default/minimum size; whole-document axe 0 violations / 0 incomplete |
| Native settings | Six exact DPR2 pairs; 84 original asset geometry checks |
| Native icons | 12 exports from the exact RGBA passed to the tray; light/dark and owned 16/24px seams |
| Island initial JS | 103,826 / 120,000 gzip bytes |

Final proof: [checks](v62-checks-final.json), [requirements](v62-requirements.json), [flow](v62-flow.json), [design](v62-design.json), [browser](v62-modes-c-screenshots.json), [axe](v62-modes-c-axe.json), [native](v62-native-e-scene.json), [badge gallery](v62-native-e-badge-gallery.png), [PNG audit](v62-png-audit-final.json), [logs](v62-logs.json), [supplementary logs](v62-logs-supplement.json), [earlier attempts](v62-earlier-attempts.json) and [staged-blob receipt](v62-acceptance.json).

Windows notifications use the configured app identifier; installed desktop delivery needs the app identity described in [Microsoft's desktop toast requirements](https://learn.microsoft.com/en-us/windows/win32/shell/enable-desktop-toast-with-appusermodelid). Tests construct and parse the real Windows notification object and dispatch its activation handler directly, while `Show`, notification registration and the registered protocol hop remain outside automation under section0.2. The badge gallery visualizes the RGBA sent to the native API, without capturing the desktop; Shell rectangle coordinates do not establish icon visibility. Native PNGs preserve WebView transparency rather than DWM wallpaper.

Only owned profiles, generated fake downloads and HWND/provider queries were used. No real clipboard/global input/cursor, user files/profiles/accounts, hosted Tack, shell/autostart/hotkey registration, Store, installer execution/signing or OS/display changes. Other hardware/platforms and fresh performance remain unclaimed. Earlier failures and available captured frames/logs remain; native B retained mismatch digests but did not save its failed pair. Subsequent capture code retains both frames and uses an explicit fixed settle with exact comparison.

V6.3 owns the rest of the tray menu/popover redesign; V6.4 owns shortcut recording/conflicts. This task is a direct local main commit with skip-ci, no PR/tag/push. M11 publication remains after V6.4.

## V6.3 — Tray menu and popover

The native tray now has the specified quick actions, Island/Mode/Widgets/Pins submenus, live numbered pins and capture pause. Native pin IDs remain stable across slot changes; unavailable entries are disabled. Island and Widget settings open the correct page in the real settings window.

The popover has Nab, Notes, Clipboard and Files. Clipboard reuses the existing history and adaptive context actions with six filters, keyboard picks, visible errors and a separate capture pause. Files composes Shelf, Pins, tools and journal history; its header search filters Shelf and Pins. Owned native drops add to Shelf, move to a folder pin and Undo restores the original bytes. A consumed drop is not replayed when its tab remounts.

| Evidence | Result |
| --- | --- |
| Frontend / Rust | 574 frontend; 389 Rust passed, 8 existing opt-in ignores |
| Browser | 36 exact light/dark 1x/1.5x views; whole-document axe 0 violations / 0 incomplete |
| Native | 8 exact DPR2 views, real menu state/actions, settings page intents, owned drop/move/Undo and restart |
| Original asset geometry | 504 browser and 114 native checks |
| Artwork | 26 original SVG exports and 11 lossless intrinsic-size native menu rasters |
| Island initial JS | 104,165 / 120,000 gzip bytes |

Final proof: [checks](v63-checks.json), [requirements](v63-requirements.json), [flow](v63-flow.json), [design](v63-design.json), [assets](v63-asset-provenance.json), [browser](v63-tray-m-screenshots.json), [axe](v63-tray-m-axe.json), [native](v63-native-e-scene.json), [PNG audit](v63-png-audit.json), [logs](v63-logs.json), [earlier attempts](v63-earlier-attempts.json), [staged-blob receipt](v63-acceptance.json).

| View | Light | Dark |
| --- | --- | --- |
| Clipboard | [1x](v63-tray-m-tray-clipboard-light@1x.png) | [1x](v63-tray-m-tray-clipboard-dark@1x.png) |
| Files | [1x](v63-tray-m-tray-files-light@1x.png) | [1x](v63-tray-m-tray-files-dark@1x.png) |
| Files search | [1x](v63-tray-m-tray-files-search-light@1x.png) | [1x](v63-tray-m-tray-files-search-dark@1x.png) |

Only owned app/WebView/control profiles and generated file fixtures were used. Native menu handles and original icon inputs are verified; Windows draws its normal menu background, arrows and checkmarks, and no physical OS-menu/Explorer pixels are claimed. Owned HWND drop targets are registered, but shell/autostart/global-hotkey registrations, real clipboard/global input/cursor, real drag-out into another app, hosted Tack/accounts, installer/signing and OS/display-setting changes are excluded. The explicit still-capture caret policy preserves focus rings. Earlier failures and available failed image pairs remain in the evidence.

V6.4 owns shortcut recording/conflicts; V7 owns hardening, whole-surface accessibility, idle performance, packaging and wrap-up. Direct local main task commit with skip-ci, no PR/tag/task push; M11 publication remains after V6.4.

## V6.4 — Shortcut recorder and conflicts

Shortcuts now uses the Figma keycap rows and Change controls. All seven v2 actions and the preserved legacy tray binding can be recorded, typed, disabled and saved explicitly. Escape cancels. IME/repeated/modifier-only input is ignored; recorder lifecycle requests are serialized, pause on window blur and reacquire before accepting keys.

A shared Rust registration owner acquires replacement keys before writing SQLite or releasing old keys. Syntax/alias/in-app conflicts and native registration failures are visible per action. A failed remap preserves the old binding and saved field; batch/persistence failures roll back candidates. Startup skips only unavailable bindings. Tray note captions use the configured key, and the one-hour hide shortcut patches the existing activity preference.

| Evidence | Result |
| --- | --- |
| Frontend / Rust | 585 frontend; 398 Rust passed, 8 existing opt-in ignores |
| Browser | 24 exact light/dark 1x/1.5x views; default axe 0 violations / 0 incomplete |
| Native | 8 exact DPR2 views; real settings commands, injected conflicts/recorded key delivery, custom/disabled persistence and restart |
| Original assets | 264 browser and 88 native geometry checks; reused unchanged SVGs |
| Island initial JS | 104,161 / 120,000 gzip bytes |

The light Conflict text is slightly darkened from the design's 4.36:1 pair to meet AA; global tokens and the badge fill/geometry are retained. The six Figma actions are followed by island reference keys, then selected-text and legacy tray controls.

Proof: [requirements](v64-requirements.json), [flow](v64-flow.json), [design](v64-design.json), [checks](v64-checks.json), [assets](v64-asset-provenance.json), [browser](v64-shortcuts-b-screenshots.json), [axe](v64-shortcuts-b-axe.json), [native](v64-native-b-scene.json), [PNG audit](v64-png-audit.json), [logs](v64-logs.json), [earlier attempts](v64-earlier-attempts.json), [staged-blob receipt](v64-acceptance.json).

| State | Light | Dark |
| --- | --- | --- |
| Startup conflict | [1x](v64-shortcuts-b-shortcuts-conflict-light@1x.png) | [1x](v64-shortcuts-b-shortcuts-conflict-dark@1x.png) |
| Recording | [1x](v64-shortcuts-b-shortcuts-recording-light@1x.png) | [1x](v64-shortcuts-b-shortcuts-recording-dark@1x.png) |
| Rejected remap | [1x](v64-shortcuts-b-shortcuts-error-light@1x.png) | [1x](v64-shortcuts-b-shortcuts-error-dark@1x.png) |

Only owned app/WebView/data fixtures and DOM input were used. Native registration outcomes and focus for recorder delivery are injected through the production transaction/recorder paths. No actual global shortcut registration/input, real clipboard/cursor, external accounts/profiles, shell/autostart/notification registration, installers/signing or OS/display changes. No physical desktop-key ownership, other-platform/hardware or new idle-performance claim.

Direct local main task commit with skip-ci, no PR/tag/task push. M11 publication is next; V7/M12 remain.

## M11 publication readiness

All four V6 tasks are implemented. [Task audit](m11-task-audit.json) verifies 8,949 original source/artifact blobs and 817 unchanged current runtime inputs. The manifest and executable match V6.4. [Required checks](m11-checks.json), [readiness receipt](m11-readiness.json) and [all 740 PNGs](m11-png-audit.json) record the delivery boundary.

[Current native integration](m11-integration.json) passes settings, modes and tray flows with 22 repeat captures; eight shortcut captures use the same build. Two capture scripts correct only legacy scope metadata, explicitly allowing owned HWND drop-target registration; original reports are retained alongside canonical corrected copies. No assertions or pixels changed.

The landing changes only M11 metadata/Done/link and M12 In progress. [Eight status captures](m11-status-a-checks.json) repeat exactly and preserve page/icon/font geometry. [Keyboard and accessibility](m11-final-a-accessibility.json) includes eight contexts and 24 default axe scans with zero violations; gradient indeterminates retain conservative proofs without excluding rules. [Source assets](m11-site-assets.json) and [local HTTP bodies](m11-site-http.json) pass at 419,647/500,000 bytes excluding fonts.

[Prepublication state](m11-prepublication.json) confirms public main/docs Pages, four unpublished skip-ci task commits, no releases and unchanged repository workflow IDs. Publication proof and the milestone checkbox remain pending until live checks pass. Application runtime, dependency/sidecar pins, workflows and historical evidence are unchanged. Tests use owned executable/data/WebView/control fixtures; actual global input, shell registration, hosted accounts and installer execution remain outside these checks. No new platform or performance claim is made; V7.1 follows M11.
