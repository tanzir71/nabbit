# Island spike — V0.1

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
node scripts/verify-island-spike.mjs
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
exposed `window.nabbitIslandSpike.setState(...)` seam; the whole native host is
click-through in V0.1. Adaptive hit rectangles, drag entry and fullscreen hiding
are V0.2. Release CPU/memory/frame measurements and the go/no-go decision remain
V0.3/V0.4; this spike does not claim those gates have passed.
