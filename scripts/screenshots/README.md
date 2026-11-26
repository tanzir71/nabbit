# Automated UI screenshots

The runner builds the opt-in component preview plus the four production entries,
starts its own loopback Vite preview, and captures every selected scenario in
light/dark at device scales 1 and 1.5. Each scenario gets a fresh Chromium context
and explicit Tauri IPC fixtures before the app loads. No native process, real
clipboard, user profile, download engine or OS preferences are involved.

```powershell
npm ci
npm run screenshots:install
npm run screenshots -- --milestone M2 --prefix local-proof --repeat-check
```

Choose a unique prefix on each run. PNGs and a JSON manifest are written under
`progress/v2/M2/`; `--milestone` accepts M0–M12. Existing files are never
overwritten. `--suite surfaces` selects tray downloads, tray clipboard, settings,
unbound sticky and idle island; `--suite foundations` selects the brand and core
controls. The default `all` produces 28 PNGs. The island stays dark even when the
context's system appearance is light. Run `npm run build` afterwards to restore
the default four-entry production build.

The screenshot pass waits for state-specific readiness, fonts and image decoding,
disables CSS animation during capture and hides carets. It fixes Date/time,
locale and timezone while leaving timers/animation scheduling functional.
Device-scale PNG dimensions and the 300 KiB limit are enforced. With
`--repeat-check`, a second capture must have the same SHA-256. The report includes
the actual browser/Playwright/Node versions, build-manifest hash, fixture hashes,
dimensions, resolved appearance, audited custom Geist glyphs and every IPC call.

Unexpected native commands, console/page errors, failed HTTP requests, outbound
requests, WebSockets, browser downloads, dialogs or popups fail the run. Fixtures
deny unknown commands rather than falling back to empty success responses.
No evidence is published before every selected scenario passes. Browser contexts,
Chromium and the owned preview server close on success and failure. Error messages
identify the scenario, theme and scale.

Optional independent raster inspection uses Python/Pillow (already available in
the implementation workspace):

```powershell
python scripts/screenshots/verify-captures.py --milestone M2 --prefix local-proof
node scripts/screenshots/verify-failures.mjs --milestone M2 --prefix local-proof
```

The first command independently decodes every PNG, verifies complete matrix
coverage, dimensions/hashes/budgets, actual theme pixels and transparent dark
island pixels. On the recorded Windows renderer it also checks the brand against
the Figma-reviewed V1.5 baseline. The second deliberately emits a console error
and blocked external fetch: the runner must reject them, publish no screenshots
and release all owned resources. These validation reports also use exclusive
creation; choose another prefix to run them again.

To add a state, extend `scenarios.mjs` with a unique name, local root HTML entry,
viewport, fixture label, `ready(page)` function and optional crop selector,
transparency flag, font-audit selector or Figma node. Add data in `fixtures.mjs`
and explicit command responses in `mock-ipc.mjs`. The mock exposes a browser-only
`__NABBIT_CAPTURE__` helper to patch fixture data and push typed-event payloads;
the download scenario exercises this with a 37% → 68% progress event. For a
separate suite, import `captureSuite(root, options, cases)` with your scenario list.
All harness code is outside production imports and build entries.

`mock-ipc.test.js` runs through the actual Tauri JS client to cover cloned read/
save responses, isolated reset, window labels/theme, events/unlisten, no-op copy,
explicit failures and unknown-command rejection. `policy.test.js` covers path
arguments, physical screenshot dimensions and byte budgets. Both run with the
existing `npm run verify`; installing browsers is needed only for captures.

These screenshots document the current interfaces. They do not claim completion
of later island/module/widget/window-lifecycle work or replace native performance
measurements. Earlier task-specific verifiers and historical evidence are kept.

References: [Playwright screenshots](https://playwright.dev/docs/api/class-page#page-screenshot),
[isolated contexts](https://playwright.dev/docs/api/class-browsercontext),
[fixed clock](https://playwright.dev/docs/api/class-clock).
