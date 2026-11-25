# Geist 1.9.2

Unmodified, upright variable fonts from the [official release](https://github.com/vercel/geist-font/releases/tag/v1.9.2), licensed under the bundled [SIL OFL](OFL.txt). No italic faces are shipped. `manifest.json` pins the source archive, original paths, sizes and SHA-256 hashes.

`src/styles/fonts.css` loads WOFF2 from the app bundle without a CDN or `local()` lookup. The native compact renderer embeds the TTFs and builds an isolated DirectWrite collection on first live use. It verifies Geist Regular and Geist Mono Medium without simulated weights. Nothing is installed in Windows. The full upstream glyph sets are preserved; the landing's Latin subset is a separate Phase L task.

The installer also includes the OFL as a Tauri resource. Updating these files requires updating their manifest and rerunning `npm run verify:fonts` plus the browser and native font checks documented in `progress/v2/M2/README.md`.
