# Verification notes — Step C build (iteration 1)

Repo: `c:\Users\sudiskmr\Downloads\DomainClassification\ahead` on `main`. Node v24.16.0, Windows. All commands run from the project root.

## 1. Offline test suite

| command | outcome |
|---|---|
| `npm test` (before any live data) | 176 pass, 1 skipped (`data-shape` skips when `data/` is empty), 0 fail, 45 s |
| `npm test` (after the live run, real `data/` present) | **177 pass, 0 skipped, 0 fail**, 45 s |

Test files: registry, normalize, http, feed, github, arxiv, json, reddit, sitemap, score, dedup, determinism, brief, llm, pipeline, cli, client-state, frontend, serve, data-shape (20 files, `node --test "tests/**/*.test.js"`). No test touches the network: `fixtureFetch` throws on any unmapped URL, and the CLI tests run `scripts/fetch.mjs` under `node --import tests/preload-fixture-fetch.mjs` which swaps `globalThis.fetch` for the fixture fetch.

## 2. Live pipeline run (network on)

`node scripts/fetch.mjs` was run three times on 2026-10-20 (UTC). Run 1 was a first run (empty `data/`); runs 2 and 3 exercised the previous-run merge on real data (`newItemCount` 2 and 0). Elapsed 12-13 s each. Exit code 0 every time.

Run 1 ended `ok 40 · empty 23 · failed 1 · items 517 · brief 561 words` (Reddit answered HTTP 429; recorded as `failed` in `meta.json` and the run continued). Run 3 (final committed data):

```
id                     | status | fetched | kept | ms    | note/error
arxiv-cs.LG            | ok     | 391     | 60   | 476   | 
arxiv-cs.CL            | ok     | 226     | 60   | 1253  | 
arxiv-cs.AI            | ok     | 100     | 60   | 2283  | api fallback
arxiv-cs.CV            | ok     | 201     | 60   | 3382  | 
hf-papers              | ok     | 100     | 60   | 628   | 
hn-top                 | ok     | 54      | 14   | 943   | 
hn-front               | ok     | 30      | 4    | 1294  | 
reddit                 | ok     | 50      | 50   | 1463  | 
openai                 | ok     | 1300    | 13   | 389   | 
anthropic              | ok     | 566     | 9    | 694   | 
deepmind               | ok     | 100     | 5    | 337   | 
google-research        | ok     | 100     | 4    | 872   | 
meta-newsroom-ai       | empty  | 10      | 0    | 188   | 
meta-engineering-ai    | ok     | 9       | 1    | 256   | 
microsoft-research     | ok     | 10      | 1    | 1580  | 
nvidia-dev             | ok     | 100     | 7    | 1407  | 
hf-blog                | ok     | 882     | 9    | 370   | 
allenai                | ok     | 25      | 2    | 1285  | 
mistral                | ok     | 90      | 1    | 415   | 
transformer-circuits   | empty  | 56      | 0    | 872   | 
lilog                  | empty  | 53      | 0    | 416   | 
interconnects          | ok     | 20      | 1    | 771   | 
raschka                | empty  | 20      | 0    | 919   | 
simonw                 | ok     | 30      | 10   | 394   | 
chiphuyen              | empty  | 10      | 0    | 1851  | 
eugeneyan              | empty  | 212     | 0    | 343   | 
hamel                  | empty  | 20      | 0    | 697   | 
semianalysis           | ok     | 20      | 2    | 989   | 
importai               | ok     | 20      | 1    | 541   | 
latentspace            | ok     | 20      | 8    | 485   | 
zvi                    | ok     | 20      | 6    | 682   | 
thebatch               | ok     | 3406    | 6    | 433   | 
oneusefulthing         | empty  | 20      | 0    | 455   | 
gradient               | empty  | 15      | 0    | 1445  | 
epoch                  | ok     | 50      | 2    | 239   | 
epoch-gradient-updates | empty  | 20      | 0    | 433   | 
alignmentforum         | ok     | 10      | 5    | 190   | 
chinai                 | ok     | 20      | 1    | 541   | 
jalammar               | empty  | 11      | 0    | 509   | 
karpathy-blog          | empty  | 10      | 0    | 395   | 
karpathy-bearblog      | empty  | 10      | 0    | 319   | 
horace                 | empty  | 6       | 0    | 237   | 
gh-rel-pytorch         | empty  | 10      | 0    | 1584  | 
gh-rel-vllm            | ok     | 10      | 6    | 1902  | 
gh-rel-transformers    | ok     | 10      | 3    | 2944  | 
gh-rel-llamacpp        | ok     | 10      | 3    | 999   | 
gh-rel-sglang          | ok     | 10      | 1    | 5630  | 
gh-rel-unsloth         | ok     | 10      | 3    | 5022  | 
gh-rel-trl             | ok     | 10      | 1    | 2089  | 
gh-rel-torchtitan      | empty  | 10      | 0    | 563   | 
gh-trending-llm        | ok     | 30      | 10   | 1068  | 
gh-trending-ml         | empty  | 30      | 0    | 1943  | 
gh-trending-agents     | ok     | 30      | 15   | 1995  | 
hf-trending            | ok     | 20      | 20   | 287   | 
pod-dwarkesh           | empty  | 142     | 0    | 309   | 
pod-mlst               | empty  | 271     | 0    | 547   | 
pod-cogrev             | ok     | 387     | 2    | 1245  | 
pod-nopriors           | empty  | 183     | 0    | 702   | 
yt-karpathy            | empty  | 15      | 0    | 296   | 
yt-yannic              | empty  | 15      | 0    | 385   | 
yt-aiexplained         | empty  | 15      | 0    | 523   | 
yt-gpumode             | ok     | 15      | 2    | 555   | 
yt-stanford            | ok     | 15      | 5    | 290   | 
yt-3b1b                | ok     | 15      | 1    | 448   | 
ok 41 · empty 23 · failed 0 · items 517 · brief 560 words
```

Observations:
- `>= 25` sources `ok`: 41. Reddit's 429 on run 1 was recorded as `{ status: 'failed', error: 'HTTP 429', httpStatus: 429 }` and never failed the run; on later runs it answered 200 (`fetched 25`).
- `arxiv-cs.AI` RSS was empty and fell back to the API (`note: 'api fallback'`, `fetched 100`, `kept 60`).
- The 23 `empty` sources all fetched fine but had nothing inside the 7-day window (low-cadence blogs, pytorch/torchtitan CI-tag release feeds, podcasts between episodes, GitHub topic:machine-learning under the 50-star floor). `empty` is not counted as failed by the UI.
- `meta.json`: `okCount 41, emptyCount 23, failedCount 0, itemCount 517, trimmedForSize 0`, `llm { enabled: false, ok: false }` (no key), `sources.anthropic.homepage === 'https://www.anthropic.com/news'`, no `homepage` key on sources without one, `sitemapCache` anthropic 9 / thebatch 6 entries, `sitemapSkipped` anthropic 3 (pages whose `article:published_time` proved older than 7 days).
- `items.json`: 448,331 bytes (cap 2,000,000), 517 items, unique ids, every `surfacedAt` within 7 days.
- Digest `data/digests/2026-10-20.json`: all six sections populated (4/3/3/2/2/1 = 15 entries), `wordCount 560`, `readingMinutes 3`, no `undefined`/`NaN`/`null` in any why-line (schema asserts this), `[AINews]` absent from Analysis and Deep read. `index.json` has one day with `entryCount 15`.
- Secrets grep over `data/**/*.json` for `Bearer|LLM_API_KEY|ghp_|sk-`: one false positive (the substring `sk-` inside "mask-token" in an abstract); no credentials.

## 3. Probe

`npm run probe` -> exit 0, one row per source (64 rows + header), printed `id | status | items | ms | note | finalUrl`:

```
id                     | status | items | ms    | note | finalUrl
... (65 rows: 64 sources + header; 41 ok, 23 empty, 0 failed)
```

## 4. Local server and UI

`npm run serve` (`scripts/serve.mjs`) serves `/` and `/ahead/`; `tests/serve.test.js` checks `text/html; charset=utf-8` + `Cache-Control: no-store` on both prefixes, MIME types for css/js/json/svg, 404 for traversal (raw `/../`, `%2e%2e`), 400 for `%ZZ`, 405 for POST, HEAD without body.

UI checked with Playwright 1.64 (reused from `../hoshlab/node_modules`, not added as a dependency) against the live data on both `http://127.0.0.1:8791/ahead/` and `http://127.0.0.1:8791/`: 45 checks, 0 failures. Covered: six brief sections with 15 entries; header digest date / read time; health button `aria-label` and `<details>` summary both equal `All sources OK` (matches `meta.failedCount === 0`); keys `2`/`3`/`4`/`5`/`8`/`9`/`0` switch tabs and `location.hash`; `j`/`k` cursor, `r` read, `s` save, `o` opens the row URL in a new page (popup URL asserted), `/` focuses search, `Escape` blurs; search filters without re-sorting; range `24h` persisted to `localStorage`; Saved chip shows the saved snapshot; `Also:` strips present on Research (alphaXiv), Labs (Meta AI blog), Blogs (AI News) and absent on News; Leaderboards 8 cards; Learn 16 checkboxes with `1/16 done` counter; Archive lists days, `Nothing to catch up on` (first visit with a single day), selecting a day renders it with the brief renderer; read/saved/lastVisit persist across reload; light scheme applies (`rgb(250, 250, 250)` background); console clean on both prefixes; `meta.json` 404 -> calm "No data yet" notice with no alert; `index.json` 500 -> `role="alert"` banner naming the file and HTTP status while Leaderboards still render from `meta`. Screenshots in `docs/screenshots/` (brief 1440/390, research, archive, learn, light scheme).

## 5. Budgets and workflow

- `index.html` 4.9 KB (< 10 KB), `app.js` ~34 KB (< 60 KB), `styles.css` ~8.5 KB (< 15 KB); asserted by `tests/frontend.test.js`.
- `.github/workflows/refresh.yml`: `cron: '0 */6 * * *'`, `workflow_dispatch`, `push` to `main` with `paths-ignore: ['data/**']`; `refresh` job `contents: write` + `pages: write`; `deploy` job `pages: write` + `id-token: write`; data committed with `[skip ci]`; artifact is the `_site` staging copy. Not exercised here (needs the push); the first Actions run is the remaining item of plan §14.

## 6. Decisions on ambiguities (simplest reading consistent with the plan)

1. **Budget stages 5-6 are whole-stage.** Stages 1-4 stop as soon as the digest fits; stages 5 (cap every title/why at 12 words) and 6 (three labels + `+N sources`) apply to every entry at once, then recount. The plan's adversarial test asserts every title/why `<= 12` words and every label list trimmed, which only holds if these stages are not interrupted mid-way.
2. **Health text grammar.** `healthStatus` says `1 source failed` for one failure and `N sources failed` otherwise; tests pin 0/1/3/7 and the 13 h stale case.
3. **HN clause with comments only.** Without points, the clause is `{comments} comments on HN` (the plan lists `{comments} comments`; "on HN" is added so the clause names its source).
4. **Sitemap map pruning lives in the parser.** `parseSitemap` returns already-pruned, 30-capped `sitemapSkipped`/`sitemapCache` maps (URLs still in the sitemap with the same normalized `lastmod` inside the age window); `pipeline.js` stores them, and carries the previous validated maps unchanged when the source fails.
5. **Redirect note.** `note: 'redirected to <finalUrl>'` compares normalized URLs (`new URL(...).href`), so percent-encoding differences (`>` vs `%3E` in query strings) are not reported as redirects; the arXiv API fallback compares against `fallbackUrl`.
6. **`<title>` suffix rule applied literally.** `Hyphenated-word title` with no `og:title` is stripped to `Hyphenated` when the remainder has >= 10 characters, as the design's regex specifies; both sitemap publishers ship `og:title` so the rule is rarely reached.
7. **`serve.mjs` rejects raw `..` segments** (404) before URL normalization so `/../package.json` is never 200, as the plan's test requires; browsers never send such a path.
8. **`pipeline.js` loads every digest file** for the index and passes those within the last 15 days (excluding today's own file) to `buildBrief`; corrupt digest files are skipped with a warning and omitted from the index.
9. **Playwright** was used from the sibling project for verification only and is not a dependency of this repo.