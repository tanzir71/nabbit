# M5 — Island interface

Application checkpoint: `7c9c2ae`. The three task commits remain separate, with their original reports and development attempts retained.

| Task | Commit | Evidence |
|---|---|---|
| V2.5 — Compact, Peek, Expanded, Drop and motion | `39d42c0` | [V2.5.md](V2.5.md) |
| V2.6 — Keyboard, Search and explicit focus | `9e49670` | [V2.6.md](V2.6.md) |
| V2.7 — Island acceptance and real landing hero | `7c9c2ae` | [V2.7.md](V2.7.md) |

The island now renders compact activities natively and creates Peek, Expanded and Drop WebViews on demand. The six-tab shell remembers filters, queries, drafts and scroll across destruction. Alt+Space toggles the island, Ctrl+1–6 selects tabs, Alt+1–9 opens persisted pin slots, typing opens Search, and Escape collapses. Focus requests originate from explicit interactions. Clipboard data uses the existing SQLite service; note/shelf intake remains a review draft until later module milestones. The full download redesign, Tack client, module services and complete settings/shortcut recorder remain later work.

`npm run tauri:dev` starts the native idle island. Alt+Space opens the island; Ctrl+Shift+V opens the existing tray. These are current entry points, not a manual acceptance checklist. Reproduction commands in each task document use automated fixtures and isolated profiles, without changing the real cursor, OS display settings or user accounts.

The landing hero now uses exact lossless captures of the compiled interface, with fixture captions and source/crop hashes. Desktop shows Expanded and mobile shows Peek. The surrounding composition follows Figma `27:246`/`27:273`; the progress section follows `29:965` and `31:1187`. This milestone changes only its metadata and M5/M6 status rows: M5 Done with this folder, M6 In progress. The three pre-release Follow the build CTAs remain until M12.

## Acceptance scope

V2.7 records a fresh isolated release measurement after 20s warm-up and a 60.273s sample: **0.000000% of one core / 0.0% rounded**, mean/peak total working set **41.971/42.013 decimal MB**, and zero WebView2 children. The high-volume location hook was removed; foreground/move/minimise events and the 500ms geometry/notification fallback remain. Earlier failed CPU measurements are preserved, including V0's historical strict 0.1% result. This single current measurement does not rewrite the old gate or claim zero CPU cost under every workload.

Each render scale has **49 actual CDP morph measurements** with complete replayable attribution. Maximum explicit drops are **21 at 1×** and **27 at 1.5×**; other morphs reach 5/4 drops. These exceed V0's ≤2 comparison. The selected native compact fallback remains; the larger-WebView result is not relabelled a passing all-WebView performance gate. Native DirectComposition has no CDP target, so no unmeasured zero-drop native result is inferred. The previously denied helper-activation test remains explicitly not automated. Focus/shortcut/shell providers are injected; owned HWND inspection, IPC, DOM input, SQLite, style flips and WebView lifecycle are real. Independent foreground switches are recorded separately.

Current application evidence in `v27-verification.json` pins **567 source inputs**, the release executable, **238 final PNGs** (largest **169,195 bytes**), all task reports and the original **102 SVGs**. It includes 120 browser shell captures, 36 keyboard/settings captures, 24 default-rule axe scans, actual input/visibility checks, both directions of simulated DPI change during animation, Expanded monitor removal, disk-backed WebView2 file routing and graceful zero-download teardown. Earlier prefixes are retained development evidence, not substituted for the final results. The initial island JavaScript closure is **89,522 / 120,000 gzip bytes**.

Fresh milestone checks pass: **96 frontend/script tests**, **92 serial Rust tests**, formatting, default/spike Clippy with warnings denied, static/HTTP site checks and byte-identical social-card regeneration. The eight status and eight keyboard-focus captures passed **24 default-rule axe scans**, retained original 16px icon geometry and bundled fonts, and kept default page dimensions unchanged. All **1,277 retained/final PNGs** in this folder decode correctly at their recorded device dimensions and stay below **300,000 bytes** (largest **169,195**). The landing transfer is **462,864/500,000 bytes excluding fonts**, with **106 exact local HTTP bodies**.

`m5-readiness.json` verifies source, report and image fingerprints against each original task commit and verifies the current application against V2.7. Older shell, dotfile and PowerShell JSON fingerprints use their original CRLF representation; the audit records exact LF/CRLF conversions without changing content or historical reports. The three unpushed task commits pass a history secret scan. The repository remains public with legacy Pages from `main` `/docs`, no releases and the unchanged two historical repository CI run IDs.

Milestone readiness, fresh checks, status/accessibility captures and publication receipts are recorded in the `m5-*` reports. M5 remains unchecked in the handoff until the milestone push and live Pages verification succeed. No PR, tag, release or repository workflow dispatch is part of this publication; only GitHub's built-in Pages deployment is allowed.

## Automated reproduction

```powershell
npm run verify
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features island-spike -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
npm run verify:site
npm run site:og -- --check
node scripts/verify-milestone-status.mjs --milestone M5 --previous-ref 7c9c2ae --prefix m5-repeat
node scripts/verify-site-accessibility.mjs --milestone M5 --prefix m5-repeat
```

Use unused output prefixes. The task documents contain the native smoke and measurement commands. There is no installer, signing, real Tack account, manual focus grant or additional hardware requirement for these checks.
