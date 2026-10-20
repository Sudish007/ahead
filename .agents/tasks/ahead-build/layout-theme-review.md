# Review: fluid layout + selectable theme (iteration 1)

Verdict: **APPROVED** (no blocking findings).

Reviewed: local commits `9116bfa` (feat) and `4aa40da` (test/evidence) on `main`, ahead of `origin/main` (`020066b`). Diff read in full for `index.html`, `app.js`, `styles.css`, `tests/frontend.test.js`, `tests/client-state.test.js`; the plan (`layout-theme-plan.md`), the verification note (`layout-theme-verification.md`) and the raw evidence (`layout-theme-evidence.json`) were read; screenshots were opened and inspected as listed below. `npm test` and the Playwright script were not re-run; the recorded results were used. One narrow spot-check was run (SHA-256 of the inline bootstrap vs the CSP hash, see §7).

## 1. Scope and constraints

- `git diff --name-only origin/main..HEAD -- package.json package-lock.json scripts src sources.config.mjs relay data .github` returns nothing: no change to the pipeline, ranking, sources, relay, data, workflow, or dependencies.
- Files changed: `index.html` (+7/-2), `app.js` (+53/-6), `styles.css` (+117 rewritten lines), two test files, `.agents/tasks/ahead-build/*` (plan, note, script, evidence), `docs/screenshots/*` (9 old removed, 40 new).
- `styles.css` contains no `@import`, `@font-face`, or `url(`: system font stack only, no web fonts. No build step, framework, or runtime dependency added (Playwright is imported by `file://` URL from another checkout in the verification script only, which lives under `.agents/` and is not part of the deployed site).
- Sizes recorded under the pinned budgets: `index.html` 5,881 B, `app.js` 33,234 B, `styles.css` 11,298 B.

## 2. Layout (brief items 1a-1e)

Diff (`styles.css`): `body { max-width: 2200px; padding: 0 clamp(16px, 3vw, 64px) 40px; font-size: 1rem; line-height: 1.5; overflow-wrap: anywhere }`, `html { font-size: clamp(15px, 12.5px + 0.3vw, 18px) }`, `.sections, .rows` explicit 1/2/3/4 columns at 900/1500/2100 px with `.section[data-key="must-know"] { grid-column: span 2 }` from 1500 px, `.cards`/`.learn-groups`/`.archive-list` auto-fill/auto-fit grids, overview prose `columns: 42ch 3`, `font-variant-numeric: tabular-nums` kept. `app.js` adds the three wrappers (`div.sections`, `div.rows` on both the normal and Saved paths, `div.learn-groups`) and `sec.dataset.key`.

Recorded evidence (`layout-theme-evidence.json`, matches the note's tables): `.sections`/`.rows` columns 1 at 360/390, 2 at 1024/1440, 3 at 1920, 4 at 2560/3840; body width capped at 2200 px from 2560 up; Must know width 1197.9 px vs 590.9 px for Research at 1920 and 1028 vs 506 at 2560 (span in effect), equal widths below 1500; overview max line length 66.9 ch (≤ 80 ch at every width); root font 15 px → 18 px.

Screenshots inspected:
- `brief-2560-light.png` (2560×1762): content spans the full 2200 px container (~180 px margin per side), overview in three columns, Must know spans two of four columns with Research and Releases & tools beside it, Labs / Analysis / One deep read on the second row. Entries keep numbering, title / meta / summary / why-line. Cursor highlight (blue outline + tinted background) on entry 1. AI-WRITTEN badge, links, health dot, theme glyph (☀) all legible.
- `brief-2560-dark.png`: same geometry in the dark palette; badge, why-lines (amber), links, cursor outline visible.
- `brief-1920-light.png` (1920×1931): three columns, Must know spanning two, Research right; Releases / Labs / Analysis row 2; One deep read row 3. Fills the width (3vw padding).
- `research-2560-light.png`: four columns of row cards, sticky filter row (5 source chips, Saved/24h/3d/7d, search) above, "Also: alphaXiv" line; score pills, inline source chips, ✓/☆ actions legible in light.
- `research-1920-dark.png`: three columns of row cards, same filter row, cursor on the first card.
- `brief-390-light.png` and `brief-390-dark.png` (390×4697, cropped and inspected at full resolution top/middle): single column, overview in one column, sections stacked as cards, nothing clipped horizontally; tablist scrolls internally as before (pre-existing). The theme button wraps onto its own line under the status text (cosmetic, see §8).
- `research-390-light.png`: single-column row cards, chips wrap, filters stacked, no clipping.
- `archive-1920-light.png`: catch-up button + "1 days archived" + day card grid. `learn-1920-light.png`: three group cards with native checkboxes rendered light (color-scheme in effect).

## 3. No horizontal scroll (brief item 1d)

Recorded `document.documentElement.scrollWidth` equals `window.innerWidth` for all 70 measurements (7 widths 360/390/1024/1440/1920/2560/3840 × 5 tabs × 2 themes). Tablist at ≥ 1024 fits without internal scroll (963/963, 1354/1354, 1805/1805, 2072/2072).

## 4. Theme toggle (brief item 2)

Diff: `#theme` button in `.status` with `aria-label="Theme: System"` and a glyph via `::before` (◐/☀/☾, `currentColor`); `sanitizeTheme`/`nextTheme` exports (System → Light → Dark → System); `S.theme` from `store.get('ahead:theme', sanitizeTheme)`; `applyTheme()` sets/removes `data-theme` on `<html>`, updates `aria-label`/`title`/`data-mode`, and writes the computed `--bg` into `meta#theme-color`; `cycleTheme()` persists via `store.set('ahead:theme', …)` (JSON-encoded, matching the other `ahead:` keys); `case 't'` in the existing keydown switch, which already returns early for inputs and modifier keys; `prefers-color-scheme` change listener re-applies in System mode. Palettes: dark in `:root`, light twice with identical declaration lists (`@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) }` and `:root[data-theme="light"]`), `color-scheme` moves with the tokens; parity is asserted by a unit test. Tokens cover background, panel, border (+ `--line-strong` for controls), text, muted, accent (links, focus ring, cursor outline), visited, why, cursor background, read opacity, badge bg/fg, ok/warn/bad.

Inline bootstrap: single-line `<script>` in `<head>` after the `theme-color` meta and before the stylesheet; reads `localStorage['ahead:theme']` (JSON, try/catch), sets `data-theme` for `light|dark`, sets `theme-color` from the stored theme or `matchMedia('(prefers-color-scheme: dark)')`. CSP `script-src` gains one `'sha256-…'` source for exactly this script (see §7).

Recorded evidence (`theme.steps`): load with nothing stored → attribute absent, bg `rgb(15,17,21)`, meta `#0f1115`, `color-scheme: dark`, label "Theme: System"; click → `light` / `rgb(250,250,250)` / `#fafafa` / `light` / "Theme: Light" / stored `"light"`; click → `dark`; click → attribute absent, stored `"system"`; `t` → light; `page.reload()` → `data-theme="light"` already present when `<body>` was created (`__themeAtBody === 'light'`); `t` + reload → dark, `__themeAtBody === 'dark'`; OS-light context with nothing stored → light via media query; OS-light with stored `"dark"` → forced dark. `t` typed inside `#search` does not change the theme. Across the 14 full page loads of the layout pass `__themeAtBody` equalled the seeded theme every time (no flash). Screenshots show the glyph changing (☀ in light, ☾ in dark captures).

## 5. Contrast (brief item 2c)

Recorded computed-colour ratios (`contrast.light`, 39 pairs) all pass their thresholds. Key light pairs: body `#111` on `#fafafa` 18.09; muted `#555` on `#fafafa` 7.14 and on `#fff` 7.46; link `#0a58ca` on `#fafafa` 6.17 / on `#fff` 6.44; why-line `#7a5200` on `#fff` 6.92; AI-WRITTEN `#1e4a8f` on `#dbe7fb` 6.92; pressed chip text `#fafafa` on `#0a58ca` 6.17; score pill / inline chip `#555` on `#eee` 6.43; control border `#767f8a` on `#fafafa` 3.89 (≥ 3); cursor outline `#0a58ca` on `#e8f0fe` 5.62 (≥ 3); health dots green/amber/red on `#eee` 6.30 / 5.11 / 5.67 (≥ 3); read-dimmed title (opacity 0.7) 7.15; read-dimmed check icon 3.29 (≥ 3). Dark pairs (39) also pass: body 15.56, muted 7.39, link 9.04, badge 7.66, control border 3.30, dots 7.62/9.88/6.31. The `--ok` light value was darkened from the planned `#1a7f4b` to `#13633a` after the first run measured the dimmed read icon at 2.64:1; this is recorded and the new value passes.

## 6. Keyboard navigation (brief item 1e)

Recorded (`keyboard`): Brief at 2560 (4 columns, 15 entries): cursor 0 → `j` 1 → `k` 0 → `j`×4 → index 4 = first Research entry, `left` 1331.8 px vs 287.8 px for entry 0 (next column, so DOM order = row-major visual order), rect inside the viewport, computed outline `2px solid rgb(122,183,255)` = `--accent`; `o` opened `https://arxiv.org/abs/2610.22791` = the current entry's `data-url`. Research (100 rows): `j`,`j`,`k` → index 1; `o` opened its `data-url`; `r`/`s` toggled `.is-read`/`.is-saved` and persisted to `ahead:read`/`ahead:saved`, toggled back; `/` focused search, `Escape` blurred; `2` then `1` switched tabs. Sticky bars at 1440 after a 2000 px scroll: nav 0–49.6, filters top 50.0, `--sticky-h` 106 px; over 24 `j` + 24 `k` the current row never went under the filter row (min gap 7.64 px). Source: `rows()` still uses `panel.querySelectorAll('.row, .entry')` in DOM order; grids have no `grid-auto-flow: dense`, so visual order equals DOM order; `.row, .entry { scroll-margin-top: calc(var(--sticky-h) + 8px) }`.

## 7. Must-survive behaviours and tests

- Unchanged in the diff: tab routing, `KEY_TABS`, `[data-range]` handlers, `#saved-chip`, search debounce, `toggleRead`/`toggleSaved`, `renderHeader` (health dot, "N sources" text), `renderArchive`/`renderCatchUp` (only the per-day `renderDigest` now emits a `.sections` grid), Learn checkbox handling, data fetch paths. The Saved path and the normal path of `renderCategory` both wrap rows in `div.rows`; `.more` still follows the grid.
- Recorded `npm test`: 260 tests, 260 pass, 0 fail (258 baseline + the two new tests). The pre-existing Windows CRLF failure in `tests/relay-allowlist.test.js` was cleared by a line-ending-only re-checkout of `relay/src/allowlist.json` (no content change, `git status` clean); unrelated to this change.
- Spot-check run by the reviewer: SHA-256 of the inline script body in `index.html` = `yWrjz1/zOM/G7P7hh4kLtN+/Y0Nejh36/84NtaOa5RU=`, listed in the CSP, exactly one inline script, single line. Playwright ran with the page CSP active and recorded 0 console errors, 0 page errors, 0 failed requests, 0 responses ≥ 400.

## 8. Non-blocking observations (no action required for approval)

1. `index.html`/`styles.css` `.status`: at 390 px the theme button wraps onto its own line under the status text (visible in `brief-390-*.png`, `research-390-light.png`). Functional, slightly uneven; the coder recorded it. Cosmetic.
2. `styles.css` `.chip { border-color: var(--line) }` and card borders use `--line` (`#ddd` on `#fafafa` ≈ 1.30:1 in light). These boundaries are decorative: chips and cards are identified by their text (16.28:1) and fill, and the pressed state uses the accent fill (6.17:1), so this is not a WCAG 1.4.11 failure; interactive control borders (buttons, search, selected tab) use `--line-strong` at 3.89:1. Same as the pre-existing design.
3. Read-dimmed meta text measures 3.57:1 (light) and 3.25:1 (dark), below 4.5:1 but above 3:1; the dimmed title stays ≥ 4.5:1 (7.15 / 5.87). This is the plan's documented trade-off for a deliberately de-emphasised state and improves on the previous dark opacity 0.55.
4. Filters are sticky only from 900 px; below that they scroll with the page (plan decision to save vertical space on phones). The brief's optional chip sidebar was not built (plan rejects it with reasons; the brief marked it optional).
5. Storage key is `ahead:theme` (the brief's example was `ahead.theme`, "key like"); it follows the existing `ahead:` convention and is used consistently by the bootstrap, `app.js`, and the tests.
6. CSP gained a single hash source for the bootstrap because the deploy workflow copies a fixed file list and cannot ship a new `theme.js`; the test pins the hash to the script body so any edit to the script without re-hashing fails `npm test`.

## Findings (blocking)

None.
