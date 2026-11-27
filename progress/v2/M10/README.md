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
