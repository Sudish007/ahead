# Ahead — fluid layout + selectable theme: final report

Repo `c:\Users\sudiskmr\Downloads\DomainClassification\ahead`, branch `main`, origin `Sudish007/ahead`. Live site: https://sudish007.github.io/ahead/. Report written 2026-10-20 after deploy and live verification.

User request (verbatim): "on large monitor ther is lot of empty margin, make it responsive and dynamic and i also want a light mode".

Outcome: the live site fills a 2560 px window with a four-column layout inside a 2200 px container (one column at 390 px, no horizontal scroll), and has a System → Light → Dark toggle (header button and `t`) that persists in `localStorage` and survives reload with no flash. The light palette passes WCAG AA on every measured pair. `npm test`: 260/260 locally and on CI. Actions run `39450116452` green. Live `styles.css` byte-identical to the committed file.

## 1. What changed

| commit | content |
|---|---|
| `9116bfa` (`9116bfac2b7c5ae687f89e91789a3b8e1bcce54a`) | `feat(ui): fluid 2200px layout with responsive grids and a System/Light/Dark theme toggle` — `index.html` (+7/−2), `app.js` (+53/−6), `styles.css` (117 lines rewritten), `tests/frontend.test.js` (+44/−2), `tests/client-state.test.js` (+12/−1); removes the nine old fixed-width screenshots (`brief-1440.png`, `brief-390.png`, `brief-light-1440.png`, `research-*`, `archive-*`, `learn-*`) |
| `4aa40da` (`4aa40daa7175c8b67741949dfe907c8e50c95d58`) | `test(ui): Playwright verification …` — `.agents/tasks/ahead-build/verify-layout-theme.mjs`, `layout-theme-evidence.json`, `layout-theme-plan.md`, `layout-theme-verification.md`, 40 new `docs/screenshots/{tab}-{width}-{theme}.png` |
| `d532093` (`d532093a169a8ad249229bff4c4ef98df491e09d`) | `docs(ui): review of the fluid layout and theme change (APPROVED)` — `layout-theme-review.md`, `layout-theme-review.json`. **This is the SHA that was pushed** (`020066b..d532093 main -> main`, 2026-10-20 15:37 UTC) and that the Actions run built and deployed |
| `942ef19` (`942ef1952a79dbfe0ec23cac449d6f87d5cef786`) | `data: refresh 2026-10-20T15:38Z [skip ci]` — written back to `main` by the Actions bot during run 39450116452 (`data/` only) |
| (this commit) | `docs(ui): layout/theme report, live verification evidence and screenshots [skip ci]` — this file, `layout-theme-evidence-live.json`, a 4-line harness fix in `verify-layout-theme.mjs` (see §6), 8 `docs/screenshots/live-*.png`. SHA recorded in §8 |

Frontend files only. Not touched: `scripts/`, `src/`, `sources.config.mjs`, `relay/`, `data/`, `.github/workflows/refresh.yml`, `package.json` (no dependency, framework, build step or web font; the system font stack is unchanged). Deployed sizes (all under the budgets pinned by `tests/frontend.test.js`): `index.html` 5,881 B (< 10 KB), `app.js` 33,234 B (< 60 KB), `styles.css` 11,302 B (< 15 KB).

### 1.1 Layout (`styles.css`, `app.js`)

- Container: `body { max-width: 2200px; padding: 0 clamp(16px, 3vw, 64px) 40px; font-size: 1rem; line-height: 1.5; overflow-wrap: anywhere }` (was `max-width: 1100px; padding: 0 16px 40px; font-size: 14px`). Fluid root size `html { font-size: clamp(15px, 12.5px + 0.3vw, 18px) }`; every absolute px type size converted to rem (tabs 0.85rem, chips/meta 0.8rem, rows/entries 0.9rem, titles 0.95rem, headings 1rem; 12 px minimum preserved).
- Grid wrappers added in `app.js`: `div.sections` around the Brief sections (each `section.section` gets `data-key`), `div.rows` around category rows (normal and Saved paths), `div.learn-groups` around the Learn groups. `#panel` stays a plain block; `rows()` (`.row, .entry` in DOM order) and all keyboard handling are unchanged.
- Grids: `.sections, .rows` explicit 1 / 2 / 3 / 4 columns at the breakpoints below, `.section[data-key="must-know"] { grid-column: span 2 }` from 1500 px; `.cards` `repeat(auto-fill, minmax(min(100%, 20rem), 1fr))`; `.learn-groups` `auto-fit` 22rem; `.archive-list` `auto-fill` 14rem; overview prose `columns: 42ch 3` (max three columns, lines ≤ 80ch). Sections, rows, learn groups and archive days are bordered cards on `--panel`; `.signals` wraps; `minmax(0, 1fr)` / `min-width: 0` everywhere so nothing can widen the page.
- Sticky filters: `.filters` sticky under the nav from 900 px (`top: var(--nav-h)`); `app.js` measures `--nav-h` / `--sticky-h` with a `ResizeObserver` and after every `render()`; `.row, .entry { scroll-margin-top: calc(var(--sticky-h) + 8px) }` so `j`/`k` never park the current row under the bars. Cursor row/entry: `background: var(--cursor-bg); outline: 2px solid var(--accent)`.

### 1.2 Theme (`index.html`, `app.js`, `styles.css`)

- `<meta name="theme-color" id="theme-color" content="#0f1115">` and a single-line inline `<script>` in `<head>` before the stylesheet: reads `localStorage['ahead:theme']` (JSON), sets `data-theme="light|dark"` on `<html>` and the theme-color, so the first paint already has the chosen palette. Its SHA-256 `yWrjz1/zOM/G7P7hh4kLtN+/Y0Nejh36/84NtaOa5RU=` is the only addition to the CSP (`script-src 'self' 'sha256-…'`); `tests/frontend.test.js` recomputes the hash from the script body and fails if they disagree. (An external `theme.js` was not possible: the workflow's `cp` list of deployable files is fixed and off-limits.)
- `#theme` button in the header (glyph ◐ / ☀ / ☾ via `::before`, `aria-label="Theme: System|Light|Dark"`, `title` with the `t` hint), `t` shortcut (ignored while typing in an input), footer key hint. `sanitizeTheme` / `nextTheme` exported from `app.js`; `S.theme` read through `store.get('ahead:theme', sanitizeTheme)`; `applyTheme()` also follows OS `prefers-color-scheme` changes while in System mode.
- Palettes: dark in `:root`; light written twice with identical declaration lists — `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {…} }` (System) and `:root[data-theme="light"] {…}` (forced) — `color-scheme` moves with the tokens so form controls and scrollbars follow. A unit test asserts the two light blocks are identical and that every dark token has a light counterpart. The ten values the pre-existing test pins (`#fafafa #111 #555 #0a58ca #7a5200` / `#0f1115 #e7e9ee #9aa3ad #7ab7ff #f0c674`) are kept. New tokens: `--line-strong`, `--cursor-bg`, `--tag-bg`, `--tag-fg`, `--visited`, `--read-opacity` (dark 0.6, light 0.7), `--ok/--warn/--bad`.

| token | dark | light |
|---|---|---|
| `--bg` / `--panel` / `--chip` | `#0f1115` / `#161920` / `#1e222b` | `#fafafa` / `#fff` / `#eee` |
| `--line` / `--line-strong` | `#262a33` / `#5e6774` | `#ddd` / `#767f8a` |
| `--fg` / `--muted` / `--visited` | `#e7e9ee` / `#9aa3ad` / `#9aa3ad` | `#111` / `#555` / `#555` |
| `--accent` / `--why` / `--cursor-bg` | `#7ab7ff` / `#f0c674` / `#1a2130` | `#0a58ca` / `#7a5200` / `#e8f0fe` |
| `--tag-bg` / `--tag-fg` | `#22304a` / `#a9c7f5` | `#dbe7fb` / `#1e4a8f` |
| `--ok` / `--warn` / `--bad` | `#4ec98a` / `#f0c674` / `#ff7b72` | `#13633a` / `#8a5a00` / `#b42318` |
| `--read-opacity` | 0.6 | 0.7 |

## 2. Breakpoints and measured column counts

Breakpoints (`styles.css`): `(min-width: 900px)` → 2 columns and sticky filters; `(min-width: 1500px)` → 3 columns + Must know spans 2; `(min-width: 2100px)` → 4 columns. Container cap 2200 px. The pre-existing `(max-width: 640px)` touch-target block is kept.

Measured with Playwright (Chromium 156.0.8078.4) from `getComputedStyle(grid).gridTemplateColumns`, identical in both themes. Local rows from `layout-theme-evidence.json` (built on the 13:09Z digest), live rows from `layout-theme-evidence-live.json` (15:38Z digest, https://sudish007.github.io/ahead/):

| width (×height) | root font | body width | `.sections` (Brief) | `.rows` (Research) | `.cards` (Leaderboards, 8) | `.learn-groups` (3) | `.archive-list` | overview prose | scrollWidth / innerWidth |
|---|---|---|---|---|---|---|---|---|---|
| 360 ×844 | 15px | 360 | **1** (328) | **1** (328) | 1 | 1 | 1 | 1 col, 36.4ch | 360 / 360 |
| 390 ×844 | 15px | 390 | **1** (358) | **1** (358) | 1 | 1 | 1 | 1 col, 40.1ch | 390 / 390 |
| 1024 ×1200 | 15.57px | 1024 | **2** (473 ×2) | **2** (473 ×2) | 3 (312 ×3) | 2 (473 ×2) | 4 (230 ×4) | 2 col, 53.0ch | 1024 / 1024 |
| 1440 ×1200 | 16.82px | 1440 | **2** (669 ×2) | **2** (669 ×2) | 3 (442 ×3) | 3 (441 ×3) | 5 (260 ×5) | 3 col, 45.4ch | 1440 / 1440 |
| 1920 ×1200 | 18px | 1920 | **3** (591 ×3), Must know 1197.9 | **3** (591 ×3) | 4 (441 ×4) | 3 (591 ×3) | 6 (289 ×6) | 3 col, 57.7ch | 1920 / 1920 |
| 2560 ×1200 | 18px | 2200 (cap) | **4** (506 ×4), Must know 1028 | **4** (506 ×4) | 5 (403 ×5) | 3 (680 ×3) | 7 (284 ×7) | 3 col, 66.9ch | 2560 / 2560 |
| 3840 ×1200 | 18px | 2200 (cap) | **4** (506 ×4) | **4** (506 ×4) | 5 (403 ×5) | 3 (680 ×3) | 7 (284 ×7) | 3 col, 66.9ch | 3840 / 3840 |
| **live** 390 ×844 | 15px | 390 | **1** (358), Must know 358 = Research 358 | **1** (358) | – | – | – | (no overview in the live digest, §6) | 390 / 390 |
| **live** 2560 ×1200 | 18px | 2200 | **4** (506 506 506 506), Must know 1028 vs Research 506 | **4** (506 506 506 506) | – | – | – | – | 2560 / 2560 |

Every one of the 70 local and 8 live scrollWidth measurements equalled innerWidth (no horizontal scroll). Tablist at ≥ 1024 shows all ten tabs without internal scrolling (live 2560: 2072/2072); at 390 it scrolls internally (880 px of tabs in 358 px) as it did before this change. `#filters` is `static` at 390 and `sticky` at 2560 (live). Visual order equals DOM order (no `grid-auto-flow: dense`), so `j`/`k` read left-to-right, top-to-bottom; at 2560 the fifth entry sits in the next column (`left` 1331.8 px vs 287.8 px for entry 0, live).

## 3. Contrast, light palette (measured from computed colours at 1440; WCAG relative-luminance ratio; read-dimmed pairs alpha-blend the row opacity over the page background)

Identical numbers locally and on the live origin (`layout-theme-evidence-live.json` → `contrast.light.pairs`). Text pairs need ≥ 4.5, outlines / borders / indicators ≥ 3; the `--line` card border is recorded as decorative with no threshold.

| pair | fg | bg | ratio | min |
|---|---|---|---|---|
| body text on page background | `#111111` | `#fafafa` | 18.09 | 4.5 |
| muted text on page background | `#555555` | `#fafafa` | 7.14 | 4.5 |
| link (accent) on page background | `#0a58ca` | `#fafafa` | 6.17 | 4.5 |
| kbd text on page background | `#555555` | `#fafafa` | 7.14 | 4.5 |
| entry title on section card | `#111111` | `#ffffff` | 18.88 | 4.5 |
| entry meta (muted) on section card | `#555555` | `#ffffff` | 7.46 | 4.5 |
| entry summary (muted) on section card | `#555555` | `#ffffff` | 7.46 | 4.5 |
| why-line on section card | `#7a5200` | `#ffffff` | 6.92 | 4.5 |
| accent link on section card | `#0a58ca` | `#ffffff` | 6.44 | 4.5 |
| AI-WRITTEN badge text on badge background | `#1e4a8f` | `#dbe7fb` | 6.92 | 4.5 |
| section heading on section card | `#111111` | `#ffffff` | 18.88 | 4.5 |
| cursor outline on cursor background | `#0a58ca` | `#e8f0fe` | 5.62 | 3 |
| cursor title on cursor background | `#111111` | `#e8f0fe` | 16.48 | 4.5 |
| cursor meta (muted) on cursor background | `#555555` | `#e8f0fe` | 6.51 | 4.5 |
| health dot on its button | `#13633a` | `#eeeeee` | 6.30 | 3 |
| theme button glyph on its button | `#111111` | `#eeeeee` | 16.28 | 4.5 |
| control border (`--line-strong`) on page background | `#767f8a` | `#fafafa` | 3.89 | 3 |
| selected tab text on chip background | `#111111` | `#eeeeee` | 16.28 | 4.5 |
| selected tab border on page background | `#767f8a` | `#fafafa` | 3.89 | 3 |
| visited title (`--visited`) on section card | `#555555` | `#ffffff` | 7.46 | 4.5 |
| alert text (`--bad`) on page background | `#b42318` | `#fafafa` | 6.30 | 4.5 |
| amber health dot (`--warn`) on chip background | `#8a5a00` | `#eeeeee` | 5.11 | 3 |
| red health dot (`--bad`) on chip background | `#b42318` | `#eeeeee` | 5.67 | 3 |
| green health dot (`--ok`) on chip background | `#13633a` | `#eeeeee` | 6.30 | 3 |
| card border (`--line`) on page background (decorative) | `#dddddd` | `#fafafa` | 1.30 | – |
| row title on row card | `#111111` | `#ffffff` | 18.88 | 4.5 |
| row meta (muted) on row card | `#555555` | `#ffffff` | 7.46 | 4.5 |
| row summary (muted) on row card | `#555555` | `#ffffff` | 7.46 | 4.5 |
| score pill text on pill background | `#555555` | `#eeeeee` | 6.43 | 4.5 |
| inline source chip text on chip background | `#555555` | `#eeeeee` | 6.43 | 4.5 |
| row action icon on its button | `#111111` | `#eeeeee` | 16.28 | 4.5 |
| pressed chip text on accent fill | `#fafafa` | `#0a58ca` | 6.17 | 4.5 |
| source chip text on chip background | `#111111` | `#eeeeee` | 16.28 | 4.5 |
| search field border on page background | `#767f8a` | `#fafafa` | 3.89 | 3 |
| search text on search field | `#111111` | `#ffffff` | 18.88 | 4.5 |
| read-dimmed title (opacity 0.7) on dimmed row card | `#575757` | `#fefefe` | 7.15 | 4.5 |
| read-dimmed meta (opacity 0.7) on dimmed row card (de-emphasised) | `#878787` | `#fefefe` | 3.57 | 3 |
| read-dimmed check icon (opacity 0.7) on dimmed button | `#589074` | `#f2f2f2` | 3.29 | 3 |
| saved star (`--why`) on its button | `#7a5200` | `#eeeeee` | 5.96 | 4.5 |

All 39 light pairs pass. The 39 dark pairs also pass (body 15.56, muted 7.39, link 9.04, why 10.92, badge 7.66, cursor outline 7.70, control border 3.30, dots 7.62 / 9.88 / 6.31, read-dimmed title 5.87, read-dimmed meta 3.25, read-dimmed icon 3.57; full list in the evidence JSON). The light `--ok` was darkened from the planned `#1a7f4b` to `#13633a` after the first local run measured the dimmed read-check icon at 2.64:1; the AI-WRITTEN badge pair on the live origin was computed from the `--tag-fg`/`--tag-bg` tokens because the live digest has no overview card (§6).

## 4. Tests

- Baseline before the change: 258 tests (257 pass locally, 1 pre-existing Windows-only failure in `tests/relay-allowlist.test.js` because `relay/src/allowlist.json` is checked out CRLF under `core.autocrlf=true`; cleared by a line-ending-only re-checkout, no content change, nothing committed).
- After the change, locally (`npm test`, re-run during this deploy step): **tests 260, pass 260, fail 0, skipped 0** (49.6 s). New tests: `styles.css: fluid container, grids, both themes defined identically` (`tests/frontend.test.js`) and `theme sanitizer and cycle` (`tests/client-state.test.js`).
- On CI (run 39450116452, `npm test` step on ubuntu-latest): `tests 260 / pass 260 / fail 0`.

## 5. Deploy

- `git pull --rebase origin main` → "Current branch main is up to date" (origin was still `020066b`); `git push origin main` → `020066b..d532093`. No force-push, no history rewrite.
- Actions run **39450116452** — https://github.com/Sudish007/ahead/actions/runs/39450116452 — event `push`, head `d532093`, created 2026-10-20T15:37:23Z, completed 15:40:14Z, **conclusion: success**. Job `refresh` 1m36s (id 118722377964: checkout, setup-node, `npm ci`, `npm test`, fetch sources + build the brief, commit `data/` back to main as `942ef19`, stage the site, upload-pages-artifact); job `deploy` 1m7s (id 118723267590, `actions/deploy-pages@v5`). The only annotation is GitHub's generic ubuntu-latest migration notice. The LLM step reported `partial: ok; overview=rejected: 110 words; why=15/15` (see §6).
- After the run, `git pull --rebase origin main` fast-forwarded the local branch onto the bot's `942ef19` before the final docs push.

## 6. Live-site checks

1. **styles.css served** (15:40:52Z, 38 s after the run finished; `GET https://sudish007.github.io/ahead/styles.css?v=<unix-ts>` with `Cache-Control: no-cache`): HTTP 200, 11,302 B, `ETag "6ad78b54-2c26"`, `Last-Modified Tue, 20 Oct 2026 15:40:04 GMT`, `X-Cache: MISS`, `Age: 0`; body contains `data-theme`, `:root[data-theme="light"]` and `max-width: 2200px`. No CDN lag was observed, so the backoff loop (30/60/60/120… s, up to ~10 min) exited on the first attempt.
2. **index.html served**: HTTP 200, 5,871 B transferred; contains the inline bootstrap (`localStorage.getItem('ahead:theme')`), the CSP hash `'sha256-yWrjz1/zOM/G7P7hh4kLtN+/Y0Nejh36/84NtaOa5RU='`, `id="theme-color"` and the `id="theme"` button.
3. **Byte-for-byte**: SHA-256 of the live `index.html`, `app.js`, `styles.css`, `favicon.svg` equals the SHA-256 of the committed files (`974f14b0…`, `e32166bf…`, `8e2a5ce5…`, `c07581dd…`).
4. **Playwright against the live origin** (`node .agents/tasks/ahead-build/verify-layout-theme.mjs --live --base https://sudish007.github.io/ahead/`, Chromium 156.0.8078.4, evidence `layout-theme-evidence-live.json`, `generatedAt` 2026-10-20T15:44:57Z, exit 0, `failures: []`):
   - Layout at 390×844 and 2560×1200, light and dark, Brief and Research: column counts and widths in §2; 6 sections / 15 entries, 100 rows / 5 source chips; `scrollWidth == innerWidth` in all 8 measurements; `data-theme` already equalled the seeded theme when `<body>` was created in all 4 full loads (no flash).
   - Theme toggle on the live origin, fresh context, OS dark: load → no attribute, canvas `rgb(15, 17, 21)`, meta `#0f1115`, `color-scheme: dark`, "Theme: System", nothing stored → click → `light`, `rgb(250, 250, 250)`, `#fafafa`, stored `"light"` → click → `dark` → click → System (stored `"system"`) → `t` → light → **`page.reload()` → still `light`, attribute present at `<body>` creation** → `t` + reload → still `dark`. `t` typed inside `#search` does not toggle. OS-light context with nothing stored → light via the media query; OS-light with stored `"dark"` → forced dark.
   - Keyboard: Brief at 2560 (4 columns) `j`/`k`, `j`×4 lands in the next column with the cursor outline `2px solid rgb(122, 183, 255)` = `--accent` and the entry inside the viewport; `o` opened `https://arxiv.org/abs/2610.22791` = the entry's `data-url`. Research: `j j k` → row 1 (`arxiv:2610.26860`), `o` opened its URL, `r`/`s` toggled and persisted read/saved then toggled back, `/` focused search, `Escape` blurred it, `2`/`1` switched tabs. Sticky bars at 1440 after a 2000 px scroll: nav 0–49.6, filters top 50.0, `--sticky-h` 106 px; over 24 `j` + 24 `k` the current row never went under the filter row (min gap 7.64 px). Popups to third-party sites were stubbed so nothing outside the live origin was contacted.
   - Contrast: 39 light + 39 dark pairs, all pass (§3).
   - Console errors 0, uncaught page errors 0, failed requests 0, responses ≥ 400: 0 (the page's CSP stayed active; a wrong script hash would have shown here).
   - The first live run stopped with a harness exception: the live digest produced by the 15:38Z refresh has `overview: null` (the LLM overview was rejected at 110 words, below the 150-word floor, which is the data layer's existing behaviour), so `.overview .tag` did not exist and the contrast pass dereferenced `null`. Fixed in `verify-layout-theme.mjs` (4 lines: fall back to the `--tag-fg`/`--tag-bg` tokens when no overview is rendered, like the existing visited/alert pairs) and re-run → PASS. Nothing in the deployed frontend changed for this.
5. **Looked at by eye** (`read_file`): `live-brief-2560-light.png` — content spans the full 2200 px container (~180 px margin per side at 2560), Must know spans two of four columns with Research and Releases & tools beside it, From the labs / Analysis worth reading / One deep read on the second row, cursor highlight on entry 1, ☀ glyph in the header, "t theme" in the footer key list. `live-brief-2560-dark.png` — same geometry, dark palette, ☾ glyph. `live-research-390-light.png` — single column of row cards, chips wrapped, filters stacked, nothing clipped; the theme button wraps under the status text (cosmetic, §7).

## 7. Left imperfect or deferred

1. **No overview card on the live Brief today.** The 15:38Z refresh's LLM overview was rejected (110 words), so the live page shows no "Overview / AI-written" card and the live screenshots do not show the three-column overview prose. That is the data layer's accept/reject rule, not a frontend change; the overview renders in three columns (≤ 80ch lines) whenever a digest has an accepted overview, as in the local `brief-2560-*.png` built on the 13:09Z digest.
2. At 390 px the theme button wraps onto its own line under the status text (health dot stays on the first line). Functional, slightly uneven; fixing it needs an extra wrapper element in `index.html`.
3. The brief's optional chip sidebar on very wide screens was not built: the sticky filter row fits every chip plus range and search on one line at ≥ 1500 px, and a sidebar would narrow the 3–4-column grid by ~16 rem exactly where those columns appear.
4. Learn at ≥ 1920 keeps three wide group cards (auto-fit collapses unused tracks; there are only three groups).
5. Read-dimmed meta text is 3.57:1 (light) / 3.25:1 (dark): above 3:1 but below 4.5:1, a deliberate de-emphasis; the dimmed title stays ≥ 4.5:1.
6. Chip and card borders use `--line` (`#ddd` on `#fafafa`, 1.30:1), decorative as before; interactive control borders use `--line-strong` (3.89:1).
7. Glyphs ◐ / ☀ / ☾ come from the OS symbol font (no web font), so their exact shape varies by platform.
8. Screenshot weight in the repo: 48 PNGs, 6.97 MB (40 local 5.46 MB + 8 live 1.51 MB).
9. Windows checkouts with `core.autocrlf=true` see `tests/relay-allowlist.test.js` fail until `relay/src/allowlist.json` is re-checked-out as LF (pre-existing, unrelated; passes on CI).
10. The final docs commit carries `[skip ci]` (repo convention for docs-only commits, and the plan's item 12) so it does not start another data refresh or spend an LLM request; the live site already serves `d532093`'s frontend. Hence no Actions run id for it.

## 8. Screenshots and evidence (all committed)

Local run (`4aa40da`, `http://127.0.0.1:8787/ahead/`, 40 files): `docs/screenshots/{brief,research,archive,learn}-{390,1024,1440,1920,2560}-{light,dark}.png`, e.g. `docs/screenshots/brief-2560-light.png`, `brief-2560-dark.png`, `brief-1920-light.png`, `brief-1024-dark.png`, `brief-390-light.png`, `research-2560-light.png`, `research-1920-dark.png`, `research-390-light.png`, `learn-2560-light.png`, `archive-1440-dark.png`. Evidence: `.agents/tasks/ahead-build/layout-theme-evidence.json`.

Live run (this commit, https://sudish007.github.io/ahead/, 8 files):

| file | size |
|---|---|
| `docs/screenshots/live-brief-2560-light.png` | 2560×1581 (full page), 255,143 B |
| `docs/screenshots/live-brief-2560-dark.png` | 2560×1581, 299,665 B |
| `docs/screenshots/live-brief-390-light.png` | 390×3693 (full page), 200,325 B |
| `docs/screenshots/live-brief-390-dark.png` | 390×3693, 236,470 B |
| `docs/screenshots/live-research-2560-light.png` | 2560×1200, 227,514 B |
| `docs/screenshots/live-research-2560-dark.png` | 2560×1200, 275,241 B |
| `docs/screenshots/live-research-390-light.png` | 390×844, 43,756 B |
| `docs/screenshots/live-research-390-dark.png` | 390×844, 48,476 B |

Evidence: `.agents/tasks/ahead-build/layout-theme-evidence-live.json`. Related documents: `layout-theme-plan.md`, `layout-theme-verification.md` (local run, iteration 1), `layout-theme-review.md` / `.json` (APPROVED, no findings), `verify-layout-theme.mjs` (the harness; Playwright 1.64.0 imported by `file://` URL from `C:/Users/sudiskmr/Downloads/DomainClassification/hoshlab/node_modules`, not a dependency of this repo).

Final commit (this report + live evidence + screenshots, `[skip ci]`): the commit that adds this file — `git log -1 --format=%H -- .agents/tasks/ahead-build/layout-theme-report.md`. It is also quoted in the deploy step's closing message.
