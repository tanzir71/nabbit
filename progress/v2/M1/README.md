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

V0.2–V0.4 and M1 remain pending. The 300 ms idle scheduling check is not a CPU
measurement; the required release idle/memory/frame gate has not been run yet.
