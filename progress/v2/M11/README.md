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
