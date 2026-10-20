# Ahead

Ahead is a personal AI intelligence dashboard: one static page that pulls 64 sources (arXiv, HF Daily Papers, Hacker News, Reddit, the frontier labs, the deep technical blogs, release feeds, podcasts and YouTube channels), ranks everything, and writes a **5-minute daily brief** you can read in one scroll. It runs on GitHub Actions every six hours and deploys to GitHub Pages. No framework, no server, no database, no API keys required (an LLM key, a YouTube Data API key and a small Cloudflare Worker relay are optional).

Live site: https://sudish007.github.io/ahead/ (repo: https://github.com/Sudish007/ahead)

## How it works

```
sources.config.mjs ──▶ scripts/fetch.mjs ──▶ src/pipeline.js
                                              fetch 64 sources (6 workers, 45 s per source, 8 min per run)
                                              normalize → dedup (canonical URL / arXiv id) → merge with the previous run
                                              score → retention (7 days) → data/items.json
                                              build the brief → data/digests/YYYY-MM-DD.json, index.json, meta.json
index.html + app.js + styles.css ◀── GitHub Pages serves the repo's static files + data/
```

The pipeline is plain Node 24 ESM with one dependency (`fast-xml-parser`). The frontend is one ES module, one stylesheet and a CSP that forbids inline code. Request headers are browser-like (Chrome `User-Agent`, feed `Accept`, `Accept-Language`) except for Reddit and the GitHub API, which get the identifying `Ahead/<version>` UA.

## Sources

Type `sitemap (publisher has no feed)` means the publisher offers no RSS/Atom feed, so Ahead reads its `sitemap.xml` and the `og:*` tags of the newest pages.

| Category | Source | Type | Notes |
|---|---|---|---|
| Research | arXiv cs.LG, cs.CL, cs.AI, cs.CV | arxiv | RSS announcements; the cs.AI feed is empty between the ~00:00 UTC expiry and the ~04:00 UTC rebuild (and on weekends), so the API fallback (15 s timeout + one retry) carries it |
| Research | HF Daily Papers | json | upvotes feed the score |
| News | Hacker News (24 h, 30+ points), HN front page | hn | AI keyword/host filter; front-page rank from `topstories.json` |
| News | Reddit r/LocalLLaMA + r/MachineLearning | reddit | one multireddit request per run; may fail from Actions IPs |
| Labs | OpenAI, Google DeepMind, Google Research, Microsoft Research, NVIDIA Technical Blog, Hugging Face Blog, Ai2, Mistral AI, Transformer Circuits | rss/atom | Mistral serves RSS as `text/plain`; the parser sniffs the body |
| Labs | Meta Newsroom (AI) + Engineering at Meta (AI) | rss | Meta AI blog has no feed; both feeds share the `meta` family |
| Labs | Anthropic | sitemap (publisher has no feed) | `/news`, `/research`, `/engineering` pages |
| Blogs | Lil'Log, Interconnects, Ahead of AI (Raschka), Simon Willison, Chip Huyen, Eugene Yan, Hamel Husain, SemiAnalysis (newsletter), Import AI, Latent Space, Don't Worry About the Vase, One Useful Thing, The Gradient, Epoch AI (atom) + Gradient Updates, Alignment Forum, ChinAI, Jay Alammar (Language Models newsletter), Andrej Karpathy (blog + bearblog), Horace He (Thonking AI) | rss/atom | Latent Space carries the `[AINews]` daily issues and podcast episodes (routed to media by audio enclosure); Import AI, Don't Worry About the Vase, Gradient Updates and ChinAI go through the relay when it is configured |
| Blogs | The Batch | sitemap (publisher has no feed) | `/the-batch/<slug>` articles; issues and tags excluded; through the relay when configured |
| Releases | PyTorch, vLLM, Transformers, llama.cpp, SGLang, Unsloth, TRL, torchtitan | github | release Atom feeds; CI tags (`viable/strict/...`) dropped |
| Releases | GitHub new repos: llm, machine-learning, ai-agents | github | search API, created in the last 7 days, 50+ stars |
| Releases | HF trending models | json | first-seen date is the run time |
| Media | Dwarkesh Podcast, Machine Learning Street Talk, The Cognitive Revolution, No Priors | rss | sponsor blocks cut from summaries; Dwarkesh through the relay when configured |
| Media | Andrej Karpathy, Yannic Kilcher, AI Explained, GPU MODE, Stanford Online, 3Blue1Brown | youtube | with `YOUTUBE_API_KEY`: one Data API `playlistItems` request per channel (no view counts); without it: the public feed with browser-like headers and 3 attempts (2 s / 8 s backoff), which answers 404/500 intermittently; feed view counts feed the score |

Link-outs (no fetch): alphaXiv (Research tab), Meta AI blog (Labs tab), AI News / smol.ai (Blogs tab; its RSS stopped on 2026-09-09 and the issues now arrive as `[AINews]` posts in the Latent Space feed), plus eight leaderboards and a 16-entry learning list in `sources.config.mjs`.

## Ranking

```
ageHours = max(0, (now - surfacedAt) / 3.6e6)
decay    = 0.5 ** (ageHours / 36)                       # half-life 36 h
W        = max source weight (1..10) across the item's sources
E        = 1.0*log2(1+hfUpvotes) + 0.6*log2(1+hnPoints) + 0.4*log2(1+hnComments)
         + 0.5*log2(1+ghStars) + 0.5*log2(1+redditScore) + 0.5*log2(1+hfLikes) + 0.15*log2(1+ytViews)
X        = 4 * min(3, distinctFamilies - 1)             # cross-source bonus, max 12
score    = round2(W * decay + E + X)
```

Only the source weight decays. Worked example (also a unit test): an HN-only story with 500 points / 200 comments, 2 h old, weight 5 scores **13.25**; a paper on arXiv + HF Papers (30 upvotes) + HN (40 points / 10 comments), 20 h old, scores **23.00** and wins despite less raw engagement. Ties are settled by surfaced time, then title and id in code-point order, so output is byte-deterministic.

## The brief

Six sections, filled in order from items surfaced in the last 36 h (72 h when fewer than 20 remain): Must know (4), Research (3), Releases & tools (3), From the labs (2), Analysis worth reading (2, long-form first), One deep read (1, from the last 7 days). Nothing repeats across days: the ids of the two previous digests are excluded, and the last 14 deep reads are never repeated. Each entry has a title, a one-to-two-sentence summary and a heuristic "why" line built only from stored facts (`#4 on HN front page, 435 points`; `30 upvotes on HF Papers; also on arXiv cs.LG`; `1,234 stars in 3 days`). The whole brief is capped at **1,100 words** (about 5 minutes at 220 wpm) by a deterministic budget that trims summaries, drops entries, then caps titles, why-lines and source labels. Past days are frozen; only today's digest is regenerated during the day.

## Adding a source

Add one object literal to `sources` in `sources.config.mjs`:

```js
{ id: 'my-blog', name: 'My Blog', category: 'blogs', type: 'rss', url: 'https://example.com/feed.xml', weight: 5, longForm: true },
```

Required: `id name category type url weight`. Optional: `homepage family maxItems maxAgeDays maxBytes longForm`, plus `parser` (json), `fallbackUrl` (arxiv), `rankUrl` (hn), `repo` (github releases), `minStars` (github search), `include`/`exclude` (sitemap, non-global RegExp), `template` (URL with `{{unix24hAgo}}`/`{{date7dAgo}}`), `viaRelay` (rss/atom/sitemap without `template`: fetch through the `ahead-relay` Cloudflare Worker when it is configured; run `node relay/build-allowlist.mjs` afterwards) and `relayPagePrefix` (sitemap + viaRelay: the `https://.../` prefix its article pages share). Then run `npm run probe` to see what every URL returns; `npm test` validates the configuration and keeps working for any source covered by an existing parser.

## Optional LLM editorial layer

Without a key the brief is fully heuristic. With a key, one request per run rewrites the why-lines and adds a 150-200 word overview (shown with an "AI-written" tag). Every number in the model's output must appear in the facts sent for that entry, or the text is rejected and the heuristic line stays.

The pipeline speaks the OpenAI chat-completions protocol only (`POST {LLM_BASE_URL}/chat/completions` with `Authorization: Bearer <key>`), so any provider that exposes an OpenAI-compatible endpoint works. Three repository secrets configure it; the workflow passes them to `scripts/fetch.mjs` as environment variables of the same name.

| Secret | Meaning |
|---|---|
| `LLM_API_KEY` | the provider's key; absent -> heuristic brief, `meta.llm = { enabled: false, ok: false }` |
| `LLM_BASE_URL` | provider base URL (defaults to OpenAI's when unset) |
| `LLM_MODEL` | model id; required whenever a key is set |

| Provider | `LLM_BASE_URL` | Notes |
|---|---|---|
| OpenAI (default) | `https://api.openai.com/v1` | key from platform.openai.com; e.g. `LLM_MODEL=gpt-4o-mini` |
| Anthropic | `https://api.anthropic.com/v1` | Anthropic's OpenAI-compatible endpoint: the same `sk-ant-...` key you use for the native Messages API, sent as a Bearer token; use a current Claude model id (e.g. `claude-sonnet-4-5`). The compatibility layer does not support every native Messages feature, but the pipeline only needs plain chat completions |
| Groq | `https://api.groq.com/openai/v1` | free tier available at console.groq.com; model ids such as `llama-3.3-70b-versatile` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | key from Google AI Studio (free tier); model ids such as `gemini-2.5-flash` or `gemini-3.6-flash`. These are thinking models: on this endpoint their reasoning tokens count against `max_tokens`, which is why the pipeline sends an 8,192-token budget (1,500 left the JSON cut off) |
| OpenRouter | `https://openrouter.ai/api/v1` | one key, many models; model ids are `vendor/model` (e.g. `anthropic/claude-sonnet-4.5`), some with a `:free` variant |

`LLM_MODEL` is always required with a key (a current model id from the provider; a key without a model records `LLM_MODEL unset` and deploys the heuristic brief). The base URL must be `https:` (or `http:` to `localhost`/`127.0.0.1`) with no credentials, query or fragment.

The request asks for JSON mode (`response_format: { type: "json_object" }`, accepted by OpenAI, Gemini, Groq and OpenRouter) with `temperature: 0.3` and `max_tokens: 8192`. The answer itself is about 1,000 tokens, but thinking models (Gemini 3.x Flash, OpenAI o-series) spend output tokens on reasoning before the visible answer and count them against the same cap, so a small budget returns a cut-off answer (`finish_reason: "length"`). If a provider answers HTTP 400 naming `max_tokens`, the request is retried once with `max_completion_tokens`; if it names `response_format`, once more without it. The reply is parsed after stripping markdown code fences, and failing that from the first balanced `{...}` in the text, so a model that wraps or narrates its JSON still works.

The request times out after 60 s. A transient answer (HTTP 429, 500, 502, 503, 504, or a network error; Gemini's free tier answers 503 "high demand" now and then) is retried after 10 s and again after 30 s (a numeric `retry-after` header wins, capped at 30 s), so one request per run means one answer, up to three attempts. A timeout is not retried. Any failure leaves the heuristic brief in place. `meta.llm` then carries `error` (`HTTP <status>`, with ` (N attempts)` appended when retries ran, `timeout`, `network`, `invalid JSON`, `truncated`, `refusal`, `reasoning only` or `empty`) and, when the provider supplied them, `finishReason`, token `usage` (`prompt`/`completion`/`total`; on Gemini, thinking tokens = total - prompt - completion) and `detail`, the first 300 characters of the model output or error body with whitespace collapsed. `usage` is also recorded on success. `detail` is scrubbed before it is cut (the key, and any `key=` value in a googleapis URL, become `REDACTED`); request headers never reach it. The key never appears in `data/`, logs or error strings.

```sh
gh secret set LLM_API_KEY      # paste the key at the prompt
gh secret set LLM_BASE_URL --body https://api.groq.com/openai/v1
gh secret set LLM_MODEL --body llama-3.3-70b-versatile
gh workflow run refresh.yml    # next run picks the secrets up
```

Remove `LLM_API_KEY` (`gh secret delete LLM_API_KEY`) to go back to the heuristic brief; nothing else changes.

## YouTube Data API key (optional)

Without a key the six YouTube channels are read from the public feed endpoint (`youtube.com/feeds/videos.xml`), which answers 404/500 for most requests from GitHub-hosted runners, so the channels usually report `HTTP 404 (3 attempts)` there. With a key the pipeline reads each channel through the YouTube Data API v3 instead and only falls back to the feed when the API call fails.

Setup:

1. [Google Cloud Console](https://console.cloud.google.com/) -> create or pick a project.
2. APIs & Services -> Library -> enable **YouTube Data API v3**.
3. APIs & Services -> Credentials -> Create credentials -> **API key**. Edit the key -> API restrictions -> restrict it to **YouTube Data API v3** (the key is only ever sent to `www.googleapis.com`).
4. Store it as a repository secret and trigger a run:

```sh
gh secret set YOUTUBE_API_KEY --repo Sudish007/ahead   # paste the key at the prompt
gh workflow run refresh.yml                            # next run picks it up
```

(Or GitHub -> Settings -> Secrets and variables -> Actions -> New repository secret `YOUTUBE_API_KEY`.) The workflow passes the secret to `scripts/fetch.mjs` as the `YOUTUBE_API_KEY` environment variable of the `Fetch sources and build the brief` step only; the test step never sees it.

What the pipeline does with it: one `GET https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=15&playlistId=UU…` per channel per run, where the uploads playlist id is the channel id from `sources.config.mjs` with its leading `UC` replaced by `UU` (no second id list). The request has an 8 s timeout and no retry. Items map to the same shape the feed produces (title, `watch?v=` URL, publish time, cleaned description with sponsor blocks cut, channel name as author) and go through the same normalization, age window, dedup and scoring, so `data/items.json` keeps its shape and the source ids stay the same; saved/read state in the browser survives the switch. The API carries no view counts, so the `N views` why-line and the `0.15*log2(1+ytViews)` score term apply only to feed-fetched items; counts stored from earlier feed runs are kept. `meta.sources.<id>.note` reads `api` when the API answered and `api: HTTP 403, fell back to feed` (or another error class) when it did not; in that case the feed path runs exactly as without a key, so a failing API never makes a source worse.

Quota: `playlistItems.list` costs 1 unit, so a run with 6 channels costs 6 units; the 4 scheduled runs a day use about 24 of the default 10,000 daily units, and every push or manual dispatch adds 6 more. The quota resets at midnight Pacific time.

Secret hygiene: the key travels only in the request URL. Every URL that reaches an error message, a log line or the `detail` field of `meta.json` is rewritten to `key=REDACTED`, and the key is never written to `data/`. `gh secret delete YOUTUBE_API_KEY --repo Sudish007/ahead` returns to the feed path; an empty secret behaves exactly like an absent one.

## Relay for Cloudflare-blocked feeds

Why: six Cloudflare-fronted sources answer a 403 JS challenge (`cf-mitigated: challenge`) to every request from GitHub-hosted runner IPs while answering 200 from a home connection. A probe on 2026-10-20 showed that a Cloudflare Worker fetching the same URLs is not challenged (126 requests, zero challenges; see `.agents/tasks/ahead-build/relay-probe-results.md`), so the pipeline can fetch them through a Worker we control.

What it is: `relay/` holds the Worker `ahead-relay` (plain JS, `wrangler` is its only dev dependency, deployed to `workers.dev`; `relay/README.md` has the short operator notes). It proxies exactly the URLs in `relay/src/allowlist.json`, generated from the `viaRelay` sources in `sources.config.mjs`: the six feed/sitemap URLs under `GET /feed/<id>` and The Batch article pages under `GET /page/thebatch?u=<encoded URL>` (only URLs starting with `https://www.deeplearning.ai/the-batch/`). Every other path, id, method or URL answers `404 {"error":"not found"}`, and every request must carry the shared-secret header `X-Relay-Token` or it answers `401 {"error":"unauthorized"}`, so it is not an open proxy. The token is never forwarded upstream; upstream requests carry the pipeline's browser-like headers.

How it behaves: a KV namespace (`RELAY_CACHE`) keeps a last-good copy of every URL (raw bytes plus `contentType`/`fetchedAt`, 30-day TTL). A copy younger than 2 h is served as is (`x-relay-cache: hit`); otherwise the Worker fetches upstream with a 10 s timeout and one retry after 2 s on a 429, stores the body and serves it (`miss`); when upstream fails (non-200, `cf-mitigated`, timeout) and a copy exists, the copy is served with `x-relay-cache: stale` and `x-relay-stale: <fetchedAt>`; with no copy it answers `502 {"error":"upstream failed","url":...,"upstreamStatus":<int|null>,"cfMitigated":<string|null>,"reason":"status"|"timeout"|"network"}`. Bodies over 4,000,000 bytes (4 MB; the largest feed is about 2 MB) are passed through but not stored (`bypass`). A cron (`0 */3 * * *`) refreshes the six feed/sitemap copies in id order 2 s apart, so pipeline runs normally hit KV and never reach Substack in a burst. Every response carries `cache-control: no-store` and 200s pass only the upstream `content-type` through.

What the pipeline does: when `RELAY_URL` and `RELAY_TOKEN` are both set (non-blank), `viaRelay` sources are requested from `${RELAY_URL}/feed/<id>` (The Batch pages from `${RELAY_URL}/page/thebatch?u=...`) with the `X-Relay-Token` header and the identifying `Ahead/<version>` UA, one attempt with a 15 s timeout (pages keep their 8 s), then go through the same parsers, age window, dedup and scoring; source ids do not change, so stored items and saved/read state survive. Any relay failure (401, 404, 502, timeout, network) logs `<id>: relay failed (<class>) for feed|page; falling back to direct [...]` and runs the direct fetch exactly as without the relay, so the relay can never make a source worse. `meta.sources.<id>.note` reads `via relay`, `via relay (stale <fetchedAt>)` when the Worker served its last-good copy, or `relay: <class>, fell back to direct` (for example `relay: HTTP 401, fell back to direct`), in which case the row's status and error are the direct fetch's. Sources without `viaRelay`, and every run where either variable is absent or blank, behave byte-for-byte as before (no header, no note). A malformed `RELAY_URL` (not `https:`, or with credentials, query or fragment) logs `relay disabled: ...` once and the run proceeds directly.

Deploy (PowerShell; `$env:CI='true'` and `$env:WRANGLER_SEND_METRICS='false'` keep wrangler from prompting):

```powershell
cd relay; npm ci
npx wrangler kv namespace create RELAY_CACHE          # once; put the printed id into relay/wrangler.toml [[kv_namespaces]]
npx wrangler deploy                                   # prints https://ahead-relay.<subdomain>.workers.dev and the cron trigger
node -e "const fs=require('fs'),p=require('path'),f=process.argv[1];fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,require('crypto').randomBytes(32).toString('hex'));console.log('written',fs.statSync(f).size)" "$env:LOCALAPPDATA\ahead\relay-token.txt"
Get-Content -Raw "$env:LOCALAPPDATA\ahead\relay-token.txt" | npx wrangler secret put RELAY_TOKEN
Get-Content -Raw "$env:LOCALAPPDATA\ahead\relay-token.txt" | gh secret set RELAY_TOKEN --repo Sudish007/ahead
gh secret set RELAY_URL --repo Sudish007/ahead --body https://ahead-relay.rishtapatra.workers.dev
```

The token is 32 random bytes as 64 hex chars and never goes on a command line; piping appends a newline, so both the Worker and the pipeline trim it before comparing or sending. The workflow passes `RELAY_URL` and `RELAY_TOKEN` to the `Fetch sources and build the brief` step only; the test step never sees them. After changing `viaRelay`/`relayPagePrefix` in `sources.config.mjs`, run `node relay/build-allowlist.mjs` and redeploy; `npm test` fails while `relay/src/allowlist.json` is stale.

Rotate the token by running the generator and the two `secret put`/`secret set` lines again; the old token stops working the moment `wrangler secret put` completes, and the next workflow run uses the new one. Disable the relay with `gh secret delete RELAY_TOKEN --repo Sudish007/ahead` (or `RELAY_URL`): the six sources return to direct fetches and today's `blocked from GitHub runner: 403 Cloudflare` error; `npx wrangler delete ahead-relay` (in `relay/`) removes the Worker itself. Observe it with `npx wrangler tail ahead-relay` (one JSON `event: upstream` line per upstream attempt with `status`, `cfRay`, `cfCacheStatus`, `cfMitigated`, `bytes`, `ms`, `attempt`, and one `event: cron` summary per tick).

Free-tier footprint per day: 8 cron ticks x 6 fetches plus about 16 relay requests (6 feeds + up to 10 pages) x 4 scheduled runs, i.e. under 100 Worker requests and under 100 KV writes (48 from the cron, up to 40 for article pages) against 100,000 requests and 1,000 writes; storage is a few MB of 1 GB; one of the five cron triggers; the 2 s gaps are sleeps and cost no CPU time.

Secret hygiene: the token travels only in the `X-Relay-Token` header to the relay host (a redirect to another host drops it). Every URL, header and body snippet that can reach an error message, a log line or the `detail` field of `meta.json` has the token replaced with `REDACTED`, `authorization`/`x-relay-token` response headers are never recorded, and the token is never written to `data/` or the repository. The local copy at `%LOCALAPPDATA%\ahead\relay-token.txt` (outside the repo) is for running `npm run fetch` or `npm run probe` through the relay:

```powershell
$env:RELAY_URL = 'https://ahead-relay.rishtapatra.workers.dev'; $env:RELAY_TOKEN = (Get-Content -Raw "$env:LOCALAPPDATA\ahead\relay-token.txt").Trim()
npm run fetch -- --source importai,zvi,chinai,pod-dwarkesh,epoch-gradient-updates,thebatch --dry-run   # six rows with `via relay`
```

Sources that use it (`viaRelay: true` in `sources.config.mjs`): Import AI (`importai`), Don't Worry About the Vase (`zvi`), ChinAI (`chinai`), Dwarkesh Podcast (`pod-dwarkesh`), Epoch AI Gradient Updates (`epoch-gradient-updates`) and The Batch (`thebatch`, sitemap plus article pages).

## Deployment

`.github/workflows/refresh.yml` runs every 6 hours on a cron (`0 */6 * * *`, i.e. 00:00, 06:00, 12:00 and 18:00 UTC), on `workflow_dispatch`, and on pushes to `main` that touch anything except `data/`. It runs the tests, runs the pipeline, commits `data/` back with `[skip ci]`, stages `index.html app.js styles.css favicon.svg data/` into `_site/` and deploys that to GitHub Pages. `actions/configure-pages@v6` with `enablement: true` creates the Pages site on the first run, so no Settings change or API call is needed before pushing. Trigger a refresh by hand with:

```sh
gh workflow run refresh.yml
gh workflow run refresh.yml -f probe=true   # also runs scripts/probe-runner.mjs and prints the matrix in the job log
```

GitHub's cron can lag by 10-30 minutes; the header shows "refreshed N min ago" so that is visible rather than alarming. Four data commits a day add roughly 30-60 MB per year to the repository.

## Local commands

```sh
npm ci
npm test                                   # offline, fixture-driven (node --test)
npm run fetch -- --source hn-top,hf-papers --dry-run   # diagnose selected parsers; never writes
npm run fetch                              # live run, writes data/
npm run probe                              # one row per source: status | items | ms | note | finalUrl
npm run probe:runner                       # header-variant matrix for the hosts that block Actions runners
npm run serve                              # http://127.0.0.1:8787/ and http://127.0.0.1:8787/ahead/
```

`--source` is rejected without `--dry-run`: a partial run never writes data or calls the LLM. `--now <ISO>` pins the run time; `--no-llm` disables the editorial layer; `--data-dir <path>` redirects output. `npm run fetch` and `npm run probe` fetch the six `viaRelay` sources through the relay when `RELAY_URL` and `RELAY_TOKEN` are both set in the environment (two-line setup in "Relay for Cloudflare-blocked feeds"); otherwise every source is fetched directly.

## Data files

- `data/items.json` — `{ generatedAt, count, items[] }`, 7 days of items sorted by rank; capped at 3,000 items and 2 MB. Each item: `id` (`arxiv:<id>` or 16 hex of the canonical URL), `title`, `url`, `canonicalUrl`, `sources[{ id, url?, at }]`, `category`, `publishedAt`, `surfacedAt`, `summary`, `score`, `signals`, optional `arxivId authors readMinutes discussionUrl tag extra`.
- `data/digests/YYYY-MM-DD.json` — one brief per UTC day: `overview`, six `sections[].entries[]`, `itemIds`, `deepReadId`, `wordCount`, `readingMinutes`, `llm`. Only today's file is ever rewritten.
- `data/digests/index.json` — `{ days: [{ date, generatedAt, wordCount, readingMinutes, entryCount }] }`, newest first.
- `data/meta.json` — run metadata: per-source `status` (`ok | empty | failed`), `fetched`, `kept`, `skipped`, `ms`, `error`/`note` (youtube sources: `api` when the Data API answered, `api: <class>, fell back to feed` when it did not; relay sources: `via relay`, `via relay (stale <fetchedAt>)` when the Worker served its last-good copy, `relay: <class>, fell back to direct` when the relay failed and the direct fetch ran), `homepage`, and `detail` (failed sources only: response `server`/`cf-ray`/`cf-mitigated`/`content-type`/`location` headers and the first 300 chars of the body, <= 400 chars); `okCount/emptyCount/failedCount`; `newItemCount`; source-scoped `sitemapSkipped`/`sitemapCache` (at most 30 entries each); `llm`; `brief`; and `static` (leaderboards, link-outs, learn list) for the UI.

`fetched` counts decoded records before filtering, `kept` the records that survived parser drops, the age window and the per-source cap; `empty` means the fetch worked but nothing was kept (pytorch's CI-tag feed, weekend arXiv), and only `failed` counts toward the health indicator.

## Known limits

- Reddit publishes no scores in its feed and may block Actions IPs; the source then reports `failed` and everything else proceeds.
- Six Cloudflare-fronted sources answer a 403 JS challenge to direct requests from GitHub-hosted runners even with browser-like headers (measured on the Actions runs after the header/retry changes): Import AI, Don't Worry About the Vase, Gradient Updates, ChinAI, Dwarkesh Podcast (Substack) and The Batch (sitemap). The same six URLs answer 200 from a home connection (`npm run fetch` locally), which points to IP-range blocking. Since 2026-10-20 the workflow fetches them through the `ahead-relay` Cloudflare Worker (see "Relay for Cloudflare-blocked feeds"), which proxies only these allowlisted URLs and requires a shared-secret header. Without `RELAY_URL`/`RELAY_TOKEN`, or when the relay itself fails, they fall back to the direct fetch and report `blocked from GitHub runner: 403 Cloudflare` as before.
- YouTube's public feed endpoint is flaky from every network (locally about 30-50 % of requests succeed) and answers 404/500 for most requests from the runner. Without `YOUTUBE_API_KEY` the six channels (Andrej Karpathy, Yannic Kilcher, AI Explained, GPU MODE, Stanford Online, 3Blue1Brown) usually report `HTTP 404 (3 attempts)` or `HTTP 500 (3 attempts)` there, and which channels get through varies run to run (typically 1 of 6). With the key (see "YouTube Data API key") they are fetched through the YouTube Data API and the feed is only the fallback.
- The GitHub search API is limited to 10 requests/min unauthenticated; the workflow's `GITHUB_TOKEN` raises that.
- HN front-page rank comes from `topstories.json`, so a story outside the top 30 shows "on HN front page" without a number.
- The `[AINews]` roundups stay in the Blogs tab and may reach Must know, but never Analysis or Deep read.
- The repository grows with every data commit; squashing history is out of scope.
