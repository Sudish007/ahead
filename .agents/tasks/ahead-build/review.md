# Ahead: static AI dashboard with a 6-hourly fetch, dedup, scoring and 5-minute brief pipeline

This change is the whole first implementation of Ahead: a Node ESM pipeline (`src/`, `scripts/fetch.mjs`) that pulls 64 sources (arXiv, HF Papers/models, HN, Reddit, lab blogs, newsletters, GitHub releases/search, podcasts, YouTube, two sitemap publishers), normalizes and deduplicates them by canonical URL / arXiv id, merges with the previous run, scores with weight x decay + log engagement + cross-source bonus, and builds a capped daily brief; a static frontend (`index.html`, `app.js`, `styles.css`) renders the brief, category tabs, leaderboards, learning list and archive with catch-up; and a GitHub Actions workflow refreshes `data/` every six hours and deploys to Pages. The implementation follows the operative plan, including all seven orchestrator decisions and P1-P12. Verification evidence (177 offline tests passing, three live runs with 41 ok / 23 empty / 0-1 failed, Playwright UI checks, committed real `data/`) is recorded in `verification-notes.md` and the committed data matches it.

Watch for: the optional LLM layer's 60 s timeout covers only the response headers, not the body read, so a stalled provider can hang the run until the Actions job timeout (confirmed, low likelihood, disabled by default); an LLM why-line containing the word "null"/"undefined"/"NaN" would trip the digest validator and fail the whole run instead of being rejected per-line (possible); `s`/`r` on Brief entries have no effect / no visible effect because `items.json` is lazy and `.entry.is-read` is unstyled (confirmed, minor); the 45 s per-source backstop and the 8-minute run budget have no direct test. None of these block the acceptance criteria.

**Verdict**: APPROVED

## High-level view

`run()` validates the config, builds the registry and HTTP client, loads the previous `items.json`/`meta.json`/digests, then a 6-worker pool claims registry indices in order and stores each `runSource` result at its index, so output order never depends on completion order. `runSource` races fetch+parse against a 45 s `WallClockError` backstop and converts every exception into `{ status: 'failed', error: errorClass(err) }`; nothing a single source does can reject the worker, and pending sources past the 8-minute budget become `failed: 'run budget exceeded'`. Outputs are validated against `schema.js` and written `.tmp` + rename in the order items, digest, index, meta.

The HTTP client bounds each request by `min(timeoutMs, deadlineAt - now)`, streams the body under `maxBytes`, recomputes headers per redirect hop so the GitHub token only ever reaches `api.github.com`, and retries once unless the host is `www.reddit.com`, the status is a non-429 4xx, or fewer than 25 s remain before the deadline. Per-host pacing lives inside the client, so arXiv fallbacks and sitemap page fetches are paced too.

Parsers validate XML before parsing, sniff the format from the body, drop malformed records individually (counted in `skipped`), keep undated feed entries (they surface at `now`), and require `lastmod` for sitemap URLs. The sitemap parser keeps source-scoped skip/cache maps, emits invalidations when a page proves older than the window, and falls back to slug titles when page fetches fail or the 40 s page budget passes.

Dedup and the previous-run merge use total orders so output is byte-deterministic; ephemeral HN/Reddit markers are stripped from stored items before merge, so a story that left the front page never claims present tense. Source `at` is the earliest sighting, which is what keeps hf-trending and GitHub-search items (surfaced at `now` every run) decaying instead of resetting every six hours.

The brief fills six sections from a 36 h pool (widened to 72 h under 20 candidates) minus the two previous days' picks, writes heuristic why-lines from validated operands only, and enforces the word budget in six stages before `finalizeDigest`. The live digest is 560 words / 3 minutes with all six sections populated and no `[AINews]` in Analysis or Deep read.

The LLM layer validates the model's overview and why-lines against the facts it was sent (D1). Two robustness gaps remain, both affecting only runs with a configured key: the body read is not covered by the 60 s abort, and the digest validator's operand-word regex can reject an otherwise valid LLM sentence and fail the run.

The frontend is one ES module behind a strict CSP; `items.json` loads lazily on the first category tab or search. Catch-up follows D5 (dates compared, today excluded, 14 max, `lastVisit` written only when the Brief renders). The keyboard `s`/`r` actions are wired for every row but only have a visible effect on category rows.

<details>
<summary>Issues (6)</summary>

1. **LLM body read outside the timeout** — `post()` clears the abort timer when headers arrive; `res.json()`/`readSome()` then read the body with no bound, so a stalled provider hangs the run until the Actions 20-minute job timeout and that cycle commits nothing. Keep the controller armed through the body read (clear after `res.json()`), or race the body read against the remaining budget. Non-blocking (LLM disabled without a key).
2. **Operand-word guard fails the run on LLM text** — `validateDigest` throws on `/\b(?:undefined|NaN|null)\b/` in any `why`, including `whySource: 'llm'` lines; an LLM sentence containing "null" (e.g. "null results") crashes `run()` after the brief is built. Apply the same regex in `editorialize` as a per-line rejection (fall back to the heuristic line) so validation never sees it. Non-blocking.
3. **`s` and `r` on Brief entries** — `s` on a Brief entry does nothing unless `items.json` has already been loaded (it is lazy), and `r` toggles `is-read` on `.entry`, which `styles.css` does not style. Build the saved snapshot from the entry's own fields (title, url, sourceNames, publishedAt, category are all present) and add an `.entry.is-read` rule. Non-blocking; the plan only mandates `j`/`k` on brief entries.
4. **Prior digest with bad scalar fields fails the run** — `loadPrevious` accepts any digest with matching `date`, `sections[]` and `itemIds[]`; a file with a non-integer `wordCount`/`readingMinutes` or bad `generatedAt` reaches `validateDigestIndex` and throws. Run `validateDigest` (or the index-field subset) in `loadPrevious` and skip with a warning, as verification note 8 already claims. Non-blocking; only the pipeline writes these files.
5. **Backstop and run budget untested** — no test exercises `runSource`'s 45 s `WallClockError` path or the 8-minute `run budget exceeded` path; the `failed` row shape they produce (`ms`, `error`, no `httpStatus`) is asserted nowhere. Add a test with an injected never-resolving `fetchImpl` and a fake `nowMs`, or export the backstop so tests can shorten it. Non-blocking.
6. **Body decoding ignores declared charsets** — `readBody` always decodes as UTF-8; a feed declaring ISO-8859-1 would show mojibake in titles/summaries. All 64 probed sources are UTF-8 today. Informational; consider honouring `charset=` from `content-type` when adding sources.

</details>

<details>
<summary>Details</summary>

### Per-source isolation: backstop, run budget and failure accounting

`runSource` races the fetch+parse promise against a `setTimeout` backstop, with `work.catch(() => {})` attached first so a fetch that fails after the backstop won cannot surface as an unhandled rejection. Every failure path, including a parser throwing a programming error, lands in the same `{ status: 'failed', items: [], fetched: 0, kept: 0, error }` shape. `errorClass` maps unknown exceptions to `'network'`, which is per spec but means a parser `TypeError` would be reported as a network failure in `meta.sources`; the live run shows no such row and the per-record guards make it unlikely (likely, informational).

The worker loop checks `nowMs() - runStart > RUN_BUDGET_MS` before claiming each source and records the remainder as `failed: 'run budget exceeded'` with `ms: 0`, which satisfies `validateMeta`. Neither this path nor the 45 s backstop has a test (confirmed gap); `http.test.js` proves the 42 s two-attempt bound and the deadline cap, which are what keep the backstop from firing in practice.

The failing-source-never-fails-the-run chain was traced through validation as well: `skipped = fetched - kept` is asserted by `validateMeta`, and `kept <= fetched` holds in every parser because `applySelection` slices from the parsed records; the `ok -> empty` downgrade happens after `toItem`, so a source whose records all fail normalization shows as `empty`. A sitemap source that fails or hits the backstop carries its previous validated skip/cache maps forward unchanged, so a transient outage never erases cache state.

### HTTP client: deadline-bounded retry and token scoping

The abort timer in `once()` stays armed until the body has been fully read; this is the pattern `llm.js` does not follow (below). Redirects use `redirect: 'manual'` with headers recomputed per hop, so an `api.github.com` redirect to another host drops the bearer token; `http.test.js` asserts this and that the token never appears in error text.

`retryable()` treats timeouts as retryable, but the 25 s remaining-time guard after the 2 s backoff means a 20 s timeout is never retried inside a 45 s source window (22 s elapsed, 23 s left) while a fast 503 is. That matches the plan's 42 s bound and keeps the retry from colliding with the backstop.

`readBody` decodes with `TextDecoder('utf-8')` regardless of the `content-type` charset. Every probed source is UTF-8, so this is informational, but a future ISO-8859-1 feed would show mojibake (possible).

### Parser hardening: malformed records, missing dates, sitemap state

An entry with no `pubDate`/`dc:date`/`published`/`updated`/`issued` is kept by `applySelection` (undated passes the age filter) and surfaces at `now` in `toItem`, so a feed that omits dates contributes items rather than failing; `parseDate` clamps future dates to `now` and rejects pre-2000 values. The JSON parsers omit absent optional fields rather than writing `undefined`, which is what keeps D3's promise, and `parseHn` swallows rank-URL failures into `note: 'rank unavailable'` without affecting status.

The sitemap parser requires a parseable `lastmod` (normalized with `toISOString()` so cache comparisons are exact), considers 30 URLs, fetches at most 10 pages at concurrency 4 under `min(start + 40 s, deadlineAt)`, and falls back to a slug title on page failure or deadline. A page whose `article:published_time` is older than the window is dropped, marked in `sitemapSkipped`, and produces an invalidation only when a stored item from this source exists at that canonical URL. `pruneSitemapMap` keeps only entries still in the sitemap with the same lastmod and caps at 30. A cached entry whose `publishedAt` were unparseable would produce an `Invalid Date` raw item that `toItem` turns into `at = now`, but `validateSitemapState` rejects such entries on load, so the path is unreachable with pipeline-written state.

### Prior-digest loading tolerance

`loadPrevious` reads every `YYYY-MM-DD.json` in `data/digests/`, skips unparseable files and those whose `date` does not match the filename or lack `sections`/`itemIds` arrays, and passes the rest to `buildBrief` (within 15 days, excluding today) and to the index rebuild. `dayEntry()` copies `generatedAt`, `wordCount` and `readingMinutes` from each prior digest, and `validateDigestIndex` then requires an ISO string and integers, so a prior digest that parses and has the two arrays but a damaged scalar field fails the entire run (confirmed code path; low likelihood because only this pipeline writes digests, after validation, via `.tmp` + rename). Verification note 8 describes the tolerance as "corrupt digest files are skipped with a warning", which overstates it. Validating prior digests with `validateDigest` in `loadPrevious` and skipping failures would make the claim true.

### Brief construction and the word budget

`recentDeepReads` is taken from the 14 most recent digests before today, but the pipeline only passes digests from the last 15 days, so "last 14 digests" is effectively "last 14 within 15 days"; for a daily cadence this is the same set.

`enforceBudget` stages 1-4 stop at the first mutation that fits; stages 5 and 6 are whole-stage (verification note decision 1), which the adversarial test's "every title/why <= 12 words" assertion requires. The terminal bound after stage 6 is 15 x (12 + 12 + 20) entry words + 15 section-title words + a <= 200-word overview = 875 < 1100, so the internal `throw` after stage 6 is unreachable for both the 880 and 1100 targets, including the post-LLM pass that re-runs the budget at 1100.

### LLM editorial layer: body-read timeout and the operand-word guard

`post()` arms an `AbortController` for 60 s and clears it in `finally` as soon as `fetchImpl` resolves, which happens when response headers arrive. `editorialize` then calls `res.json()` (and `readSome()` on the 400 branch) with no timeout, so a provider that returns headers and then stalls the body holds `run()` open indefinitely; in Actions the 20-minute job timeout kills the run and that cycle commits no data (confirmed code path; requires a misbehaving provider and a configured key). Clearing the timer after `res.json()`, or racing the body read against the remaining budget, closes the gap.

`validateDigest` rejects any `why` matching `/\b(?:undefined|NaN|null)\b/`. For heuristic lines this is a sound tripwire for operand leaks. For accepted LLM lines it is a run-failing assertion on free text: a why-line such as "reports null results on 3 benchmarks" passes `editorialize`'s checks (word count, number tokens), is written into the digest, and then throws `SchemaError` before any file is written, so the whole refresh exits 1 (possible; low likelihood). Applying the same regex inside `editorialize` as a per-line rejection keeps the heuristic line and never reaches the validator.

The key never enters error text (`fail()` strings are fixed classes), the request body carries no key, and `brief.facts` is never serialized (D1); `llm.test.js` asserts all three.

### Frontend: Brief-tab keyboard actions and lazy items

`items.json` is fetched only on the first category tab or search input, so on the Brief tab `S.items` is `null`. The `s` handler resolves the row via `itemById(row.dataset.id)` and, failing that, only un-saves an already saved id; on a Brief entry it therefore does nothing (confirmed). `r` toggles `is-read` on the entry, but `styles.css` styles only `.row.is-read`, so the toggle persists to `localStorage` with no visible feedback (confirmed). The footer advertises `s save` and `r read` globally. Digest entries carry every field the saved snapshot needs (`title`, `url`, `sourceNames`, `publishedAt`, `category`), so a snapshot can be built from the entry without loading items; a one-line `.entry.is-read` rule covers `r`. The plan mandates `j`/`k` on brief entries and is silent on `s`/`r` there, so this is a polish gap, not an acceptance failure.

The saved-snapshot "no longer in the 7-day window" hint reads `S.items?.some(...)`, which is falsy while items are still loading, so a snapshot can show the hint between toggling Saved and the items response; `ensureItems().finally` re-renders category tabs, so it self-corrects (confirmed, cosmetic).

### Test coverage

Twenty offline suites (177 tests, 45 s) cover the plan's §13 table end to end, including the robustness paths this review focused on: full-pipeline runs with forced failures (Reddit 403, Mistral `TypeError`) proving `failedCount === 2` and the run completing, malformed-record injection in every JSON parser, corrupt previous `items.json`/`meta.json`, same-day and next-day re-runs, HTTP retry/deadline/byte-cap/token scoping under a fake clock, the adversarial 1,100-word brief, and the LLM acceptance/rejection/retry matrix. `fixtureFetch` throws on unmapped URLs so no test reaches the network, and `data-shape.test.js` validates the committed data without a `now`, so it cannot go stale in CI.

Not tested: the 45 s `runSource` backstop and the 8-minute run budget (their `failed` rows are asserted nowhere); the LLM body-read stall; GitHub Actions end to end, which the plan defers to the first push.

</details>

<details>
<summary>File map</summary>

- `sources.config.mjs` — 64 source literals (5/3/12/22/12/10 by category), 8 leaderboards, 3 `more` link-outs, 16 learn entries.
- `src/registry.js` — registry Map, `sourceInfo` fallback for removed ids, `codePointCompare`.
- `src/schema.js` — config validation naming exact paths; item/items-file/digest/index/meta validators; advisory sitemap-state validator.
- `src/http.js` — run-scoped client: timeout/deadline, byte cap, manual redirects, one retry with 25 s guard, per-host pacing, token scoping, error classes.
- `src/normalize.js` — URL canonicalization, arXiv id extraction, text cleaning, date parsing, `toItem`.
- `src/parsers/feed.js`, `arxiv.js`, `json.js`, `reddit.js`, `sitemap.js`, `common.js` — per-type parsers with per-record drops and `applySelection`.
- `src/dedup.js` — in-run merge, ephemeral strip, invalidations, previous-run merge with authority tuples.
- `src/score.js` — score formula and `compareRank` total order.
- `src/brief.js` — section fill, `orderSources` (D4), heuristic why-lines, six-stage budget, `finalizeDigest`.
- `src/llm.js` — config resolution, fact-validated editorial pass, `max_tokens` compatibility retry.
- `src/pipeline.js` — `run()`/`runSource()`: pool, backstop, budget, merge, retention, brief, meta, validation, atomic writes.
- `scripts/fetch.mjs`, `probe-sources.mjs`, `serve.mjs` — CLI (sole stdout owner), probe via `runSource`, local static server for `/` and `/ahead/`.
- `index.html`, `app.js`, `styles.css`, `favicon.svg` — static frontend; pure helpers exported for tests.
- `.github/workflows/refresh.yml` — cron/dispatch/push refresh, `[skip ci]` data commit, Pages deploy (as plan §12).
- `tests/*.test.js`, `tests/helpers.js`, `tests/preload-fixture-fetch.mjs`, `tests/fixtures/` — offline suites and 31 real-response fixtures.
- `data/` — first live refresh (517 items, 2026-10-20 digest, index, meta).
- `README.md`, `docs/screenshots/`, `.agents/tasks/ahead-build/verification-notes.md` — docs and evidence.

Full diff: `git log --oneline 5749d97..ac0bd30` (14 commits on `main`).

</details>
