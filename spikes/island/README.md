# Island spike — V0.1–V0.3

This throwaway surface tests a WebView2 island inside Nabbit. It is compiled only
with Cargo feature `island-spike` on Windows and opens only when
`NABBIT_ISLAND_SPIKE=1`. Unset the variable for normal app startup; value `0` is
the same-binary baseline with no island. Both explicit spike sessions skip OS
autostart and global-shortcut changes so automated launches stay isolated.

The native host is a single 720×460 logical transparent window, top-centred on
the primary work area. It is frameless, non-resizable, topmost, excluded from
the taskbar, non-focusable and created with `no_redirection_bitmap(true)`.
Position/size are set at creation; every morph happens inside that fixed host.

| Shape | Size | Radius | Enter motion |
|---|---|---|---|
| Idle | 112×26 | 13 | 220 ms collapse, after the 80 ms content fade |
| Live | 320×32 | 16 | 260 ms spring, stiffness 380 / damping 32 |
| Peek | 400×74 | 24 | 320 ms spring, stiffness 300 / damping 28 |
| Expanded | 680×297 | 28 | 380 ms spring, stiffness 260 / damping 30 |
| Drop target | 640×150 | 24 | 320 ms peek spring |

`scripts/generate-island-motion.mjs` samples the analytic damped springs into
`motion.css` at spike build time. Animation uses CSS `linear()`, with no animation
dependency or JS animation loop. Reduced motion changes geometry immediately
and uses a 120 ms crossfade. The collapsed surface schedules no JS timers or
animation frames.

The live, peek and expanded samples come from Figma `7:17`, `8:61` and `9:78`;
idle is `7:2`. Every supplied SVG is a local original export rendered at its
intrinsic size. The app's Button and IconButton components are reused. Fonts use
the specified system fallback until V1.2 bundles Geist. Sample download/module
controls are disabled; state control belongs to the spike harness.

## Automated verification

Use the same isolated Playwright runtime as the M0 site capture:

```powershell
npm install --prefix .tools/site-qa --no-audit --no-fund --ignore-scripts playwright@1.65.1
.\.tools\site-qa\node_modules\.bin\playwright.cmd install chromium
npm run build:spike
cargo build --manifest-path src-tauri/Cargo.toml --features island-spike,custom-protocol
.\scripts\windows-island-spike-smoke.ps1
.\scripts\windows-island-spike-smoke.ps1 -Interaction
node scripts/verify-island-spike.mjs
node scripts/verify-island-interaction.mjs
```

The smoke creates its own SQLite and WebView2 data directories, disables engine
updates in the fixture, uses a free loopback CDP port, drives the actual WebView2
page and closes only its own app process. It verifies the runtime flag-off case,
native extended styles, client dimensions and unchanged HWND bounds across all
four morphs. `skip_taskbar` uses Tao's `ITaskbarList::DeleteTab`; it does not
require a `WS_EX_TOOLWINDOW` bit. HWND creation is followed by a bounded readiness
wait before inspecting asynchronously applied window styles.

The preview check serves the built spike through Vite and covers light/dark at
1×/1.5× plus reduced motion. Both native and preview checks assert geometry,
original asset dimensions, a fixed host, zero runtime errors and zero idle JS
scheduling. Reports and PNGs are under `progress/v2/M1/`.

After capturing, `npm run verify` builds the normal app and excludes the spike
HTML entry. `npm run build:spike` is needed again for another spike build.

For a local developer controller, preview the spike entry with
`?preview=1&controls=1`. Native acceptance controls it through the explicitly
exposed `window.nabbitIslandSpike.setState(...)` seam. Release measurements use
the separate V0.3 procedure below. The go/no-go decision remains V0.4.

## V0.2 interaction

A ResizeObserver reports the current CSS pill rectangle plus 8 logical pixels
through `island_set_hitrect`. Rust converts physical cursor coordinates using
the host origin/DPI and changes `WS_EX_TRANSPARENT` only when necessary. The
cursor worker samples every 25 ms within 120 logical pixels of the current
target, otherwise every 500 ms. A foreground WinEvent hook wakes it immediately;
geometry updates reuse the cached cursor instead of increasing sampling. No
frontend polling runs while collapsed.

A held button moving from outside into the work area's top 48 logical pixels
opens the three-zone drop target. Leaving the band and target cancels it. URL,
file and text payloads reorder the best matching zone first, using Figma
`8:120`, `8:144` and `8:168` and nine original SVG exports. Drops only produce
review-candidate receipts; they never read file contents or start jobs.

[Tauri's Windows native handler replaces HTML5 drag handling](https://v2.tauri.app/reference/config/#dragdropenabled).
The spike disables that replacement and resolves dropped DOM File objects via
[WebView2 AdditionalObjects / ICoreWebView2File](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2file).
Rust sends the resolved paths in the standard native drop event consumed by
`onDragDropEvent`; URL/text payloads retain HTML5 DataTransfer handling. The two
optional Rust dependencies already exist in Tauri's lockfile and compile only
with the Windows spike feature.

Fullscreen suppression considers QUNS busy/D3D/presentation states and matching
foreground/monitor rectangles, excluding the shell, this process and another
monitor. It makes the surface transparent and click-through while the native
host remains shown and composited. Restoring visibility preserves the prior
shape. Typed visibility events carry monotonic revisions to reject stale events.

`-Interaction` seeds `NABBIT_ACCEPTANCE_CURSOR` with a JSON file of logical local
cursor coordinates, button state and foreground/monitor fixtures. This provider
never falls back to the real cursor. The acceptance-only snapshot command
requires that provider and forces a sample only when explicitly requested by
the external harness. The smoke checks 16 scenarios against actual HWND styles,
host visibility/bounds, WebView2 state, adaptive sample counters and a real
disposable file-path round trip. Browser tests use synthetic DataTransfer events
at light/dark and 1×/1.5×. All test storage remains under ignored `.tools/`.

## V0.3 release measurements

```powershell
npm run build:spike
cargo build --manifest-path src-tauri/Cargo.toml --release --features island-spike,custom-protocol
.\scripts\windows-island-performance.ps1
```

This builds an unsigned executable without bundling, signing or installing.
The script runs same-binary baseline (`NABBIT_ISLAND_SPIKE=0`) and collapsed
island (`=1`) trials with fresh disposable SQLite/WebView2 profiles. Each gets
20 seconds of settling followed by at least 60 seconds of idle sampling.
CDP and tracing are disabled throughout those CPU/memory samples.

Process discovery follows the app's descendants, rather than every WebView2 on
the machine. Read-only native CPU-query handles remain open for observed
processes until the sample ends, so a WebView2 child that exits still contributes
its final CPU time. The report retains per-query snapshots (a 1-second wait plus
process-query time), process births and
departures, CPU seconds, unrounded one-core percentage, one-decimal percentage,
and the machine-normalized percentage. Working set is summed across the app and
all observed live descendants; shared pages can be counted in several processes.
Baseline/island mean and peak values and their differences are recorded in bytes.

A separate isolated release launch enables loopback CDP for motion collection.
`measure-island-frames.mjs` records all 12 directed transitions among the four
shapes, three times, with no OS focus change or animation flags. User-timing
marks bracket actual CSS width transitions; Chromium's compositor
BeginFrame/DrawFrame/DroppedFrame sequence IDs are scoped to the island's renderer
and layer tree. Partial drops count. One refresh around the marks includes the
refresh containing the initial mutation and the final draw. Missing markers,
mapping, drawn frames or lost trace data fail collection instead of yielding a
zero-drop result. Draw gaps are descriptive and do not manufacture drops during
intentional animation delays. The analyser has six synthetic trace tests.

Machine metadata comes from local Windows queries, including the existing DWM
refresh ratio and island DPI/scaling. No display settings are changed; other
applications remain uncontrolled. `v03-performance.json`, `v03-frame-timings.json`
and the filtered `v03-compositor-trace.json` retain the evidence. The full trace,
profiles and trial logs stay under ignored `.tools/`. Threshold failures are
retained for the V0.4 decision; successful data collection alone does not pass
the gate.

API references: [DWM timing](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmgetcompositiontiminginfo),
[CDP tracing](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/),
[Chromium frame accounting](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/trace/handlers/FramesHandler.ts).
