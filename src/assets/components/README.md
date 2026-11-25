# Foundation assets

Unmodified Figma exports from Nabbit Foundations and the download-options select. `manifest.json` records their source nodes, intrinsic dimensions and SHA-256 hashes. `assets.ts` exposes local Vite URLs; no temporary asset URL is used at runtime.

`DesignIcon` retains each export at its intrinsic size and uses its alpha mask with the shared foreground colour in dark mode. `Toggle` uses the original 34�20 state exports; a token-driven SVG filter recolours the two original fills in dark mode without changing their geometry. Pixel acceptance checks cover both switch colours at 1� and 1.5�. No glyph paths were extracted or redrawn. The progress ring is a dynamic data control with a 70% inner radius.

Run `npm run build:components`, `node scripts/verify-components.mjs`, then `python scripts/verify-component-pixels.py` to verify asset integrity, rendered geometry, keyboard behavior and raster colours.
