# L.2 — publishing metadata and recovery

The landing title and description now describe Nabbit v2's Windows island and
explicit development state. Canonical and Open Graph URL use the GitHub Pages
home. Open Graph and Twitter share the same title, description, large-image
URL and descriptive alternative text; PNG type and 1200×630 dimensions are
declared. Milestone metadata remains M2 until the M3 publication task.

`docs/og.html` is the editable static source for `docs/assets/og.png`. It uses
the shared tokens and Latin Geist/Geist Mono, the unchanged Figma mark and the
landing's original mobile island preview markup/SVGs. The image says Design
preview, V2 in development / Building in public and First v2 release after
milestone M12. No runtime or build step is added to the website.

The Playwright renderer waits for decoded images and real custom-font glyphs,
blocks external resources, renders exactly 1200×630 device pixels and writes
the **78,876-byte PNG** with an input/output hash manifest. `--check` renders
again and compares the PNG bytes and source provenance. Text inputs normalize
CRLF to LF for hashes so a Git checkout cannot invalidate identical sources.
The social image is fetched by sharing crawlers; it is not a browser resource
loaded on a normal landing visit. Canonical/social metadata uses absolute URLs;
HTML/CSS asset references remain relative under `/nabbit/`.

Existing SVG/ICO favicons already come from Figma mark component `12:478`.
They are retained, linked on landing/OG/404 and checked byte-for-byte against
the original 32-pixel variant and generated desktop ICO. The 404 now uses the
same tokens, bundled fonts, typography, buttons and focus rings as the landing.
Its `/nabbit/` base resolves assets from deeply nested missing URLs, it stays
noindex and Back to Nabbit always points to the absolute Pages home. A mobile
navigation-only image rule was scoped to `.site-nav` so it cannot hide the 404
brand mark.

`llms.txt` explains the intended v2 scope, distinguishes planned work and Figma
previews from the accepted v0.1 foundation, retains explicit-download/privacy
rules and links to the actual spec, implementation log, source, setup, license,
privacy and deterministic demo. It does not promise an available v2 installer
or treat all target platforms as verified.

`l2-final-publishing-checks.json` records 12 isolated browser contexts under a
local `/nabbit/` preview: eight 404 contexts (1440/390 × light/dark × 1×/1.5×)
and four fixed-size OG contexts (1200 × light/dark × 1×/1.5×). The nested 404
document is served by a fixture with HTTP 404; CSS/fonts/images use real local
requests. Enter on the focused recovery link navigates to the absolute canonical
URL, intercepted locally and redirected to the local landing without contacting
the public deployment. The landing then exposes the expected title, three
pre-release CTAs, local matching social PNG and accurate llms resource.

All contexts pass actual custom-font glyph auditing, visible original-size
brand marks, image decoding, overflow, focus/navigation and zero runtime/missing
resource/third-party resource failures. OG 1× screenshots equal the published
PNG byte-for-byte. The 12 final PNGs were visually inspected with the Figma
landing/mark as the style reference; **largest 133,092 bytes**. All M3 PNGs
remain under 300,000 bytes. Preliminary screenshots stay in ignored tooling.

Reproduce using an unused screenshot prefix:

```powershell
npm run site:og
npm run site:og -- --check
npm run verify:site
node scripts/verify-site-publishing.mjs --prefix local-publishing-proof
```

Required checks pass: `npm run verify` (43 frontend/script tests, lint/typecheck,
font/icon/token integrity, default four-entry build and 46,346 / 120,000 gzip
island JS budget), Rust formatting, Clippy with warnings denied and 39 Rust
tests. Final lint, metadata/source pins and byte-identical OG regeneration pass
after the mobile logo fix. `verify:site` reports **499,475 bytes excluding
fonts** conservatively across landing/demo/404/llms resources, under 500,000.
The complete axe/landing acceptance pass remains L.3; remote deployment is M3.
L.2 commits directly to main with skip-ci and makes no push, PR, release, tag or
repository workflow change.
