# M2 evidence — foundations in progress

## V1.2 — bundled fonts

The app and island now load upright Geist and Geist Mono from the official
[Geist 1.9.2 release](https://github.com/vercel/geist-font/releases/tag/v1.9.2).
The two unmodified WOFF2 files total 140,700 bytes. The native compact renderer
embeds the matching TTFs (340,256 bytes), creates an isolated in-memory DirectWrite
collection on first live use, and requires Geist Regular / Geist Mono Medium with
no simulated weights. It never installs fonts or contacts the Windows font service.
The native-to-web handoff waits for both bundled faces before acknowledging paint.

`src/assets/fonts/manifest.json` pins the archive and each original file by SHA-256.
`npm run verify:fonts`, included in `verify`, rejects changed/missing assets or
license bytes. Folder attributes preserve the original OFL line endings on Windows;
Tauri includes the OFL in installer resources, and About identifies the font license.
The font metadata report confirms upright 100–900 weight axes and matching glyph
coverage in TTF/WOFF2. No font package or runtime dependency was added.

Shared font stacks replace Inter. Tailwind `font-sans` / `font-mono`, code/key
elements, existing settings paths/shortcuts and changing download progress use
the bundled families. Nine `type-*` styles expose the exact Foundations `12:373`
size, line height, weight and tracking. Component reconstruction remains V1.3;
the landing and its Latin subset remain Phase L.

Verification:

- `npm run verify`: 22 frontend/script tests, type check, lint, font/token checks
  and default production build; the default build still omits the spike entry.
- Rust: formatting, default and spike-feature Clippy with warnings denied,
  36 tests and the native feature/custom-protocol build.
- `v12-font-checks.json`: light/dark × 1×/1.5×, all nine type styles, fixed-width
  changing digits and actual custom-font glyphs via `CSS.getPlatformFontsForNode`.
  Both font requests stay inside the app bundle; external requests and page errors
  are empty. Twelve PNGs cover type ramp, tray and settings.
- `v12-font-metadata.json`: inspected upstream family names, weight axes, upright
  angle and glyph coverage, using fontTools 4.63.0 for this one-time inspection.
  fontTools is not an app/build dependency.
- `v12-island-preview-checks.json`: five contexts including reduced motion,
  original SVG dimensions, fixed host geometry and zero idle JS scheduling;
  sixteen PNGs cover the four original morph states.
- `v12-native-checks.json` and `v12-webview-*.json`: four actual Windows contexts,
  lazy private fonts, cached live surface, unchanged foreground focus, input and
  fullscreen rules, stable idle draw/commit counters, larger-view handoffs and
  destruction, zero retained WebView2 children, native file-drop path resolution
  at 1.5× and zero downloads. Twenty own-HWND/page PNGs cover compact and larger
  surfaces, including transparent fullscreen. No desktop capture or real cursor,
  Windows preference, display scaling, autostart or shortcut changes.
- Visual comparison used Figma type ramp `12:373` and compact live `7:17`.
  Review caught a pre-existing native CDP screenshot crop at synthetic 1.5× zoom.
  An explicit CSS-sized clip still failed the new PNG-dimension assertion; the
  helper now includes the full host before page zoom. A fresh four-context run
  passes with full 720×460 / 1080×690 captures. Earlier M1 evidence is unchanged.
- All 48 V1.2 PNGs are at most 85,528 bytes. `v12-validation.json` replays report
  assertions, executable/font hashes, PNG dimensions and budgets. Site verification
  remains green (31,884 bytes excluding fonts). The M1 performance limitations
  are unchanged; this font task does not claim a new CPU/memory/frame gate pass.

Reproduce with the isolated Playwright 1.65.1 installation described for M1:

```powershell
npm run verify
npm run verify:site
node scripts/verify-fonts.mjs
npm run build:spike
node scripts/verify-island-spike.mjs --output-prefix v12-island --output-dir progress/v2/M2
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features island-spike -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
cargo build --manifest-path src-tauri/Cargo.toml --features island-spike,custom-protocol
.\scripts\windows-native-island-smoke.ps1 -OutputPrefix v12 -OutputDir progress/v2/M2
```

Run frontend builds before the native build; do not overwrite `dist/` during
native asset embedding. The native smoke uses fresh fixture profiles, stops only
its own process, and restores process environment variables afterward.

## V1.1 — colour tokens and appearance

`src/styles/tokens.mjs` is the single source for all 36 light/dark colour pairs.
The values were checked against Figma Foundations `12:53` and `12:213`;
`signal/on`, absent from those swatch boards, follows handoff §4.1. The generator
emits identical `src/styles/tokens.css` and `docs/assets/tokens.css`, with hex
variables and RGB channels for Tailwind opacity modifiers. `npm run verify:tokens`
rejects stale output. The site file is ready for Phase L; the current landing
continues to use its existing stylesheet.

The app uses semantic Tailwind colours instead of the previous indigo/slate
palette. Primary actions use ink; lime is reserved for live progress. The island
entry stays dark independently of the app preference. Fonts, component geometry,
the full component preview, multi-entry surfaces and new icons remain V1.2–V1.6.

Settings → General offers System / Light / Dark. SQLite stores the choice;
a versioned, theme-only local cache supplies initial paint, and loaded settings
remain authoritative. The controller reads Windows theme through Tauri's existing
window permission and subscribes to theme-change events. Browser previews use
`prefers-color-scheme`. Both sources are event-driven, with no polling, and
late subscription/query results are handled during cleanup and newer events.
An explicit choice wins until System is selected again.

Legacy settings without `theme` retain their other values and default to System;
unknown future theme names also fall back to System. The SQLite test verifies
the override after closing/reopening the database. Appearance-only saves avoid
autostart/global-shortcut reconfiguration. The browser IPC acknowledgement mock
now returns a fresh settings object so the existing first-run notice dismisses.

Automated verification:

- `npm run verify`: 22 tests, including system changes, override precedence,
  cached choice, stale Windows queries, late listener cleanup and API fallback.
- Rust: 36 tests, formatting and default/spike-feature Clippy with warnings denied.
- `v11-preview-checks.json`: light/dark × 1×/1.5×, all 36 computed colour variables,
  rendered swatches, overrides across system changes/reload, no runtime errors
  or external requests. Twelve PNGs cover the palette, tray and appearance panel.
- `v11-native-theme.json`: actual Windows WebView2 theme query and injected
  window-theme events, override precedence, SQLite-backed reload and preserved
  settings. The hidden app never changes foreground focus, Windows preferences,
  autostart or shortcuts; the fixture ends with zero downloads. Two own-page PNGs
  capture settled light/dark controls, without desktop capture.
- `v11-island-preview-checks.json`: five regression contexts (including reduced
  motion), fixed geometry, original asset dimensions and zero idle JS scheduling.
  Sixteen PNGs show that the island remains dark in both system preferences.
- All 30 PNGs are at most 113,710 bytes. Colour-board captures were visually
  compared to Figma; existing system font fallbacks remain for V1.2.
- `v11-token-validation.json`: inspected source pairs, generated-output parity
  and PNG budgets. Site verification still passes at 31,884 bytes excluding fonts.

Reproduce without changing Windows settings:

```powershell
npm run tokens
npm run verify
npm run build:spike
node scripts/verify-theme.mjs
node scripts/verify-island-spike.mjs --output-prefix v11-island --output-dir progress/v2/M2
cargo build --manifest-path src-tauri/Cargo.toml --features island-spike,custom-protocol
.\scripts\windows-theme-smoke.ps1
```

Native smoke uses fresh app-data/WebView2 profiles, disabled engine updates and
an explicit flag-zero spike session that skips OS integration. Event injection
targets only Nabbit's window; it never changes the Windows theme or display scale.
M2 publication remains pending until all foundation tasks are complete.
