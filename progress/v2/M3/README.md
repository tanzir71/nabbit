# M3 evidence — new landing page

## M3 — New landing page

Application source: `d04113b` on main, retaining separate L.1–L.3 commits.
This milestone publishes the static Figma landing, local fonts/tokens, original
artwork and HTML/CSS island previews, bookmarklet, responsive navigation,
accessible progress list, social metadata/image and recovery/agent pages.
Feature visuals remain labelled design previews while v2 is in development.

The milestone capture shows metadata M3, M3 Done with its Screenshots link,
and M4 In progress. Eight desktop/mobile × light/dark × 1×/1.5× contexts pass,
including 24 clean axe scans and keyboard interactions. The conservative site
transfer is 490,848 / 500,000 bytes excluding fonts; 108 local HTTP asset bodies
match source. All 278 M3 PNGs are under 300,000 bytes (largest 274,427 bytes).
Full-page device pixels are preserved in lossless tiles. Required frontend/Rust
checks pass: 43 and 39 tests, formatting, Clippy with warnings denied, pins,
typecheck/lint and the four-entry build. Initial island JS remains 46,346 /
120,000 gzip bytes. The M1 performance limitations are unchanged.

Open `https://tanzir71.github.io/nabbit/` for the published milestone. Existing
tray development remains `npm run tauri:dev`, then Ctrl+Shift+V; the production
island lifecycle and module interfaces remain the next implementation phases.
Use fresh prefixes with the L.3 reproduction commands for local screenshot and
accessibility checks. `m3-prepublication.json` and `m3-readiness.json` record the
source, baseline repository/Pages configuration, workflow IDs and capture pins.
Published milestone: `c4b477d`. Built-in Pages run `45738349021` succeeded for
that exact commit. Live HTTPS checks confirm M3 metadata, M3 Done/M4 In progress,
all 108 source assets, nested custom 404 and all 278 public PNG hashes. Published
normal resources total 490847 bytes excluding fonts. Repository CI IDs are unchanged.
See `m3-deployment.json` and `m3-live-check.json` for the publication receipt
and full remote audit. The milestone and verification-receipt commits use skip-ci
with fast-forward main pushes.

## L.3 — final site acceptance

[Implementation, automated evidence and reproduction](L.3.md). Final checks
include 27 axe scans with zero violations, full keyboard navigation, exact
HTTP asset bodies, a strict 500,000-byte budget (490,716 bytes excluding fonts)
and eight fresh full-page captures. Pixel comparisons preserve the Figma
geometry outside documented text-color changes; the expanded mobile menu
keeps hero content uncovered. All 190 M3 PNGs meet the 300 KB limit.
The remaining task is the M3 milestone push and live deployment verification.

## L.2 — metadata, social preview and 404

[Implementation, automated evidence and reproduction](L.2.md). Shared v2
Open Graph/Twitter metadata now points to a reproducible 1200×630 Playwright
PNG. The verified Figma favicons, shared-style nested 404 recovery and accurate
agent documentation pass 12 browser contexts, with 12 PNGs below 300 KB.
L.3's full acceptance/axe pass and the M3 deployment remain next.

## L.1 — Figma landing implementation

The static `docs/index.html` now follows desktop Figma `27:220`, mobile `31:933`
and Files `49:1132`. It loads generated app/site tokens, local Latin variable
Geist/Geist Mono, `site.css` and one small event-driven script. There is no
site framework, build requirement, CDN, analytics or resource request to another
origin. All 13 milestone rows remain ordinary HTML; M2 stays Done and M3 stays
In progress until the M3 publication task.

Desktop includes Nav, Hero, Live activities, Downloads, Notes, Files, Tools,
Modes, Privacy, Progress, final CTA and Footer in source order. At 1440 pixels,
the content is 1120 pixels wide at x=160 and the page is 7113 pixels high, with
every section boundary matching Figma. The 390-pixel design uses 20-pixel side
padding, compact HTML/CSS previews, its native menu and an All 13 milestones
disclosure. It omits standalone Live/Modes and the large final-CTA copy as in the
mobile frame. Required behavior adds the full development notice, Send to Nabbit
bookmarklet and current Done/Screenshots rows; these account for the mobile page
being 3696 pixels high rather than the original 3581. The simulated tray remains
linked from the footer.

The three 2× Figma composites (`27:273`, `27:499`, `27:607`) were exported through
the read-only asset-download tool and encoded as WebP without resizing. Their
dimensions are 2240×940, 1192×1120 and 1192×1120; encoded sizes are 62,496,
75,000 and 81,200 bytes. Small previews are static HTML/CSS. All 91 SVG assets
retain their original exported bytes and intrinsic dimensions. The manifest in
`docs/assets/landing-manifest.json` pins source nodes, geometry and SHA-256;
temporary Figma URLs and original large PNG exports stay in ignored tooling.
The pinned app fonts supply Latin subsets of 34,960 and 36,064 bytes, with the
original SIL OFL and source/output hashes. Optional regeneration needs
`fonttools[woff]` 4.63.0: `python scripts/subset-site-fonts.py`.

`npm run verify:site` passes base-path links/resources, ordered milestone states,
three Follow the build CTAs, exact pre-release copy, demo/404, original asset
pins, font licenses and app/site token byte parity. Its conservative total across
the landing, simulated demo, 404 and llms resources is **495,793 bytes excluding
fonts**, under 500,000 bytes. The releases API returned no releases during this
task, so no installer CTA is shown. Send to Nabbit copies the draggable
bookmarklet; it never launches a download on the landing.

`l1-final-browser-checks.json` records eight local `/nabbit/` browser contexts:
1440/390 × light/dark × 1×/1.5×. Each passes actual custom-font glyph auditing,
original served SVG bytes and rendered dimensions, decoded images, overflow,
zero runtime/network errors and zero third-party resource requests. Mobile tests
exercise Enter/Tab/Escape, visible focus, menu close/link targets and the roadmap
disclosure. Mocked clipboard success/failure tests verify the exact copied
bookmarklet and percent-encoded destination without touching the real clipboard
or launching the protocol. Light/dark captures are identical because this Figma
landing stays light except for its Privacy band. Additional 320, 600, 601, 900,
901, 1200 and 1201 widths pass overflow, loading and disclosure-state checks in
`l1-responsive-checks.json`.

All eight full pages were visually reviewed against the Figma section contexts.
`l1-final-tiles.json` records **80 PNG tiles**, largest **274,145 bytes**. Tiles
retain device pixels without resizing or quantization; decoding and reassembling
them reproduces each original full-page raster exactly. The manifest includes
the full-source PNG hashes, pixel hashes and physical crop rectangles. Full PNGs
remain in ignored `.tools/landing-captures/l1-final/` because some exceed the
300 KB publication limit.

Automated reproduction, using a fresh prefix:

```powershell
npm run verify:site
node scripts/verify-landing.mjs --prefix local-landing-proof
python scripts/split-landing-captures.py --prefix local-landing-proof
```

The browser tool serves `docs/` directly under `/nabbit/` with its own loopback
preview and isolated Chromium contexts, then closes its owned resources. Existing
report prefixes are refused. No production build is needed to serve this site.

Staged secret scanning found no leaks. A separate audit reads staged Git blobs
to confirm asset/font/token pins and lossless screenshot reconstruction survive
Git's text normalization.

Required repository checks also pass: `npm run verify` (43 frontend/script tests,
typecheck/lint, asset/token/font pins, four-entry build and 46,346 / 120,000 gzip
island JS budget), Rust formatting, Clippy with warnings denied and 39 Rust tests.
No application/native behavior changed in L.1. Metadata/OG/404/llms updates remain
L.2; the full axe/site acceptance pass remains L.3. This task is committed locally
to main with skip-ci; publication waits for the M3 milestone.
