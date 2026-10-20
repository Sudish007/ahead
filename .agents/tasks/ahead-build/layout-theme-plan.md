# Ahead — fluid layout + selectable theme: implementation plan

Repo: `c:\Users\sudiskmr\Downloads\DomainClassification\ahead`, branch `main`, origin `Sudish007/ahead`. Work directly in this checkout (no worktree). Node v24.16.0, Windows, PowerShell. All paths below are absolute or relative to that repo root.

Workflow context: this plan is executed by the `build-loop` (coder + reviewer, max 2 iterations; the reviewer writes `.agents/tasks/ahead-build/layout-theme-review.json` with `verdict: APPROVED`) and then by the `deploy-verify-report` step. **Phase A (items 1-9) runs inside the build loop and never pushes. Phase B (items 10-12) is the deploy step.**

## 0. Findings from exploration that fix the design

| finding | source | consequence |
|---|---|---|
| Deploy copies exactly `index.html app.js styles.css favicon.svg` + `data/` into `_site` | `.github/workflows/refresh.yml` line 62 (`cp index.html app.js styles.css favicon.svg _site/`), file is off-limits | **No new frontend file can be deployed.** The theme bootstrap must be an inline `<script>` in `index.html`; there is no `theme.js` option. |
| CSP meta is `script-src 'self'` and `tests/frontend.test.js` asserts the exact CSP string and "no inline scripts" | `index.html` line 6, `tests/frontend.test.js` lines 19 and 28 | The inline bootstrap needs a `'sha256-<base64>'` hash source added to `script-src`; both assertions are updated deliberately (item 6). |
| `body { max-width: 1100px; padding: 0 16px 40px; font-size: 14px }`; all type sizes are absolute px (13/12/11 px) | `styles.css` lines 12-16 and throughout | Container, padding and the whole type scale change (item 1). `tests/frontend.test.js` line 60 asserts `max-width: 1100px` and must change. |
| Light palette exists only under `@media (prefers-color-scheme: light)`; test pins the five light values `#fafafa #111 #555 #0a58ca #7a5200` and the five dark values | `styles.css` lines 1-9, `tests/frontend.test.js` lines 53-55 | Keep those ten values verbatim (they already meet AA); add the new tokens and the `data-theme` blocks around them. |
| `app.js` appends `.overview` and `.section` elements straight into `#panel`; category rows (`article.row`) also go straight into `#panel`; Learn appends `.learn-group` divs; Archive appends `ul.archive-list`; Leaderboards `ul.cards` | `app.js` `renderDigest` (~line 330), `renderCategory` (~line 300), `renderLearn` (~line 385), `renderArchive` (~line 415), `renderCards` (~line 364) | Add three wrapper elements in `app.js` (`div.sections`, `div.rows`, `div.learn-groups`) so each grid has its own container; `#panel` stays a plain block. Cursor code `rows()` = `panel.querySelectorAll('.row, .entry')` is unaffected (DOM order). |
| Digest sections have a stable `key` (`must-know`, `research`, `releases`, `labs`, `analysis`, `deep-read`) | `data/digests/2026-10-20.json`, `src/brief.js` line 7 | `renderDigest` sets `sec.dataset.key = section.key`; CSS spans `.section[data-key="must-know"]`. |
| `localStorage` keys are `ahead:read`, `ahead:saved`, `ahead:learn`, `ahead:lastVisit`, `ahead:range`, JSON-encoded via `createStore` (`'7d'` is stored as `"7d"`) | `app.js` lines 109-116, `createStore` | Theme key is **`ahead:theme`**, JSON-encoded (`"light"`), read through `store.get('ahead:theme', sanitizeTheme)`; the bootstrap must `JSON.parse` it. |
| Keyboard handler is one `doc.addEventListener('keydown')` with a `switch (e.key)`; `t` is unused; keys are ignored while an input has focus | `app.js` lines ~500-515 | Add `case 't'` to the switch. |
| No `theme-color` meta exists today | `index.html` head | Add `<meta name="theme-color" id="theme-color" content="#0f1115">` before the bootstrap script. |
| `nav` is sticky (`top: 0; z-index: 2`); `.filters` is a sibling, not sticky | `styles.css` lines 44-47, 49 | Make `.filters` sticky under the nav at >= 900 px using a measured `--nav-h`; fix the pre-existing "scrollIntoView hides the row under the sticky bar" with `scroll-margin-top`. |
| `npm test` = `node --test "tests/**/*.test.js"`; baseline on this machine: 258 tests, **257 pass, 1 fail** (`tests/relay-allowlist.test.js`: `relay/src/allowlist.json` is CRLF in the working copy because `core.autocrlf=true`; index is LF; passes on the Linux runner) | run on 2026-10-20 | Pre-existing and unrelated. Do not edit `relay/`. The harmless local fix is `git -c core.autocrlf=false checkout -- relay/src/allowlist.json` (rewrites the working copy as LF, produces no diff). Record whichever you do in the report. |
| Playwright 1.64.0 + Chromium 156 are importable from `C:/Users/sudiskmr/Downloads/DomainClassification/hoshlab/node_modules/playwright/index.mjs` via a `file://` URL from any directory (smoke-tested: `chromium.launch()` + 2560-px viewport OK). Browser binaries are in `%LOCALAPPDATA%\ms-playwright` | verified during planning | Verification script imports Playwright by absolute `file://` URL; it is not added as a dependency (matches earlier steps). |
| `.agents/` and `docs/screenshots/` are tracked in git (33 and 9 files) | `git ls-files` | Script, evidence JSON, report and screenshots are committed. |
| `scripts/serve.mjs` binds `127.0.0.1`, `PORT` env, default 8787, serves `/` and `/ahead/`, `Cache-Control: no-store` | `scripts/serve.mjs` | Verify against `http://127.0.0.1:8787/ahead/` (use the IP, not `localhost`, to avoid the ::1 resolution on Node 24). |
| Live data: digest overview 1,358 chars / 159 words; 15 entries (4/3/3/2/2/1); Research has 599 items (100 rows rendered), Blogs has 11 source chips; 8 leaderboard cards; 16 Learn items in 3 groups; 1 archived day | `data/` on 2026-10-20 | Used for the expected column counts and wait conditions below. |

## 1. CSS architecture (`styles.css`)

Design decisions (chosen, not optional):

- **Explicit breakpoints, not `auto-fill`, for the two main grids** (`.sections`, `.rows`): deterministic column counts at the brief's widths, and a `grid-column: span 2` on "Must know" is only safe when the grid is guaranteed to have >= 3 explicit columns (a span on an `auto-fill` grid with 1 column creates an implicit column and horizontal overflow). `auto-fill`/`auto-fit` is used only for the small-card grids (leaderboards, archive days, learn groups) where no item spans.
- **No left sidebar for chips.** The filters stay a sticky row above the list at every width >= 900 px. Rationale: a sidebar adds a third filter layout mode, narrows the `.rows` grid by ~16 rem at exactly the widths where the brief expects 3-4 columns, and at >= 1500 px all 11 Blogs chips plus range and search already fit on one line, so the sticky row costs one line of height.
- **Overview prose uses CSS multi-columns** `columns: 42ch 3` (column width >= 42ch, at most 3 columns): at 2200 px that is three ~75-ch columns, at 1024 two ~55-ch columns, one column on phones. Every line stays under ~80ch while the card still uses the full container width.
- **Sticky offsets are measured, not guessed**: `app.js` writes `--nav-h` and `--sticky-h` on `<html>` with `style.setProperty` (allowed by the CSP and by the design doc; the test only forbids `setAttribute('style'`).

### 1.1 Container and fluid type

| selector | today | new |
|---|---|---|
| `html` | `background; color` | add `font-size: clamp(15px, 12.5px + 0.3vw, 18px);` |
| `body` | `max-width: 1100px; padding: 0 16px 40px; font-size: 14px; line-height: 1.45` | `max-width: 2200px; padding: 0 clamp(16px, 3vw, 64px) 40px; font-size: 1rem; line-height: 1.5; overflow-wrap: anywhere;` (keep `margin: 0 auto`, the font stack and `font-variant-numeric: tabular-nums` unchanged — the test pins the latter) |

Resulting root font-size: 360/390/640 px -> 15 px (clamped), 900 -> 15.2, 1024 -> 15.6, 1440 -> 16.8, 1920 -> 18 (18.26 clamped), 2560/3840 -> 18 px. Container width: 390 -> 358, 1024 -> 963, 1440 -> 1354, 1920 -> 1805, 2560 -> 2200 (cap), 3840 -> 2200.

Convert every absolute font size to rem so it follows the root (12 px minimum is preserved because 0.8rem x 15px = 12px):

| selector(s) | today | new |
|---|---|---|
| `.wordmark` / `.wordmark .mark` | 20px / 28px box | `1.3rem` / `1.75rem` box |
| `.status`, `.health-details`, `.also`, `.counter`, `.section h2 .day` | 13px | `0.85rem` |
| `kbd`, `.overview .tag` | 11px | `0.72rem` (tablist kbd: `0.7rem`, see the tab row) |
| `.chip`, `.score`, `.meta`, `.chips-inline a, .chips-inline span`, `footer` | 12px | `0.8rem` |
| `.row`, `.entry`, `.card .blurb` | 13px | `0.9rem` |
| `.headline .title`, `.entry .title`, `.day-heading` | 14px | `0.95rem` |
| `.section h2`, `.learn-group h2` | 15px | `1rem` |
| `.tablist [role="tab"]` | inherits 14px, padding 6px 10px | `font-size: 0.85rem; padding: 0.3rem 0.5rem;` and `.tablist kbd { font-size: 0.7rem; margin-right: 4px; }` — measured with Playwright against the live DOM: the ten tabs need 906 px at 1024 (963 available, fits), 961 px at 1440, 1014 px at 1920; at 900 px they need 889 px vs 846 available and scroll inside the tablist as they do today (today's 14 px strip needs 998 px and already scrolls at 1024: 998 > 992). The `0.875rem` variant was rejected: 957 px at 1024 leaves a 6 px margin that another OS font would eat. |
| `button` | `min-height: 32px; padding: 6px 10px` | `min-height: 2rem; padding: 0.375rem 0.625rem; border-color: var(--line-strong)` |
| `.chip` | `min-height: 28px` | `min-height: 1.75rem; border-color: var(--line)` (override the strong border; chips are identified by fill + pressed accent) |
| `#search` | `min-width: 200px; min-height: 32px` | `min-width: 12rem; min-height: 2rem; border-color: var(--line-strong)` |
| `.icon`, `.health`, `.theme` | 32px | `2rem` |
| `@media (max-width: 640px)` block | `min-height: 40px`, health 40px | unchanged (keep the absolute 40 px touch targets; add `.theme` next to `.health`) |

### 1.2 Grids (every class below is emitted by `app.js`; see item 2 for the three new wrappers)

```css
/* shared rule for the two main grids */
.sections, .rows { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px 16px; margin-top: 10px; }
.sections { align-items: start; }      /* section cards keep their own height */
.rows { align-items: stretch; }        /* row cards align per grid row */
@media (min-width: 900px)  { .sections, .rows { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 1500px) { .sections, .rows { grid-template-columns: repeat(3, minmax(0, 1fr)); } .sections > .section[data-key="must-know"] { grid-column: span 2; } }
@media (min-width: 2100px) { .sections, .rows { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
```

Expected column counts (Brief `.sections` and category `.rows`): 360/390/640 -> **1**, 900/1024/1440 -> **2**, 1500/1920 -> **3**, 2100/2560/3840 -> **4**. Card widths: 1024 -> ~473 px, 1440 -> ~669, 1920 -> ~590, 2560 -> ~536. At 3 columns "Must know" (span 2) + Research fill row 1, Releases/Labs/Analysis row 2, Deep read row 3; at 4 columns row 1 = Must know (2) + Research + Releases, row 2 = Labs + Analysis + Deep read. DOM order = row-major visual order, so `j`/`k` still read left-to-right, top-to-bottom.

Other grids and cards:

```css
.section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px 12px; min-width: 0; }
.section h2 { margin: 0 0 6px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }   /* was 18px 0 6px */
.section ol { margin: 0; padding-left: 1.6em; }
.entry { padding: 7px 6px 7px 4px; border-radius: 6px; }
.row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); align-items: start; min-width: 0; }  /* was 56px 1fr auto + border-bottom */
.score { min-width: 2.75rem; }
.row.is-read { opacity: var(--read-opacity); }
.row[aria-current="true"], .entry[aria-current="true"] { background: var(--cursor-bg); outline: 2px solid var(--accent); outline-offset: 0; border-radius: 6px; }  /* was panel bg + 1px line, invisible inside a panel card */
.signals { white-space: normal; }   /* was nowrap; long signal strings must wrap in narrow cards */
.overview { padding: 12px 16px; }
.overview p { margin: 6px 0 0; columns: 42ch 3; column-gap: 2.5rem; }
.cards { grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr)); gap: 10px 14px; }   /* 390 -> 1, 1024 -> 2, 1440 -> 4, 1920 -> 5, 2560 -> 6 */
.learn-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); gap: 12px 16px; align-items: start; }   /* 3 groups side by side from ~1150 px */
.learn-group { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; min-width: 0; }
.learn-group h2 { margin: 0 0 6px; }
.archive-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr)); gap: 10px 14px; }
.archive-list li { flex-direction: column; align-items: flex-start; gap: 4px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
.health-list { columns: 18rem; }    /* was columns: 2; more columns on wide screens */
```

### 1.3 Sticky filter row and cursor visibility

```css
@media (min-width: 900px) { .filters { position: sticky; top: var(--nav-h, 3.5rem); z-index: 2; background: var(--bg); } }
.row, .entry { scroll-margin-top: calc(var(--sticky-h, 4rem) + 8px); }
```

`nav` keeps `position: sticky; top: 0; z-index: 2`. `app.js` measures `--nav-h` (nav height) and `--sticky-h` (nav + filters height when the filters are visible and the viewport is >= 900 px, else nav only) with a `ResizeObserver` on `nav` and `#filters`, and after every `render()` (item 2). `scrollIntoView({ block: 'nearest' })` honours `scroll-margin-top`, so `k` never parks the current row under the sticky bars.

### 1.4 Overflow rules

`body { overflow-wrap: anywhere }` (inherited everywhere), `minmax(0, 1fr)` on every grid track, `min-width: 0` on `.section`, `.row`, `.card`, `.learn-group`, `.archive-list li`, `.signals { white-space: normal }`. The tablist keeps its own `overflow-x: auto` (internal scrolling below 1024 px is fine; the page itself must never scroll horizontally).

### 1.5 Budget

`styles.css` is 8,494 bytes; the additions are ~3 KB. Stay under the 15 KB budget asserted by `tests/frontend.test.js` by keeping the existing one-declaration-per-line style. Do not raise the budget.

## 2. `app.js` changes (small, all inside `start()` except two pure exports)

1. `renderDigest`: create `const grid = el('div', 'sections')` after the overview; for each section `sec.dataset.key = typeof section.key === 'string' ? section.key : ''`; append sections to `grid`, append `grid` to `panel`. Catch-up and archive-day views call `renderDigest` too, so each day gets its own `.sections` grid under its `.day-heading`.
2. `renderCategory`: wrap the `rowFor(...)` loop (both the saved-snapshot path and the normal path) in `const list = el('div', 'rows')`; append `list` to `panel`; the `.more` button stays after the grid. Early returns (`.notice`, alert) are unchanged.
3. `renderLearn`: append the three `.learn-group` divs into `const groups = el('div', 'learn-groups')`, then `panel.appendChild(groups)`; the `.counter` paragraph stays above.
4. Sticky measurement (CSS 1.3): 
   ```js
   const nav = doc.querySelector('nav');
   const wide = window.matchMedia('(min-width: 900px)');
   function measureSticky() {
     const navH = nav.offsetHeight;
     const filtersH = !filters.hidden && wide.matches ? filters.offsetHeight : 0;
     doc.documentElement.style.setProperty('--nav-h', `${navH}px`);
     doc.documentElement.style.setProperty('--sticky-h', `${navH + filtersH}px`);
   }
   if ('ResizeObserver' in window) { const ro = new ResizeObserver(measureSticky); ro.observe(nav); ro.observe(filters); }
   ```
   and call `measureSticky()` at the end of `render()`.
5. Theme (section 3 below): exports `sanitizeTheme`, `nextTheme`; `S.theme`; `applyTheme()`, `cycleTheme()`; `case 't'`; button click; `prefers-color-scheme` change listener.

Nothing else in `app.js` changes: `rows()`, `moveCursor`, `openRow`, click handling, routing, data loading and all `localStorage` keys stay as they are. Keep the file under 60 KB (now 30.8 KB).

## 3. Theme design

### 3.1 Palettes (CSS custom properties)

The ten values the existing test pins are kept verbatim. New tokens are added to both palettes. `--read-opacity` for dark moves from the hard-coded `0.55` to `0.6` so dimmed meta text clears 3:1 (2.99:1 at 0.55).

| token | dark (default `:root`) | light | role |
|---|---|---|---|
| `--bg` | `#0f1115` | `#fafafa` | page background, sticky bars, theme-color |
| `--panel` | `#161920` | `#fff` | section/row/learn/archive cards, overview, search field |
| `--chip` | `#1e222b` | `#eee` | chips, score pill, kbd, generic buttons |
| `--line` | `#262a33` | `#ddd` | separators, card borders, chip borders (decorative) |
| `--line-strong` | `#5e6774` | `#767f8a` | borders of interactive controls: buttons, search, selected tab (>= 3:1) |
| `--fg` | `#e7e9ee` | `#111` | body and title text |
| `--muted` | `#9aa3ad` | `#555` | meta, summaries, counters, placeholders |
| `--accent` | `#7ab7ff` | `#0a58ca` | links, pressed chips, focus ring, cursor outline, hover borders |
| `--visited` | `#9aa3ad` | `#555` | `.headline .title:visited` (same as today: muted) |
| `--why` | `#f0c674` | `#7a5200` | why-line, saved star |
| `--cursor-bg` | `#1a2130` | `#e8f0fe` | `[aria-current="true"]` background |
| `--read-opacity` | `0.6` | `0.7` | `.row.is-read` |
| `--tag-bg` / `--tag-fg` | `#22304a` / `#a9c7f5` | `#dbe7fb` / `#1e4a8f` | "AI-WRITTEN" badge (`.overview .tag`: `background: var(--tag-bg); color: var(--tag-fg); border: 0`) |
| `--ok` / `--warn` / `--bad` | `#4ec98a` / `#f0c674` / `#ff7b72` | `#1a7f4b` / `#8a5a00` / `#b42318` | health dot, read icon, alert |
| `color-scheme` | `dark` | `light` | form controls, scrollbars |

Focus ring stays `outline: 2px solid var(--accent); outline-offset: 2px` exactly (the test pins that text); the cursor outline uses the same accent.

WCAG ratios computed during planning (relative-luminance formula; the Playwright script re-measures them from computed styles):

Light palette:

| pair | colors | ratio | requirement |
|---|---|---|---|
| body text / bg | `#111` on `#fafafa` | 18.09 | >= 4.5 |
| body text / panel (cards) | `#111` on `#fff` | 18.88 | >= 4.5 |
| muted / bg | `#555` on `#fafafa` | 7.14 | >= 4.5 |
| muted / panel | `#555` on `#fff` | 7.46 | >= 4.5 |
| muted / chip (score pill, kbd) | `#555` on `#eee` | 6.43 | >= 4.5 |
| muted / cursor-bg | `#555` on `#e8f0fe` | 6.51 | >= 4.5 |
| link / bg, / panel, / chip | `#0a58ca` on `#fafafa` / `#fff` / `#eee` | 6.17 / 6.44 / 5.55 | >= 4.5 |
| pressed chip text / accent fill | `#fafafa` on `#0a58ca` | 6.17 | >= 4.5 |
| visited / panel | `#555` on `#fff` | 7.46 | >= 4.5 |
| why / panel, / bg | `#7a5200` on `#fff` / `#fafafa` | 6.92 / 6.63 | >= 4.5 |
| AI-WRITTEN badge | `#1e4a8f` on `#dbe7fb` | 6.92 | >= 4.5 |
| alert text / bg | `#b42318` on `#fafafa` | 6.30 | >= 4.5 |
| read icon (ok) / panel | `#1a7f4b` on `#fff` | 5.02 | >= 4.5 |
| read-dimmed title (fg at 0.7 over panel = `#585858`) | on `#fff` | 7.11 | >= 4.5 |
| read-dimmed meta (muted at 0.7 = `#888`) | on `#fff` | 3.54 | >= 3 (de-emphasised) |
| control border / bg, / panel | `#767f8a` on `#fafafa` / `#fff` | 3.89 / 4.06 | >= 3 |
| focus ring + cursor outline / bg, / panel | `#0a58ca` on `#fafafa` / `#fff` | 6.17 / 6.44 | >= 3 |
| health dot green / amber / red on `--chip` | `#1a7f4b` / `#8a5a00` / `#b42318` on `#eee` | 4.33 / 5.11 / 5.67 | >= 3 |

Dark palette (unchanged values plus new tokens): fg/bg 15.56, fg/panel 14.48, muted/bg 7.39, muted/panel 6.88, muted/chip 6.23, accent/bg 9.04, accent/panel 8.41, pressed chip 9.04, why/panel 10.92, badge 7.66, alert 7.49, control border/bg 3.30, border/panel 3.07, dots on chip 7.62 / 9.88 / 6.31, read-dimmed title at 0.6 = 6.14, read-dimmed muted at 0.6 = 3.40. All pass.

### 3.2 How `data-theme` composes with `prefers-color-scheme`

```css
:root { /* dark tokens */ color-scheme: dark; }
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) { /* light tokens */ color-scheme: light; }
}
:root[data-theme="light"] { /* light tokens */ color-scheme: light; }
```

- No attribute (System): the media query decides, exactly as today.
- `data-theme="light"`: forced light regardless of the OS.
- `data-theme="dark"`: `:not([data-theme="dark"])` excludes the light block, so the `:root` defaults (dark) apply even when the OS is light.
- Both light blocks are written **on one line each with identical declaration lists** (same order, same spelling). A unit test asserts they are identical and that every `--token` declared in the dark `:root` block appears in the light block (item 5). Specificity: `:root:not([data-theme="dark"])` and `:root[data-theme="light"]` are both (0,2,0) and beat `:root` (0,1,0).
- `color-scheme` moves with the tokens, so inputs, checkboxes and scrollbars follow the chosen theme. Keep `<meta name="color-scheme" content="dark light">`.

### 3.3 Inline bootstrap in `<head>` (no flash) + CSP hash

`index.html` head order: CSP meta, charset/viewport as today, `<meta name="color-scheme">`, **`<meta name="theme-color" id="theme-color" content="#0f1115">`**, **the inline script**, `<title>`, icon, stylesheet. The script runs before the stylesheet is requested and before `<body>` exists, so the first paint already has the right attribute.

Single line (no newline inside the element, so the hash does not depend on line endings):

```html
<script>(function(){var t=null;try{t=JSON.parse(localStorage.getItem('ahead:theme'))}catch(e){}var r=document.documentElement;if(t==='light'||t==='dark'){r.setAttribute('data-theme',t)}else{t=null}var m=document.getElementById('theme-color');if(m){m.content=(t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches)?'#0f1115':'#fafafa'}})();</script>
```

CSP becomes `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self' 'sha256-<BASE64>'; connect-src 'self'; base-uri 'none'; form-action 'none'` where `<BASE64>` is the SHA-256 of the exact text between `<script>` and `</script>`:

```powershell
node -e "const h=require('fs').readFileSync('index.html','utf8');const m=h.match(/<script>([^]*?)<\/script>/);console.log(require('crypto').createHash('sha256').update(m[1],'utf8').digest('base64'))"
```

Re-run it after any edit to the script; the unit test in item 6 fails if the hash and the script disagree. Rejected alternative: an external `theme.js` (no hash needed) cannot be deployed because the workflow's `cp` list is fixed and off-limits. The CSP stays strict: only this exact script may run inline.

### 3.4 Header button, `t` shortcut, theme-color

`index.html`, inside `.status` after `#health`:

```html
<button id="theme" class="theme" type="button" aria-label="Theme: System" title="Theme: System (t)" data-mode="system"><span class="theme-icon" aria-hidden="true"></span></button>
```

CSS: `.theme { display: inline-grid; place-items: center; width: 2rem; height: 2rem; padding: 0; border-radius: 50%; line-height: 1; }`, `.theme-icon::before { content: "◐"; }`, `.theme[data-mode="light"] .theme-icon::before { content: "☀"; }`, `.theme[data-mode="dark"] .theme-icon::before { content: "☾"; }` (system glyphs, `currentColor`, no image, no web font). Footer: append `, <kbd>t</kbd> theme` to the keys list.

`app.js`:

```js
export const sanitizeTheme = (v) => (v === 'light' || v === 'dark' ? v : 'system');
export const nextTheme = (t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system');   // System -> Light -> Dark -> System
// in S: theme: store.get('ahead:theme', sanitizeTheme)   (do not write it back at startup; absence means System)
const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
const themeBtn = $('theme'); const themeMeta = $('theme-color'); const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const root = doc.documentElement;
  if (S.theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', S.theme);
  themeBtn.dataset.mode = S.theme;
  const label = `Theme: ${THEME_LABELS[S.theme]}`; themeBtn.setAttribute('aria-label', label); themeBtn.title = `${label} (t)`;
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim(); if (themeMeta && bg) themeMeta.content = bg;
}
function cycleTheme() { S.theme = nextTheme(S.theme); store.set('ahead:theme', S.theme); applyTheme(); }
themeBtn.addEventListener('click', cycleTheme);
darkQuery.addEventListener('change', () => { if (S.theme === 'system') applyTheme(); });   // keeps theme-color right in System mode
applyTheme();   // before loadCore()
// keydown switch: case 't': cycleTheme(); break;   (already guarded: not in an input, no modifier keys)
```

## 4. Tests

### 4.1 Existing assertions that break and how to update them (`tests/frontend.test.js`)

| line | assertion | change |
|---|---|---|
| 19 | exact CSP string | regex that allows the hash: `script-src 'self' 'sha256-[A-Za-z0-9+/]{43}='` and otherwise the same directives |
| 28 | `no inline scripts` | replace with: exactly one `<script>` without `src`; its body contains no `\n`, includes `'ahead:theme'` and `data-theme`; `createHash('sha256').update(body, 'utf8').digest('base64')` appears in the CSP as `'sha256-…'`; the script's index is after `id="theme-color"` and before `href="styles.css"` |
| 60 | `max-width: 1100px` | `max-width: 2200px` |
| 53-55 | the ten palette values and `@media (prefers-color-scheme: light)` | keep as is (values retained) |
| 56-59 | focus-visible, reduced motion, 640px breakpoint, tabular-nums | keep as is |

### 4.2 New assertions (same style: static assertions on the source text)

In `tests/frontend.test.js`:

- `index.html`: `<meta name="theme-color" id="theme-color" content="#0f1115">` present; `/<button id="theme" class="theme" type="button"[^>]*aria-label="Theme: System"/`; footer contains `<kbd>t</kbd>`.
- `app.js`: `/'ahead:theme'/`, `/case 't':/`, `/el\('div', 'sections'\)/`, `/el\('div', 'rows'\)/`, `/el\('div', 'learn-groups'\)/`.
- `styles.css` (add a new test `'styles.css: fluid container, grids, both themes defined identically'`): `/font-size: clamp\(/`, `/padding: 0 clamp\(/`, `@media (min-width: 900px)`, `(min-width: 1500px)`, `(min-width: 2100px)`, `repeat(4, minmax(0, 1fr))`, `.section[data-key="must-know"] { grid-column: span 2`, `overflow-wrap: anywhere`, `scroll-margin-top`, `:root[data-theme="light"]`, `:root:not([data-theme="dark"])`, `color-scheme: light`, `color-scheme: dark`, `--read-opacity`, `--tag-bg`, `--cursor-bg`, `--line-strong`. Then the palette parity check:

  ```js
  const forced = css.match(/^:root\[data-theme="light"\] \{([^}]*)\}/m)[1].trim();
  const system = css.match(/:root:not\(\[data-theme="dark"\]\) \{([^}]*)\}/)[1].trim();
  assert.equal(forced, system, 'forced-light and system-light palettes must be identical');
  const tokens = (block) => [...block.matchAll(/--[a-z-]+(?=:)/g)].map((m) => m[0]).sort();
  const dark = css.match(/^:root \{([^}]*)\}/m)[1];
  assert.deepEqual(tokens(forced), tokens(dark), 'every dark token has a light counterpart');
  ```

In `tests/client-state.test.js`: one new test `theme sanitizer and cycle` importing `sanitizeTheme`, `nextTheme`: `'light'`/`'dark'` pass through; `'system'`, `undefined`, `null`, `'blue'`, `1`, `{}` -> `'system'`; `nextTheme('system') === 'light'`, `('light') === 'dark'`, `('dark') === 'system'`, `('nonsense') === 'system'`.

Expected totals after the change: 260 tests (258 + 1 frontend + 1 client-state); 260 pass on CI, and 260 pass locally once the relay allowlist working copy is LF (otherwise 259 pass + the pre-existing failure).

## 5. Playwright verification script

**Path:** `c:\Users\sudiskmr\Downloads\DomainClassification\ahead\.agents\tasks\ahead-build\verify-layout-theme.mjs`. `npm test` only matches `tests/**/*.test.js`, so nothing under `.agents/` is picked up. The file is committed (`.agents/` is tracked) as the record of how verification ran.

**Import** (no dependency added):

```js
import { pathToFileURL } from 'node:url';
const PW_DIR = process.env.PLAYWRIGHT_DIR ?? 'C:/Users/sudiskmr/Downloads/DomainClassification/hoshlab/node_modules';
const { chromium } = await import(pathToFileURL(`${PW_DIR}/playwright/index.mjs`).href);
```

**CLI:** `node .agents/tasks/ahead-build/verify-layout-theme.mjs` (local) and `node .agents/tasks/ahead-build/verify-layout-theme.mjs --live --base https://sudish007.github.io/ahead/` (live). Local mode probes `http://127.0.0.1:8787/ahead/`; if nothing answers it spawns `node scripts/serve.mjs` with `PORT=8787` and kills it on exit. Output: `docs/screenshots/*.png`, `.agents/tasks/ahead-build/layout-theme-evidence.json` (`-live.json` in live mode), a console summary, exit code 1 on any failure.

**Collectors on every page** (asserted empty at the end, in both modes): `console` messages of type `error` (a CSP block of the inline script would show up here as "Refused to execute inline script"), `pageerror`, `requestfailed`, responses with status >= 400. Never create the contexts with `bypassCSP: true`: the page's CSP must stay active so a wrong hash is caught. `page.evaluate` and `context.addInitScript` are not subject to the page CSP (verified during planning: `addStyleTag` is blocked by `style-src 'self'`, `evaluate` is not), so the script needs no style or script injection — read computed styles only.

**Theme seeding:** one browser context per theme with `colorScheme: 'dark'` and `context.addInitScript` that writes `localStorage.setItem('ahead:theme', JSON.stringify(theme))` and installs a `MutationObserver` on `document.documentElement` recording `window.__themeAtBody = document.documentElement.getAttribute('data-theme')` the moment `document.body` appears (proves the attribute was set before any body content could paint).

**Per width W in [360, 390, 1024, 1440, 1920, 2560, 3840], per theme in [light, dark], per tab in [brief, research, archive, learn]:** viewport `{ width: W, height: W <= 640 ? 844 : 1200 }`, `goto(base + '#' + tab)`, wait for the tab's content (`.sections .entry` / `.rows .row` / `.archive-list li` / `.learn-list input`), then record:

- `document.documentElement.scrollWidth <= window.innerWidth` (hard assertion, every width, every tab, every theme).
- Root font size `getComputedStyle(document.documentElement).fontSize` and `document.body.clientWidth`.
- Column counts: `getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length` for `.sections` (brief), `.rows` (research), `.cards` (leaderboards, once), `.learn-groups` (learn), `.archive-list` (archive). Chromium returns the resolved track list (e.g. `536.5px 536.5px 536.5px 536.5px`), so the split count is the real column count. Hard assertions for `.sections` and `.rows`: 390 -> 1, 1024 -> 2, 1440 -> 2, 1920 -> 3, 2560 -> 4, 3840 -> 4, 360 -> 1. Also assert at >= 1500 that the `must-know` section's `getBoundingClientRect().width` is more than 1.8x the `research` section's width (span 2 in effect) and that at < 1500 the two widths are equal.
- Overview: `columnWidth`/`columnGap` from computed style, `p.clientWidth`; used columns `N = min(3, floor((w + gap) / (colW + gap)))`; assert `(w - (N - 1) * gap) / N <= 80 * (colW / 42)` (no line longer than ~80ch) and record N (expect 1 at 390, 2 at 1024, 3 at >= 1440).
- Tablist at >= 1024: `tablist.scrollWidth <= tablist.clientWidth + 1` (all ten tabs visible).
- Screenshot when W in {390, 1024, 1440, 1920, 2560}: `docs/screenshots/${tab}-${W}-${theme}.png`; `fullPage: true` for brief, viewport only for the other tabs (keeps the 100-row Research captures small). Live mode writes `live-${tab}-${W}-${theme}.png` for tabs brief + research at W in {2560, 390} (8 files).
- `__themeAtBody` equals the seeded theme (no-flash evidence).

**Theme toggle (1440, fresh context without seeding, `colorScheme: 'dark'`):** after load `data-theme` is absent and `getComputedStyle(html).backgroundColor === 'rgb(15, 17, 21)'`; click `#theme` -> `data-theme="light"`, bg `rgb(250, 250, 250)`, `meta#theme-color` content `#fafafa`, `getComputedStyle(html).colorScheme === 'light'`, button `aria-label === 'Theme: Light'`; click -> `dark`, `rgb(15, 17, 21)`, `#0f1115`; click -> attribute absent again. Press `t` -> `light`; `localStorage.getItem('ahead:theme') === '"light"'`; `page.reload()` -> `data-theme="light"` and `__themeAtBody === 'light'`. Then a context with `colorScheme: 'light'`: no attribute -> light bg (media-query path); seed `"dark"` -> dark bg (forced dark beats a light OS).

**Keyboard in the grid (2560, brief, dark):** `rows = [...document.querySelectorAll('.row, .entry')]`; index of `[aria-current="true"]` is 0 after load; `j` -> 1, `k` -> 0, `j` x4 -> 4 (first Research entry) and its `getBoundingClientRect().left` is greater than entry 0's (moved into the next column); the current entry's rect is inside the viewport (`top >= 0`, `bottom <= innerHeight`) and its computed `outlineColor` equals the computed `--accent` (clearly visible). `o`: `const [popup] = await Promise.all([context.waitForEvent('page'), page.keyboard.press('o')])`; `popup.url()` (after `waitForLoadState('commit')` or using `popup.url()` immediately) equals the current element's `dataset.url`; close the popup. Repeat on research (`.rows`): `j`, `j`, `k` -> index 1; `o` opens that row's `data-url`; `r` adds `.is-read`, `s` adds `.is-saved`, `Escape` after `/` blurs search. Also at 1440 in a category tab scroll down, press `k` repeatedly and assert the current row's `top >= filters.getBoundingClientRect().bottom` (not hidden under the sticky bars).

**Contrast from computed colors (both themes, at 1440):** helper `luminance(rgbString)`, `ratio(fg, bg)`, `effectiveBackground(el)` (walk up until a non-transparent `backgroundColor`, else `html`), alpha-blend for `.is-read` using the row's `opacity`. Pairs recorded with fg/bg/ratio/min/pass: `.entry .title` on its section card; `.entry .meta` on the card; `.entry .why`; `.discussion` or `footer a` (accent link) on bg; `.overview .tag` color on its own background; `.chip[aria-pressed="true"]` text on its fill; `.health .dot` background on `.health` background (3:1); `#search` border-color on bg (3:1); `[aria-current="true"]` outline color on `--cursor-bg` (3:1); `.row.is-read .title` blended on the row card; `.row.is-read .meta` blended (3:1). Hard assertion: every light-theme pair passes its minimum; dark pairs recorded and asserted too.

**Evidence JSON shape:** `{ base, mode, generatedAt, chromium, widths: { "2560": { rootFontSize, bodyWidth, tabs: { brief: { scrollWidth, innerWidth, columns: { ".sections": 4 }, overview: { columns: 3, colWidthPx }, mustKnowSpan: true }, research: { columns: { ".rows": 4 } }, ... } } }, theme: {...}, keyboard: {...}, contrast: { light: [...], dark: [...] }, console: { errors, pageErrors, failedRequests, badResponses }, failures: [] }`. The report copies the column table and the contrast table from this file.

## 6. Implementation plan (ordered; Phase A = build loop, Phase B = deploy step)

Before item 1: `git -C c:/Users/sudiskmr/Downloads/DomainClassification/ahead pull --rebase origin main` (the Actions bot commits `data/` every six hours), then run `npm test` once to confirm the baseline described in section 0.

- [ ] 1. Fluid container, fluid type scale and overflow rules in `styles.css` per sections 1.1 and 1.4: `html` font-size clamp, `body` max-width 2200px / padding clamp / 1rem / line-height 1.5 / `overflow-wrap: anywhere`, every px font size converted to rem per the table, button/chip/search sizes in rem, tab font 0.85rem with 0.3rem/0.5rem padding and 0.7rem tablist kbd, `.signals` wraps, `.health-list { columns: 18rem }`. Update `tests/frontend.test.js` line 60 (`max-width: 2200px`) and add the `font-size: clamp(` / `padding: 0 clamp(` assertions.
      Files: `styles.css`, `tests/frontend.test.js`
      Verify: `node --test tests/frontend.test.js` passes; `npm run serve` + open `http://127.0.0.1:8787/ahead/` in the Playwright smoke (`node -e` with `chromium.launch()` is fine at this stage) at 2560: `document.body.clientWidth === 2200` and `getComputedStyle(document.documentElement).fontSize === '18px'`; at 390 `scrollWidth <= innerWidth`.

- [ ] 2. Grid wrappers and section keys in `app.js` (section 2, points 1-3): `div.sections` in `renderDigest` with `sec.dataset.key`, `div.rows` in `renderCategory` (both paths), `div.learn-groups` in `renderLearn`. No other behaviour changes.
      Files: `app.js`
      Verify: `node --test tests/client-state.test.js tests/frontend.test.js` passes (app.js still imports without a DOM); in the browser the Brief shows six `.sections > .section` with `data-key` attributes, Research shows `.rows > .row` (100), Learn shows `.learn-groups > .learn-group` (3); `j`/`k`/`o`/`r`/`s` behave as before (manual Playwright check acceptable here; the full script comes in item 7).

- [ ] 3. Grid and card CSS per section 1.2 (`.sections, .rows` shared rule + the 900/1500/2100 breakpoints, `must-know` span, section/row/learn/archive cards, cursor highlight with `--cursor-bg` + accent outline (temporarily alias `--cursor-bg` to `--panel`-adjacent values in both existing palettes; item 5 finalises the tokens), `.cards`/`.learn-groups`/`.archive-list` auto-fill grids, overview `columns: 42ch 3`). Add the grid assertions to the new styles test in `tests/frontend.test.js` (section 4.2) except the theme-token ones.
      Files: `styles.css`, `tests/frontend.test.js`
      Verify: `node --test tests/frontend.test.js`; in the browser `getComputedStyle(document.querySelector('.sections')).gridTemplateColumns.split(/\s+/).length` is 1 / 2 / 2 / 3 / 4 at 390 / 1024 / 1440 / 1920 / 2560 and the same for `.rows` on Research; `scrollWidth <= innerWidth` at 360 and 3840; `styles.css` still < 15 KB (`(Get-Item styles.css).Length`).

- [ ] 4. Sticky filters and cursor visibility (sections 1.3 and 2.4): `.filters` sticky under `--nav-h` at >= 900 px, `scroll-margin-top` on `.row, .entry`, `measureSticky()` + `ResizeObserver` in `app.js`, called after each `render()`.
      Files: `styles.css`, `app.js`
      Verify: `node --test tests/frontend.test.js tests/client-state.test.js`; in the browser at 1440 on Research, `getComputedStyle(document.documentElement).getPropertyValue('--sticky-h')` is a px value > nav height, `#filters` `getBoundingClientRect().top` equals the nav's bottom after scrolling 2000 px, and after `End` + repeated `k` the current row's top is never above `#filters`' bottom.

- [ ] 5. Theme palettes and `data-theme` composition in `styles.css` (sections 3.1 and 3.2): add the new tokens to the dark `:root` block (keeping the five pinned dark values), replace the light media block body with `:root:not([data-theme="dark"]) { … }` on one line, add the identical one-line `:root[data-theme="light"] { … }` block, switch `.overview .tag`, `.row.is-read`, `[aria-current]`, `button`/`#search` borders, `.headline .title:visited` to the new tokens; `.theme` button styles with the three glyphs. Extend the styles test with the theme-token assertions and the palette-parity check from section 4.2.
      Files: `styles.css`, `tests/frontend.test.js`
      Verify: `node --test tests/frontend.test.js`; in the browser `document.documentElement.setAttribute('data-theme','light')` turns `getComputedStyle(document.documentElement).backgroundColor` into `rgb(250, 250, 250)` and `colorScheme` into `light`; removing it restores the system scheme; `'dark'` forces dark in a `colorScheme: 'light'` context.

- [ ] 6. Theme bootstrap, button, shortcut and meta (sections 3.3 and 3.4): `index.html` gets the `theme-color` meta, the single-line inline script, the hash in the CSP, the `#theme` button, the footer `t` hint; `app.js` gets `sanitizeTheme`/`nextTheme` exports, `S.theme`, `applyTheme`/`cycleTheme`, `case 't'`, click and `prefers-color-scheme` listeners. Update `tests/frontend.test.js` lines 19 and 28 (CSP regex, one hash-listed inline script) and add the index/app assertions from section 4.2; add the `theme sanitizer and cycle` test to `tests/client-state.test.js`.
      Files: `index.html`, `app.js`, `tests/frontend.test.js`, `tests/client-state.test.js`
      Verify: `npm test` -> 260 tests, every test passes except (if not normalised) the pre-existing `relay-allowlist` CRLF failure; `index.html` < 10 KB; in the browser with the console open: no CSP error, clicking `#theme` cycles System -> Light -> Dark -> System, `t` does the same, `localStorage['ahead:theme']` is `"light"`/`"dark"` and reload keeps the choice with no flash (the `__themeAtBody` check in item 7 is the formal evidence).

- [ ] 7. Write `.agents/tasks/ahead-build/verify-layout-theme.mjs` per section 5 and run it locally. Remove the nine old screenshots (`brief-1440.png`, `brief-390.png`, `brief-light-1440.png`, `research-*.png`, `archive-*.png`, `learn-*.png`) so `docs/screenshots/` holds only the new `{tab}-{width}-{theme}.png` set (40 files). Read `docs/screenshots/brief-1920-light.png`, `brief-2560-dark.png`, `research-2560-light.png` and `research-1920-dark.png` with the image reader and confirm multi-column content spanning the width, not a centred column; fix CSS and re-run if anything is off.
      Files: `.agents/tasks/ahead-build/verify-layout-theme.mjs`, `.agents/tasks/ahead-build/layout-theme-evidence.json`, `docs/screenshots/*.png`
      Verify: `node .agents/tasks/ahead-build/verify-layout-theme.mjs` exits 0 with `failures: []`, zero console errors / failed requests, the expected column counts, every light contrast pair passing, `__themeAtBody` matching the seeded theme, keyboard checks passing. Re-run `npm test` afterwards (the script must not have changed anything under `tests/`).

- [ ] 8. Write the first version of `.agents/tasks/ahead-build/layout-theme-report.md`: what changed (files), breakpoints and measured column counts per width (from the evidence JSON), the light-palette contrast table as measured, the `npm test` totals (and the relay-allowlist note), screenshot paths, deviations from the brief (inline script hash instead of plain inline because of the CSP; no chip sidebar; dark `--read-opacity` 0.6; old screenshots removed), and a "pending after deploy" section listing commit SHAs, Actions run id, live screenshots and live `styles.css` check as to-be-filled.
      Files: `.agents/tasks/ahead-build/layout-theme-report.md`
      Verify: the report's column table and contrast numbers match `layout-theme-evidence.json`; `npm test` summary line pasted verbatim.

- [ ] 9. Commit locally in this order (no push in Phase A; stage files by name, never `git add -A`):
      1. `feat(ui): fluid 2200px container, rem type scale and responsive grids for brief, categories, leaderboards, learn and archive` — `styles.css`, `app.js`, `tests/frontend.test.js` (items 1-4)
      2. `feat(ui): user-selectable System/Light/Dark theme with t shortcut, no-flash bootstrap and AA light palette` — `index.html`, `app.js`, `styles.css`, `tests/frontend.test.js`, `tests/client-state.test.js` (items 5-6)
      3. `test(ui): Playwright layout/theme verification, evidence and screenshots at 390-2560 in both themes` — `.agents/tasks/ahead-build/verify-layout-theme.mjs`, `.agents/tasks/ahead-build/layout-theme-evidence.json`, `docs/screenshots/` (adds + deletions), `.agents/tasks/ahead-build/layout-theme-report.md` (item 7-8)
      Files: as listed
      Verify: `git status --short` clean except untracked nothing; `git log --oneline -3` shows the three commits; `npm test` still green; the reviewer then reads the evidence JSON, the report and the 1920/2560 screenshots and writes `.agents/tasks/ahead-build/layout-theme-review.json`.

- [ ] 10. **(Phase B, deploy step)** Publish: `git -C c:/Users/sudiskmr/Downloads/DomainClassification/ahead pull --rebase origin main` (never force-push, never rewrite history), `git push origin main`, then `gh run list --repo Sudish007/ahead --limit 3` and `gh run watch <id> --repo Sudish007/ahead --exit-status`. The push triggers one refresh + deploy run (~2-3 min). Retry `gh`/network errors with backoff (30 s, 60 s, 120 s).
      Files: none
      Verify: the run for the pushed SHA has `conclusion: success`; record the run id and URL.

- [ ] 11. Live check: poll `https://sudish007.github.io/ahead/styles.css` (PowerShell `Invoke-WebRequest -Headers @{ 'Cache-Control' = 'no-cache' }`) until the body contains `data-theme` (Pages CDN caches ~10 min; retry every 60 s, up to 15 min), and confirm `https://sudish007.github.io/ahead/` contains `'sha256-` and `id="theme-color"`. Then `node .agents/tasks/ahead-build/verify-layout-theme.mjs --live --base https://sudish007.github.io/ahead/` -> `live-brief-2560-{light,dark}.png`, `live-brief-390-*.png`, `live-research-2560-*.png`, `live-research-390-*.png`, `layout-theme-evidence-live.json`, exit 0. Read `live-brief-2560-light.png` and confirm four section columns.
      Files: `docs/screenshots/live-*.png`, `.agents/tasks/ahead-build/layout-theme-evidence-live.json`
      Verify: live script exits 0; zero console errors / failed requests against the live origin; the live `styles.css` check passed.

- [ ] 12. Finalise the report (commit SHAs from `git log`, Actions run id/URL, live screenshot paths, live styles check, anything imperfect) and commit `docs: layout/theme report, live verification screenshots [skip ci]` — `[skip ci]` because a docs-only push would otherwise start another data refresh (and spend LLM quota) without changing the site. `git pull --rebase origin main`, `git push origin main`.
      Files: `.agents/tasks/ahead-build/layout-theme-report.md`, `docs/screenshots/live-*.png`, `.agents/tasks/ahead-build/layout-theme-evidence-live.json`
      Verify: `git status` clean, `git log origin/main --oneline -1` shows the docs commit, `gh run list --repo Sudish007/ahead --limit 1` shows no new run for it (skipped), the live site still serves the new `styles.css`.

## 7. Report contents (`.agents/tasks/ahead-build/layout-theme-report.md`)

What changed (files + commit SHAs); breakpoints (900 / 1500 / 2100) and the measured column counts at 390, 1024, 1440, 1920, 2560, 3840 for `.sections`, `.rows`, `.cards`, `.learn-groups`, `.archive-list`; root font size at each width; the light-palette contrast table as measured by the script (and the dark one); `npm test` totals before/after; Actions run id + URL; every screenshot path; the deviations listed in item 8; anything left imperfect (candidates: PNG weight of 48 screenshots, the `relay-allowlist` CRLF quirk on Windows checkouts, glyph rendering of ◐/☀/☾ depends on the OS symbol font).

## 8. Out of scope — do not touch

`scripts/`, `src/`, `sources.config.mjs`, `relay/` (a line-ending-only checkout of `relay/src/allowlist.json` is allowed; no content change), `data/`, `.github/workflows/refresh.yml`, `package.json` dependencies (no Playwright dependency, no runtime deps, no framework, no bundler, no build step), fonts (system stack only, no web fonts), the data pipeline, ranking, LLM layer, relay. Do not change tab/route semantics, storage keys, the `ahead:lastVisit` rule, the health indicator, or the CSP beyond adding the one hash source. Do not add `theme.js` or any new deployable file (the workflow would not ship it).
