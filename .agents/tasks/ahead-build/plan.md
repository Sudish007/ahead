# Ahead — implementation plan (operative spec for the coder)

Project root: `c:\Users\sudiskmr\Downloads\DomainClassification\ahead` (git, branch `main`, work directly here). Node v24.16.0. Plain Node ESM, `node:test`, `fast-xml-parser` 5.11.2, no framework/bundler/server/database. The site is static and must work under `https://sudish007.github.io/ahead/` (every URL relative).

This file is the spec. `design.md` (same folder) is consulted only for the details this plan points to by section number (`D§5.3` = design.md section 5.3). `source-probe.md` records what every URL returns; `tests/fixtures/README.md` lists the 31 fixtures. Where this plan and design.md disagree, this plan wins.

---

## 1. Decisions (settled; implement exactly, do not reopen)

### Seven orchestrator decisions

- **D1 — LLM validation input.** `buildBrief()` returns a `Brief = { digest, facts }` where `facts: Map<entryId, { signals }>` is built from the selected items (`{ ...item.signals }`). `editorialize(brief, config, fetchImpl)` builds the prompt entries from `brief.digest` entries plus `brief.facts.get(id).signals`, and validates the response against that same object: every `why` key must be an existing entry id; every number token in an accepted `why[id]` must occur in that entry's sent fields (`id`, `section`, `title`, `summary`, each `sourceNames` string, `JSON.stringify(signals)`); overview numbers must occur in the union of all entries' sets. `facts` is never serialized; `pipeline.js` writes `brief.digest` only. The serialized digest entry has no `signals` field.
- **D2 — Hugging Face model id.** `isHfModelId(id)`: string, length <= 200, matches `^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$` (slash required, exactly two segments), AND neither segment contains `..` or ends with `.`. Anything else is a per-record drop (counted in `skipped`). The test rejecting `owner/..` and `model..name/x` stands. (All 20 fixture models have `owner/name` ids.)
- **D3 — HF optional fields; GitHub stars operand.** Missing optional HF fields are **omitted** (never `undefined`/`null` in JSON; signals object contains only present keys). Exhaustive mapping:
  - HF Papers: `paper.upvotes -> signals.hfUpvotes`; `paper.githubStars -> extra.githubStars` (stored only: not in the score, not in any why clause); `paper.githubRepo -> extra.githubRepo` only when a non-empty string. Everything else (`numComments`, `projectPage`, `ai_summary`, `ai_keywords`, `organization`, `mediaUrls`, ...) is dropped.
  - HF Models: `likes -> signals.hfLikes`; `downloads -> extra.downloads`; `trendingScore -> extra.trendingScore`; `pipeline_tag -> extra.pipelineTag`; `library_name -> extra.libraryName`; `author -> authors: [author]` (only when a non-empty string). Numeric values only after `Number(v)` is finite and non-negative. `summaryText` = present parts joined by ` · ` in the order `pipeline_tag`, `library_name`, `{likes} likes`, `{downloads} downloads` (numbers with en-US thousands separators), e.g. `image-text-to-text · transformers · 1,548 likes · 17,924 downloads`.
  - The brief's GitHub-stars clause operand is `item.signals.ghStars` (= `stargazers_count` from the search API), formatted with en-US thousands separators (`1,234 stars in 3 days`). `extra.githubStars` never feeds a clause.
- **D4 — Brief source presentation.** `orderSources(item, registry)` sorts `item.sources` by registry weight descending, then `at` ascending (earliest first), then id by `codePointCompare`. `primary = orderSources(item)[0]`; `primaryFamily = sourceInfo(primary.id).family`. Digest `sourceIds`/`sourceNames` follow this order (primary first). `{source}` in every fallback clause is `sourceInfo(primary.id).name`. The `also on ...` clause walks the same order, skips `primaryFamily` and the `hn` family when an HN clause was already emitted, dedups by family, and names each family by its first source in that order. The 6.4 label-trimming pass keeps the first three labels of this order.
- **D5 — Catch up since last visit.** `selectCatchUpDays(indexDays, previousVisitMs, newestDate)` returns, newest first and at most 14, every index entry whose `date` (UTC `YYYY-MM-DD`) is strictly later than the UTC date of `previousVisitMs` and strictly earlier than `newestDate`, where `newestDate = index.days[0].date` (the digest the Brief tab renders; "today"). Today's brief is never part of catch-up; a later same-day refresh never re-qualifies a day (dates, not `generatedAt`, are compared). `previousVisitMs` is the `ahead:lastVisit` value read once at startup into memory; `ahead:lastVisit = Date.now()` is written every time the Brief tab is rendered (this is the only write; no `pagehide`/`visibilitychange` write). `previousVisitMs === 0` (first visit) yields up to the 14 newest earlier digests.
- **D6 — Homepage metadata.** `meta.sources[id].homepage` = the registry's configured `homepage` when present (validated HTTP(S)); omitted otherwise. The row's source chip is an `<a target="_blank" rel="noopener noreferrer">` whose `href` is `meta.sources[id]?.homepage ?? new URL(item.url).origin`. This replaces design wording that the chip links to `sources[].url`.
- **D7 — Local static server.** `scripts/serve.mjs` is written fresh (~60 lines, `node:http`): binds `127.0.0.1`, `PORT` env (integer 1..65535, else 8787); serves the project root under both `/` and `/ahead/` (strip a leading `/ahead` segment, then resolve); `GET`/`HEAD` only (405 otherwise); `decodeURIComponent` failure -> 400; resolved path must stay inside the root (else 404); `/` or a directory -> `index.html`; MIME: `.html text/html; charset=utf-8`, `.js text/javascript; charset=utf-8`, `.css text/css; charset=utf-8`, `.json application/json; charset=utf-8`, `.svg image/svg+xml`, `.ico image/x-icon`, `.png image/png`, `.xml application/xml`, else `application/octet-stream`; headers `Cache-Control: no-store`, `Content-Type`, `Content-Length`; plain-text 404 (no 404.html); no gzip. Prints both base URLs on start.

### Planner decisions for remaining ambiguities (also settled)

- **P1** Add `src/registry.js` (`buildRegistry`, `sourceInfo`, `codePointCompare`, `UNKNOWN_SOURCE`) so `dedup.js`, `score.js`, `brief.js`, `pipeline.js` share one implementation without an import cycle. `compareRank` stays in `score.js`.
- **P2** Heuristic why-line number formatting: the stars clause uses en-US thousands separators (D3); every other count (`hnPoints`, `hnComments`, `hfUpvotes`, `hfLikes`, `ytViews`) uses `compact(n)`: `n < 1000 -> String(n)`; `n < 1e6 -> (n/1e3).toFixed(1).replace(/\.0$/, '') + 'k'`; else `(n/1e6).toFixed(1).replace(/\.0$/, '') + 'm'`. The stars clause uses `in 1 day` when `d === 1`, otherwise `in {d} days`.
- **P3** Digest `date` is the UTC date of `now` captured at run start. `readingMinutes = max(1, ceil(wordCount / 220))`.
- **P4** `pipeline.js` exports `runSource(source, deps)` (the generic per-source runner incl. the 45 s backstop) so `scripts/probe-sources.mjs` reuses it instead of duplicating fetch/parse logic.
- **P5** `createHttpClient` takes an optional `userAgent`; the default is `Ahead/<version> (+https://github.com/Sudish007/ahead; personal AI dashboard)` with `<version>` read once from `package.json` (`readFileSync(new URL('../package.json', import.meta.url))`).
- **P6** `tests/helpers.js` imports `src/pipeline.js` lazily inside `runFixture()` (`await import(...)`) so parser tests can use the helpers before the pipeline exists.
- **P7** Archive "Catch up" button label: `Catch up since <UTC date of previousVisit>`; `Catch up` when `previousVisit === 0`; when the selection is empty the button is disabled with text `Nothing to catch up on`.
- **P8** Health `<details>` lists each source as plain text `name · status · kept · error?` (no links). Only the row chip uses `homepage` (D6).
- **P9** Items from a source id absent from `meta.sources` (removed source) render the chip as the id with `href = origin(item.url)`.
- **P10** `favicon.svg`: a 32x32 SVG, dark circle `#0f1115` with the accent-colored (`#7ab7ff`) text `A`; no external refs.
- **P11** Frontend static contract tests live in `tests/frontend.test.js` (size budgets, CSP meta, no `innerHTML`, no absolute `fetch('/...')` paths); client-state tests in `tests/client-state.test.js`; a server test in `tests/serve.test.js`. These are in addition to the design's test list.
- **P12** Keyboard tabs: `1` Brief … `9` Learn, `0` Archive (design §8.2); the brief's "1-9 tabs" is satisfied, `0` adds Archive.

---

## 2. Stack, scripts, conventions

- `package.json`: `"type": "module"`, `engines.node ">=22"`, `dependencies: { "fast-xml-parser": "5.11.2" }` (moved from devDependencies; runtime needs it after `npm ci`), no other deps. Scripts: `test` = `node --test "tests/**/*.test.js"`, `fetch` = `node scripts/fetch.mjs`, `probe` = `node scripts/probe-sources.mjs`, `serve` = `node scripts/serve.mjs`.
- `.gitignore`: `node_modules`, `.DS_Store`, `_site/`. `.agents/` and `data/` stay tracked. `.gitattributes` already has `tests/fixtures/** -text`.
- Code style: ESM, `node:test` + `node:assert/strict`, exact-pinned versions, pipeline code in `src/*.js`, CLIs in `scripts/*.mjs`, tests flat in `tests/*.test.js`. No `console.*` inside `src/` except through the injected logger; `run()` never writes stdout.
- Every date-dependent test pins `NOW = new Date('2026-10-19T12:00:00Z')` (fixture capture day).

---

## 3. Modules and exported signatures

```
sources.config.mjs      export const sources, linkouts, learn            (literals: §4 below + D§4.2 for linkouts/learn)

src/registry.js         buildRegistry(sources) -> Map<id, {...source, family, registryIndex, category, type, parser}>
                        sourceInfo(registry, id) -> entry | { id, name: id, family: id, weight: 1, longForm: false,
                                                               registryIndex: Infinity, category: null, type: null, parser: null }
                        codePointCompare(a, b) -> number        (D§5.7 code)
src/schema.js           validateConfig({ sources, linkouts, learn })      throws ConfigError naming `sources[3].include` etc.
                        validateItem(item), validateItemsFile(obj), validateDigest(digest), validateDigestIndex(index, digestsByDate),
                        validateMeta(meta), validateSitemapState(meta, sitemapSourceIds, logger) -> { sitemapSkipped, sitemapCache }
                        CATEGORIES, TYPES, SIGNAL_KEYS, SECTION_KEYS, CATEGORY_PRECEDENCE
src/http.js             createHttpClient({ fetchImpl, githubToken = '', sleep, nowMs = Date.now, userAgent }) -> { fetchText }
                        fetchText(url, { timeoutMs = 20000, maxBytes = 8_000_000, accept, deadlineAt }) -> { status, text, finalUrl, contentType }
                        HttpError, BodyTooLarge, TimeoutError, errorClass(err) -> 'HTTP 403' | 'timeout' | 'body too large' | 'network' | 'parse error: <class>' | 'wall clock'
                        PACING = { 'export.arxiv.org': 3000, 'rss.arxiv.org': 1000, 'api.github.com': 1000 }, ACCEPT = { feed, json, html }
src/normalize.js        canonicalizeUrl(raw) -> string|null, extractArxivId(s) -> string|null, stripHtml(html), cleanText(html),
                        truncate(text, max), parseDate(value, now) -> Date|undefined, isHttpUrl(s), itemId(canonicalUrl, arxivId),
                        toItem(raw, source, now) -> Item|null        (null = invalid record; caller increments skipped)
src/parsers/feed.js     parseFeed(body, source, ctx) -> { items: RawItem[], fetched, kept, note? }   (rss | atom | youtube | github releases)
                        FXP_OPTIONS, sniffFormat(body), text(node)
src/parsers/arxiv.js    fetchArxivSource(source, ctx) -> SourceResult
src/parsers/json.js     parseHn(body, source, ctx) (async: rankUrl), parseHfPapers, parseHfModels, parseGithubSearch
                        isAiStory(title, url), AI_HOSTS, AI_TITLE_STRONG, isHfModelId(id)
src/parsers/reddit.js   parseReddit(body, source, ctx)
src/parsers/sitemap.js  parseSitemap(body, source, ctx) -> { items, fetched, kept, note?, sitemapSkipped, sitemapCache, invalidations }
src/dedup.js            mergeItems(candidates, registry) -> Item[]                     (D§5.6; candidates carry { registryIndex, nativeIndex })
                        applyInvalidations(previousItems, invalidations, registry, logger) -> Item[]   (D§5.8 first two paragraphs)
                        mergePrevious(previousItems, freshItems, registry, logger) -> Item[]          (D§5.8 table; union + carry-forward)
                        compareProvenance, distinctFamilies(item, registry), stripEphemeral(item)
src/score.js            HALF_LIFE_HOURS = 36, ENGAGEMENT = {...}, CROSS_BONUS = 4, CROSS_CAP = 3
                        score(item, now, registry) -> number (2 decimals), round2(n), compareRank(a, b)
src/brief.js            buildBrief(items, previousDigests, now, { targetWords, registry }) -> { digest, facts }      (D1)
                        orderSources(item, registry) (D4), heuristicWhy(item, now, registry), splitSentences(text),
                        countWords(text), countDigestWords(digest), enforceBudget(digest, targetWords), finalizeDigest(digest), SECTIONS
src/llm.js              resolveLlmConfig(env, { noLlm }) -> { eligible, endpoint?, model?, key?, meta: { enabled, ok, model?, error? } }
                        editorialize(brief, config, fetchImpl) -> Promise<{ enabled, ok, model?, error? }>   (mutates brief.digest)
                        numberTokens(text) -> string[], SYSTEM_PROMPT
src/pipeline.js         run(options) -> Promise<RunResult>, runSource(source, deps) -> SourceResult (P4), defaultLogger
scripts/fetch.mjs       CLI: --source <id[,id]> --dry-run --no-llm --data-dir <path> --now <ISO>; sole stdout owner
scripts/probe-sources.mjs  fetch+parse every registry source via runSource; prints id | status | items | ms | note | finalUrl; no writes
scripts/serve.mjs       D7
index.html app.js styles.css favicon.svg   frontend (§9). app.js pure exports: sanitizeReadMap, sanitizeSavedMap, sanitizeLearnMap,
                        sanitizeLastVisit, sanitizeRange, createStore(storage, warn), selectCatchUpDays, healthStatus(meta, nowMs),
                        sourceChipHref(sourceMeta, itemUrl), start()   — start() runs only `if (globalThis.document)`
tests/helpers.js        ROOT, FIXTURES, CONFIG = { sources, linkouts, learn }, NOW, read(name), fixtureFetch({ now, overrides }), runFixture(options)
.github/workflows/refresh.yml   §10
README.md               D§15 outline
```

Shared shapes:

```
RawItem      = { nativeIndex, title, url, publishedAt?: Date, surfacedAt?: Date, summaryHtml?, summaryText?, bodyLength?, authors?,
                 arxivId?, signals?, discussionUrl?, tag?, enclosureType?, extra? }            (nativeIndex never serialized)
ctx          = { now, fetchText, logger, previousItemsByCanonicalUrl, previousSitemapSkipped, previousSitemapCache, sourceStartedAtMs, deadlineAt }
SourceResult = { status: 'ok'|'empty'|'failed', items: RawItem[], fetched, kept, note?, error?, httpStatus?, finalUrl?,
                 sitemapSkipped?, sitemapCache?, invalidations? }
RunResult    = { diagnostic: false, items, digest, digestIndex, meta, sourceResults }       (normal and full-registry dry run)
             | { diagnostic: true, items, sourceResults }                                   (onlySourceIds + dryRun)
sourceResults[i] = { id, name, category, status, fetched, kept, skipped, ms, httpStatus?, note?, error? }   in registry order
```

`run()` options: `{ sources, linkouts, learn, now = new Date(), dataDir = 'data', fetchImpl = globalThis.fetch, env = process.env, logger = defaultLogger, nowMs = Date.now, onlySourceIds, dryRun = false, noLlm = false }`. Steps 1-7 of D§5.1 are the contract; the sequence in §11 step 13 below restates it.

---

## 4. Source registry (`sources.config.mjs`), 64 fetched sources

Schema (D§4.1): required `id name category type url weight`; optional `homepage family maxItems(40) maxAgeDays(7) maxBytes(8_000_000) longForm(false) parser fallbackUrl rankUrl repo minStars include exclude template`. `category` in `research|news|labs|blogs|releases|media`; `type` in `rss|atom|json|arxiv|hn|reddit|github|youtube|sitemap`. Per-source selection order is fixed: parser-specific drops -> `maxAgeDays` on `(surfacedAt ?? publishedAt)` -> `maxItems` in native order (no re-sort). `fetched` = decoded records before these steps; `kept` = survivors after them; `skipped = fetched - kept`. Validation rules: D§4.2 last two paragraphs (fatal, before any request; `include`/`exclude` must be `RegExp` without `g`/`y`).

Template placeholders: `{{unix24hAgo}} = floor(now/1000) - 86400`; `{{date7dAgo}} = YYYY-MM-DD of now - 7d`.
`arxiv` fallbackUrl pattern: `https://export.arxiv.org/api/query?search_query=cat:<CAT>&sortBy=submittedDate&sortOrder=descending&max_results=100`.
GitHub search URL pattern: `https://api.github.com/search/repositories?q=topic:<TOPIC>+created:>{{date7dAgo}}&sort=stars&order=desc&per_page=30`.
YouTube URL pattern: `https://www.youtube.com/feeds/videos.xml?channel_id=<ID>`.

| id | name | cat | type | w | url | options |
|---|---|---|---|---|---|---|
| arxiv-cs.LG | arXiv cs.LG | research | arxiv | 3 | https://rss.arxiv.org/rss/cs.LG | fallbackUrl(cs.LG), family arxiv, maxItems 60 |
| arxiv-cs.CL | arXiv cs.CL | research | arxiv | 3 | https://rss.arxiv.org/rss/cs.CL | fallbackUrl(cs.CL), family arxiv, maxItems 60 |
| arxiv-cs.AI | arXiv cs.AI | research | arxiv | 3 | https://rss.arxiv.org/rss/cs.AI | fallbackUrl(cs.AI), family arxiv, maxItems 60 |
| arxiv-cs.CV | arXiv cs.CV | research | arxiv | 3 | https://rss.arxiv.org/rss/cs.CV | fallbackUrl(cs.CV), family arxiv, maxItems 60 |
| hf-papers | HF Daily Papers | research | json | 8 | https://huggingface.co/api/daily_papers?limit=100 | parser hf-papers, maxItems 60, homepage https://huggingface.co/papers |
| hn-top | Hacker News | news | hn | 5 | https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points>30,created_at_i>{{unix24hAgo}}&hitsPerPage=100 | template, family hn, maxItems 40 |
| hn-front | HN front page | news | hn | 6 | https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50 | rankUrl https://hacker-news.firebaseio.com/v0/topstories.json, family hn, maxItems 30 |
| reddit | Reddit r/LocalLLaMA + r/MachineLearning | news | reddit | 4 | https://www.reddit.com/r/LocalLLaMA+MachineLearning/top/.rss?t=day&limit=50 | maxItems 50 |
| openai | OpenAI | labs | rss | 7 | https://openai.com/news/rss.xml | maxItems 30 |
| anthropic | Anthropic | labs | sitemap | 8 | https://www.anthropic.com/sitemap.xml | include `/^https:\/\/www\.anthropic\.com\/(news\|research\|engineering)\/[^/]+$/`, maxItems 10, homepage https://www.anthropic.com/news |
| deepmind | Google DeepMind | labs | rss | 7 | https://deepmind.google/blog/rss.xml | |
| google-research | Google Research | labs | rss | 6 | https://research.google/blog/rss/ | |
| meta-newsroom-ai | Meta Newsroom (AI) | labs | rss | 5 | https://about.fb.com/news/tag/ai/feed/ | family meta |
| meta-engineering-ai | Engineering at Meta (AI) | labs | rss | 5 | https://engineering.fb.com/category/ai-research/feed/ | family meta |
| microsoft-research | Microsoft Research | labs | rss | 5 | https://www.microsoft.com/en-us/research/feed/ | |
| nvidia-dev | NVIDIA Technical Blog | labs | atom | 4 | https://developer.nvidia.com/blog/feed | maxItems 20 |
| hf-blog | Hugging Face Blog | labs | rss | 5 | https://huggingface.co/blog/feed.xml | maxItems 20 |
| allenai | Ai2 | labs | rss | 5 | https://allenai.org/rss.xml | |
| mistral | Mistral AI | labs | rss | 6 | https://mistral.ai/news/rss | (served as text/plain) |
| transformer-circuits | Transformer Circuits | labs | atom | 7 | https://transformer-circuits.pub/feed.xml | longForm |
| lilog | Lil'Log | blogs | rss | 7 | https://lilianweng.github.io/index.xml | longForm |
| interconnects | Interconnects | blogs | rss | 7 | https://www.interconnects.ai/feed | longForm |
| raschka | Ahead of AI (Raschka) | blogs | rss | 6 | https://magazine.sebastianraschka.com/feed | longForm |
| simonw | Simon Willison | blogs | atom | 4 | https://simonwillison.net/atom/everything/ | maxItems 10 |
| chiphuyen | Chip Huyen | blogs | rss | 6 | https://huyenchip.com/feed.xml | longForm |
| eugeneyan | Eugene Yan | blogs | rss | 5 | https://eugeneyan.com/rss/ | longForm |
| hamel | Hamel Husain | blogs | rss | 5 | https://hamel.dev/index.xml | longForm |
| semianalysis | SemiAnalysis | blogs | rss | 7 | https://newsletter.semianalysis.com/feed | longForm |
| importai | Import AI | blogs | rss | 6 | https://importai.substack.com/feed | |
| latentspace | Latent Space | blogs | rss | 5 | https://www.latent.space/feed | (carries `[AINews]` posts and podcast episodes via audio enclosure) |
| zvi | Don't Worry About the Vase | blogs | rss | 5 | https://thezvi.substack.com/feed | longForm |
| thebatch | The Batch | blogs | sitemap | 4 | https://www.deeplearning.ai/sitemap.xml | include `/^https:\/\/www\.deeplearning\.ai\/the-batch\/[^/]+\/?$/`, exclude `/\/the-batch\/(tag\|issue-\d+)/`, maxItems 10, homepage https://www.deeplearning.ai/the-batch/ |
| oneusefulthing | One Useful Thing | blogs | rss | 4 | https://www.oneusefulthing.org/feed | |
| gradient | The Gradient | blogs | rss | 5 | https://thegradient.pub/rss/ | longForm |
| epoch | Epoch AI | blogs | atom | 6 | https://epoch.ai/atom.xml | family epoch |
| epoch-gradient-updates | Epoch AI Gradient Updates | blogs | rss | 5 | https://epochai.substack.com/feed | family epoch |
| alignmentforum | Alignment Forum | blogs | rss | 4 | https://www.alignmentforum.org/feed.xml | longForm |
| chinai | ChinAI | blogs | rss | 4 | https://chinai.substack.com/feed | |
| jalammar | Jay Alammar (Language Models newsletter) | blogs | rss | 5 | https://newsletter.languagemodels.co/feed | longForm |
| karpathy-blog | Andrej Karpathy (blog) | blogs | rss | 8 | https://karpathy.github.io/feed.xml | family karpathy, longForm |
| karpathy-bearblog | Andrej Karpathy (bearblog) | blogs | atom | 7 | https://karpathy.bearblog.dev/feed/ | family karpathy |
| horace | Horace He (Thonking AI) | blogs | rss | 6 | https://www.thonking.ai/feed | homepage https://horace.io, longForm |
| gh-rel-pytorch | PyTorch releases | releases | github | 6 | https://github.com/pytorch/pytorch/releases.atom | repo pytorch/pytorch |
| gh-rel-vllm | vLLM releases | releases | github | 6 | https://github.com/vllm-project/vllm/releases.atom | repo vllm-project/vllm |
| gh-rel-transformers | Transformers releases | releases | github | 6 | https://github.com/huggingface/transformers/releases.atom | repo huggingface/transformers |
| gh-rel-llamacpp | llama.cpp releases | releases | github | 3 | https://github.com/ggml-org/llama.cpp/releases.atom | repo ggml-org/llama.cpp, maxItems 3 |
| gh-rel-sglang | SGLang releases | releases | github | 5 | https://github.com/sgl-project/sglang/releases.atom | repo sgl-project/sglang |
| gh-rel-unsloth | Unsloth releases | releases | github | 4 | https://github.com/unslothai/unsloth/releases.atom | repo unslothai/unsloth |
| gh-rel-trl | TRL releases | releases | github | 5 | https://github.com/huggingface/trl/releases.atom | repo huggingface/trl |
| gh-rel-torchtitan | torchtitan releases | releases | github | 4 | https://github.com/pytorch/torchtitan/releases.atom | repo pytorch/torchtitan |
| gh-trending-llm | GitHub new repos: llm | releases | github | 4 | search URL (topic:llm) | template, family gh-trending, minStars 50, maxItems 15 |
| gh-trending-ml | GitHub new repos: machine-learning | releases | github | 4 | search URL (topic:machine-learning) | template, family gh-trending, minStars 50, maxItems 15 |
| gh-trending-agents | GitHub new repos: ai-agents | releases | github | 4 | search URL (topic:ai-agents) | template, family gh-trending, minStars 50, maxItems 15 |
| hf-trending | HF trending models | releases | json | 4 | https://huggingface.co/api/models?sort=trendingScore&limit=20 | parser hf-models, maxItems 20 |
| pod-dwarkesh | Dwarkesh Podcast | media | rss | 6 | https://api.substack.com/feed/podcast/69345.rss | maxItems 5, homepage https://www.dwarkesh.com |
| pod-mlst | Machine Learning Street Talk | media | rss | 5 | https://anchor.fm/s/1e4a0eac/podcast/rss | maxItems 5 |
| pod-cogrev | The Cognitive Revolution | media | rss | 4 | https://feeds.megaphone.fm/RINTP3108857801 | maxItems 5 |
| pod-nopriors | No Priors | media | rss | 4 | https://feeds.megaphone.fm/nopriors | maxItems 5 |
| yt-karpathy | Andrej Karpathy (YouTube) | media | youtube | 7 | channel UCXUPKJO5MZQN11PqgIvyuvQ | maxItems 5 |
| yt-yannic | Yannic Kilcher | media | youtube | 4 | channel UCZHmQk67mSJgfCCTn7xBfew | maxItems 5 |
| yt-aiexplained | AI Explained | media | youtube | 4 | channel UCNJ1Ymd5yFuUPtn21xtRbbw | maxItems 5 |
| yt-gpumode | GPU MODE | media | youtube | 5 | channel UCJgIbYl6C5no72a0NUAPcTA | maxItems 5 |
| yt-stanford | Stanford Online | media | youtube | 2 | channel UCBa5G_ESCn8Yd4vw5U-gIcg | maxItems 5 |
| yt-3b1b | 3Blue1Brown | media | youtube | 2 | channel UCYO_jab_esuFRV4b17AJtAw | maxItems 5 |

Counts: research 5, news 3, labs 12, blogs 22, releases 12, media 10 = 64. `linkouts = { leaderboards: [8 entries], more: [alphaXiv -> research, Meta AI blog -> labs, AI News (smol.ai) -> blogs] }` and `learn` (16 entries: 6 courses incl. hf-courses/zero-to-hero, 2 books, 8 papers) are copied verbatim from D§4.2. smol.ai is not fetched (stale since 2026-09-09; its issues arrive as `[AINews]` posts in `latentspace`).

---

## 5. Pipeline contracts (restated; details in D§5)

**HTTP (`src/http.js`, D§5.2).** Headers: `user-agent` (P5) + `accept` (`feed`: `application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8`; `json`: `application/json`; `html`: `text/html`). `authorization: Bearer <githubToken>` + `accept: application/vnd.github+json` only when `hostname === 'api.github.com'` and the token is non-empty; never on redirects to other hosts; never in error messages. Abort at `min(start + timeoutMs, deadlineAt)`; no request starts after `deadlineAt`. Stream the body; abort and throw `BodyTooLarge` past `maxBytes`. `redirect: 'follow'`; return `finalUrl`. Status >= 400 -> `HttpError`. One retry after 2 s for network errors, 5xx and 429 (429: wait `min(retry-after, 30 s)`); no retry for other 4xx or for host `www.reddit.com`; skip the retry when `deadlineAt - nowMs() < 25_000` after the backoff. Per-host pacing (`PACING`) via a promise chain + last-request map inside the client; applies to every caller (fallbacks, rank URL, sitemap pages).

**Scheduler and per-source runner (`src/pipeline.js`, D§5.1 step 3).** Pool of 6 workers claims registry indices in order and stores each result at its index (flatten in registry order, never completion order). `runSource`: `sourceStartedAtMs = nowMs()`, `deadlineAt = sourceStartedAtMs + 45_000`, bind `ctx.fetchText` with the source's `maxBytes`, type `accept`, and `deadlineAt`; dispatch by type (`arxiv` -> `fetchArxivSource(source, ctx)`; everything else: one fetch then `(body, source, ctx)` parser; `github` dispatches on host). Wrap in try/catch + `Promise.race` against the 45 s backstop (`failed: 'wall clock'`). Record `ms`, `httpStatus`, `note: 'redirected to <finalUrl>'` when `finalUrl !== url`. Whole-run budget 8 min: pending sources become `failed: 'run budget exceeded'`.

**Parsers (`src/parsers/*`, D§5.3).** Implement each bullet of D§5.3 as written, with these plan overrides: HF model id guard = D2; HF field mapping = D3. Key facts: feed sniff on body (`<feed` Atom, `<rss`/`<rdf:RDF` RSS), never the header; FXP options `{ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', cdataPropName: false, parseTagValue: false, trimValues: true, processEntities: true, htmlEntities: true, isArray: name => ['item','entry','link','category','author','enclosure'].includes(name) }`; `XMLValidator.validate` first; date precedence `pubDate | dc:date | published | updated | issued`; audio enclosure from `blogs`/`labs` re-routes to `media`; media summaries cut before the first standalone `Sponsors:`; `bodyLength = cleanText(fullBody).length`; GitHub release tags containing `/` dropped, title `${repo} ${tag}`; HN: `isAiStory` filter (regexes in D§5.5; fixture pins: 9 of 42 bydate ids, 8 of 30 front ids), `extra.hnFrontCurrent = true` on every current `hn-front` item, `extra.hnRank` from `rankUrl` first-30 index, `note: 'rank unavailable'` on failure; Reddit: external `[link]` href becomes `url` unless host is/ends with `.reddit.com`/`.redd.it`, `extra.subreddit`, `extra.redditTopCurrent = true`; arXiv: drop `replace*`, `rssFetched === 0` or primary failure -> API fallback (`note: 'api fallback'` / `'api fallback failed'`); sitemap: `lastmod` required and normalized with `toISOString()`, include/exclude, sort lastmod desc, consider 30, at most 10 page fetches (8 s, 1.5 MB, concurrency 4) ending at `min(sourceStartedAtMs + 40_000, deadlineAt)`, source-scoped `sitemapSkipped`/`sitemapCache` (30 entries each), `invalidations = [{ sourceId, canonicalUrl, provenPublishedAt }]`, slug fallback `extra.titleFrom = 'slug'`, `note: 'page fetches truncated (n of m)'`.

**Normalize (`src/normalize.js`, D§5.4-5.5).** `Item` shape in §6 below. `at = raw.surfacedAt ?? raw.publishedAt ?? now` (feeds/arXiv/HN/Reddit/YouTube/releases: publishedAt; hf-papers: `submittedOnDailyAt`; hf-models/GitHub search: `now`; sitemap: `article:published_time ?? lastmod`). Canonicalization steps 1-7 of D§5.5 (strip tracking params regex, sorted query, `youtube.com/watch` keeps `v`, `youtu.be` rewrite, HN `item` keeps `id`, arXiv -> `https://arxiv.org/abs/<id>`, GitHub owner/repo lower-cased, percent-encoding preserved). `itemId = arxivId ? 'arxiv:' + arxivId : sha256(canonicalUrl).slice(0, 16)`. Title <= 200, summary <= 600 (arXiv abstracts <= 400), authors <= 5, `readMinutes = ceil(bodyLength / 1000)`.

**Dedup and previous-run merge (`src/dedup.js`, D§5.6, D§5.8).** Key `arxivId ? 'arxiv:' + arxivId : canonicalUrl`; same-source duplicates keep the smallest `nativeIndex`; `compareProvenance` = weight desc, `at` asc, registryIndex asc, id code-point asc; per-field table D§5.6 (paper-title class, URL category precedence `research > releases > labs > blogs > media > news`, longest summary, max signals in schema order, authors research-first, discussion HN > Reddit > other, extra per key). Before merging with the previous run: `stripEphemeral` deletes `extra.hnRank`, `extra.hnFrontCurrent`, `extra.redditTopCurrent` from every stored item; then `applyInvalidations` (remove only that sourceId; drop item when no source remains; delete `extra.titleFrom`; `publishedAt = min(prev, provenPublishedAt)`; recompute `surfacedAt`, category); then `mergePrevious` with the D§5.8 authority tuples (`bestAuthority`, `titleAuthority`, `urlAuthority`, `authorAuthority`, `discussionAuthority`; exact tie -> fresh). Retention: drop `surfacedAt < now - 7d`; arXiv-only items (all sources family `arxiv`, no signals) after 3 d. Sort by `compareRank`, keep 3,000, then trim the final `ceil(n * 0.05)` while serialized bytes > 2,000,000 (`meta.trimmedForSize`).

---

## 6. Data file schemas (`data/`, validated by `src/schema.js` before every write)

```js
// data/items.json — 7 days of items, sorted once with compareRank
{ generatedAt: ISO, count: number, items: Item[] }

Item = {
  id: 'arxiv:2610.22379' | '3f9c2a1b7d4e6f80',   // 16 hex of sha256(canonicalUrl) when no arXiv id
  title: string,                                 // 1..200, cleaned
  url: string,                                   // http(s), <= 2048; arXiv items use https://arxiv.org/abs/<id>
  canonicalUrl: string,
  sources: [{ id: string, url?: string, at: ISO }],  // registry-index order, unknown ids last (code-point)
  category: 'research'|'news'|'labs'|'blogs'|'releases'|'media',
  publishedAt: ISO, surfacedAt: ISO,             // surfacedAt = max(sources[].at); drives decay/windows/retention
  summary: string,                               // <= 600 (may be '')
  score: number,                                 // 2 decimals
  signals: { hnPoints?, hnComments?, hfUpvotes?, redditScore?, ghStars?, hfLikes?, ytViews? },  // only present keys, this order
  arxivId?: string, authors?: string[] /* <=5 */, readMinutes?: number, discussionUrl?: string, tag?: string,
  extra?: { primaryCategory?, hnRank?, hnFrontCurrent?, redditTopCurrent?, subreddit?, titleFrom?, via?, topics?,
            githubStars?, githubRepo?, downloads?, trendingScore?, pipelineTag?, libraryName? }   // keys in code-point order; omit when empty
}

// data/digests/YYYY-MM-DD.json — only today's file is ever written
{ date: 'YYYY-MM-DD', generatedAt: ISO, wordCount: number, readingMinutes: number,
  overview: null | { text: string, source: 'llm', model: string },
  sections: [{ key: 'must-know'|'research'|'releases'|'labs'|'analysis'|'deep-read', title: string,
               entries: [{ id, title, url, discussionUrl?, sourceIds: string[], sourceNames: string[],   // D4 order
                           summary, why, whySource: 'heuristic'|'llm', publishedAt, category, score, readMinutes? }] }],
  itemIds: string[],              // exactly the section-order entry ids, no duplicates
  deepReadId: string | null,
  llm: { enabled: boolean, ok: boolean } }

// data/digests/index.json — rebuilt from the directory listing, newest first
{ days: [{ date, generatedAt, wordCount, readingMinutes, entryCount }] }      // entryCount === itemIds.length of that digest

// data/meta.json
{ generatedAt, durationMs, itemCount, newItemCount, trimmedForSize,
  sources: { [id]: { name, category, status: 'ok'|'empty'|'failed', fetched, kept, skipped, ms,
                     httpStatus?, error?, note?, homepage? } },                 // homepage per D6
  okCount, emptyCount, failedCount,
  sitemapSkipped: { [sourceId]: { [canonicalUrl]: lastmodISO } },             // <= 30 per source
  sitemapCache:   { [sourceId]: { [canonicalUrl]: { lastmod, title, summary, publishedAt } } },
  llm: { enabled, ok, model?, error? },
  brief: { date, wordCount, readingMinutes },
  static: { leaderboards: [...], more: [...], learn: [...] } }                 // structuredClone({ ...linkouts, learn })
```

Schema assertions (fatal, before writes): unique item ids; every `surfacedAt` within retention; items file <= 2 MB; digest `itemIds` equals section-order ids; `deepReadId` matches; `wordCount` equals `countDigestWords(digest)` and is <= 1100; `readingMinutes === max(1, ceil(wordCount/220))`; every index `entryCount === itemIds.length`; `meta.sources` keys == registry ids (plus nothing else); `llm` states consistent (`digest.llm` = `{ enabled, ok }` of `meta.llm`). `error` is a short class string, never a stack. Writes go through `<file>.tmp` + rename, one file at a time, in the order items -> digest -> index -> meta.

---

## 7. Scoring (`src/score.js`, D§5.7)

```
ageHours = max(0, (now - surfacedAt) / 3.6e6)
decay    = 0.5 ** (ageHours / 36)                                   // HALF_LIFE_HOURS = 36
W        = max(sourceInfo(id).weight for id in item.sources)        // unknown id -> 1
E        = 1.0*log2(1+hfUpvotes) + 0.6*log2(1+hnPoints) + 0.4*log2(1+hnComments)
         + 0.5*log2(1+ghStars) + 0.5*log2(1+redditScore) + 0.5*log2(1+hfLikes) + 0.15*log2(1+ytViews)   // missing -> 0
X        = 4 * min(3, distinctFamilies - 1)                         // CROSS_BONUS 4, CROSS_CAP 3 -> max 12
score    = round2(W * decay + E + X)
```

Worked example (unit test): A = HN-only, 500 pts / 200 comments, 2 h old, weight 5 -> 13.25. B = arXiv + HF Papers (30 upvotes) + HN (40 pts / 10 comments), 20 h old, W 8 -> 23.00. `B > A`.

`compareRank(a, b) = (b.score - a.score) || (Date.parse(b.surfacedAt) - Date.parse(a.surfacedAt)) || codePointCompare(a.title, b.title) || codePointCompare(a.id, b.id)` — total order used for `items.json`, caps, and every brief pool. Never `localeCompare`.

---

## 8. The 5-minute brief (`src/brief.js`, D§6)

**Inputs.** `buildBrief(items, previousDigests, now, { targetWords, registry })`; `targetWords = llmEligible ? 880 : 1100`.

**Pools (D§6.1).** `used` = union of `itemIds` from the digests of the two previous UTC calendar days. Shared pool = items with `surfacedAt >= now - 36h` minus `used`; if fewer than 20 remain, rebuild from 72 h minus `used`. Each pick is removed from the shared pool.

**Sections (D§6.2), filled in this order:**

| key | title | n | pool |
|---|---|---|---|
| must-know | Must know | 4 | shared pool, `compareRank` |
| research | Research | 3 | remaining `category === 'research'`, `compareRank` |
| releases | Releases & tools | 3 | remaining `releases`, `compareRank` |
| labs | From the labs | 2 | remaining `labs`, `compareRank` |
| analysis | Analysis worth reading | 2 | remaining `blogs`, title not `/^\[AINews\]/`; sort `(longForm(b) - longForm(a)) || compareRank` where `longForm(x) = x.readMinutes >= 5 || isLongForm(x)` |
| deep-read | One deep read | 1 | independent: every retained item with `category === 'blogs'`, title not `/^\[AINews\]/`, `surfacedAt >= now - 7d`, not in `used`, not already picked, not a `deepReadId` of the last 14 digests; `compareRank`; first with `readMinutes >= 8 || isLongForm`; else first remaining |

`isLongForm(item) = item.sources.some(s => sourceInfo(s.id).longForm)`. Empty pool -> `entries: []` (UI shows "Nothing new today").

**Entry text (D§6.3 + D3/D4/P2).** `title` <= 140 chars (word boundary + `…`); `summary` = first 1-2 sentences of `item.summary`, <= 280 chars, split on `(?<=[.!?])\s+(?=[A-Z0-9"“])` guarding `e.g.`, `i.e.`, `vs.`, `et al.`, `Fig.`, `No.`; `sourceIds`/`sourceNames` per D4. `why` (heuristic):
1. At most one HN clause: `#{rank} on HN front page` (needs `extra.hnFrontCurrent === true` and integer `hnRank`) / `on HN front page` (marker, no rank) / `{points} points on HN` and/or `{comments} comments` (no marker); append available points/comments once.
2. Then distinct factual clauses in order: `{n} upvotes on HF Papers`; `also on {families}` (D4 walk); `{stars} stars in {d} days` or `{stars} stars on GitHub` (D3/P2; `d = max(1, ceil((now - publishedAt) / 86_400_000))` only when `publishedAt` is finite and <= now); `new release {tag}`; `{likes} likes on Hugging Face`; `{views} views`. Each consumes its signal key/family so no fact repeats. A clause is eligible only when every operand is present and valid (never stringify `undefined`/`null`/`NaN`).
3. No factual clause -> exactly one category fallback with `{source}` = primary source name (D4): labs `{source} announcement`; research `new on arXiv ({primaryCategory})` or `new research paper`; blogs `{source}, ~{readMinutes} min read` or `{source} analysis`; releases `{source} release`; media `new episode from {source}`; news `top of r/{subreddit} today` (only with `extra.redditTopCurrent === true`), else `from r/{subreddit}`, else `on HN` (a known `type: 'hn'` source), else `new discussion`.
4. Emit `first + '; ' + second` only when the join is <= 160 chars; otherwise the first clause alone, truncated at a word boundary to 160.

**Word budget (D§6.4).** `countWords(t) = t.split(/\s+/).filter(Boolean).length` over every entry's `title + summary + why + sourceNames.join(' ')`, plus the six section titles and `overview.text`. Stages until `wordCount <= targetWords`, recomputing after each mutation: (1) summaries to one sentence / 160 chars in order `analysis -> labs -> releases -> research -> deep-read -> must-know`, last entry first (pass 1 skips must-know, pass 2 includes it); (2) drop the last entry of `research`, `releases`, `labs`, `analysis` cycling, never below one, never touching must-know/deep-read; (3) summaries to 120 chars; (4) empty summaries one by one; (5) cap every title and why at 12 words (`…`); (6) `sourceNames` -> first three labels (D4 order), each <= 6 words, plus `+N sources` when more; then assert `<= targetWords` (failure = internal bug, throw). Terminal bound: 15 entries x (12 + 12 + 20) = 660 entry words, so a no-overview brief is < 880 and with a <= 200-word overview < 1,100.

**Finalizer (`finalizeDigest`, called once by `pipeline.js` after the last budget pass):** `itemIds` = section-order entry ids; `deepReadId` = deep-read entry id or `null`; `wordCount = countDigestWords(digest)`; `readingMinutes = max(1, ceil(wordCount / 220))`. The index entry's `entryCount = itemIds.length`. No later step may add/drop/reorder entries.

---

## 9. Optional LLM editorial layer (`src/llm.js`, D§7, D1)

- `resolveLlmConfig(env, { noLlm })`: eligible only when `LLM_API_KEY` and `LLM_MODEL` are non-empty after trimming and `noLlm` is false. No key or `--no-llm` -> `meta { enabled: false, ok: false }`. Key but empty model -> `{ enabled: false, ok: false, error: 'LLM_MODEL unset' }`. `LLM_BASE_URL` default `https://api.openai.com/v1`; must parse, protocol `https:` (or `http:` only for hostname `localhost`/`127.0.0.1`), empty username/password/search/hash; invalid -> `{ enabled: false, ok: false, model, error: 'invalid LLM_BASE_URL' }`. Endpoint = clone of the URL with `pathname = base.pathname.replace(/\/+$/, '') + '/chat/completions'`.
- `editorialize(brief, config, fetchImpl)`: one `POST endpoint`, headers `authorization: Bearer <key>`, `content-type: application/json`; body `{ model, temperature: 0.3, max_tokens: MAX_TOKENS (8192), response_format: { type: 'json_object' }, messages: [system, user] }`; 60 s timeout per attempt. The budget is sized for thinking models (Gemini 3.x Flash, o-series), whose reasoning counts against the same cap: 1,500 truncated Gemini's JSON in the first live run. Compatibility retries, each applied at most once, only on HTTP 400 whose body (<= 16 KB read) names the parameter case-insensitively: `max_tokens` -> remove it and set `max_completion_tokens` to the same value; `response_format` -> remove it. Any other 400 is final. Transient failures (HTTP 429/500/502/503/504 or a thrown network error) are retried after `RETRY_BACKOFF_MS = [10000, 30000]` (a numeric `retry-after` header replaces the plan value, capped at 30 s), so at most three attempts; compat retries do not count as attempts; a timeout (AbortError) is final; the error string gets ` (N attempts)` appended when retries ran. `editorialize` takes an optional fourth argument `{ sleep }` for tests. System prompt: fixed text per D§7 (editor of a one-page daily AI brief for an expert reader; only the facts given; `overview` 160-190 words (hard limits 150/200) naming the 3-5 developments that matter most and why; `why` map id -> one line of 12-20 words, never more than 25; never invent numbers, names or dates; reply with a single JSON object `{ "overview": string, "why": { id: string } }`, no markdown fences, no prose). User message: JSON array of `{ id, section, title, summary (cut to 300 chars), sourceNames, signals }` with `signals` from `brief.facts` (D1), at most 15 entries.
- Response: `choices[0].finish_reason === 'length'` -> `truncated` (a cut-off answer is never trusted). Content absent or blank -> `refusal` when `message.refusal` is set, `reasoning only` when only `message.reasoning_content` is set, else `empty`. Otherwise `parseJsonObject(content)`: trim, strip one surrounding markdown fence, `JSON.parse`; failing that, the first balanced top-level `{...}` that parses (string-aware brace matching; a balanced-but-invalid object is skipped as a whole); none -> `invalid JSON`. `overview` accepted only when a string with `150 <= countWords <= 200` and every normalized number token is in the union of all entries' allowed sets. `why[id]` accepted only when `id` exists, trimmed non-empty, <= 200 chars, `countWords <= 25`, and every normalized number token is in that entry's allowed set (allowed set = tokens of `id`, `section`, `title`, `summary`, each `sourceNames` string, `JSON.stringify(signals)`). `numberTokens(text)` = matches of `/#?[+-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+)(?:%|[kKmMbB]|x)?/g`, normalized by lower-casing, removing commas and a leading `#`/`+`.
- Accepted values are applied (`whySource: 'llm'`, `overview = { text, source: 'llm', model }`), then `enforceBudget(digest, 1100)` runs again. Result `{ enabled: true, ok: true, model, usage? }` if at least one field was accepted; `{ enabled: true, ok: false, model, error: 'HTTP <status>' | 'timeout' | 'network' | 'invalid JSON' | 'truncated' | 'refusal' | 'reasoning only' | 'empty', finishReason?, usage?, detail? }` otherwise (heuristic brief untouched). `usage` = `{ prompt?, completion?, total? }` from the response's `usage` counts; `detail` = `excerpt(text, key)`: the model content (or the error body / raw response when there is no content) with the key scrubbed first, googleapis `key=` values redacted, control characters and whitespace runs collapsed, cut to 300 chars (`validateMeta` enforces single line <= 300). The key never appears in logs, errors, or `data/`. `pipeline.js` logs `describeLlmFailure(result)` as one warning and projects the result into `digest.llm = { enabled, ok }` and `meta.llm` (full object).
- README provider table: OpenAI `https://api.openai.com/v1` (default), Anthropic `https://api.anthropic.com/v1`, Groq `https://api.groq.com/openai/v1`, Gemini `https://generativelanguage.googleapis.com/v1beta/openai`, OpenRouter `https://openrouter.ai/api/v1`; `LLM_MODEL` is always required with a key; secrets via `gh secret set LLM_API_KEY|LLM_BASE_URL|LLM_MODEL`.

---

## 10. Frontend (`index.html`, `app.js`, `styles.css`, `favicon.svg`; D§8)

**Constraints.** No framework, bundler, server or database. One ES module `app.js`, one stylesheet, system font stack (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`; `font-variant-numeric: tabular-nums`). Every URL relative (`data/meta.json`, `app.js`, `styles.css`, `favicon.svg`) so the site works at `/` and `/ahead/`. CSP meta: `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'` -> no inline styles/scripts; dynamic styling via classes, `data-*` attributes or `el.style.setProperty`. All text through `textContent`; every `href`/`window.open` URL re-parsed and must be `http(s):`, else rendered as plain text. Budgets: `index.html` < 10 KB, `app.js` < 60 KB, `styles.css` < 15 KB.

**index.html skeleton.** `<header>`: wordmark "Ahead", digest date (UTC), "refreshed N min ago" (re-rendered every 60 s), "N min read", health dot `<button>` + `<details>`. `<nav aria-label="Sections">` with `role="tablist"` of 10 `role="tab"` buttons. Filter bar (hidden on Brief/Leaderboards/Learn/Archive): source chips, Saved chip, range `24h | 3d | 7d`, search `<input type="search">`. `<main>` with one `role="tabpanel"`. `<template>`s for an item row and a brief entry. `<footer>` with source count + GitHub link. `<script type="module" src="app.js">`.

**Tabs / routes / keys** (`location.hash`, unknown -> `#brief`):

| key | tab | hash | content |
|---|---|---|---|
| 1 | Brief (default) | `#brief` | overview (with "AI-written" tag) when present; six sections, numbered entries: title link, source names, summary, why (distinct color), age |
| 2 | Research | `#research` | category list + `Also:` strip (alphaXiv) |
| 3 | News | `#news` | category list |
| 4 | Labs | `#labs` | category list + `Also:` strip (Meta AI blog) |
| 5 | Blogs | `#blogs` | category list + `Also:` strip (AI News) |
| 6 | Releases | `#releases` | category list |
| 7 | Podcasts & Video | `#media` | category list |
| 8 | Leaderboards | `#leaderboards` | `meta.static.leaderboards`: name + blurb + link (link-out only) |
| 9 | Learn | `#learn` | `meta.static.learn` grouped courses/books/papers, checkbox per entry, `7/16 done` counter |
| 0 | Archive | `#archive`, `#archive/YYYY-MM-DD` | list of days from `index.json` with reading time; selecting one renders that digest with the brief renderer; **Catch up since last visit** button (D5/P7): loads the selected digests in parallel, merges entries by `id` keeping the first (newest) occurrence, groups by day, renders in one scroll |

**Data loading.** Startup: `Promise.all([fetch('data/meta.json'), fetch('data/digests/index.json')])` with `{ cache: 'no-cache' }`; then `data/digests/<index.days[0].date>.json?v=<meta.generatedAt>`. Archive digests fetched without buster. `data/items.json?v=<meta.generatedAt>` fetched once, lazily, on first category tab or first search input ("Loading 7 days of items…" row meanwhile). Error states: `meta.json` 404 -> calm "No data yet. The first refresh runs within six hours; trigger one with `gh workflow run refresh.yml`." (no alert); any other failure -> `role="alert"` banner naming file + status with a Retry button; Leaderboards/Learn still render from the last good `meta`; an `items.json` failure shows the banner inside category panels only.

**Category list rendering.** Items of the tab's category with `surfacedAt` inside the range (default `7d`, persisted), in stored `compareRank` order; filtered by selected source chips (chips = sources of that category with items, with counts; chip label = `meta.sources[id].name` or id) and by search (case-insensitive substring over title + summary, >= 2 chars, 120 ms debounce). First 100 rows, "Show 100 more" appends. Row: score pill; title `<a target="_blank" rel="noopener noreferrer">`; source chips (D6 href); relative age with absolute UTC `title`; signals `▲435 · 215 comments · 1.2k★`; two-line clamped summary; "discussion" link when `discussionUrl`; icon buttons "Mark read" / "Save" with `aria-label`. `.is-read` (opacity .55), `.is-saved`. The Saved chip switches to all saved snapshots across categories, newest `savedAt` first; a snapshot whose item is no longer in `items.json` shows a "no longer in the 7-day window" hint.

**Per-item interactions.** Click/`o`/`Enter`: `window.open(url, '_blank', 'noopener')`. `r` toggles read, `s` toggles saved (snapshot `{ title, url, sourceNames, publishedAt, category, savedAt }`). `j`/`k` move an `aria-current="true"` cursor over visible rows (brief entries too, via `data-id`/`data-url`), `scrollIntoView({ block: 'nearest' })`; cursor resets to the first row when the list changes. `/` focuses search; `Escape` clears/blurs; digits switch tabs. All keys ignored while an input is focused except `Escape`.

**Client state (`localStorage`, prefix `ahead:`, D§8.4).** `ahead:read` `{ [id]: epochMs }` (prune > 30 days); `ahead:saved` `{ [id]: snapshot }`; `ahead:learn` `{ [learnId]: epochMs }`; `ahead:lastVisit` epochMs (D5 write rule); `ahead:range` `'24h'|'3d'|'7d'`. Per-key sanitizers (plain-record maps into `Object.create(null)`; ids non-empty <= 200 chars; finite non-negative integer timestamps; saved snapshot fields: title 1..200, HTTP(S) url <= 2048, `sourceNames` <= 16 strings <= 100 chars, `publishedAt` parseable <= 40 chars, category enum, `savedAt` integer; bad entries dropped individually; bad top level -> empty record / `0` / `'7d'`). All storage ops in try/catch; on any throw warn once and switch to an in-memory store for the session.

**Header indicators (D§8.5).** `healthStatus(meta, nowMs)`: green when `failedCount === 0` and data < 12 h old; amber when `1 <= failedCount <= 5`; red when `failedCount > 5` or data >= 12 h old. Status string: `N sources failed` when `failedCount > 0`; else `Data is N h old` when >= 12 h; else `All sources OK`. Same string on the button's `aria-label` + `title` and on the `<details>` `<summary>`; details body lists every source (P8). `empty` is never counted as failed.

**Visual (D§8.6).** Dark default: `--bg #0f1115`, `--fg #e7e9ee`, `--muted #9aa3ad`, `--accent #7ab7ff`, `--why #f0c674`; `@media (prefers-color-scheme: light)`: `--bg #fafafa`, `--fg #111`, `--muted #555`, `--accent #0a58ca`, `--why #7a5200`. 14 px body, 13 px rows, 12 px chips minimum. Max width 1100 px; at <= 640 px the tablist scrolls horizontally, rows stack, buttons stay 40 px tall. `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`; `prefers-reduced-motion` disables the row-opacity transition. Landmarks `header/nav/main/footer`; `role="tab"`, `aria-selected`, `aria-controls`.

---

## 11. Scripts

- **`scripts/fetch.mjs`**: parse flags; `--source` without `--dry-run` -> stderr message, exit 1 before `run()`; `--now` invalid -> exit 1; call `run({ sources, linkouts, learn, now, dataDir, onlySourceIds, dryRun, noLlm })`; print `id | status | fetched | kept | ms | note/error` for `result.sourceResults` + one summary line (`ok N · empty N · failed N · items N · brief N words`); exit 0. Configuration errors, unwritable `dataDir`, unexpected exceptions -> stderr + exit 1.
- **`scripts/probe-sources.mjs`**: `createHttpClient({ fetchImpl: globalThis.fetch, githubToken: process.env.GITHUB_TOKEN ?? '' })`, `runSource` for every registry source with empty previous state, print `id | status | items | ms | note | finalUrl`; never writes.
- **`scripts/serve.mjs`**: D7.

---

## 12. GitHub Actions (`.github/workflows/refresh.yml`, D§9)

```yaml
name: Refresh data and deploy
on:
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:
  push:
    branches: [main]
    paths-ignore: ['data/**']
concurrency:
  group: refresh
  cancel-in-progress: false
jobs:
  refresh:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: write
      pages: write
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          persist-credentials: true
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm test
      - name: Fetch sources and build the brief
        run: node scripts/fetch.mjs
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
          LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
          LLM_MODEL: ${{ secrets.LLM_MODEL }}
      - name: Commit data back to main
        run: |
          git fetch origin main
          test "$(git rev-parse origin/main)" = "$GITHUB_SHA" || { echo "main moved; newer workflow will regenerate data" >&2; exit 1; }
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data
          if git diff --cached --quiet; then echo "no data changes"; else git commit -m "data: refresh $(date -u +%Y-%m-%dT%H:%MZ) [skip ci]"; fi
          git push origin HEAD:main
      - name: Stage the site
        run: |
          mkdir -p _site
          cp index.html app.js styles.css favicon.svg _site/
          cp -r data _site/data
      - uses: actions/configure-pages@v6
        with:
          enablement: true
      - uses: actions/upload-pages-artifact@v5
        with:
          path: _site
  deploy:
    needs: refresh
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
```

Live site: `https://sudish007.github.io/ahead/`. Recursion guards: `paths-ignore: ['data/**']`, `[skip ci]`, and `GITHUB_TOKEN` pushes never trigger workflows. The artifact is the `_site` staging copy only (never `node_modules`, `src`, `tests`, `.agents`).

---

## 13. Tests (`tests/*.test.js`, `node --test`; offline, fixture-driven, `NOW = 2026-10-19T12:00:00Z`)

`tests/helpers.js`: `CONFIG`, `ROOT`, `FIXTURES`, `NOW`, `read(name)`, `fixtureFetch({ now = NOW, overrides = {} })`, `runFixture(options)` (P6). `fixtureFetch` exact map (registry URL after template expansion, every `fallbackUrl`, every `rankUrl`): `arxiv-cs.LG -> arxiv-rss-cs.LG.xml`, `arxiv-cs.AI -> arxiv-rss-cs.AI-empty.xml`, all four fallbackUrls -> `arxiv-api-cs.LG.xml`, `hf-papers -> hf-daily-papers.json`, `hn-top -> hn-algolia-bydate.json`, `hn-front -> hn-algolia-front.json`, rankUrl -> `hn-topstories.json`, `reddit -> reddit-multi-rss.xml`, `openai -> openai-news.xml`, `anthropic -> anthropic-sitemap.xml`, `deepmind -> deepmind-blog.xml`, `google-research -> google-research.xml`, `meta-newsroom-ai -> meta-newsroom-ai.xml`, `nvidia-dev -> nvidia-dev-blog-atom.xml`, `hf-blog -> hf-blog.xml`, `allenai -> allenai-rss.xml`, `mistral -> mistral-news-rss.xml` (content-type `text/plain`), `transformer-circuits -> transformer-circuits-feed.xml`, `interconnects -> substack-interconnects.xml`, `simonw -> simonwillison-atom.xml`, `alignmentforum -> alignmentforum.xml`, `thebatch -> deeplearning-sitemap.xml`, `epoch -> epoch-atom.xml`, `karpathy-bearblog -> karpathy-bearblog-atom.xml`, `gh-rel-pytorch -> gh-releases-pytorch.xml`, `gh-rel-vllm -> gh-releases-vllm.xml`, `gh-rel-llamacpp -> gh-releases-llamacpp.xml`, `gh-trending-llm -> gh-search-llm.json`, `gh-trending-ml -> gh-search-ml.json`, `hf-trending -> hf-trending-models.json`, `pod-mlst -> podcast-mlst-anchor.xml`, `pod-cogrev -> podcast-cognitive-revolution.xml`, `yt-gpumode -> youtube-gpumode.xml`. Kind fallback for the rest: `arxiv -> arxiv-rss-cs.LG.xml`, `rss -> openai-news.xml`, `rss`+`media -> podcast-mlst-anchor.xml`, `atom -> simonwillison-atom.xml`, github releases -> `gh-releases-vllm.xml`, github search -> `gh-search-llm.json`, `youtube -> youtube-gpumode.xml`, `sitemap -> anthropic-sitemap.xml`, `hn -> hn-algolia-front.json`, `reddit -> reddit-multi-rss.xml`, json `hf-papers`/`hf-models` fixtures. Any `accept: text/html` request returns `<title>{slug} \ Site</title><meta property="og:title" content="OG {slug}"><meta property="og:description" content="Desc {slug}"><meta property="article:published_time" content="{lastmod}">` where `lastmod` is looked up from a `Map<loc, lastmod>` built once by regex-scanning both sitemap fixtures. `overrides[url] = { status } | { body, contentType? } | { throw: Error }`. Unmapped URLs throw.

| file | must prove (condensed; full detail D§13) |
|---|---|
| registry.test.js | `validateConfig(CONFIG)` passes; the 64 baseline ids are present (`sources.length >= 64` allowed); every source resolves to an exact fixture or kind fallback; table-driven invalid cases (blank name/family, non-HTTP homepage/fallbackUrl/rankUrl, bad maxItems/maxBytes/maxAgeDays, non-boolean flags, non-RegExp or `/x/g` `/x/y` include/exclude naming the exact field, bad repo, template placeholders, missing parser/fallbackUrl/minStars, bad linkouts/learn) each throw before any fetch; `more` has the three pinned tab assignments |
| normalize.test.js | `canonicalizeUrl` table (utm/ref/fbclid, trailing `/`, `/index.html`, http->https, `www.`, `//` collapse, percent-encoding byte-exact, youtube/youtu.be, HN id, sorted query, invalid/`javascript:` -> null); `extractArxivId` (abs/pdf/v3/HF/alphaxiv/old-style/text prefix); `cleanText`; `parseDate` (RFC 822 offsets, ISO, garbage/pre-2000 -> undefined, future -> clamp); `toItem` `at` per kind and `maxAgeDays` (HF model with 2025 `createdAt` passes via `surfacedAt = now`; undated item passes; 8-day-old feed item dropped) |
| http.test.js | pacing: three `export.arxiv.org` requests complete at 0/3000/6000 ms with a fake clock; unpaced hosts don't wait; retry on 503 once, none on 403, none for `www.reddit.com` 429; retry skipped when < 25 s remain; 42 s bound; `maxBytes` abort; token only on `https://api.github.com/...`, never on `github.com`/other hosts/cross-host redirect; token never in error text; `process.env.GITHUB_TOKEN` has no effect on a client built without a token |
| feed.test.js | every XML fixture -> expected count/first title/date/link; Mistral `text/plain`; HF blog empty summaries; Interconnects 5 items, exactly 2 `audio/*` -> `media`; YouTube `ytViews` + `published`; Epoch CDATA title; Ai2 `-08:00`; smol `content:encoded` summary with `bodyLength === cleanText(body).length`; Cognitive Revolution synopsis kept, cut before `Sponsors:`, full-body `bodyLength` |
| github.test.js | pytorch -> 0 items (`empty`); vllm -> 3 with tags; llama.cpp `bNNNN` tags, `maxItems: 3` |
| arxiv.test.js | cs.LG fixture: `fetched 18`, `kept 13`, none of the five replace ids, `maxItems: 5` keeps the first five in fixture order, ids/abstract prefix/authors/primaryCategory; empty cs.AI -> API fallback (`fetched 10`, versionless ids, `extra.via = 'api'`, `note: 'api fallback'`); primary HTTP failure + valid API -> `ok`; both fail -> `failed` 0/0; valid empty RSS + fallback failure -> `empty`, `note: 'api fallback failed'`; all-replace RSS -> `empty` with nonzero `fetched` and no fallback call |
| json.test.js | HN bydate keeps exactly ids 50150434, 50148855, 50148452, 50145715, 50145507, 50145337, 50143755, 50141657, 50141429 and excludes 50150750; front keeps 8 (50145337, 50135762, 50145507, 50150434, 50145715, 50148855, 50151390, 50151928), `maxItems: 3` native order; `hnFrontCurrent` only on hn-front; ranks in 1..30 with 50145337 -> 10 and 50150434 -> 4; failed rank -> no rank, `ok`, `note: 'rank unavailable'`; HF Papers id/upvotes/surfaced date/order cap + D3 mapping (`extra.githubStars`/`githubRepo` present on 7 fixture papers; no other paper fields leak); HF Models likes/first-seen/trending cap + D3 summary format (`fishaudio/drama-3` has no `library_name` -> omitted, no `undefined`); `isHfModelId` D2 table (`owner/model.name` ok; `gpt2`, `owner/..`, `model..name/x`, `owner/name.`, `a/b/c`, `-x/y`, 201 chars rejected); GitHub search floors 50 -> 8, 100 -> 5, ML fixture -> `empty`; malformed-element injections increase `fetched`+`skipped` and never produce `undefined` labels |
| reddit.test.js | 12 items, subreddit from category, 4 external `[link]` targets (3 x huggingface.co, warlock.ai), 8 permalinks for Reddit-hosted, boilerplate stripped, `redditTopCurrent === true` on all |
| sitemap.test.js | Anthropic: 15 in-window URLs (desc lastmod) with `maxItems: 30`, 10 with the registry cap, 30 no-lastmod URLs skipped, normalized `toISOString`; Batch: 2 articles in 7 d (`metas-muse-wonder-rivals-top-models`, `anthropic-gives-claude-haiku-a-big-update`), issues excluded, tag/about never considered, 9 with `maxAgeDays: 14`; page success/throw(slug)/old-date-drop; passed deadline -> all slugs + truncated note; 8 s sitemap download leaves exactly 32 s; exact cache hit -> no request; other-source cache / HN prior item / changed lastmod -> request; skip marker same version -> 0 requests, changed -> 1; two-run invalidation `{ sourceId, canonicalUrl, provenPublishedAt }`; map pruning/cap 30/failure-preserving; `<title>` suffix strip rule; malformed loc/lastmod -> `skipped` |
| dedup.test.js | synthetic `Map` registry; arXiv + HF + HN merge (fixed arXiv URL, all source links, paper-title class beats HN weight); every in-run field rule; duplicate same-source native indices; signal key order; category precedence; source order; the complete previous/fresh table incl. all three ephemeral deletions, `applyInvalidations` sitemap-only vs sitemap+HN; each authority tuple decides its field; unknown-source fallback |
| score.test.js | `round2(A) === 13.25`, `round2(B) === 23`, `B > A`; decay halves at 36 h; bonus capped at 12; missing signals -> 0; unknown id weight 1 / own family; `compareRank` four-level order without `localeCompare` |
| determinism.test.js | reversed completion delays + shuffled candidates -> byte-identical `items` JSON and section entries; two-run high-then-low-weight fixture keeps stored title; mixed-authority two-run permutations byte-identical |
| brief.test.js | sections filled with required counts from synthetic items; `used` exclusion; 36 -> 72 h widening only under 20; five-day-old deep read from the independent pool; empty pools -> `entries: []`; **word cap**: `targetWords 880` fits with `readingMinutes <= 5`, a 200-word overview survives under 1,100; adversarial 15-entry one-letter-token case -> summaries empty, titles/why <= 12 words, three six-word labels + `+N sources`, complete `sourceIds`, `wordCount <= 1100` (and <= 880 without overview); Analysis trims before Must know; why-line cases (one HN clause; no present-tense without marker; `top of r/x today` only with `redditTopCurrent`; no repeats; second clause only when the join <= 160; fallbacks never `undefined`; stars `1`, `1`, `2` days at now / 24 h / 24 h + 1 ms, `1,234 stars` formatting (D3), `on GitHub` for invalid/future date); D4 ordering with a mixed research/labs/HN/unknown item (`sourceNames` primary-first, `{source}` = primary, `also on` skips primary family + hn); `[AINews]` in Must know but never Analysis/Deep read; `facts` map contains the selected ids' signals (D1) and the digest has no `signals` key; `finalizeDigest` identity fields |
| llm.test.js | valid JSON applies overview/why within budget; embedded JSON extracted; overview 149/150/200/201 -> only 150 and 200 accepted; overview may reuse any entry's number, invented `90%` rejects only the overview (`ok: true` when a why is accepted); garbage/500/timeout/nothing accepted -> `{ enabled: true, ok: false }` + error; no key / `--no-llm` / empty model / invalid base -> no request, `{ enabled: false, ok: false }` with meta detail; body has `max_tokens: 1500` and no key, Authorization header present; 400 mentioning `max_tokens` -> one retry with only `max_completion_tokens: 1500`, other 400 -> none; `https://example.com/v1/` -> `.../v1/chat/completions`; `ftp://x`, non-local http, credentials, query, fragment rejected; `http://localhost:11434/v1` ok; why rejects invented number, cross-entry number, 26 words; accepts `1,200` supported only by `signals.hnPoints = 1200` (D1) and the request body contains that signal; post-LLM entry drop -> finalized ids/counts match |
| pipeline.test.js | `runFixture` with Reddit 403 + Mistral `TypeError` overrides and a temp `dataDir`: `diagnostic === false`; four files; `failedCount === 2`; `error: 'HTTP 403'` / `'network'`; `okCount + emptyCount === sources.length - 2`; `okCount >= 40`; valid digest; unique ids; arXiv fallback note; `meta.static` deep-equals `structuredClone({ ...linkouts, learn })`; `meta.sources.anthropic.homepage === 'https://www.anthropic.com/news'` and no `homepage` key for sources without one (D6); hn-front items have rank 1..30 + marker; Reddit survivors have marker; second same-day run six hours later strips ephemeral fields, keeps the item and `hn-front` source, no present-tense why; Reddit disappearance + failure variants say `from r/<sub>`; next-day run: `newItemCount`, cache reuse, prior digest immutable, no cross-day repeats, finalizer/index equality; sitemap-only vs sitemap+HN invalidation; injected logger receives warnings; `run()` writes nothing to stdout |
| cli.test.js | `--source hn-top` without `--dry-run` exits 1 before fetch/write; `--source hn-top,hf-papers --dry-run` fetches exactly those ids in registry order, no LLM call even with a key, no writes, prints one table; direct `run({ onlySourceIds, dryRun: false })` rejects; `dryRun: true` returns `{ diagnostic: true, items, sourceResults }` |
| client-state.test.js | each sanitizer with `null`/array/scalar -> null-prototype empty record; mixed valid/invalid timestamps; saved snapshot field failures drop only the bad entry; `lastVisit`/`range` defaults; throwing `getItem`/`setItem` -> one warning + in-memory fallback; `selectCatchUpDays` (D5): last visit 2026-10-17T18:00Z with days 10-19 (newest), 10-18, 10-17, 10-16 -> exactly `[10-18]`; same-day refresh of 10-19 never included; `previousVisit 0` -> up to 14 newest earlier days; `healthStatus` strings for 0 / 3 / 7 failures and 13 h-old data; `sourceChipHref` homepage vs origin (D6) |
| frontend.test.js | `index.html` < 10 KB, `app.js` < 60 KB, `styles.css` < 15 KB; CSP meta present; 10 `role="tab"` buttons; `app.js` contains no `innerHTML`, no `setAttribute('style'`, no `fetch('/`; all `data/` references relative |
| serve.test.js | start `serve.mjs` on an ephemeral `PORT`; `/` and `/ahead/` return `index.html` with `text/html; charset=utf-8` and `Cache-Control: no-store`; `/ahead/styles.css` -> `text/css; charset=utf-8`; `/package.json` -> `application/json; charset=utf-8`; `/../package.json`, `/%2e%2e/package.json` -> not 200; `/%ZZ` -> 400; `POST /` -> 405; `HEAD /` -> 200 no body; missing -> 404 (D7) |
| data-shape.test.js | when `data/items.json`, `data/meta.json`, `data/digests/index.json` exist: validate all against `schema.js`; `meta.static` has the three arrays; sitemap maps <= 30 keys per source; items file <= 2 MB; every indexed digest exists with `wordCount <= 1100`, exact `itemIds`, `deepReadId`, recounts, `entryCount`; otherwise skip with a message |

---

# Implementation Plan

Ordered by dependency. Each item leaves the repo in a state where `npm test` passes. Verify commands run from the project root. Commit after each item (conventional commit messages, e.g. `feat(parsers): feed parser`), never push.

- [ ] 1. Scaffold + registry + config validation.
      Edit `package.json` (move `fast-xml-parser` to `dependencies`, add `probe` script), add `_site/` to `.gitignore`, run `npm install` so `package-lock.json` reflects the move. Write `sources.config.mjs` (§4 table + D§4.2 `linkouts`/`learn` literals verbatim), `src/registry.js` (P1), `src/schema.js` with `validateConfig` and the enum constants (`CATEGORIES`, `TYPES`, `SIGNAL_KEYS`, `SECTION_KEYS`, `CATEGORY_PRECEDENCE`; output validators come in item 13), `tests/helpers.js` (`CONFIG`, `ROOT`, `FIXTURES`, `NOW`, `read`; `fixtureFetch`/`runFixture` added in item 4), `tests/registry.test.js`.
      Files: `package.json`, `package-lock.json`, `.gitignore`, `sources.config.mjs`, `src/registry.js`, `src/schema.js`, `tests/helpers.js`, `tests/registry.test.js`
      Verify: `npm test` — registry tests pass (64 baseline ids present, every invalid-config table case throws naming the exact field).

- [ ] 2. Normalization.
      Write `src/normalize.js` (`canonicalizeUrl`, `extractArxivId`, `stripHtml`, `cleanText`, `truncate`, `parseDate`, `isHttpUrl`, `itemId`, `toItem`) per §5 and D§5.4-5.5, and `tests/normalize.test.js`.
      Files: `src/normalize.js`, `tests/normalize.test.js`
      Verify: `node --test tests/normalize.test.js` passes (canonicalization table, arXiv ids, dates, `toItem` `at` derivation and `maxAgeDays`).

- [ ] 3. HTTP client.
      Write `src/http.js` (`createHttpClient`, error classes, `errorClass`, `PACING`, `ACCEPT`; P5 user agent) per §5 and D§5.2, and `tests/http.test.js` with injected `fetchImpl`, `sleep`, `nowMs`.
      Files: `src/http.js`, `tests/http.test.js`
      Verify: `node --test tests/http.test.js` passes (pacing timings, retry matrix, deadline gating, byte cap, token scoping, no env reads).

- [ ] 4. Feed parser (rss/atom/youtube/github releases) + fixture fetch helper.
      Add `fixtureFetch` (exact map + kind fallback + generated HTML pages + overrides; §13) and `runFixture` (P6 lazy import) to `tests/helpers.js`. Write `src/parsers/feed.js` per D§5.3 feed bullet (FXP options, sniffing, field mapping, audio re-route, `Sponsors:` cut, `bodyLength`, GitHub release tag rule), `tests/feed.test.js`, `tests/github.test.js`.
      Files: `tests/helpers.js`, `src/parsers/feed.js`, `tests/feed.test.js`, `tests/github.test.js`
      Verify: `node --test tests/feed.test.js tests/github.test.js` passes (every XML fixture's count/first item, Interconnects 2 audio -> media, pytorch -> empty, llama.cpp cap 3).

- [ ] 5. JSON parsers (HN + rank, HF Papers, HF Models, GitHub search).
      Write `src/parsers/json.js` per D§5.3 json bullets with D2 (`isHfModelId`) and D3 (exhaustive HF mapping, summary format), `isAiStory` + regexes from D§5.5 as exported constants, `tests/json.test.js`.
      Files: `src/parsers/json.js`, `tests/json.test.js`
      Verify: `node --test tests/json.test.js` passes (9/42 and 8/30 pinned HN ids, ranks 10 and 4, HF mapping, D2 table, star floors 8/5/empty, malformed-element injections).

- [ ] 6. arXiv source runner.
      Write `src/parsers/arxiv.js` (`fetchArxivSource`: RSS decode, `replace*` drop, API fallback branches, `fetched`/`kept`/`note` per path) and `tests/arxiv.test.js`.
      Files: `src/parsers/arxiv.js`, `tests/arxiv.test.js`
      Verify: `node --test tests/arxiv.test.js` passes (18/13, cap 5 in fixture order, empty -> API fallback 10, both-fail, empty + fallback-fail, all-replace no fallback).

- [ ] 7. Reddit parser.
      Write `src/parsers/reddit.js` (permalink vs external `[link]`, host rule `.reddit.com`/`.redd.it`, boilerplate strip, `extra.subreddit`, `extra.redditTopCurrent`) and `tests/reddit.test.js`.
      Files: `src/parsers/reddit.js`, `tests/reddit.test.js`
      Verify: `node --test tests/reddit.test.js` passes (12 items, 4 external / 8 hosted, markers).

- [ ] 8. Sitemap parser.
      Write `src/parsers/sitemap.js` (decode, lastmod normalize, include/exclude, 30-URL window, 10 page fetches at concurrency 4 with `pageDeadlineAt = min(sourceStartedAtMs + 40_000, deadlineAt)`, og:* extraction + `<title>` suffix rule, cache/skip maps, invalidations, slug fallback, truncated note, map pruning/cap) and `tests/sitemap.test.js`.
      Files: `src/parsers/sitemap.js`, `tests/sitemap.test.js`
      Verify: `node --test tests/sitemap.test.js` passes (Anthropic 15/10, Batch 2/9, cache/skip/invalidation/deadline cases incl. the 32 s check).

- [ ] 9. Scoring and ranking.
      Write `src/score.js` (constants, `score`, `round2`, `compareRank`) and `tests/score.test.js`.
      Files: `src/score.js`, `tests/score.test.js`
      Verify: `node --test tests/score.test.js` passes (13.25 / 23.00, half-life, cap 12, unknown id, `compareRank` order).

- [ ] 10. Dedup, invalidations, previous-run merge.
      Write `src/dedup.js` (`mergeItems`, `compareProvenance`, `stripEphemeral`, `applyInvalidations`, `mergePrevious` with the D§5.8 authority tuples, `distinctFamilies`) and `tests/dedup.test.js`.
      Files: `src/dedup.js`, `tests/dedup.test.js`
      Verify: `node --test tests/dedup.test.js` passes (every in-run field rule, every previous/fresh rule, authority tuples, sitemap-only vs sitemap+HN invalidation).

- [ ] 11. Brief builder.
      Write `src/brief.js` (`buildBrief` -> `{ digest, facts }` (D1), `orderSources` (D4), `heuristicWhy` (D3/P2 formatting), sentence split, `enforceBudget`, `countWords`, `countDigestWords`, `finalizeDigest`, `SECTIONS`) and `tests/brief.test.js` including the adversarial 1,100-word test.
      Files: `src/brief.js`, `tests/brief.test.js`
      Verify: `node --test tests/brief.test.js` passes (section counts, pools, D4 ordering, why-lines, `wordCount <= 1100` / `<= 880`, `readingMinutes`, finalizer).

- [ ] 12. LLM editorial layer.
      Write `src/llm.js` (`resolveLlmConfig`, `editorialize` with D1 facts, `numberTokens`, compatibility retry, `SYSTEM_PROMPT`) and `tests/llm.test.js` with a mocked `fetchImpl`.
      Files: `src/llm.js`, `tests/llm.test.js`
      Verify: `node --test tests/llm.test.js` passes (all acceptance/rejection cases, base-URL rules, retry rule, three result states, no key leakage).

- [ ] 13. Pipeline, output schemas, CLI.
      Finish `src/schema.js` (`validateItem`, `validateItemsFile`, `validateDigest`, `validateDigestIndex`, `validateMeta`, `validateSitemapState`). Write `src/pipeline.js` (`run`, `runSource` (P4), `defaultLogger`) implementing D§5.1 steps 1-7: validate config -> build registry + HTTP client -> load previous items/meta sitemap state/14 digests (diagnostic mode: items + sitemap maps only) -> 6-worker scheduler with 45 s backstop and 8 min run budget -> normalize + tag candidates -> `mergeItems` -> (diagnostic: score, `compareRank`, return) -> `stripEphemeral` + `applyInvalidations` + `mergePrevious` -> rescore all -> `compareRank` -> retention (7 d / arXiv-only 3 d) -> 3,000 cap -> 2 MB trim -> `resolveLlmConfig` -> `buildBrief` with `targetWords` -> `editorialize` if eligible -> `finalizeDigest` -> `meta` (incl. `homepage` per D6, `sitemapSkipped`/`sitemapCache` pruned to 30, `static`) -> validate all outputs -> write via `.tmp` + rename unless `dryRun` -> return `RunResult`. Write `scripts/fetch.mjs` (§11). Write `tests/pipeline.test.js`, `tests/cli.test.js`, `tests/determinism.test.js`, `tests/data-shape.test.js`.
      Files: `src/schema.js`, `src/pipeline.js`, `scripts/fetch.mjs`, `tests/pipeline.test.js`, `tests/cli.test.js`, `tests/determinism.test.js`, `tests/data-shape.test.js`
      Verify: `npm test` — all suites pass; `node scripts/fetch.mjs --source hn-top,hf-papers --dry-run` exits 0, prints a two-row table, writes nothing (`git status --short data` empty).

- [ ] 14. Probe and local server scripts.
      Write `scripts/probe-sources.mjs` (§11, reuses `runSource`) and `scripts/serve.mjs` (D7), plus `tests/serve.test.js`.
      Files: `scripts/probe-sources.mjs`, `scripts/serve.mjs`, `tests/serve.test.js`
      Verify: `node --test tests/serve.test.js` passes; `npm run serve` then `curl -I http://127.0.0.1:8787/ahead/` returns `200`, `text/html; charset=utf-8`, `Cache-Control: no-store` (Ctrl-C to stop). `npm run probe` prints one row per source (network; may show a few `failed`).

- [ ] 15. Frontend.
      Write `index.html`, `styles.css`, `app.js`, `favicon.svg` per §10 (tabs, routing, keyboard, rendering, client state with per-key sanitizers and in-memory fallback, health indicator, error states, `Also:` strips, Archive + catch-up per D5/P7, source chips per D6/P9). Pure helpers exported; `start()` guarded by `globalThis.document`. Write `tests/client-state.test.js` and `tests/frontend.test.js`.
      Files: `index.html`, `styles.css`, `app.js`, `favicon.svg`, `tests/client-state.test.js`, `tests/frontend.test.js`
      Verify: `node --test tests/client-state.test.js tests/frontend.test.js` passes; with `npm run serve` and no data yet, `http://127.0.0.1:8787/ahead/` shows the "No data yet" state with a clean console.

- [ ] 16. First real data run and end-to-end local check.
      Run `npm run fetch` (live network, ~1 min). Then `npm test` (data-shape test now validates real `data/`). Open `http://127.0.0.1:8787/ahead/` and `http://127.0.0.1:8787/`: Brief renders six sections, tabs/keys/search/chips/range/saved/archive/catch-up work, health text matches `meta.failedCount`, light scheme renders under `prefers-color-scheme: light`. Commit `data/` (tracked by design).
      Files: `data/items.json`, `data/meta.json`, `data/digests/<date>.json`, `data/digests/index.json`
      Verify: `npm test` green; `node -e "const m=require('./data/meta.json');console.log(m.okCount,m.emptyCount,m.failedCount)"` shows `okCount >= 25`; digest `wordCount <= 1100` and `readingMinutes <= 5`.

- [ ] 17. Workflow and README.
      Write `.github/workflows/refresh.yml` exactly as §12 and `README.md` per D§15 (what Ahead is; source table by category marking Anthropic and The Batch `sitemap (publisher has no feed)` and the other alternates; `Also:` link-outs; ranking formula + worked example; brief rules and the 1,100-word cap; adding a source (one literal + `npm run probe`); LLM setup with provider table, `LLM_MODEL` requirement, base-URL rules, `max_tokens` compatibility retry; Pages auto-enablement; cron + `gh workflow run refresh.yml`; local commands incl. `/ahead/` prefix; data formats; known limits).
      Files: `.github/workflows/refresh.yml`, `README.md`
      Verify: `npm test` still green; `node -e "require('node:fs').readFileSync('.github/workflows/refresh.yml','utf8')"` loads; YAML has `cron: '0 */6 * * *'`, `workflow_dispatch`, `push` to `main`, two jobs with the §12 permissions. After the user pushes: the Actions run is green, `data/` gets a `[skip ci]` commit, and `https://sudish007.github.io/ahead/data/meta.json` answers 200.

---

## 14. Verification checklist (final gate)

- [ ] `npm ci && npm test` green on Node 24; no test touches the network (unmapped URL throws).
- [ ] `node scripts/fetch.mjs --source hn-top --dry-run` ok; `--source hn-top` alone exits 1 without fetching.
- [ ] Live `npm run fetch`: `>= 25` sources `ok`, Reddit/others may be `failed` without failing the run; four data files written atomically; `meta.failedCount` matches the UI text `N sources failed`; `meta.sources.anthropic.homepage` present.
- [ ] Weekday digest: all six sections populated; `wordCount <= 1100`; `readingMinutes <= 5`; no `undefined`/`NaN` in any why-line; `[AINews]` never in Analysis/Deep read.
- [ ] `npm run probe` lists every source with status/items/ms/finalUrl.
- [ ] `npm run serve`: `/` and `/ahead/` both render; `Cache-Control: no-store`; traversal and malformed URIs rejected; MIME types correct for html/js/css/json/svg/ico/png.
- [ ] UI: default tab Brief; `1`-`9`/`0` switch tabs; `j`/`k`/`o`/`s`/`r`/`/`/`Escape` behave; source chips (D6 links), range `24h/3d/7d` persisted, search filters without re-sorting; read/saved persist across reload; Saved chip shows snapshots; Archive lists days with reading time; "Catch up since <date>" selects per D5 (never today's digest, never re-qualifies a refreshed day); Leaderboards/Learn render from `meta.static`; `Also:` strips on Research/Labs/Blogs only; `No data yet` on 404, `role="alert"` banner otherwise; dark default and light scheme both >= 4.5:1; console clean.
- [ ] File budgets: `index.html` < 10 KB, `app.js` < 60 KB, `styles.css` < 15 KB; `items.json` <= 2 MB.
- [ ] Secrets: no token/key in `data/`, logs, or error strings (grep the data dir for `Bearer`/the key value returns nothing).
- [ ] Actions: first run creates Pages (`configure-pages` with `enablement: true`), commits data with `[skip ci]`, deploys; `https://sudish007.github.io/ahead/` loads the brief; `gh workflow run refresh.yml` triggers a manual refresh; a data-only commit does not retrigger.
- [ ] Optional LLM: with `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` set, `meta.llm.ok === true`, overview 150-200 words with an "AI-written" tag; with the key removed the heuristic brief deploys unchanged (`llm: { enabled: false, ok: false }`).
