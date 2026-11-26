# M4 — Island plumbing

Application checkpoint: `9f9f600`. This milestone preserves the four V2.1–V2.4 task commits and their original evidence. The native idle island now has lifecycle/placement/monitor preferences, hit rectangles, adaptive input and drag-band handling, foreground visibility and the typed activity/priority/deadline plumbing. The Zustand presentation reducer and its remembered panel state are connected. Compact content, larger surfaces and motion are V2.5; keyboard bindings are V2.6 and full island acceptance is V2.7.

`npm run tauri:dev` starts the native idle island. The existing tray shortcut remains Ctrl+Shift+V; Shape and Place settings already persist size, shape and monitor selection. These are current entry points, not a manual acceptance checklist. The native and browser scripts in each task's evidence reproduce the automated checks with isolated profiles and injected providers.

| Task | Commit | Evidence |
|---|---|---|
| V2.1 — lifecycle and placement | `236734b` | [V2.1.md](V2.1.md) |
| V2.2 — input and drag band | `3b0c380` | [V2.2.md](V2.2.md) |
| V2.3 — foreground visibility | `ac955b1` | [V2.3.md](V2.3.md) |
| V2.4 — activity plumbing | `9f9f600` | [V2.4.md](V2.4.md) |

Fresh milestone checks pass: **79 frontend/script tests**, **66 serial Rust tests**, formatting and Clippy with warnings denied. The initial island JavaScript closure is **53,540 / 120,000 gzip bytes**. `m4-readiness.json` verifies all four tasks' source/report pins against their exact commits and the current application against the V2.4 source/executable pins. Earlier V0 strict one-core CPU **0.1%** and the denied helper-activation limitation remain recorded; this milestone makes no new performance-gate or cross-platform claim.

The landing changes only its milestone metadata and M4/M5 rows: M4 Done with this screenshot folder, M5 In progress. Eight status captures cover desktop/mobile × light/dark × 1/1.5 device scale and retain the original icon geometry, fonts and default page dimensions. Eight keyboard-focus captures and **24 default-rule axe scans** pass. Six focus captures are pixel-identical to M3; the two desktop 1× captures differ at only four antialias pixels on the focused CTA outline corner. Status theme pairs are pixel-identical. All **114 PNGs** in this folder were audited, retain original device resolution and are below **300,000 bytes** (largest **131,263**).

Static checks, all **108 exact local HTTP resource bodies** and byte-identical social-card regeneration pass. The conservative landing transfer is **490,986 / 500,000 bytes excluding fonts**. Original SVG/WebP/font files, pre-release Follow the build CTAs and repository workflows are unchanged. The prepublication snapshot confirms public `main`, legacy Pages from `main` `/docs`, no releases and the unchanged two historical repository CI run IDs. Published milestone: `8f586ed`. Built-in Pages run `45760545427` succeeded for that exact commit. Live HTTPS checks confirm M4 metadata, M4 Done/M5 In progress, all 108 source assets, nested custom 404 and all 114 public PNG hashes. Published normal resources total 490985 bytes excluding fonts. Repository CI IDs are unchanged. See `m4-deployment.json` and `m4-live-check.json` for the publication receipt and full remote audit. The milestone and verification-receipt commits use skip-ci with fast-forward main pushes.

## Automated reproduction

```powershell
npm run verify
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
npm run verify:site
npm run site:og -- --check
node scripts/verify-milestone-status.mjs --milestone M4 --previous-ref 9f9f600 --prefix m4-repeat
node scripts/verify-site-accessibility.mjs --milestone M4 --prefix m4-repeat
```

Use unused prefixes for another capture run; existing evidence is never overwritten. The task documents contain the native smoke commands. All checks run locally without changing real cursor/display settings, authenticating to Tack, installing or signing anything.
