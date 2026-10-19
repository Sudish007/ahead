# Ahead — source probe report

Two passes, both on 2026-10-19 (UTC), from the dev machine with Node v24.16.0 built-in `fetch` (undici), the same client `scripts/fetch.mjs` will use. User-Agent: `Ahead/0.1 (+https://github.com/Sudish007/ahead; personal AI dashboard; contact: github.com/Sudish007)`.

- **Pass 1 (morning)**: about 200 requests covering every URL in the brief's SOURCES section plus alternates, sitemaps, article pages, Reddit pacing and feed sizes. Raw bodies in `%TEMP%\ahead-probe\raw\`.
- **Pass 2 (14:06Z, design iteration 2)**: the final registry re-fetched end to end with the design's pacing (70 requests: 64 registry URLs, 4 arXiv API fallbacks, HN `topstories.json`, the dropped smol.ai feed), plus the checks the design review asked for: HN front-page ordering against `topstories.json`, the deeplearning.ai sitemap, one Anthropic and one Batch article page, and the five OpenAI-compatible LLM endpoints. Script: `%TEMP%\ahead-probe\reprobe.mjs`, results `%TEMP%\ahead-probe\reprobe-summary.json`. **All 70 requests returned HTTP 200.**

A curated, trimmed subset of the raw bodies is committed under `tests/fixtures/` (see `tests/fixtures/README.md`; regenerated in pass 2 by `%TEMP%\ahead-probe\make-fixtures2.mjs`).

Legend: **OK** = returned usable data; **FAIL** = no usable data at the URL given in the brief; **ALT** = working replacement found; **LINK-OUT** = no machine-readable feed, keep as a link in the UI; **DROP** = nothing usable or nothing new.

## Summary

| Group | In brief | OK as given | Fixed with ALT | Link-out | Dropped |
|---|---|---|---|---|---|
| Research | 6 (arXiv x4, HF papers, alphaXiv) | 5 (cs.AI RSS empty all day, API fallback works) | 1 (cs.AI via API) | 1 (alphaXiv) | 0 |
| News & discussion | 4 (HN x2, Reddit x2) | 2 (HN) | 2 (Reddit via one multireddit `.rss`) | 0 | 0 |
| Labs | 11 | 6 | 5 (Anthropic, Meta, Allen AI, Mistral, Transformer Circuits) | 1 extra (ai.meta.com/blog) | 0 |
| Deep technical blogs | 21 | 16 | 5 (SemiAnalysis, The Batch, Epoch, Jay Alammar, Horace He) | 0 | 1 (AI News / smol.ai: feed stale since 2026-09-09; the same issues arrive through the Latent Space feed, see B13) |
| Open source & releases | 12 (8 release feeds, 3 searches, HF trending) | 12 | 0 | 0 | 0 |
| Podcasts | 5 | 5 resolved | 1 swap (Latent Space podcast feed is 14 MB; use publication feed) | 0 | 0 |
| YouTube | 6 | 6 resolved | 0 | 0 | 0 |
| Leaderboards | 8 | 8 reachable (LMArena is behind a bot challenge; fine in a browser) | 0 | 8 by design | 0 |
| Learn | 16 links | 16 | 0 | 16 by design | 0 |

One brief source is dropped as a fetched source (smol.ai, replaced by the same content inside the Latent Space feed). Two brief URLs need a new source *type* (`sitemap`) because the publisher has no feed: Anthropic and The Batch. Everything else is RSS/Atom/JSON as expected.

Cross-cutting findings that shape the design:

1. **Reddit allows exactly one unauthenticated request per minute per client** (`x-ratelimit-remaining: 0.0`, `x-ratelimit-reset: 3..47` on every 200; the second request within the window is a 429, even 6 s apart). `top.json` is 403 regardless (HTML bot wall), `old.reddit.com` redirects to a login page, `api.reddit.com` is 403. The Atom endpoint works. Fix: a single multireddit request per run, `https://www.reddit.com/r/LocalLLaMA+MachineLearning/top/.rss?t=day&limit=50` (200 in both passes, 50 entries). Reddit Atom carries no score/comment counts. Never retry a Reddit 429 inside a run.
2. **Feeds can be large**: OpenAI 791 KB / 1,299 items, arXiv cs.LG 826 KB / 391 items, SemiAnalysis newsletter 3.15 MB, Raschka 2.7 MB, Zvi 2.0 MB, NVIDIA 758 KB, Cognitive Revolution 4.45 MB, MLST 2.1 MB, Latent Space *podcast* feed 13.95 MB (decompressed; replaced). The HTTP layer needs a body cap (design: 8 MB) and per-source item caps.
3. **Content-Type is unreliable**: Mistral serves RSS as `text/plain`, Substack as `application/xml`, Google as `text/xml`, GitHub as `application/atom+xml`, YouTube as `text/xml`. Sniff the body (`<rss`, `<feed`, `<urlset`, `{`/`[`), never trust the header.
4. **arXiv RSS quirks**: all items in a feed share one `pubDate` (the announcement date, `Mon, 19 Oct 2026 00:00:00 -0400`); `<arxiv:announce_type>` is `new | cross | replace | replace-cross` (cs.LG today: 126/96/87/82) and `replace*` must be dropped; the description starts with `arXiv:2610.22379v1 Announce Type: new \nAbstract: `; `dc:creator` holds authors; each item has one or more `<category>` elements (first = primary, e.g. `cs.LG`); the feed publishes nothing on Saturday/Sunday (`<skipDays>`). cs.AI returned a valid but empty feed three times today (892 bytes, 05:57Z, 06:02Z, 14:06Z); the API query for `cat:cs.AI` returned 100 entries, so the API is the fallback.
5. **GitHub `releases.atom` is polluted on big repos**: pytorch/pytorch's 10 entries are all `viable/strict/<n>` auto-tags, torchtitan's are `ciflow/rl/<n>`. Real releases have slash-free tags (`v0.32.1rc0`, `v5.20.1`, `b11730`, `v0.1.908-beta`). Filter: drop entries whose tag (from the `/releases/tag/<tag>` link, URL-decoded) contains `/`.
6. **GitHub search API unauthenticated limit is 10 requests/min** (`x-ratelimit-limit: 10`; pass 2 saw remaining 9, 8, 7 across the three searches). Three searches per run fit. `GITHUB_TOKEN` in Actions raises it to 30.
7. **Substack publication feeds include podcast episodes** as items with `<enclosure type="audio/mpeg">` (Latent Space 4/20, Interconnects 2/20, Dwarkesh 16/20). The pipeline routes audio-enclosure items to the Podcasts & Video category instead of fetching separate multi-MB podcast feeds.
8. Several brief URLs **redirect**: openai.com/blog/rss.xml -> /news/rss.xml; semianalysis.com/feed -> semianalysis.com/feed/ (stale, see below); lmarena.ai -> arena.ai; scale.com/leaderboard -> labs.scale.com/leaderboard; epoch.ai/data/ai-benchmarking-dashboard -> epoch.ai/benchmarks. Follow redirects (fetch default) and store the final URL where relevant.
9. **Algolia's `front_page` hits are sorted by points, not by HN position** (pass 2, N2/N7 below). The true rank is available from `https://hacker-news.firebaseio.com/v0/topstories.json` (500 ids in current order; 4.5 KB; no auth): all 30 front-page hits were found within its first 30 ids when both were fetched in the same minute.
10. **Sitemaps have `lastmod` gaps**: 30 of 566 Anthropic URLs and 291 of 3,400 deeplearning.ai URLs have no `<lastmod>` (index/landing pages such as `/`, `/the-batch/about`). Those must be skipped rather than treated as new.

---

## Research

| # | Source | URL probed | Type | Result | Shape / notes |
|---|---|---|---|---|---|
| R1 | arXiv cs.LG | `https://rss.arxiv.org/rss/cs.LG` | arxiv (RSS 2.0) | **OK** 200, `application/rss+xml`, 826,171 B (both passes) | 391 `<item>`; ns `arxiv, dc, content, atom`; `<title>`, `<link>https://arxiv.org/abs/2610.22379</link>`, `<description>arXiv:2610.22379v1 Announce Type: new \nAbstract: ...`, `<guid>`, `<dc:creator>`, `<category>cs.LG</category><category>cs.AI</category>`, `<pubDate>Mon, 19 Oct 2026 00:00:00 -0400</pubDate>` (same for every item), `<arxiv:announce_type>new|cross|replace|replace-cross` (126/96/87/82). |
| R2 | arXiv cs.CL | `https://rss.arxiv.org/rss/cs.CL` | arxiv | **OK** 200, 470,458 B | 226 items, same shape. |
| R3 | arXiv cs.AI | `https://rss.arxiv.org/rss/cs.AI` | arxiv | **OK-but-EMPTY** 200, 892 B (three times today) | Valid channel, zero items, `<skipDays>Saturday, Sunday`. 0 items triggers the API fallback (R6 with `cat:cs.AI` returned 100 entries in pass 2). |
| R4 | arXiv cs.CV | `https://rss.arxiv.org/rss/cs.CV` | arxiv | **OK** 200, 441,299 B | 201 items. |
| R5 | arXiv Atom variant | `https://rss.arxiv.org/atom/cs.LG` | arxiv (Atom) | **OK** 200, `application/atom+xml` | 391 entries, `<updated>2026-10-19T04:00:34.682296+00:00</updated>`. Not needed; RSS is used. |
| R6 | arXiv API | `https://export.arxiv.org/api/query?search_query=cat:cs.LG&sortBy=submittedDate&sortOrder=descending&max_results=100` (http 301s to https) | arxiv (Atom) | **OK** 200, `application/atom+xml`, 235-252 KB per category; all four categories 200 in pass 2 paced 3 s apart | 100 `<entry>`: `<id>http://arxiv.org/abs/2610.23847v1</id>`, `<title>`, `<summary>`, `<published>2026-10-16T17:58:08Z</published>`, `<updated>`, `<author><name>`, `<link rel="alternate" href="https://arxiv.org/abs/2610.23847v1">`, `<link title="pdf">`, `<arxiv:primary_category term="cs.LG">`. Combined `cat:cs.LG+OR+cat:cs.CL+OR+cat:cs.AI+OR+cat:cs.CV&max_results=200` also works (200 entries, 485 KB). Use https. Keep >= 3 s between arXiv API calls (arXiv ToS); the design enforces this in `http.js` for every request to the host. |
| R7 | HF daily papers | `https://huggingface.co/api/daily_papers` | json | **OK** 200, `application/json`, 294,947 B; `?limit=100` -> 100 papers, 588,894 B (pass 2) | Array. Element: `{ paper: { id: "2610.22306", authors[{name}], publishedAt, submittedOnDailyAt, title, summary (700-1900 chars), upvotes, discussionId, projectPage?, githubRepo?, githubStars?, ai_summary?, ai_keywords? }, publishedAt, title, summary, thumbnail, numComments, submittedBy, isAuthorParticipating }`. Top upvotes today: 187, 153, 116, 114, 88. `?date=2026-10-16` (Fri) -> 50; `?date=2026-10-17` (Sat) -> 0 (no weekend editions). |
| R8 | alphaXiv | `https://www.alphaxiv.org/` | html | **LINK-OUT** 200 HTML (Next.js), no `<link rel=alternate>` | `https://api.alphaxiv.org/v2/papers/trending-papers?...` 404, `/api/trending` 404, `/feed` redirects to home. No public JSON. Link-out as the brief allows: `https://www.alphaxiv.org/explore`. |

## News & discussion

| # | Source | URL probed | Type | Result | Shape / notes |
|---|---|---|---|---|---|
| N1 | HN by date | `https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points>30,created_at_i>1792326412&hitsPerPage=100` | hn | **OK** 200, `application/json`, 43,572 B (pass 2: 43 hits, 43,883 B) | `{ nbHits: 42, hits: [{ objectID, title, url, points, num_comments, author, created_at, created_at_i, story_id, _tags[] }] }`. `url` may be absent for Ask/Show HN text posts (link to `https://news.ycombinator.com/item?id=<objectID>` then). Keyword test over titles: 9 of 42 AI-related. Beware broad words: "agent" alone matched "ICE agent", so `agent`/`model` only count inside phrases ("AI agent", "open-weight model"); upper-case `AI` alone is a reliable match. |
| N2 | HN front page | `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50` | hn | **OK** 200, 29,764 B (pass 2: 29,960 B) | `nbHits: 30`, same hit shape. **Correction (pass 2): hits are sorted by points descending (499, 455, 448, 422, 421, ...), which is Algolia's default for an empty query; they are NOT in HN front-page order.** The pass-1 note claiming "position = #n on HN" was wrong. In pass 2 the top-points hit was HN #19 and HN #1 (a non-AI Flock/ICE story, 50150750) was the 4th hit. Sample: 455 pts / 215 comments "Hybrid Reasoning Agents..." -> `https://arxiv.org/abs/2610.18861` (cross-source with arXiv/HF Papers), HN rank 10. |
| N7 | **HN topstories (rank source)** | `https://hacker-news.firebaseio.com/v0/topstories.json` | hn (json) | **OK** 200, `application/json`, 4,501 B, ~700 ms | Array of 500 integer story ids in current HN order. Fetched in the same minute as N2: all 30 `front_page` hits were present within the first 30 ids (ranks 19,10,14,1,22,3,20,29,16,15,4,27,21,30,28,25,18,23,24,17,13,6,8,5,9,2,12,7,26,11 in Algolia hit order). Design: the `hn-front` parser issues this one extra request and sets `extra.hnRank = indexOf(objectID) + 1` when found within the first 30; if the request fails, items carry no rank and the why-line says "on HN front page" instead. Both files are committed as the fixture pair `hn-algolia-front.json` / `hn-topstories.json`. |
| N3 | r/LocalLLaMA JSON | `https://www.reddit.com/r/LocalLLaMA/top.json?t=day&limit=50` | reddit | **FAIL** 403, HTML bot wall (189 KB), `retry-after: 0` | Same for r/MachineLearning. `https://old.reddit.com/...top.json` -> 200 but redirected to `/login/?reason=lor2` HTML. `https://api.reddit.com/r/LocalLLaMA/top?t=day` -> 403. |
| N4 | r/LocalLLaMA RSS | `https://www.reddit.com/r/LocalLLaMA/top/.rss?t=day` | reddit (Atom) | **OK** 200, `application/atom+xml`, 97,550 B | 25 entries: `<author><name>/u/..`, `<category term="LocalLLaMA" label="r/LocalLLaMA"/>`, `<content type="html">` (escaped HTML: thumbnail table + self text + `[link]`/`[comments]`), `<id>t3_...`, `<link href="https://www.reddit.com/r/LocalLLaMA/comments/...">`, `<updated>`, `<published>`, `<title>`. No score, no comment count. Headers: `x-ratelimit-remaining: 0.0`, `x-ratelimit-reset: 47`, `cache-control: private, max-age=3600`. |
| N5 | r/MachineLearning RSS | `https://www.reddit.com/r/MachineLearning/top/.rss?t=day` | reddit | **429** when requested within 60 s of N4 (also 429 with 6 s pacing); **200** with 12 entries when it was the first request of a minute | Confirms a 1 request/min budget. |
| N6 | **ALT: multireddit** | `https://www.reddit.com/r/LocalLLaMA+MachineLearning/top/.rss?t=day&limit=50` | reddit | **OK** 200, 179,542 B (pass 2: 197,935 B, 50 entries, `x-ratelimit-remaining: 0.0`, reset 3 s) | 50 entries (38 LocalLLaMA, 12 MachineLearning), subreddit in `<category term>`. `[link]` hrefs: external hosts (huggingface.co, GitHub, blogs) for link posts; `i.redd.it`, `preview.redd.it`, `www.reddit.com/gallery/...` or the comments permalink for self/media posts, so the "is this Reddit-hosted" rule must match subdomains. One request covers both subs. Reddit may still 403/429 from GitHub Actions IPs; the source must fail soft (meta.json `failed`, 0 items). |

## Labs

| # | Source | URL probed | Type | Result | Shape / notes |
|---|---|---|---|---|---|
| L1 | OpenAI | `https://openai.com/news/rss.xml` | rss | **OK** 200, `text/xml`, 791,461 B | 1,299 items (whole archive); 12 in the last 7 days; `<title><![CDATA[...]]>`, `<description><![CDATA[one sentence]]>`, `<link>https://openai.com/index/<slug>`, `<guid isPermaLink="true">`, `<pubDate>Fri, 16 Oct 2026 19:00:00 GMT</pubDate>`. `https://openai.com/blog/rss.xml` 301s here. Mixed content (customer stories + research + product); weight should be moderate, HN cross-source lifts the important ones. |
| L2 | Anthropic | `https://www.anthropic.com/rss.xml` | rss | **FAIL** 404 (HTML "Not Found") | Also 404: `/news/rss.xml`, `/feed.xml`, `/news/feed`, `/rss`, `/research/rss.xml`; `alignment.anthropic.com/{feed,rss,atom,index}.xml` 404; `rsshub.app/anthropic/news` 403 (Cloudflare). |
| L2a | **ALT: Anthropic sitemap** | `https://www.anthropic.com/sitemap.xml` | **sitemap** (new type) | **OK** 200, 72,650 B (both passes) | `<urlset>` with 566 `<url>`; 469 match `/(news|research|engineering)/<slug>`; **30 URLs have no `<lastmod>`** (skip them); 15 article URLs changed in the 7 days before 2026-10-19T12:00Z, e.g. `/news/public-benefit-fund` 2026-10-18T18:05:05Z, `/research/ai-expectations-gap` 2026-10-17, `/engineering/redesigning-source-control` 2026-10-15. Article page (pass 2, 107 KB, 966 ms, `<head>` 5.3 KB): `og:title` "Investing in the public benefit", `og:description`, `og:type article`, `article:published_time 2026-10-18T16:49:35.513Z`, `article:modified_time 2026-10-18T18:05:05.000Z` (= sitemap lastmod, so lastmod is the edit time, not the publish time). The `/news` HTML list is also parseable but class names are build-hashed, so the sitemap is the stable choice. |
| L3 | Google DeepMind | `https://deepmind.google/blog/rss.xml` | rss | **OK** 200, `application/xml`, 68,646 B | 100 items, single-line XML; `<title>`, `<link>`, `<description>` (one sentence), `<pubDate>Thu, 15 Oct 2026 16:08:03 +0000`, `<guid>`, `media:thumbnail`, `media:content`. |
| L4 | Google Research | `https://research.google/blog/rss/` | rss | **OK** 200, `application/rss+xml`, 78,400 B | 100 items, latest 2026-10-16. The old Blogspot/FeedBurner feeds (`blog.research.google/feeds/posts/default?alt=rss`, `feeds.feedburner.com/blogspot/gJZg`) still answer 200 but stopped in 2024-03; do not use. |
| L5 | Meta AI blog | `https://ai.meta.com/blog/rss/` | rss | **FAIL** 404 ("Meta AI - Error") | Also 404: `/blog/feed/`, `/blog/rss.xml`, `/feed/`, `/blog/feed.xml`, `ai.meta.com/sitemap.xml`. `ai.meta.com/blog/` is a 206 KB JS app with 10 post links and loose date strings; not scrapable reliably. |
| L5a | **ALT: Meta Newsroom AI** | `https://about.fb.com/news/tag/ai/feed/` | rss | **OK** 200, `application/rss+xml`, 148,160 B | 10 items, latest 2026-10-12 "Introducing Muse Wonder and Muse Wonder Full: Frontier Models for Agents"; WordPress RSS with `content:encoded`, CDATA. |
| L5b | **ALT: Engineering at Meta, AI research** | `https://engineering.fb.com/category/ai-research/feed/` | rss | **OK** 200, 9 items | Latest 2026-09-02. WordPress RSS. `research.facebook.com/feed/` answers 200 but last item is 2023-05 (dead). Keep `https://ai.meta.com/blog/` as a link-out in the Labs panel. |
| L6 | Microsoft Research | `https://www.microsoft.com/en-us/research/feed/` | rss | **OK** 200, `application/rss+xml` | 10 items, latest 2026-10-15; `content:encoded`, CDATA, `dc:creator`. `/research/blog/feed/` is identical. |
| L7 | NVIDIA technical blog | `https://developer.nvidia.com/blog/feed` | atom | **OK** 200, `application/atom+xml`, 757,706 B | 100 entries (with/without trailing slash), CDATA titles/content, `<updated>2026-10-16T16:46:50Z`. (`blogs.nvidia.com/feed/`, the corporate blog, also works: 18 items; not used.) |
| L8 | Hugging Face blog | `https://huggingface.co/blog/feed.xml` | rss | **OK** 200, `application/rss+xml`, 260,123 B | 881 items (archive), 8 in last 7 days; items have only `<title>`, `<pubDate>`, `<link>`, `<guid>`; **no description** (summary empty). |
| L9 | Allen AI (Ai2) | `https://allenai.org/blog/rss.xml` | rss | **FAIL** 404 | `medium.com/feed/ai2-blog` 200 but last post 2024-11-07 "We're moving our blog!"; `blog.allenai.org/feed` 404. |
| L9a | **ALT: Ai2 RSS** | `https://allenai.org/rss.xml` | rss | **OK** 200, 25 items | Discovered via `<link rel="alternate" type="application/rss+xml">` on `allenai.org/blog` (which redirects to `/research`). Latest 2026-10-14; `<pubDate>2026-10-14T00:00:00-08:00` (ISO, not RFC 822), description is CDATA HTML with an `<img>` (strip tags). |
| L10 | Mistral | `https://mistral.ai/news/rss.xml` | rss | **FAIL** 404 (also `/feed.xml`) | Page HTML advertises `<link rel=alternate href="https://mistral.ai/news/rss">`. |
| L10a | **ALT: Mistral news RSS** | `https://mistral.ai/news/rss` | rss | **OK** 200, **`text/plain`**, 26,029 B | 90 items, latest 2026-10-15 "Introducing Timestral"; minimal RSS (`title, link, guid, description?, pubDate`), 62 of 90 items have no description. `https://mistral.ai/rss.xml` 302s here. |
| L11 | Transformer Circuits | `https://transformer-circuits.pub/` | html | page 200; `<link rel=alternate href="/feed.xml">` | `/rss.xml` and `/atom.xml` return **403**. |
| L11a | **ALT: Transformer Circuits Atom** | `https://transformer-circuits.pub/feed.xml` | atom | **OK** 200, `application/atom+xml`, 25,516 B | 56 entries: `<title>`, `<link href>`, `<id>`, `<updated>2026-08-21T00:00:00+00:00`, `<summary>` (one sentence), `<category term="note"|"paper">`. Low cadence (latest Aug 2026). |

## Deep technical blogs

| # | Source | URL probed | Type | Result | Shape / notes |
|---|---|---|---|---|---|
| B1 | Lil'Log | `https://lilianweng.github.io/index.xml` | rss | **OK** 200, 53 items | Hugo RSS; latest 2026-07-04 "Harness Engineering for Self-Improvement". Low cadence, very long posts (deep-read candidate). |
| B2 | Interconnects | `https://www.interconnects.ai/feed` | rss | **OK** 200, 20 items, 538 KB | Substack: `<title><![CDATA[`, `<description>` = subtitle (~25 chars), `<dc:creator>`, `<enclosure>` (image/jpeg; `audio/mpeg` on the 2 podcast posts, items 3 and 17 of 20), `<content:encoded>` full HTML (up to 32 KB), `itunes` ns. Latest 2026-10-17. |
| B3 | Ahead of AI (Raschka) | `https://magazine.sebastianraschka.com/feed` | rss | **OK** 200, 20 items, 2.7 MB | Substack; latest 2026-09-29. |
| B4 | Simon Willison | `https://simonwillison.net/atom/everything/` | atom | **OK** 200, 30 entries | `<summary type="html">` escaped HTML, `<published>`, `<updated>`; latest 2026-10-18; many short link posts per day (cap 10/run, lower weight). |
| B5 | Chip Huyen | `https://huyenchip.com/feed.xml` | rss | **OK** 200, 10 items | Latest 2025-01-16 (quiet). Links have a doubled slash `https://huyenchip.com//2025/...` -> canonicalizer must collapse `//` in paths. |
| B6 | Eugene Yan | `https://eugeneyan.com/rss/` | rss | **OK** 200, 212 items, 104,927 B | Latest 2026-06-21; same `//` path quirk. |
| B7 | Hamel Husain | `https://hamel.dev/index.xml` | rss | **OK** 200, 20 items | Quarto RSS, CDATA, `media` ns; latest 2026-09-30. |
| B8 | SemiAnalysis | `https://www.semianalysis.com/feed` | rss | **STALE** 200 (301 -> `https://semianalysis.com/feed/`), 10 items, latest 2025-09-16 | Site moved back to Substack. |
| B8a | **ALT: SemiAnalysis newsletter** | `https://newsletter.semianalysis.com/feed` | rss | **OK** 200, 20 items, 3.15 MB | Latest 2026-10-19 "Datacenters 2027: The Year of Acceleration". Substack shape. Largest blog feed; within the 8 MB cap. |
| B9 | Import AI | `https://importai.substack.com/feed` | rss | **OK** 200, 20 items | Latest 2026-10-19 (pass 2; "Import AI 476" on 10-12 in pass 1). (`jack-clark.net/feed/` mirrors the same posts; not needed.) |
| B10 | Latent Space | `https://www.latent.space/feed` | rss | **OK** 200, 20 items, 913 KB | Latest 2026-10-17; 4/20 items have `<enclosure type="audio/mpeg">` = podcast episodes (see P3). **11 of 20 items are `[AINews] ...` posts**: the daily swyx AI News issues now publish here (see B13). |
| B11 | Don't Worry About the Vase (Zvi) | `https://thezvi.substack.com/feed` | rss | **OK** 200, 20 items, 2.0 MB | Latest 2026-10-19. Very long posts (deep-read candidate). WordPress mirror `thezvi.wordpress.com/feed/` also 200. |
| B12 | The Batch | `https://www.deeplearning.ai/the-batch/feed/` | rss | **FAIL** 404 | Also 404: `/the-batch/rss.xml`, `/feed/`, `/the-batch/feed.xml`, `/rss.xml`. No `<link rel=alternate>` on the page. |
| B12a | **ALT: deeplearning.ai sitemap** | `https://www.deeplearning.ai/sitemap.xml` | **sitemap** | **OK** 200, `application/xml`, 489,002 B, 3,400 `<url>` (pass 2 capture, `%TEMP%\ahead-probe\raw\reprobe-thebatch.xml`) | 2,729 URLs of the shape `/the-batch/<x>`: 2,355 articles with `<lastmod>` (`2026-10-14T12:17:00.000-07:00` format), 373 `/the-batch/issue-NNN` weekly wrappers (duplicate the articles; exclude), 1 `/the-batch/about` (no lastmod; skip); 381 `/the-batch/tag/<x>` pages (two path segments, fail the include regex). 291 of 3,400 URLs have no lastmod (home, `/courses`, `/about`, ...). 9 articles changed in the 14 days before 2026-10-19; 2 within 7 days of 2026-10-19T12:00Z (`metas-muse-wonder-rivals-top-models` 10-14, `anthropic-gives-claude-haiku-a-big-update` 10-12). Article page (pass 2, 179 KB, 407 ms, `<head>` 9.1 KB): `og:title` "Data Points: Meta's Muse Wonder rivals top models", `og:description`, `og:url`, `og:type article`, `article:published_time 2026-10-14T12:17:00.000-07:00` (= lastmod). Filter: `/the-batch/<slug>` only; exclude `/the-batch/(tag|issue-\d+)`. |
| B13 | AI News (swyx / smol.ai) | `https://news.smol.ai/rss.xml` | rss | **OK-but-STALE -> DROP** 200, 2,253,193 B, 716 items (both passes) | Only `<content:encoded>` (no description); newest item still 2026-09-09 "not much happened today" in pass 2, oldest 2023-12. The issues since then are published on `latent.space` as `[AINews] ...` posts (11 of the 20 current Latent Space items), which the `latentspace` source already fetches. Decision: not a fetched source; it would be a 2.25 MB download four times a day for zero items. `feed.xml` 404; `buttondown.com/ainews/rss` last item 2025-04 ("We have moved"). The trimmed fixture `smol-ainews.xml` stays as a parser edge case (content:encoded-only items). |
| B14 | One Useful Thing | `https://www.oneusefulthing.org/feed` | rss | **OK** 200, 20 items | Latest 2026-10-01. |
| B15 | The Gradient | `https://thegradient.pub/rss/` | rss | **OK** 200, `text/xml`, 15 items | Ghost RSS; latest 2026-02-18 (slow). |
| B16 | Epoch AI | `https://epoch.ai/rss.xml` | rss | **FAIL** 404 (also `/feed.xml`, `/feed`) | Page `epoch.ai/blog` (-> `/latest`) advertises `<link rel=alternate href="/atom.xml">`. |
| B16a | **ALT: Epoch AI Atom** | `https://epoch.ai/atom.xml` | atom | **OK** 200, 50 entries | `<title type="html"><![CDATA[`, `<summary type="html">`, several `<author>`, `<category term>`, `<published>2026-10-16T00:00:00.000Z`. Covers data insights, blog, gradient updates. (`epochai.substack.com/feed` also 200, 20 items, latest 2026-10-09; second source "Gradient Updates", same `family`.) |
| B17 | Alignment Forum | `https://www.alignmentforum.org/feed.xml` | rss | **OK** 200, 10 items, 773 KB | Latest 2026-10-18; descriptions are the full post as HTML inside CDATA (hundreds of KB). |
| B18 | ChinAI | `https://chinai.substack.com/feed` | rss | **OK** 200, 20 items | Latest 2026-10-19. |
| B19 | Jay Alammar | `https://jalammar.github.io/feed.xml` | atom | **STALE** 200, 10 entries, last 2025-03-26 "Moving To Substack" | |
| B19a | **ALT: Language Models newsletter** | `https://newsletter.languagemodels.co/feed` | rss | **OK** 200, 11 items | Latest 2025-11-03 "Inside NeurIPS 2025". Substack shape. |
| B20 | Andrej Karpathy blog | `https://karpathy.github.io/feed.xml` | rss | **OK** 200, 10 items | Latest post 2026-02-12 "microgpt" (feed-level `updated` 2026-04-10). |
| B20a | Karpathy bearblog (second blog) | `https://karpathy.bearblog.dev/feed/` | atom | **OK** 200, 10 entries | Latest post 2026-04-30. Use both Karpathy feeds (distinct URLs, same `family`). |
| B21 | Horace He | `https://horace.io/` | html | **FAIL** no feed: `/feed.xml`, `/rss.xml`, `/index.xml` 404 (GitHub Pages), no `<link rel=alternate>` | |
| B21a | **ALT: Thonking AI (Horace He's Substack)** | `https://www.thonking.ai/feed` | rss | **OK** 200, 6 items | Latest 2025-03-04. Low weight; keep `horace.io` as the source homepage. |

## Open source & releases

| # | Source | URL probed | Type | Result | Shape / notes |
|---|---|---|---|---|---|
| O1 | pytorch/pytorch releases | `https://github.com/pytorch/pytorch/releases.atom` | github (Atom) | **OK** 200, 10 entries | **All 10 are `viable/strict/<n>` auto-tags** (`<link href=".../releases/tag/viable%2Fstrict%2F1792407148">`). Real releases are rare; the slash filter leaves 0 items most runs, which is correct. |
| O2 | vllm-project/vllm | `.../vllm-project/vllm/releases.atom` | github | **OK** 200, 745 KB | `v0.32.1rc0` 2026-10-18; release notes as `<content type="html">` (hundreds of KB). |
| O3 | huggingface/transformers | `.../huggingface/transformers/releases.atom` | github | **OK** 200, 1.4 MB | "Release v5.20.1" 2026-10-16. |
| O4 | ggml-org/llama.cpp | `.../ggml-org/llama.cpp/releases.atom` | github | **OK** 200 | Build tags `b11730` several per day; title "b11730: cuda: cap MMQ ...". Cap 3/run, low weight. |
| O5 | sgl-project/sglang | `.../sgl-project/sglang/releases.atom` | github | **OK** 200, 1.43 MB, 3.0 s | `v0.5.22` 2026-10-19. |
| O6 | unslothai/unsloth | `.../unslothai/unsloth/releases.atom` | github | **OK** 200, 1.96 MB | Title is prose ("Meta Muse Spark Open + NVIDIA Nemotron 3.5"), tag in link `v0.1.908-beta`. |
| O7 | huggingface/trl | `.../huggingface/trl/releases.atom` | github | **OK** 200 | `v1.16.0` 2026-10-16. |
| O8 | pytorch/torchtitan | `.../pytorch/torchtitan/releases.atom` | github | **OK** 200 | All entries `ciflow/rl/<n>` auto-tags -> filtered out. |
| O9 | GitHub search topic:llm | `https://api.github.com/search/repositories?q=topic:llm+created:>2026-10-12&sort=stars&order=desc&per_page=30` | github (JSON) | **OK** 200, 170,620 B | `{ total_count: 12173, incomplete_results: false, items: [{ full_name, html_url, description, stargazers_count, created_at, pushed_at, topics[], language, ... }] }`; stars 947, 826, 415, 176, 105, 96, 78, 73, 65, 59, 55, 46, ... 14. Headers `x-ratelimit-limit: 10`, `x-ratelimit-remaining: 9` (unauthenticated). |
| O10 | topic:machine-learning | same with `topic:machine-learning` | github | **OK** 200 | `total_count: 2219`; stars 24, 22, 20, 12, 11, 7, ... -> apply a floor (`minStars: 50`) so noise does not enter; this source legitimately reports `empty` most weeks. |
| O11 | topic:ai-agents | same with `topic:ai-agents` | github | **OK** 200 | `total_count: 11450`; top 2,379 and 1,168 stars. |
| O12 | HF trending models | `https://huggingface.co/api/models?sort=trendingScore&limit=20` | json | **OK** 200, 10,765 B | Array[20] `{ _id, id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", modelId, likes, trendingScore: 1422, downloads, tags[], pipeline_tag, library_name, createdAt }`. The `trendingScore` param is valid. Fallback `?sort=downloads&direction=-1&limit=20` works but returns all-time leaders (all-MiniLM-L6-v2); only use with a `createdAt` filter. Undocumented `https://huggingface.co/api/trending?type=model&limit=20` also 200 (`{ recentlyTrending: [{ repoData... }] }`), not used. |

## Podcasts (feeds resolved with the iTunes Search API, `https://itunes.apple.com/search?media=podcast&term=...`, then fetched)

| # | Show | Resolved feed | Result | Notes |
|---|---|---|---|---|
| P1 | Dwarkesh Podcast | iTunes id 1516093381 -> `https://apple.dwarkesh-podcast.workers.dev/feed.rss` (200, 142 items) and the equivalent Substack podcast feed **`https://api.substack.com/feed/podcast/69345.rss`** (200, 142 items, 576 KB, identical episodes/links to `https://www.dwarkesh.com/p/<slug>`) | **OK** | Use the Substack URL (the workers.dev proxy looks custom and could vanish). Latest 2026-10-01. |
| P2 | Machine Learning Street Talk | iTunes id 1510472996 -> **`https://anchor.fm/s/1e4a0eac/podcast/rss`** | **OK** 200, 271 items, 2.1 MB | CDATA HTML descriptions, `itunes:*`, `<enclosure>`. Latest 2026-10-10. |
| P3 | Latent Space podcast | iTunes id 1674008350 -> `https://api.substack.com/feed/podcast/1084089.rss` | **OK but 13.95 MB** (235 items, full show notes) | Replace with the publication feed `https://www.latent.space/feed` (B10): episodes are the items with `audio/mpeg` enclosures and link to the same `latent.space/p/<slug>` pages. No separate podcast source. |
| P4 | The Cognitive Revolution | iTunes id 1669813431 -> **`https://feeds.megaphone.fm/RINTP3108857801`** | **OK** 200, 387 items, 4.45 MB | Plain-text `<description>` (summary + sponsor blurbs; cut at "Sponsors:"), `<link>` to cognitiverevolution.ai, `itunes:duration`. Latest 2026-10-17. Largest feed in the registry; within the 8 MB cap. |
| P5 | No Priors | iTunes id 1668002688 -> **`https://feeds.megaphone.fm/nopriors`** | **OK** 200, 183 items, 1.07 MB | Megaphone RSS, latest 2026-10-15. |

## YouTube (channel ids read from `"externalId"` in each handle page, then feeds fetched)

| # | Channel | Handle page | Channel id | Feed `https://www.youtube.com/feeds/videos.xml?channel_id=...` | Latest upload |
|---|---|---|---|---|---|
| Y1 | Andrej Karpathy | `https://www.youtube.com/@AndrejKarpathy` 200 | `UCXUPKJO5MZQN11PqgIvyuvQ` | **OK** 200, 15 entries (`text/xml`) | 2025-02-27 "How I use LLMs" (rare uploads) |
| Y2 | Yannic Kilcher | `@YannicKilcher` 200 | `UCZHmQk67mSJgfCCTn7xBfew` | **OK** 200, 15 | 2026-03-06 |
| Y3 | AI Explained | `@aiexplained-official` 200 | `UCNJ1Ymd5yFuUPtn21xtRbbw` | **OK** 200, 15 | 2026-10-12 |
| Y4 | GPU MODE | `@GPUMODE` 200 | `UCJgIbYl6C5no72a0NUAPcTA` | **OK** 200, 15 | 2026-10-17 "GSQ-RCO: Better Non-Uniform GGUF Quantization" |
| Y5 | Stanford Online | `@stanfordonline` 200 | `UCBa5G_ESCn8Yd4vw5U-gIcg` | **OK** 200, 15 | 2026-10-18 (re-uploads of old lectures; low weight) |
| Y6 | 3Blue1Brown | `@3blue1brown` 200 | `UCYO_jab_esuFRV4b17AJtAw` | **OK** 200, 15 | 2026-10-16 |

Entry shape: `<yt:videoId>`, `<yt:channelId>`, `<title>`, `<link rel="alternate" href="https://www.youtube.com/watch?v=ID">`, `<author><name>`, `<published>`, `<updated>` (changes with edits; use `published`), `<media:group>` with `<media:title>`, `<media:thumbnail>`, `<media:description>` (full description), `<media:community><media:starRating .../><media:statistics views="N"/>`. Views are available as an engagement signal.

## Leaderboards (link-out panel; probed only for reachability)

| # | Name | URL in brief | Result | Use this URL |
|---|---|---|---|---|
| LB1 | LMArena | `https://lmarena.ai/leaderboard` | 301 -> `https://arena.ai/leaderboard` -> **403 Cloudflare "Just a moment"** for non-browser clients; loads in a browser | `https://arena.ai/leaderboard` |
| LB2 | Artificial Analysis | `https://artificialanalysis.ai/` | 200 | as is |
| LB3 | Scale SEAL | `https://scale.com/leaderboard` | 200 via 301 -> `https://labs.scale.com/leaderboard` | `https://labs.scale.com/leaderboard` |
| LB4 | LiveBench | `https://livebench.ai/` | 200 ("LiveBench 2.0") | as is |
| LB5 | SWE-bench | `https://www.swebench.com/` | 200 | as is |
| LB6 | Epoch AI benchmarks | `https://epoch.ai/data/ai-benchmarking-dashboard` | 200 via 301 -> `https://epoch.ai/benchmarks` | `https://epoch.ai/benchmarks` |
| LB7 | HF Open LLM Leaderboard | `https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard` | 200 (archived board, still hosted) | as is |
| LB8 | Papers with Code (HF revival) | `https://paperswithcode.co/` | 200 "Papers with Code — Trending research and open source" | as is; `https://huggingface.co/papers/trending` (200) as a second link |

## Learn (static link-outs; all 200)

Courses/books: `https://stanford-cs336.github.io/spring2025/`, `https://web.stanford.edu/class/cs224n/`, `https://cs231n.stanford.edu/`, `https://rail.eecs.berkeley.edu/deeprlcourse/`, `https://github.com/rasbt/LLMs-from-scratch`, `https://udlbook.github.io/udlbook/`, `https://huggingface.co/learn`, `https://karpathy.ai/zero-to-hero.html`.
Papers (arXiv abs pages): Attention Is All You Need `1706.03762`, GPT-3 `2005.14165`, InstructGPT `2203.02155`, Chinchilla `2203.15556`, LLaMA `2302.13971`, DeepSeek-V3 `2412.19437`, DeepSeek-R1 `2501.12948`, Constitutional AI `2212.08073`.

## LLM provider endpoints (optional editorial layer; probed for existence only, no key)

`POST {base}/chat/completions` with `authorization: Bearer invalid` and a minimal body. A 401/400 "bad key" proves the OpenAI-compatible path exists and the Bearer header reaches the auth layer; a 404 would have meant the path is wrong.

| Provider | `LLM_BASE_URL` | Result |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | 401 `{"error":{"message":"Incorrect API key provided: invalid...","type":"invalid_request_error"}}` |
| Anthropic (OpenAI-compatible) | `https://api.anthropic.com/v1` | 401 `{"error":{"code":"authentication_error","message":"Invalid Anthropic API Key","type":"invalid_request_error"}}` |
| Groq | `https://api.groq.com/openai/v1` | 401 `{"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}` |
| Gemini (OpenAI-compatible) | `https://generativelanguage.googleapis.com/v1beta/openai` | 400 `{"error":{"code":400,"message":"Please pass a valid API key","status":"INVALID_ARGUMENT"}}` |
| OpenRouter | `https://openrouter.ai/api/v1` | 401 `{"error":{"message":"Missing Authentication header","code":401}}` (OpenRouter did not read the invalid Bearer, but the path exists) |

Model ids were not verified (they need a key and change often); the README tells the user to pick any current model id from the provider's model list and the live step verifies the chosen one once.

## Pass 2: the final registry re-fetched (2026-10-19T14:06Z)

Run with the design's pacing (`export.arxiv.org` 3 s, `rss.arxiv.org` 1 s, `api.github.com` 1 s, 6 host groups in parallel); the whole run took 40 s wall clock including the 12 s of arXiv API pacing. "newest" is the newest `pubDate`/`published`/`updated`/`lastmod`/`created_at` found in the body (for Atom feeds with `updated` this can be later than the newest post, e.g. YouTube and Bear blog).

| id | HTTP | content-type | size | items | newest | ms |
|---|---|---|---|---|---|---|
| arxiv-cs.LG | 200 | `application/rss+xml` | 826 KB | 391 | 2026-10-19 | 321 |
| arxiv-cs.CL | 200 | `application/rss+xml` | 470 KB | 226 | 2026-10-19 | 24 |
| arxiv-cs.AI | 200 | `application/rss+xml` | 1 KB | 0 | 2026-10-19 | 17 |
| arxiv-cs.CV | 200 | `application/rss+xml` | 441 KB | 201 | 2026-10-19 | 65 |
| arxiv-api-cs.LG (fallback) | 200 | `application/atom+xml` | 235 KB | 100 | 2026-10-19 | 640 |
| arxiv-api-cs.CL (fallback) | 200 | `application/atom+xml` | 241 KB | 100 | 2026-10-19 | 236 |
| arxiv-api-cs.AI (fallback) | 200 | `application/atom+xml` | 243 KB | 100 | 2026-10-19 | 516 |
| arxiv-api-cs.CV (fallback) | 200 | `application/atom+xml` | 252 KB | 100 | 2026-10-19 | 988 |
| hf-papers | 200 | `application/json` | 589 KB | 100 | 2026-10-19 | 428 |
| hn-top | 200 | `application/json` | 44 KB | 43 | 2026-10-19 | 687 |
| hn-front | 200 | `application/json` | 30 KB | 30 | 2026-10-19 | 558 |
| hn-topstories (rank source) | 200 | `application/json` | 5 KB | 500 | - | 699 |
| reddit | 200 | `application/atom+xml` | 198 KB | 50 | 2026-10-19 | 1569 |
| openai | 200 | `text/xml` | 791 KB | 1299 | 2026-10-16 | 148 |
| anthropic (sitemap) | 200 | `application/xml` | 73 KB | 566 | 2026-10-19 | 509 |
| deepmind | 200 | `application/xml` | 69 KB | 100 | 2026-10-15 | 1571 |
| google-research | 200 | `application/rss+xml` | 78 KB | 100 | 2026-10-16 | 763 |
| meta-newsroom-ai | 200 | `application/rss+xml` | 148 KB | 10 | 2026-10-12 | 100 |
| meta-engineering-ai | 200 | `application/rss+xml` | 255 KB | 9 | 2026-09-02 | 158 |
| microsoft-research | 200 | `application/rss+xml` | 269 KB | 10 | 2026-10-15 | 1462 |
| nvidia-dev | 200 | `application/atom+xml` | 758 KB | 100 | 2026-10-16 | 596 |
| hf-blog | 200 | `application/rss+xml` | 260 KB | 881 | 2026-10-16 | 251 |
| allenai | 200 | `application/xml` | 24 KB | 25 | 2026-10-14 | 473 |
| mistral | 200 | `text/plain` | 26 KB | 90 | 2026-10-15 | 170 |
| transformer-circuits | 200 | `application/atom+xml` | 26 KB | 56 | 2026-08-21 | 817 |
| lilog | 200 | `application/xml` | 80 KB | 53 | 2026-07-04 | 114 |
| interconnects | 200 | `application/xml` | 538 KB | 20 | 2026-10-17 | 447 |
| raschka | 200 | `application/xml` | 2.70 MB | 20 | 2026-09-29 | 216 |
| simonw | 200 | `application/xml` | 109 KB | 30 | 2026-10-18 | 199 |
| chiphuyen | 200 | `application/xml` | 341 KB | 10 | 2025-01-16 | 1667 |
| eugeneyan | 200 | `application/xml` | 105 KB | 212 | 2026-06-21 | 365 |
| hamel | 200 | `application/xml` | 526 KB | 20 | 2026-09-30 | 125 |
| semianalysis | 200 | `application/xml` | 3.15 MB | 20 | 2026-10-19 | 253 |
| importai | 200 | `application/xml` | 473 KB | 20 | 2026-10-19 | 123 |
| latentspace | 200 | `application/xml` | 913 KB | 20 | 2026-10-17 | 269 |
| zvi | 200 | `application/xml` | 2.03 MB | 20 | 2026-10-19 | 195 |
| thebatch (sitemap) | 200 | `application/xml` | 489 KB | 3400 | 2026-10-14 | 197 |
| smol-ainews (dropped) | 200 | `application/xml` | 2.25 MB | 716 | 2026-09-09 | 391 |
| oneusefulthing | 200 | `application/xml` | 907 KB | 20 | 2026-10-01 | 147 |
| gradient | 200 | `text/xml` | 591 KB | 15 | 2026-02-18 | 1363 |
| epoch | 200 | `application/xml` | 42 KB | 50 | 2026-10-16 | 278 |
| epoch-gradient-updates | 200 | `application/xml` | 646 KB | 20 | 2026-10-09 | 156 |
| alignmentforum | 200 | `application/rss+xml` | 773 KB | 10 | 2026-10-18 | 235 |
| chinai | 200 | `application/xml` | 344 KB | 20 | 2026-10-19 | 335 |
| jalammar | 200 | `application/xml` | 466 KB | 11 | 2025-11-03 | 425 |
| karpathy-blog | 200 | `application/xml` | 893 KB | 10 | 2026-04-10 (feed `updated`) | 164 |
| karpathy-bearblog | 200 | `application/atom+xml` | 143 KB | 10 | 2026-10-19 (feed `updated`) | 1400 |
| horace | 200 | `application/xml` | 302 KB | 6 | 2025-03-04 | 366 |
| gh-rel-pytorch | 200 | `application/atom+xml` | 17 KB | 10 | 2026-10-19 | 1519 |
| gh-rel-vllm | 200 | `application/atom+xml` | 745 KB | 10 | 2026-10-18 | 1780 |
| gh-rel-transformers | 200 | `application/atom+xml` | 1.40 MB | 10 | 2026-10-16 | 2311 |
| gh-rel-llamacpp | 200 | `application/atom+xml` | 73 KB | 10 | 2026-10-19 | 1036 |
| gh-rel-sglang | 200 | `application/atom+xml` | 1.43 MB | 10 | 2026-10-19 | 3050 |
| gh-rel-unsloth | 200 | `application/atom+xml` | 1.96 MB | 10 | 2026-10-17 | 2765 |
| gh-rel-trl | 200 | `application/atom+xml` | 975 KB | 10 | 2026-10-16 | 1470 |
| gh-rel-torchtitan | 200 | `application/atom+xml` | 11 KB | 10 | 2026-10-19 | 433 |
| gh-trending-llm | 200 | `application/json` | 175 KB | 30 | 2026-10-19 | 875 |
| gh-trending-ml | 200 | `application/json` | 177 KB | 30 | 2026-10-18 | 1072 |
| gh-trending-agents | 200 | `application/json` | 172 KB | 30 | 2026-10-19 | 902 |
| hf-trending | 200 | `application/json` | 11 KB | 20 | 2026-10-17 | 217 |
| pod-dwarkesh | 200 | `application/xml` | 576 KB | 142 | 2026-10-01 | 337 |
| pod-mlst | 200 | `application/rss+xml` | 2.12 MB | 271 | 2026-10-10 | 160 |
| pod-cogrev | 200 | `application/xml` | 4.45 MB | 387 | 2026-10-17 | 272 |
| pod-nopriors | 200 | `application/xml` | 1.07 MB | 183 | 2026-10-15 | 57 |
| yt-karpathy | 200 | `text/xml` | 56 KB | 15 | 2026-10-19 (`updated`) | 252 |
| yt-yannic | 200 | `text/xml` | 40 KB | 15 | 2026-10-15 | 542 |
| yt-aiexplained | 200 | `text/xml` | 59 KB | 15 | 2026-10-15 | 26 |
| yt-gpumode | 200 | `text/xml` | 20 KB | 15 | 2026-10-17 | 183 |
| yt-stanford | 200 | `text/xml` | 41 KB | 15 | 2026-10-18 | 503 |
| yt-3b1b | 200 | `text/xml` | 26 KB | 15 | 2026-10-16 | 23 |

Observations from pass 2 that changed the design: HN front-page order (N2/N7, finding 9 above); the HN keyword filter keeps 8 of the 30 current front-page hits (ids 50145337, 50135762, 50145507, 50150434, 50145715, 50148855, 50151390, 50151928) and excludes the #1 story (Flock/ICE, 50150750); `gh-trending-ml` has nothing above 24 stars, so `minStars: 50` makes it `empty` (correct); the four GitHub release feeds over 1 MB take 1.5-3 s each, which is why the per-source wall clock stays at 45 s while sitemap page fetches get their own 40 s deadline.

## Final source list for `sources.config.mjs` (what the implementation fetches)

Research (5 + 1 link-out): arxiv-cs.LG, arxiv-cs.CL, arxiv-cs.AI, arxiv-cs.CV (RSS with API fallback), hf-papers, [alphaXiv link-out].
News (3): hn-top (search_by_date), hn-front (front_page, plus one `topstories.json` request for rank), reddit (one multireddit Atom request).
Labs (12 + 1 link-out): openai, anthropic (sitemap), deepmind, google-research, meta-newsroom-ai, meta-engineering-ai, microsoft-research, nvidia-dev, hf-blog, allenai, mistral, transformer-circuits, [ai.meta.com/blog link-out].
Blogs (22): lilog, interconnects, raschka, simonw, chiphuyen, eugeneyan, hamel, semianalysis (newsletter), importai, latentspace (also carries the `[AINews]` issues and the Latent Space podcast episodes), zvi, thebatch (sitemap), oneusefulthing, gradient, epoch (atom), epoch-gradient-updates (substack), alignmentforum, chinai, jalammar (newsletter), karpathy-blog, karpathy-bearblog, horace (thonking.ai).
Releases (12): gh-rel-pytorch, gh-rel-vllm, gh-rel-transformers, gh-rel-llamacpp, gh-rel-sglang, gh-rel-unsloth, gh-rel-trl, gh-rel-torchtitan, gh-trending-llm, gh-trending-ml, gh-trending-agents, hf-trending.
Podcasts & video (10): pod-dwarkesh, pod-mlst, pod-cogrev, pod-nopriors (Latent Space episodes arrive via the latentspace blog feed and are routed by audio enclosure), yt-karpathy, yt-yannic, yt-aiexplained, yt-gpumode, yt-stanford, yt-3b1b.

Total fetched sources: 64 (research 5, news 3, labs 12, blogs 22, releases 12, podcasts & video 10). Requests per run: 64 source requests + 1 HN topstories + 0-4 arXiv API fallbacks + up to 10 article-page fetches per sitemap source (first run; typically 0-3 afterwards). Sources with at least one item inside a 7-day window on 2026-10-19: 43 (counting arXiv cs.AI through its API fallback), above the "25 distinct sources" verification gate.

## Fixtures regenerated in pass 2

`substack-interconnects.xml` now holds items 0-3 and 17 of the raw capture (5 items, 2 `audio/mpeg` enclosures); `arxiv-rss-cs.LG.xml` holds 10 `new` + 3 `cross` + 3 `replace` + 2 `replace-cross` items (18 items, 13 survive the `replace*` filter); `hn-algolia-front.json` and the new `hn-topstories.json` are the same-minute pair from pass 2; `deeplearning-sitemap.xml` is new (18 of 3,400 URLs: 10 newest articles, `/the-batch/about` without lastmod, 2 `issue-NNN`, 2 `tag/`, 3 non-batch URLs); `gh-search-ml.json` is new (5 repos, 24..11 stars). All XML fixtures pass `XMLValidator`. `.gitattributes` marks `tests/fixtures/** -text`.

## Replication

`%TEMP%\ahead-probe\probe.mjs` .. `probe5.mjs` (pass 1), `reprobe.mjs`, `inspect3.mjs`, `inspect4.mjs`, `fetch-article.mjs`, `make-fixtures2.mjs`, `verify-fixtures2.mjs` (pass 2); `summary.json`, `summary2.json`, `summary3.json`, `reprobe-summary.json` hold the structured results. The design turns the same logic into `scripts/probe-sources.mjs` (`npm run probe`) so every URL can be re-verified in one command before each release.
