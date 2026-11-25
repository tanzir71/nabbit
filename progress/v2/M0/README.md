# M0 evidence

## M0 — Public repository and Pages

The `m0-*` captures show the publication state: M0 Done with its Screenshots link,
M1 In progress, and milestone metadata `M0`. They use the same automated browser
matrix and checks as P.4 below. The milestone push and live deployment result
will be recorded here after verification.

## P.4 — Pages publishing state

The existing v0.1 landing now points to `https://tanzir71.github.io/nabbit/`.
It has three pre-release primary CTAs, the M0–M12 list, a nested-path-safe 404,
and relative local assets. M0 is **In progress** in the `p4-*` captures; its
milestone commit will update M0 to Done and M1 to In progress.

Figma references inspected: Progress `29:965` and Hero `27:246` in the Nabbit
file. The new list follows the reference's 1120px container, 16px corners,
44px rows, badges, and original 16×16 SVG icons. Milestone names follow the
handoff. Metadata uses secondary text colour for readability. The existing
landing and system-font stack remain until the foundations and Phase L tasks;
these captures do not claim the complete v2 landing design is implemented.

Automated browser checks ran against **Vite preview under `/nabbit/`**:

- Widths 1440 and 390, colour preferences light and dark, device scales 1 and 1.5.
- Keyboard activation of the navigation CTA reaches the milestone list; its
  focus ring is visible in the landing captures.
- All 13 status rows render, and the original icons load at 16×16 logical px.
- The footer demo link opens the preserved simulation and Stage reveals its
  synthetic Download action.
- The 404 recovery target remains the site root even from a nested missing URL.
- No horizontal overflow, third-party resource requests, runtime errors or
  missing resources.
- 24 PNGs, each below 300 KiB (largest: 172,193 bytes). The legacy landing and
  404 intentionally keep their existing dark appearance in both preferences.

The complete browser matrix and image sizes are in `p4-site-checks.json`.
`npm run verify:site` also validates canonical/OG/README/llms links, every current
internal anchor and resource under the Pages base, pre-release CTAs, milestone
status order and screenshot links, and the 500 KiB transfer budget excluding fonts
(31,638 bytes for the checked pages and resources).

Reproduce the automated capture with an isolated QA runtime:

```powershell
npm install --prefix .tools/site-qa --no-audit --no-fund --ignore-scripts playwright@1.65.1
.\.tools\site-qa\node_modules\.bin\playwright.cmd install chromium
node scripts/capture-site.mjs progress/v2/M0 p4
```

The app-wide IPC screenshot harness remains V1.6. No Vercel config, repository
workflow or simulated demo source was changed in P.4. Publication is the M0 task.
