# L.3 — landing acceptance and accessibility

The final landing passes the local `/nabbit/` acceptance checks. Milestone
metadata remains M2, with M3 In progress until the separate publication task.
No production app or native behavior changes in this task.

## Accessibility and keyboard

Pinned development-only `axe-core` 4.14.1 runs locally through Playwright. The
runner enables all default rules, retains complete violations/incomplete results
and uses no exclusions or disabled rules. Its eight 1440/390 × light/dark ×
1×/1.5× contexts run **24 scans with zero violations**: desktop landing/404,
and mobile landing, menu open, roadmap expanded and 404. Three additional
scans of the legacy demo at both widths and the 1200-wide OG source also have
zero violations. See `l3-verified-accessibility.json` and
`l3-verified-auxiliary-axe.json`.

Desktop axe leaves eight indeterminate contrast nodes per context: five labels
over gradients and three captions inside the overlapping Files illustration.
The evidence retains all 32 findings and their reviews. Gradient reviews use
conservative per-channel RGB bounds across the opaque stops, with the standard
luminance formula. The three Files captions are sample text inside a labelled,
noninteractive picture, partly covered by other preview cards; foreground and
own-backdrop ratios are retained as supporting data. The lowest recorded
foreground/backdrop ratio is **6.093755:1**. New or unexpected indeterminate
checks fail the runner. See the [axe API guidance](https://github.com/dequelabs/axe-core/blob/develop/doc/API.md)
and [WCAG contrast guidance, including incidental picture text](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

Initial scans found low-contrast development text, milestone codes/status and
preview captions. Site selectors now use the existing secondary text token,
slightly darken warning text against its soft background and slightly lighten
island pin metadata. App tokens and original SVG/image bytes are unchanged.
The expanded mobile menu now occupies its own header space instead of covering
hero text; the collapsed header retains its original pixels. A missing landmark
around the simulated demo's notice was corrected by changing its div to header.

The keyboard walk exercises the skip link into main, every navigation link,
all visible primary/source CTAs, Enter/Tab/Space/Escape, mobile menu close/focus
return, the native roadmap disclosure and bookmarklet copying. Focus rings
are visible. External repository navigation is intercepted locally before any
network request reaches GitHub. Clipboard writes use an injected fixture, with
no real clipboard or protocol launch. Seven extra widths (320, 600, 601, 900,
901, 1200, 1201) pass overflow/image/error checks; expanded 320/600 menus leave
the hero below the header. Focus/menu evidence is included in the PNGs and
`l3-verified-responsive-checks.json`.

## Figma and image fidelity

Fresh full-page screenshots cover all eight required contexts. At 1440, the
page remains 7113 pixels high with the exact Figma `27:220` section geometry;
mobile follows `31:933` plus the previously documented pre-release behavior.
Files remains based on `49:1132`. Actual custom fonts, original served SVG
bytes/intrinsic dimensions, all decoded images, disclosures and bookmarklet
success/failure pass. All 91 original SVGs and the three 2× WebPs retain their
source pins; no raster or SVG artwork was redrawn.

`l3-verified-fidelity-checks.json` independently reconstructs the old L.1 and
current screenshots from their lossless published tiles. Across every device
pixel, dimensions are identical and all changed pixels lie within the documented
text-color rectangles. This also proves that removing unused layer-name HTML
attributes and changing the collapsed menu layout rules did not shift the page.
The current captures were visually compared with the Figma section references.
All eight before/after simulated-demo PNGs are byte-identical despite its new
banner landmark (`l3-verified-demo-landmark.json`).

This task adds **98 PNGs**: 80 full-page tiles, eight focus captures, two menu
breakpoint captures and eight demo captures. Largest new PNG: **273,995 bytes**.
The complete M3 folder now has **190 PNGs**, largest **274,145 bytes**; every
file is under 300,000 bytes. Tiles preserve device pixels without resampling.
The regenerated social PNG is still byte-identical at 78,876 bytes; its source
manifest was refreshed for the stylesheet change.

## Assets, budget and repository checks

`verify:site` now enforces a strict **500,000-byte** ceiling excluding fonts.
The conservative aggregate across landing/demo/404/llms resources is
**490,716 bytes**. Removed 212 unused Figma layer-name attributes from the
landing markup, keeping node IDs and all content. This leaves room for future
milestone screenshot links. Original artwork, tokens and font sources remain
pinned. Shared app/site tokens match byte-for-byte.

`l3-verified-site-assets.json` records every normal resource and its exact bytes.
`l3-verified-http-assets.json` confirms **108 HTTP 200 bodies** under `/nabbit/`
match their source, including the separately fetched social source/PNG/provenance.
Internal links/anchors, all 13 ordered milestone rows, three pre-release CTAs,
canonical/social metadata, nested 404, demo and agent documentation pass.
Browser tests record zero runtime/missing-resource/third-party-resource errors.

Required checks pass: `npm run verify` (43 frontend/script tests, typecheck/lint,
font/icon/token pins, production build), Rust formatting, Clippy with warnings
denied and 39 Rust tests. Initial island JS remains **46,346 / 120,000 gzip
bytes**. Every production chunk excludes axe-core, Playwright and site-verifier
code. `npm audit --omit=dev` reports zero vulnerabilities; existing development
advisories were not changed by this single pinned test dependency.

Reproduce with unused output prefixes/paths:

```powershell
npm run verify:site
node scripts/verify-site.mjs --report progress/v2/M3/local-assets.json
node scripts/verify-site-http.mjs --assets progress/v2/M3/local-assets.json --report progress/v2/M3/local-http.json
npm run verify:site:accessibility -- --prefix local-accessibility
node scripts/verify-landing.mjs --prefix local-landing
python scripts/split-landing-captures.py --prefix local-landing
python scripts/verify-landing-fidelity.py --baseline l1-final --current local-landing
npm run site:og -- --check
```

The fidelity comparison applies while milestone content remains the same as
L.1; the M3 status/link updates intentionally change that content. Each runner
owns and closes its local server/browser and refuses existing report paths.
No live app, real account, user profile, OS setting or manual test is involved.
L.3 is committed locally to main with skip-ci. The M3 push and live Pages
deployment check remain the next task.
