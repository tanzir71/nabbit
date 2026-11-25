# M1 evidence — island spike

## V0.1

- SDK alignment: Tauri Rust 2.12.7, JavaScript API 2.12.5, CLI 2.12.6. The 2.12
  window builder supplies `no_redirection_bitmap`; CLI info reports no version
  mismatch. The regenerated SDK permission catalog is included without adding
  capabilities to the spike.
- `v01-preview-checks.json`: light/dark at 1×/1.5×, plus reduced motion. All four
  shapes have the Figma dimensions/radii, original SVG sizes, fixed host bounds,
  no runtime errors and no idle JS scheduling.
- `v01-webview-checks.json`: the same four morphs inside the actual Tauri
  WebView2 page. Its root background is transparent. An actual CSS width
  transition interpolates idle→live to 278.140625px at the checked midpoint;
  reduced motion has no width transition and uses the 120 ms crossfade.
- `v01-native-window.json`: runtime flag `0` creates no island; flag `1` creates
  the shown 720×460 logical host at this machine's 100% scale. Extended styles
  are `0x82C0138`, including `WS_EX_NOACTIVATE`, `WS_EX_NOREDIRECTIONBITMAP`,
  topmost and click-through. Bounds stay `(600,0)–(1320,460)` for every morph.
- 20 PNGs (16 preview, 4 native), maximum 68,312 bytes. The native PNGs retain
  alpha 0 outside the island (checked at the corner and lower empty area) and
  opaque `#050506` inside it. Captures were visually inspected against Figma
  idle `7:2`, downloading `7:17`, peek `8:61` and expanded Nab `9:78`.
- The opt-in spike JS is about 53.1 kB gzip including its shared React/core
  chunk; no clipboard/settings/editor module is imported by the spike entry.
  The normal build excludes the spike entry entirely.
- Regression checks passed: `npm run verify` (5 tests), `npm run verify:site`,
  Rust formatting, default and spike-feature Clippy with warnings denied, and
  22 Rust tests. Production npm audit reports zero advisories. Native capture
  alpha samples are recorded in `v01-alpha-check.json`.

Reproduction and fixture isolation details are in `spikes/island/README.md`.
The native test keeps OS autostart/hotkey settings untouched and never moves the
real cursor. The prototype uses the system font fallback pending V1.2.

## V0.2

- `v02-native-window.json`: 16 injected cursor/foreground scenarios against the
  actual WebView2 host. `WS_EX_TRANSPARENT` flips for inside/outside/edge points
  and the drag target; the HWND stays shown and its 720×460 bounds stay fixed,
  including notification-state and borderless fullscreen suppression.
- `v02-native-*.json`: current padded hit rectangles, typed presentation events,
  foreground-hook installation and adaptive sampling. Far-away cursor reads
  are at most 2 Hz (plus event wakeups); nearby reads use the 25 ms schedule.
  Fullscreen restoration keeps the expanded state. Other-monitor, shell and
  own-process fixtures remain visible.
- Final sampling observed 2 cursor reads in 1,110 ms far away and 37 in 1,112 ms
  nearby. `v02-alpha-check.json` confirms all fullscreen pixels have alpha 0;
  drag/resume captures retain transparent margins and an opaque pill.
- `v02-native-drops.json`: synthetic native HTML5 URL/text drops and a disk-backed
  disposable file resolve to the expected review zones. The file path traverses
  WebView2 AdditionalObjects → Rust → standard `onDragDropEvent`. A virtual
  browser file without a disk path is rejected without a runtime error. No
  download or file operation is started.
- `v02-preview-checks.json`: four configurations (light/dark × 1×/1.5×), each
  checking the three payloads, reordered zones, Figma 640×150/r24 geometry,
  original 20px icons, solid selected/dashed inactive borders, padded ResizeObserver
  reports, unsupported data, fullscreen restoration and stale-event rejection.
- 15 new PNGs: 12 preview drop targets and native drag/fullscreen/resume states.
  Visually compared against Figma drop variants `8:120`, `8:144`, `8:168`;
  payload-driven ordering follows the handoff. The island stays dark in both
  themes. Geist bundling remains V1.2.
- Regression checks: 12 frontend tests, 28 Rust tests, app/site verification,
  formatting, and default/spike-feature Clippy with warnings denied. React
  effect/listener cleanup and event-driven updates were reviewed. Native and
  browser reports contain no runtime errors.

V0.3–V0.4 and M1 remain pending. The 300 ms idle scheduling check is not a CPU
measurement; the required release idle/memory/frame gate has not been run yet.
