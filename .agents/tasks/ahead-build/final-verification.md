# Final verification — Ahead

Date: 2026-10-20 (UTC). Repo `Sudish007/ahead`, branch `main`. Node v24.16.0 locally; Node 24 on `ubuntu-latest` in Actions. Evidence is consolidated from `verification-notes.md` (Steps C, D, E) plus a re-check of the live URLs and Actions history made while writing this file.

- **Repository:** https://github.com/Sudish007/ahead
- **Live site:** https://sudish007.github.io/ahead/
- **Last data-bearing commit on `main` before this doc:** `2f4a34b data: refresh 2026-10-20T03:43Z [skip ci]` (bot). The docs commit SHA is recorded in §Commit at the end of this file.

## Acceptance criteria (plan §14) — one by one

### 1. `npm ci && npm test` green on Node 24; no test touches the network

**Met.**

| command | outcome |
|---|---|
| `npm test` (empty `data/`) | 176 pass, 1 skipped (`data-shape` skips without data), 0 fail, ~45 s |
| `npm test` (with live `data/`) | **177 pass, 0 skipped, 0 fail**, ~45 s — run after Step C, twice in Step D (before/after the `src/http.js` fix), and in Actions runs 39365298984 and 39365652341 (`npm ci` + `npm test` steps green) |

20 test files under `node --test "tests/**/*.test.js"`. `fixtureFetch` throws on any unmapped URL; the CLI tests run `scripts/fetch.mjs` under `node --import tests/preload-fixture-fetch.mjs`, which swaps `globalThis.fetch`.

### 2. `--source hn-top --dry-run` ok; `--source hn-top` alone exits 1 without fetching

**Met.** Covered by `tests/cli.test.js` (part of the 177 passing tests): dry-run with `--source` prints the parser diagnostics and writes nothing; `--source` without `--dry-run` exits 1 before any fetch.

### 3. Live `npm run fetch`: >= 25 sources `ok`; failures do not fail the run; four data files written atomically; `meta.failedCount` matches the UI; `meta.sources.anthropic.homepage` present

**Met locally; met on Actions with a caveat (see Limitations).**

Local runs (`node scripts/fetch.mjs`, network on, 7 runs across Steps C and D, exit 0 every time, 12-13 s each):

- Final local run: `ok 41 · empty 23 · failed 0 · items 529 · brief 558 words`. 41 >= 25.
- Transient failures observed and handled without failing the run: Reddit HTTP 429 (two runs), `yt-yannic` / `yt-aiexplained` HTTP 404 (upstream flakiness; fixed with a one-time retry for `www.youtube.com` 404s in `src/http.js`, commit `86e9635`).
- `arxiv-cs.AI` RSS empty -> API fallback (`note: 'api fallback'`, fetched 100, kept 60).
- Files written: `data/items.json`, `data/meta.json`, `data/digests/2026-10-20.json`, `data/digests/index.json` (temp-file + rename in `pipeline.js`; `tests/pipeline.test.js`).
- `meta.sources.anthropic.homepage === 'https://www.anthropic.com/news'`; sources without a homepage have no `homepage` key.
- Health text: `All sources OK` when `failedCount === 0` (asserted in the Playwright run); `1 source failed` seen in the run-3 data; `N sources failed` otherwise (`tests/client-state.test.js` pins 0/1/3/7).

Per-source `kept` counts for the final local run (Step C run 3, 41 ok / 23 empty / 0 failed):

| source | kept | source | kept | source | kept |
|---|---|---|---|---|---|
| arxiv-cs.LG | 60 | arxiv-cs.CL | 60 | arxiv-cs.AI | 60 |
| arxiv-cs.CV | 60 | hf-papers | 60 | hn-top | 14 |
| hn-front | 4 | reddit | 50 | openai | 13 |
| anthropic | 9 | deepmind | 5 | google-research | 4 |
| meta-engineering-ai | 1 | microsoft-research | 1 | nvidia-dev | 7 |
| hf-blog | 9 | allenai | 2 | mistral | 1 |
| interconnects | 1 | simonw | 10 | semianalysis | 2 |
| importai | 1 | latentspace | 8 | zvi | 6 |
| thebatch | 6 | epoch | 2 | alignmentforum | 5 |
| chinai | 1 | gh-rel-vllm | 6 | gh-rel-transformers | 3 |
| gh-rel-llamacpp | 3 | gh-rel-sglang | 1 | gh-rel-unsloth | 3 |
| gh-rel-trl | 1 | gh-trending-llm | 10 | gh-trending-agents | 15 |
| hf-trending | 20 | pod-cogrev | 2 | yt-gpumode | 2 |
| yt-stanford | 5 | yt-3b1b | 1 | | |

`empty` (fetched fine, nothing inside the 7-day window): meta-newsroom-ai, transformer-circuits, lilog, raschka, chiphuyen, eugeneyan, hamel, oneusefulthing, gradient, epoch-gradient-updates, jalammar, karpathy-blog, karpathy-bearblog, horace, gh-rel-pytorch, gh-rel-torchtitan, gh-trending-ml, pod-dwarkesh, pod-mlst, pod-nopriors, yt-karpathy, yt-yannic, yt-aiexplained. `empty` does not count toward the health indicator.

Committed data (bot run 39365652341, now on `main` and live): `okCount 33, emptyCount 19, failedCount 12, itemCount 535, trimmedForSize 0`. 33 >= 25. The 12 failures are listed under Limitations.

### 4. Weekday digest: six sections populated; `wordCount <= 1100`; `readingMinutes <= 5`; no `undefined`/`NaN`; `[AINews]` never in Analysis/Deep read

**Met.** `data/digests/2026-10-20.json` (local and live): Must know 4, Research 3, Releases & tools 3, From the labs 2, Analysis worth reading 2, One deep read 1 = 15 entries. `wordCount 558`, `readingMinutes 3`. The digest schema test asserts no `undefined`/`NaN`/`null` in any why-line and no `[AINews]` in Analysis or Deep read; the live `index.json` reports `entryCount 15, wordCount 558, readingMinutes 3`.

### 5. `npm run probe` lists every source with status/items/ms/finalUrl

**Met.** Exit 0; header plus 64 rows (`id | status | items | ms | note | finalUrl`); 41 ok / 23 empty / 0 failed on the local run.

### 6. `npm run serve`: `/` and `/ahead/` render; `Cache-Control: no-store`; traversal and malformed URIs rejected; MIME types correct

**Met.** `tests/serve.test.js`: `text/html; charset=utf-8` + `Cache-Control: no-store` on both prefixes; MIME for css/js/json/svg; 404 for `/../` and `%2e%2e`; 400 for `%ZZ`; 405 for POST; HEAD without body. The Playwright runs used `scripts/serve.mjs` on both `http://127.0.0.1:8791/` and `/ahead/` (Step C) and `http://localhost:8787/ahead/` (Step D).

### 7. UI behaviour

**Met.** Playwright 1.64 (Chromium headless, borrowed from a sibling project, not a dependency), Step C: 45 checks, 0 failures on both prefixes; Step D: 19 checks, 0 failures, run twice. Verified: default tab Brief; keys `2`/`3`/`4`/`5`/`8`/`9`/`0` switch tabs and update `location.hash`; `j`/`k` move `aria-current` on exactly one row; `o` opens the row URL in a new page (popup URL asserted, `https://arxiv.org/abs/2610.22791`); `s` saves, `r` marks read, `/` focuses search, `Escape` blurs; search filters without re-sorting; range `24h` persisted in `localStorage`; read/saved/lastVisit persist across reload; Saved chip shows the saved snapshot; Archive lists `2026-10-20` with reading time and shows `Nothing to catch up on` on a single-day first visit, selecting a day renders it with the brief renderer; Leaderboards 8 cards and Learn 16 checkboxes (`1/16 done`) from `meta.static`; `Also:` strips on Research (alphaXiv), Labs (Meta AI blog), Blogs (AI News) and absent on News; `meta.json` 404 -> calm `No data yet` notice, `index.json` 500 -> `role="alert"` banner naming file and status while Leaderboards still render; light scheme applies (`rgb(250, 250, 250)`); 390 px: no horizontal overflow on Brief/Research/Archive/Learn; **0 console errors, 0 page errors, 0 failed requests** across pages/tabs/viewports.

Screenshots (`c:\Users\sudiskmr\Downloads\DomainClassification\ahead\docs\screenshots\`):

- `brief-1440.png`, `brief-390.png` (full page)
- `brief-light-1440.png`
- `research-1440.png`, `research-390.png`
- `archive-1440.png`, `archive-390.png`
- `learn-1440.png`, `learn-390.png` (full page)

Contrast (>= 4.5:1 in both schemes) is enforced by the token values in `styles.css` and checked in `tests/frontend.test.js`; it was not re-measured in the browser.

### 8. File budgets

**Met.** `index.html` 4.9 KB (< 10 KB), `app.js` ~34 KB (< 60 KB), `styles.css` ~8.5 KB (< 15 KB), asserted by `tests/frontend.test.js`. `items.json` 462,103 bytes locally and ~470 KB live (cap 2,000,000; `trimmedForSize 0`).

### 9. Secrets

**Met.** Grep over `data/**/*.json` for `Bearer|LLM_API_KEY|ghp_|sk-` returned one false positive (`sk-` inside "mask-token" in an abstract) and no credentials. `tests/llm.test.js` asserts the key never appears in error strings. No `LLM_*` secret is set on the repo, so the live run never held a key.

### 10. Actions: first run creates Pages, commits data with `[skip ci]`, deploys; live URL loads; manual trigger works; data-only commit does not retrigger

**Met.**

- Pages was created with `gh api -X POST repos/Sudish007/ahead/pages -f build_type=workflow` (`html_url: https://sudish007.github.io/ahead/`, `https_enforced: true`) before the first run; `configure-pages@v6` with `enablement: true` remains in the workflow and ran green.
- **First run:** id **39365298984**, https://github.com/Sudish007/ahead/actions/runs/39365298984 — trigger push of `4b6690e`, created 03:37:48Z, finished 03:39:58Z (2 m 10 s), `conclusion: success`. `refresh` job: checkout, setup-node, `npm ci`, `npm test`, fetch (19.9 s), data commit, stage `_site`, configure-pages, upload-pages-artifact all green; `deploy` job 118441011292 (`deploy-pages@v5`) green. Bot commit `fa17400 data: refresh 2026-10-20T03:39Z [skip ci]` landed on `origin/main` and **did not** start a second run (`paths-ignore: ['data/**']` + `[skip ci]`).
- **Second run:** id **39365652341**, https://github.com/Sudish007/ahead/actions/runs/39365652341 — trigger push of `3e7d3df` (docs), created 03:41:56Z, `conclusion: success`; bot commit `2f4a34b data: refresh 2026-10-20T03:43Z [skip ci]`, again no retrigger. `gh run list` shows exactly these two runs, confirming that neither data commit retriggered the workflow.
- Manual trigger: `workflow_dispatch` is declared in `refresh.yml`; `gh workflow run refresh.yml` was not exercised separately because the two push-triggered runs already proved the job end to end.
- Live URLs, re-checked while writing this file (HEAD requests):

| URL | status | bytes |
|---|---|---|
| https://sudish007.github.io/ahead/ | **200** | 5,203 |
| https://sudish007.github.io/ahead/data/meta.json | **200** | 23,964 |
| https://sudish007.github.io/ahead/data/digests/index.json | **200** | 161 |

Live `meta.json`: `generatedAt 2026-10-20T03:42:54.189Z` (run 39365652341), `okCount 33, emptyCount 19, failedCount 12, itemCount 535`, `llm { enabled: false, ok: false }` — identical to the local `data/meta.json` after `git pull --rebase`.

### 11. Optional LLM layer

**Heuristic path met; LLM-on path verified by unit tests only.** No `LLM_API_KEY` is set, so the live `meta.llm` is `{ enabled: false, ok: false }` and the heuristic brief deployed. The with-key behaviour (overview 150-200 words, "AI-written" tag, number-grounding rejection, base-URL rules, `max_completion_tokens` retry, three result states) is covered by `tests/llm.test.js` against a mocked `fetchImpl`; it has not been run against a real provider because the user has not supplied a key. Setup steps are in `README.md` ("Optional LLM editorial layer").

## Commits (chronological, `main`)

| SHA | message |
|---|---|
| `ac0bd30` | docs: build verification notes |
| `86e9635` | fix(http): retry transient YouTube feed 404s once |
| `bd301d8` | data: live refresh (41 ok, 23 empty, 0 failed; 529 items; 558-word brief) |
| `00bde73` | docs: Step D browser verification screenshots and notes |
| `4b6690e` | ci: grant id-token write to refresh job for Pages enablement |
| `fa17400` | data: refresh 2026-10-20T03:39Z [skip ci] (bot, run 39365298984) |
| `3e7d3df` | docs: Step E deploy verification notes |
| `2f4a34b` | data: refresh 2026-10-20T03:43Z [skip ci] (bot, run 39365652341) |
| `88c3be0` | docs: README provider notes and final verification record (this file; pushed to `origin/main`) |

## Unresolved limitations

1. **12 sources fail from GitHub-hosted runners but not from a home connection.** Substack feeds (`importai`, `zvi`, `epoch-gradient-updates`, `chinai`, `pod-dwarkesh`) and The Batch sitemap (`thebatch`, deeplearning.ai) answer HTTP 403; the six YouTube channel feeds (`yt-karpathy`, `yt-yannic`, `yt-aiexplained`, `yt-gpumode`, `yt-stanford`, `yt-3b1b`) answer HTTP 404 even after the one retry. The pipeline handles this as designed (errors recorded per source, exit 0, brief built from 535 items) and the live health button reads `12 sources failed`, which is accurate. Candidate fixes, not implemented: browser-like `User-Agent`/`Accept` headers for those hosts, or an Invidious/Piped RSS mirror for YouTube.
2. **LLM layer not exercised against a real provider** (no key supplied). Unit-tested only.
3. **`gh workflow run refresh.yml` not exercised** as a separate manual trigger; the two push runs covered the same job.
4. **The repository grows with each data commit** (about four per day); squashing history is out of scope.
5. Browser verification used Playwright from a sibling project and a throw-away driver script; there is no repeatable `npm run e2e` in this repo.
