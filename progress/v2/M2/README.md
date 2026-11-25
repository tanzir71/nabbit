# M2 evidence — foundations in progress

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
