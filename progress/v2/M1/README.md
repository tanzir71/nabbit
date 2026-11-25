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

## V0.3 release measurements

The unsigned release executable was built from application commit `30fa8a4` with
`island-spike,custom-protocol`. `v03-performance.json` records its SHA-256 and
raw process-family samples. Both idle trials used fresh isolated profiles,
20 seconds of settling and at least 60 seconds of sampling, with CDP/tracing off.

| Measurement | Flag-zero baseline | Shown collapsed island |
|---|---:|---:|
| Sample duration | 60.118 s | 60.326 s |
| CPU seconds, app + WebView2 descendants | 0.140625 | 0.1875 |
| CPU, percentage of one core | 0.233914% | 0.310813% |
| CPU, normalized over 12 logical processors | 0.019493% | 0.025901% |
| Mean total working set, decimal MB | 367.742 | 457.511 |
| Peak total working set, decimal MB | 371.741 | 461.365 |
| Observed processes | 8 | 9 |

The island adds **89.769 MB mean / 89.625 MB peak** (85.611/85.473 MiB), exceeding
the 60 MB allowance. CPU values are retained unrounded; the collector also
records the stricter one-core, one-decimal result (0.2% baseline / 0.3% island).
Working sets sum resident pages across the process family, including shared
pages counted in multiple processes. Snapshot/query overhead gives observed
intervals around 1.25 seconds; native CPU counters cover the full sample.

Machine: **Windows 11 Home 10.0.26300**, DWM refresh **60.00024 Hz**, **96 DPI / 100%**
scaling, WebView2 **Edg/158.0.4370.33**. Display settings and other applications
were left unchanged. Both accepted process trees stayed stable. The collector
also retains query-only CPU handles for children that exit; an automated helper
test retrieved 0.34375 final CPU seconds after its process exited.

`v03-frame-timings.json` contains **36 native morphs**: all 12 directed transitions
among idle/live/peek/expanded, three rounds. A separate fresh release launch
enabled CDP tracing. No screenshot capture, JS profiler or animation flags ran
during collection. Explicit Chromium compositor dropped-frame sequence IDs are
scoped to the island renderer/layer tree, with partial drops included.

| Round | Maximum drops in one morph | Total drops over 12 morphs |
|---|---:|---:|
| 1, first use of the shapes | 20 | 55 |
| 2 | 0 | 0 |
| 3 | 2 | 2 |

The worst morph was round 1 live→expanded (20 drops, 585.290 ms observed), which
exceeds the ≤2-frame limit. Later smooth rounds are retained alongside that
failure. The target host stayed 720×460, motion preference was normal, no trace
data was lost and no runtime errors occurred. `v03-compositor-trace.json` keeps
the frame events/marks and deduplicated target layer mappings needed to replay
all 36 results exactly; the complete trace remains in ignored `.tools/`.

The frame analyser's six synthetic tests cover duplicate/partial drops,
renderer/layer/window isolation, missing data, refresh accounting, failed limits
and invalid markers. The published trace was replayed against every recorded
result after compaction, without changing any frame count. Regression checks
passed: `npm run verify` (18 tests), site verification, Rust formatting,
default/spike Clippy with warnings denied, and 28 Rust tests. Reproduction:
`spikes/island/README.md`.

V0.3's failed measurements are retained unchanged. V0.4 takes the required
no-go/fallback branch below; the M1 publication remains pending.

## V0.4 gate and native compact fallback

**No-go for the all-WebView2 renderer.** `v04-gate-decision.json` evaluates the
original CPU (0.3% of one core at one decimal), memory (+89.769 MB mean) and
first-use morph (20 drops) against all three limits. None passes. Idle/live now
use a custom Win32 layered HWND and DirectComposition; peek, expanded and drag
targets retain the existing WebView2 interface. No production V2 state bus,
monitor system or downloader feature is included in this spike.

The fixed 720×460 native host never resizes or hides for animation/fullscreen.
Cached Direct2D surfaces render the original 18px Figma progress SVG and text;
antialiased rounded clips, offsets and opacity animate on the compositor.
Interrupted geometry/fades continue from their current value. Larger views are
created outside Windows event callbacks, acknowledge typed generation-numbered
instructions after paint and are destroyed on return to compact. Native idle
has no JavaScript or render timer. The existing tray is lazy only in these
explicit native spike/baseline sessions; normal v0.1 startup is unchanged.

`v04-native-checks.json` verifies four light/dark × 1×/1.5× contexts against the
unsigned release executable. `v04-native-reduced-checks.json` adds two contexts
with a native reduced-motion fixture: geometry changes immediately, with the
120 ms content crossfade covered by the pure motion tests. Checks include actual
styles, fixed physical bounds, input margins, transparent fullscreen with the
HWND still shown, unchanged idle commit/draw counters, repeated larger-view
handoffs/destruction, drag entry/cancellation, unchanged foreground focus and
the hidden tray factory. SQLite contains zero downloads. The 1.5× disk-backed
DOM File round-trip preserves the explicit note zone through native path
resolution (`v04-native-file-drop.json`); it remains a review candidate.
The reduced-motion report also verifies zero WebView2 child processes after an
instrumented larger-view/tray open/close cycle. Its teardown working-set snapshot
includes screenshot instrumentation and is not the idle benchmark below.

The 42 new PNGs are split into 18 native (including fullscreen/reduced motion),
8 WebView2 and 16 Vite preview captures, all at most 68,312 bytes. Native capture
uses Windows.Graphics.Capture `CreateForWindow` for Nabbit's exact HWND, with
cursor capture disabled. Raw BGRA is encoded to transparent PNG and verified for
geometry, palette, antialiased corners, SVG/text, transparent margins and
zero-alpha fullscreen. No desktop/monitor capture, picker, focus change or
capture-setting change is involved. Web PNGs capture only their own page. The
preview also checks reduced motion, original asset dimensions, fixed host,
zero runtime errors and zero idle JS scheduling. Compared against Figma `7:2`,
`7:17`, `8:61` and `9:78`; system font fallbacks remain until V1.2 bundles Geist.

### Native release measurements

`v04-native-performance.json` uses the same unsigned release executable as both
native smoke reports (SHA-256 `c38492f15052e9ef1f62254924431e9692167b4f193f4087bf5999285d53a0d8`).
It was built from this task's working tree based on `9aff055`; the report
explicitly records that the source tree was dirty. Both trials use fresh data,
the same lazy tray policy, 20 seconds of settling and over 60 seconds of sampling.
Capture, the native acceptance control worker, CDP and tracing are disabled.

| Measurement | No-island baseline | Native collapsed island |
|---|---:|---:|
| Sample duration | 60.334 s | 60.394 s |
| CPU seconds, full process family | 0.015625 | 0.031250 |
| CPU, percentage of one core | 0.025898% | 0.051744% |
| CPU, one core rounded to one decimal | 0.0% | **0.1%** |
| CPU, normalized over 12 processors | 0.002158% | 0.004312% |
| Mean working set, decimal MB | 27.483 | 39.280 |
| Peak working set, decimal MB | 27.537 | 39.510 |
| Stable process count (app + console host) | 2 | 2 |
| WebView2 processes | 0 | 0 |

Added working set is **11.796 MB mean / 11.973 MB peak**, within the 60 MB budget.
The strict one-core 0.0% idle target is **not met** in this native sample; both
raw and rounded values are retained. The machine-normalized value rounds to
0.0%, but is not substituted for that stricter result. Windows, refresh and DPI
remain Windows 11 Home 10.0.26300 / 60.00024 Hz / 96 DPI (100%). Other applications
and display settings were untouched. Native DirectComposition animation is not
CDP animation: no native dropped-frame count or complete performance pass is
claimed, and the original failed WebView2 trace is unchanged.

The first collector attempt completed only its baseline, then correctly failed
native startup validation because PowerShell/.NET left an empty scale override.
The collector now deletes absent overrides with the environment provider and
restores absent variables by deletion. `v04-native-attempts.json` and
`v04-native-attempt1-baseline.json` retain that incomplete attempt separately;
the accepted comparison is a fresh, complete pair, with no executable change.

Validation: 18 frontend/script tests, 35 Rust tests, app/site verification,
formatting, default and spike-feature Clippy with warnings denied, release build,
four native plus two reduced-motion contexts, five preview contexts and source
review of React listener/observer cleanup, stale acknowledgements and idle work.
Reproduction and API references: `spikes/island/README.md`. V0.4 completes the
required fallback branch; M1 is the next separate task and has not been pushed.
