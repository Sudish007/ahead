# Ahead — fluid layout + selectable theme: local verification (iteration 1)

Repo `c:\Users\sudiskmr\Downloads\DomainClassification\ahead`, branch `main`, built on `020066b` (origin/main at the time; `git pull --rebase origin main` reported "Already up to date"). Nothing pushed in this step.

Commits (local only):

| SHA | content |
|---|---|
| `9116bfa` | `feat(ui): fluid 2200px layout with responsive grids and a System/Light/Dark theme toggle` — `index.html`, `app.js`, `styles.css`, `tests/frontend.test.js`, `tests/client-state.test.js`; also removes the nine old `docs/screenshots/*.png` of the fixed-width layout (`brief-1440.png`, `brief-390.png`, `brief-light-1440.png`, `research-*.png`, `archive-*.png`, `learn-*.png`), which had been staged with `git rm` before the commit |
| (this commit) | `test(ui): …` — `.agents/tasks/ahead-build/verify-layout-theme.mjs`, `layout-theme-evidence.json`, `layout-theme-plan.md`, this note, 40 new `docs/screenshots/{tab}-{width}-{theme}.png` |

Files touched: `index.html`, `app.js`, `styles.css`, `tests/frontend.test.js`, `tests/client-state.test.js`, `docs/screenshots/`, `.agents/tasks/ahead-build/`. Not touched: `scripts/`, `src/`, `sources.config.mjs`, `relay/` (content), `data/`, `.github/workflows/refresh.yml`, `package.json`. No dependency, framework, build step or web font added. Sizes after the change: `index.html` 5,881 B (< 10 KB budget), `app.js` 33,234 B (< 60 KB), `styles.css` 11,298 B (< 15 KB).

## 1. What changed (summary; the plan is `layout-theme-plan.md`)

- **Container and type**: `body { max-width: 2200px; padding: 0 clamp(16px, 3vw, 64px) 40px; font-size: 1rem; line-height: 1.5; overflow-wrap: anywhere }`, `html { font-size: clamp(15px, 12.5px + 0.3vw, 18px) }`; every absolute px type size converted to rem (tabs 0.85rem, chips/meta 0.8rem, rows/entries 0.9rem, titles 0.95rem, headings 1rem). Measured root font size: 15px at 360/390, 15.57px at 1024, 16.82px at 1440, 18px at 1920 and above. Body width: 360 → 360, 390 → 390, 1024 → 1024, 1440 → 1440, 1920 → 1920, 2560 → 2200 (cap), 3840 → 2200.
- **Grids**: `app.js` wraps the Brief sections in `div.sections` (each `section.section` gets `data-key`), category rows in `div.rows` (normal and Saved paths), Learn groups in `div.learn-groups`. `styles.css`: `.sections, .rows` = 1 column, 2 at `(min-width: 900px)`, 3 at `1500px` (+ `.section[data-key="must-know"] { grid-column: span 2 }`), 4 at `2100px`; `.cards` `repeat(auto-fill, minmax(min(100%, 20rem), 1fr))`; `.learn-groups` `auto-fit` 22rem; `.archive-list` `auto-fill` 14rem. Overview prose `columns: 42ch 3`. Sections, rows, learn groups and archive days are bordered cards on `--panel`.
- **Sticky filters / cursor**: `.filters` sticky under the nav from 900px (`top: var(--nav-h)`); `app.js` measures `--nav-h` / `--sticky-h` with a `ResizeObserver` and after every `render()`; `.row, .entry { scroll-margin-top: calc(var(--sticky-h) + 8px) }`; cursor row/entry: `background: var(--cursor-bg); outline: 2px solid var(--accent)`.
- **Theme**: `<meta name="theme-color" id="theme-color">` + a single-line inline `<script>` in `<head>` (before the stylesheet) that reads `localStorage['ahead:theme']` (JSON), sets `data-theme="light|dark"` on `<html>` and the theme-color; its SHA-256 (`yWrjz1/zOM/G7P7hh4kLtN+/Y0Nejh36/84NtaOa5RU=`) is listed in the CSP `script-src`. `#theme` button in the header (glyph ◐/☀/☾ via `::before`, `aria-label="Theme: System|Light|Dark"`), `t` shortcut, `sanitizeTheme`/`nextTheme` exports, `applyTheme()` also follows `prefers-color-scheme` changes while in System mode. Palettes: dark `:root`, light twice with identical declaration lists (`@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {…} }` and `:root[data-theme="light"] {…}`), `color-scheme` moves with the tokens. New tokens: `--line-strong`, `--cursor-bg`, `--tag-bg`, `--tag-fg`, `--visited`, `--read-opacity` (dark 0.6, light 0.7).
- **Deviations from the brief/plan**: (a) the inline bootstrap needs a CSP hash because the page ships `script-src 'self'`; `tests/frontend.test.js` now asserts exactly one single-line inline script whose hash matches the CSP. (b) No chip sidebar on very wide screens (the brief said "optionally"; the plan rejects it, the sticky filter row fits every chip on one line at ≥ 1500px). (c) Light `--ok` changed from the planned `#1a7f4b` to `#13633a`: the first run measured the green read-check icon inside a dimmed (opacity 0.7) row at 2.64:1; `#13633a` gives 3.29:1 there and 6.30:1 for the health dot. (d) `.status` gap tightened to `6px 14px` because at 390px the new theme button wraps under the status text. (e) `body` has no background of its own (`<html>` paints the canvas), so the "body background-color changes" assertion reads `getComputedStyle(html).backgroundColor` and additionally checks `body`'s computed `color`.

## 2. Commands run and results

| command | result |
|---|---|
| `git -C …/ahead status` → clean except untracked `layout-theme-plan.md`; `git -C …/ahead pull --rebase origin main` | `Already up to date.` at `020066b` |
| `npm test` (baseline before edits) | `tests 258, pass 257, fail 1` — the failure is `tests/relay-allowlist.test.js` because `relay/src/allowlist.json` was CRLF in the working copy (`core.autocrlf=true`); fixed locally with `Remove-Item relay/src/allowlist.json; git -c core.autocrlf=false checkout -- relay/src/allowlist.json` (working copy now LF, `git status` shows no diff, file content unchanged) → `tests 258, pass 258, fail 0` |
| `node --test tests/frontend.test.js tests/client-state.test.js` (after edits) | `pass 14, fail 0` |
| `npm test` (after edits) | **`tests 260, pass 260, fail 0, skipped 0`** (48.3 s) — 258 + `styles.css: fluid container, grids, both themes defined identically` + `theme sanitizer and cycle` |
| `node -e "…createHash('sha256')…"` on the inline script | `yWrjz1/zOM/G7P7hh4kLtN+/Y0Nejh36/84NtaOa5RU=` (single line, 341 chars) |
| `node .agents/tasks/ahead-build/verify-layout-theme.mjs` (run 1) | 1 failure: page errors from the init script calling `localStorage` inside the `noopener` popups (`Access is denied for this document`) — a test-harness bug, fixed with a try/catch; also found the 2.64:1 read-icon pair above |
| `node .agents/tasks/ahead-build/verify-layout-theme.mjs` (run 2, after `--ok` change) | **`PASS`, exit 0, `failures: []`**, Chromium 156.0.8078.4, evidence in `layout-theme-evidence.json` (`generatedAt` 2026-10-20T15:11:54Z) |
| `npm test` after the script run | `tests 260, pass 260` (the script touched nothing under `tests/`) |

The script imports Playwright 1.64.0 from `C:/Users/sudiskmr/Downloads/DomainClassification/hoshlab/node_modules/playwright/index.mjs` (file URL, not a dependency), probes `http://127.0.0.1:8787/ahead/` and, when nothing answers, spawns `node scripts/serve.mjs` with `PORT=8787` and kills it at the end (the IDE tool refused to start `npm run serve` as a background process, so the script's own spawn was used). Popups opened by `o` are routed to a stub response so no third-party site is contacted; the page's own CSP stays active (`bypassCSP` is not used), so a wrong script hash would have shown up as a console error.

## 3. Horizontal overflow (`document.documentElement.scrollWidth <= window.innerWidth`)

Every width × theme × tab passed; scrollWidth equalled innerWidth exactly in all 70 measurements:

| width (viewport height) | brief | research | archive | learn | leaderboards |
|---|---|---|---|---|---|
| 360 (844) | 360/360 | 360/360 | 360/360 | 360/360 | 360/360 |
| 390 (844) | 390/390 | 390/390 | 390/390 | 390/390 | 390/390 |
| 1024 (1200) | 1024/1024 | 1024/1024 | 1024/1024 | 1024/1024 | 1024/1024 |
| 1440 (1200) | 1440/1440 | 1440/1440 | 1440/1440 | 1440/1440 | 1440/1440 |
| 1920 (1200) | 1920/1920 | 1920/1920 | 1920/1920 | 1920/1920 | 1920/1920 |
| 2560 (1200) | 2560/2560 | 2560/2560 | 2560/2560 | 2560/2560 | 2560/2560 |
| 3840 (1200) | 3840/3840 | 3840/3840 | 3840/3840 | 3840/3840 | 3840/3840 |

(same numbers in light and dark). Tablist: all ten tabs visible without internal scrolling at ≥ 1024 (`scrollWidth == clientWidth`: 963/963, 1354/1354, 1805/1805, 2072/2072); at 360/390 the tablist scrolls internally (881px of tabs) as before, the page does not.

## 4. Grid columns per tab per width (`getComputedStyle(grid).gridTemplateColumns`, non-zero tracks)

| width | root font | body width | `.sections` (Brief) | `.rows` (Research) | `.cards` (Leaderboards, 8) | `.learn-groups` (3) | `.archive-list` (1 day) | overview columns / line length |
|---|---|---|---|---|---|---|---|---|
| 360 | 15px | 360 | 1 (328px) | 1 (328) | 1 | 1 | 1 | 1 / 36.4ch |
| 390 | 15px | 390 | 1 (358) | 1 (358) | 1 | 1 | 1 | 1 / 40.1ch |
| 1024 | 15.57px | 1024 | **2** (473 473) | **2** (473 473) | 3 (312 ×3) | 2 (473 ×2) | 4 (230 ×4) | 2 / 53.0ch |
| 1440 | 16.82px | 1440 | **2** (669 669) | **2** (669 669) | 3 (442 ×3) | 3 (441 ×3) | 5 (260 ×5) | 3 / 45.4ch |
| 1920 | 18px | 1920 | **3** (591 ×3) | **3** (591 ×3) | 4 (441 ×4) | 3 (591 ×3, 1 collapsed) | 6 (289 ×6) | 3 / 57.7ch |
| 2560 | 18px | 2200 | **4** (506 ×4) | **4** (506 ×4) | 5 (403 ×5) | 3 (680 ×3, 2 collapsed) | 7 (284 ×7) | 3 / 66.9ch |
| 3840 | 18px | 2200 | **4** (506 ×4) | **4** (506 ×4) | 5 (403 ×5) | 3 (680 ×3) | 7 (284 ×7) | 3 / 66.9ch |

Identical in both themes. "Must know" span: width 328 = research at 360, 358 at 390, 473.28 = 473.28 at 1024, 668.81 = 668.81 at 1440 (no span below 1500), **1197.9 vs 590.9 at 1920 and 1028 vs 506 at 2560/3840** (span 2 in effect). Overview line length stayed ≤ 80ch at every width (max 66.9ch). Six sections / 15 entries rendered at every width; Research rendered 100 rows and 5 source chips; `#filters` computed `position` is `static` below 900px and `sticky` from 1024px up.

Screenshots looked at by eye (`read_file`): `brief-2560-light.png` and `brief-2560-dark.png` (overview in three columns, then Must know spanning two of four columns with Research and Releases & tools beside it, labs/analysis/deep read on the second row, content spanning the full 2200px container), `research-2560-light.png` (four columns of row cards, filter row above), `brief-1920-light.png` (three columns, Must know spanning two), `research-1920-dark.png` (three columns), `brief-1024-dark.png` (two columns, two-column overview), `learn-2560-light.png` (three group cards side by side), `archive-1440-dark.png` (day card grid), `brief-390-light.png` and `research-390-light.png` (single column, nothing clipped). Light theme is legible throughout; the AI-WRITTEN badge, links, chips and the cursor highlight are visible in both themes.

## 5. Theme toggle, persistence, no flash

Fresh context, OS dark (`colorScheme: 'dark'`), 1440×1200, `#brief`:

| step | `data-theme` | `<html>` background | `body` color | `theme-color` | `color-scheme` | button `aria-label` | `localStorage['ahead:theme']` |
|---|---|---|---|---|---|---|---|
| load, nothing stored | (absent) | `rgb(15, 17, 21)` | `rgb(231, 233, 238)` | `#0f1115` | `dark` | Theme: System | `null` |
| click `#theme` | `light` | `rgb(250, 250, 250)` | `rgb(17, 17, 17)` | `#fafafa` | `light` | Theme: Light | `"light"` |
| click | `dark` | `rgb(15, 17, 21)` | `rgb(231, 233, 238)` | `#0f1115` | `dark` | Theme: Dark | `"dark"` |
| click | (absent) | `rgb(15, 17, 21)` | | `#0f1115` | `dark` | Theme: System | `"system"` |
| press `t` | `light` | `rgb(250, 250, 250)` | | `#fafafa` | `light` | Theme: Light | `"light"` |
| `page.reload()` | `light` | `rgb(250, 250, 250)` | | `#fafafa` | `light` | Theme: Light | `"light"`; `data-theme` was already `light` when `<body>` was created (`__themeAtBody`) |
| press `t`, reload | `dark` | `rgb(15, 17, 21)` | | `#0f1115` | `dark` | Theme: Dark | `"dark"`; `__themeAtBody === 'dark'` |
| type `t` inside `#search` (Research tab) | stays `dark`, the field contains `t` | | | | | | |
| OS light context, nothing stored | (absent) | `rgb(250, 250, 250)` | | `#fafafa` | `light` | | `null` (media-query fallback) |
| OS light context, stored `"dark"` | `dark` | `rgb(15, 17, 21)` | | `#0f1115` | `dark` | | forced dark beats a light OS; `__themeAtBody === 'dark'` |

No-flash evidence for every full page load in the layout pass (7 widths × 2 themes): a `MutationObserver` installed before any page script recorded `data-theme` at the moment `<body>` was inserted; it equalled the seeded theme in all 14 loads. The inline script runs before the stylesheet `<link>`, so the first paint already uses the chosen palette.

## 6. Keyboard navigation in the grids

2560×1200, dark, Brief (`.sections`, 15 entries, 4 columns): initial cursor index 0 of 15 → `j` → 1 → `k` → 0 → `j`×4 → 4 = first Research entry (`arxiv:2610.22791`), whose `left` is 1331.8px vs 287.8px for entry 0 (next column, DOM order = row-major visual order); its rect is inside the viewport (top 452.9, bottom 695.6 of 1200); computed outline `2px solid rgb(122, 183, 255)` = the accent colour. `o` opened a popup whose URL was `https://arxiv.org/abs/2610.22791` = the current entry's `data-url`.

Research (`.rows`, 100 rows): `j`, `j`, `k` → index 1 (`arxiv:2610.24087`); `o` opened `https://arxiv.org/abs/2610.24087` (= `data-url`); `r` added `.is-read`, `s` added `.is-saved`, both persisted (`ahead:read` / `ahead:saved` contain the id), `r`/`s` again toggled both off; `/` focused `#search`, `Escape` blurred it; `2` then `1` switched tabs (`location.hash === '#brief'`).

Sticky bars at 1440, Research, scrolled 2000px: nav at top 0..49.6, `#filters` top 50.0 (stuck right under the nav), `--nav-h` 50px, `--sticky-h` 106px. After `j`×24 then `k`×24 back to index 0, the current row's top was never above the filter row's bottom (minimum gap 7.64px; `scroll-margin-top` = sticky-h + 8px).

## 7. Contrast (computed colours, 1440×1200; WCAG relative-luminance ratio; `read-dimmed` pairs alpha-blend the row's opacity over the page background)

### light
tokens: --bg #fafafa, --panel #fff, --chip #eee, --line #ddd, --line-strong #767f8a, --fg #111, --muted #555, --accent #0a58ca, --visited #555, --why #7a5200, --cursor-bg #e8f0fe, --read-opacity 0.7, --tag-bg #dbe7fb, --tag-fg #1e4a8f, --ok #13633a, --warn #8a5a00, --bad #b42318

| pair | fg | bg | ratio | min | pass |
|---|---|---|---|---|---|
| body text on page background | #111111 | #fafafa | 18.09 | 4.5 | yes |
| muted text on page background | #555555 | #fafafa | 7.14 | 4.5 | yes |
| link (accent) on page background | #0a58ca | #fafafa | 6.17 | 4.5 | yes |
| kbd text on page background | #555555 | #fafafa | 7.14 | 4.5 | yes |
| entry title on section card | #111111 | #ffffff | 18.88 | 4.5 | yes |
| entry meta (muted) on section card | #555555 | #ffffff | 7.46 | 4.5 | yes |
| entry summary (muted) on section card | #555555 | #ffffff | 7.46 | 4.5 | yes |
| why-line on section card | #7a5200 | #ffffff | 6.92 | 4.5 | yes |
| accent link on section card | #0a58ca | #ffffff | 6.44 | 4.5 | yes |
| AI-WRITTEN badge text on badge background | #1e4a8f | #dbe7fb | 6.92 | 4.5 | yes |
| section heading on section card | #111111 | #ffffff | 18.88 | 4.5 | yes |
| cursor outline on cursor background (3:1) | #0a58ca | #e8f0fe | 5.62 | 3 | yes |
| cursor title on cursor background | #111111 | #e8f0fe | 16.48 | 4.5 | yes |
| cursor meta (muted) on cursor background | #555555 | #e8f0fe | 6.51 | 4.5 | yes |
| health dot on its button (3:1) | #13633a | #eeeeee | 6.30 | 3 | yes |
| theme button glyph on its button | #111111 | #eeeeee | 16.28 | 4.5 | yes |
| control border (--line-strong) on page background (3:1) | #767f8a | #fafafa | 3.89 | 3 | yes |
| selected tab text on chip background | #111111 | #eeeeee | 16.28 | 4.5 | yes |
| selected tab border on page background (3:1) | #767f8a | #fafafa | 3.89 | 3 | yes |
| visited title (--visited) on section card | #555555 | #ffffff | 7.46 | 4.5 | yes |
| alert text (--bad) on page background | #b42318 | #fafafa | 6.30 | 4.5 | yes |
| amber health dot (--warn) on chip background (3:1) | #8a5a00 | #eeeeee | 5.11 | 3 | yes |
| red health dot (--bad) on chip background (3:1) | #b42318 | #eeeeee | 5.67 | 3 | yes |
| green health dot (--ok) on chip background (3:1) | #13633a | #eeeeee | 6.30 | 3 | yes |
| card border (--line) on page background (decorative) | #dddddd | #fafafa | 1.30 | 1 | yes |
| row title on row card | #111111 | #ffffff | 18.88 | 4.5 | yes |
| row meta (muted) on row card | #555555 | #ffffff | 7.46 | 4.5 | yes |
| row summary (muted) on row card | #555555 | #ffffff | 7.46 | 4.5 | yes |
| score pill text on pill background | #555555 | #eeeeee | 6.43 | 4.5 | yes |
| inline source chip text on chip background | #555555 | #eeeeee | 6.43 | 4.5 | yes |
| row action icon on its button | #111111 | #eeeeee | 16.28 | 4.5 | yes |
| pressed chip text on accent fill | #fafafa | #0a58ca | 6.17 | 4.5 | yes |
| source chip text on chip background | #111111 | #eeeeee | 16.28 | 4.5 | yes |
| search field border on page background (3:1) | #767f8a | #fafafa | 3.89 | 3 | yes |
| search text on search field | #111111 | #ffffff | 18.88 | 4.5 | yes |
| read-dimmed title (opacity 0.7) on dimmed row card | #575757 | #fefefe | 7.15 | 4.5 | yes |
| read-dimmed meta (opacity 0.7) on dimmed row card (3:1, de-emphasised) | #878787 | #fefefe | 3.57 | 3 | yes |
| read-dimmed check icon (opacity 0.7) on dimmed button (3:1) | #589074 | #f2f2f2 | 3.29 | 3 | yes |
| saved star (--why) on its button | #7a5200 | #eeeeee | 5.96 | 4.5 | yes |

### dark
tokens: --bg #0f1115, --panel #161920, --chip #1e222b, --line #262a33, --line-strong #5e6774, --fg #e7e9ee, --muted #9aa3ad, --accent #7ab7ff, --visited #9aa3ad, --why #f0c674, --cursor-bg #1a2130, --read-opacity 0.6, --tag-bg #22304a, --tag-fg #a9c7f5, --ok #4ec98a, --warn #f0c674, --bad #ff7b72

| pair | fg | bg | ratio | min | pass |
|---|---|---|---|---|---|
| body text on page background | #e7e9ee | #0f1115 | 15.56 | 4.5 | yes |
| muted text on page background | #9aa3ad | #0f1115 | 7.39 | 4.5 | yes |
| link (accent) on page background | #7ab7ff | #0f1115 | 9.04 | 4.5 | yes |
| kbd text on page background | #9aa3ad | #0f1115 | 7.39 | 4.5 | yes |
| entry title on section card | #e7e9ee | #161920 | 14.48 | 4.5 | yes |
| entry meta (muted) on section card | #9aa3ad | #161920 | 6.88 | 4.5 | yes |
| entry summary (muted) on section card | #9aa3ad | #161920 | 6.88 | 4.5 | yes |
| why-line on section card | #f0c674 | #161920 | 10.92 | 4.5 | yes |
| accent link on section card | #7ab7ff | #161920 | 8.41 | 4.5 | yes |
| AI-WRITTEN badge text on badge background | #a9c7f5 | #22304a | 7.66 | 4.5 | yes |
| section heading on section card | #e7e9ee | #161920 | 14.48 | 4.5 | yes |
| cursor outline on cursor background (3:1) | #7ab7ff | #1a2130 | 7.70 | 3 | yes |
| cursor title on cursor background | #e7e9ee | #1a2130 | 13.26 | 4.5 | yes |
| cursor meta (muted) on cursor background | #9aa3ad | #1a2130 | 6.30 | 4.5 | yes |
| health dot on its button (3:1) | #4ec98a | #1e222b | 7.62 | 3 | yes |
| theme button glyph on its button | #e7e9ee | #1e222b | 13.11 | 4.5 | yes |
| control border (--line-strong) on page background (3:1) | #5e6774 | #0f1115 | 3.30 | 3 | yes |
| selected tab text on chip background | #e7e9ee | #1e222b | 13.11 | 4.5 | yes |
| selected tab border on page background (3:1) | #5e6774 | #0f1115 | 3.30 | 3 | yes |
| visited title (--visited) on section card | #9aa3ad | #161920 | 6.88 | 4.5 | yes |
| alert text (--bad) on page background | #ff7b72 | #0f1115 | 7.49 | 4.5 | yes |
| amber health dot (--warn) on chip background (3:1) | #f0c674 | #1e222b | 9.88 | 3 | yes |
| red health dot (--bad) on chip background (3:1) | #ff7b72 | #1e222b | 6.31 | 3 | yes |
| green health dot (--ok) on chip background (3:1) | #4ec98a | #1e222b | 7.62 | 3 | yes |
| card border (--line) on page background (decorative) | #262a33 | #0f1115 | 1.32 | 1 | yes |
| row title on row card | #e7e9ee | #161920 | 14.48 | 4.5 | yes |
| row meta (muted) on row card | #9aa3ad | #161920 | 6.88 | 4.5 | yes |
| row summary (muted) on row card | #9aa3ad | #161920 | 6.88 | 4.5 | yes |
| score pill text on pill background | #9aa3ad | #1e222b | 6.23 | 4.5 | yes |
| inline source chip text on chip background | #9aa3ad | #1e222b | 6.23 | 4.5 | yes |
| row action icon on its button | #e7e9ee | #1e222b | 13.11 | 4.5 | yes |
| pressed chip text on accent fill | #0f1115 | #7ab7ff | 9.04 | 4.5 | yes |
| source chip text on chip background | #e7e9ee | #1e222b | 13.11 | 4.5 | yes |
| search field border on page background (3:1) | #5e6774 | #0f1115 | 3.30 | 3 | yes |
| search text on search field | #e7e9ee | #161920 | 14.48 | 4.5 | yes |
| read-dimmed title (opacity 0.6) on dimmed row card | #919397 | #13161c | 5.87 | 4.5 | yes |
| read-dimmed meta (opacity 0.6) on dimmed row card (3:1, de-emphasised) | #626970 | #13161c | 3.25 | 3 | yes |
| read-dimmed check icon (opacity 0.6) on dimmed button (3:1) | #357f5b | #181b22 | 3.57 | 3 | yes |
| saved star (--why) on its button | #f0c674 | #1e222b | 9.88 | 4.5 | yes |

All 39 light pairs and all 39 dark pairs pass their thresholds (text ≥ 4.5:1, outlines/borders/indicators ≥ 3:1; the `--line` card border is recorded as decorative with no threshold). The "visited" and "alert"/amber/red rows are computed from the tokens because `:visited` colours are not exposed to scripts and the alert/amber/red states are not present in today's data.

## 8. Console and network

Across every page in the run (layout, theme, keyboard, contrast passes, including the popups): console errors 0, uncaught page errors 0, failed requests 0, responses with status ≥ 400: 0. (Run 1 had 22 page errors, all from the verification script's own init script touching `localStorage` inside `noopener` popups; fixed in the script, none from the app.)

## 9. Screenshots (`docs/screenshots/`, 40 files, 5.5 MB total; Brief is full-page, others viewport-only)

`brief|research|archive|learn` × `390|1024|1440|1920|2560` × `light|dark`, e.g. `docs/screenshots/brief-2560-light.png`, `brief-2560-dark.png`, `research-2560-light.png`, `research-2560-dark.png`, `brief-1920-light.png`, `brief-1920-dark.png`, `research-1920-light.png`, `research-1920-dark.png`, `archive-1440-dark.png`, `learn-2560-light.png`, `brief-390-light.png`, `research-390-light.png` … (full list of 40 paths in `layout-theme-evidence.json` under `widths.<W>.<theme>.tabs.<tab>.screenshot`). The 390-wide Brief captures are 4,697px tall (full page).

## 10. Left imperfect / notes for the reviewer and the deploy step

- At 390px the theme button wraps onto its own line under the status text (the health dot still fits on the first line); functional, slightly uneven. Fixing it needs an HTML wrapper around the two buttons; not done to keep the markup change minimal.
- Learn at ≥ 1920 keeps three wide group cards (auto-fit collapses the unused tracks); there are only three groups.
- `--ok` in the light palette is `#13633a` (not the `#1a7f4b` the plan proposed).
- Screenshot weight: 40 PNGs, 5.5 MB in the repo.
- Pre-existing Windows quirk: `relay/src/allowlist.json` is checked out CRLF under `core.autocrlf=true`, which fails `tests/relay-allowlist.test.js` locally until the working copy is re-checked-out as LF; no content change, nothing to commit.
- The deploy step still has to: push, watch the Actions run, confirm the live `styles.css` contains `data-theme`, run `node .agents/tasks/ahead-build/verify-layout-theme.mjs --live --base https://sudish007.github.io/ahead/` (writes `docs/screenshots/live-{brief,research}-{390,2560}-{light,dark}.png` and `layout-theme-evidence-live.json`), and write `layout-theme-report.md`.
