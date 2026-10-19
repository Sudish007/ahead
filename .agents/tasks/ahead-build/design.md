# Ahead — technical design (iteration 2)

Companion to `source-probe.md` (same folder), which records what every source URL returned on 2026-10-19 in two passes. This document fixes every architectural decision the implementation needs; the brief's ARCHITECTURE section is taken as given and is not re-argued here. Iteration 2 resolves all 23 findings of `design-review.md`; section 18 lists each finding and what changed.

## 1. Overview

Ahead is a static single-page site plus a Node data pipeline. The pipeline (`scripts/fetch.mjs`, logic in `src/`) runs in GitHub Actions every 6 hours, fetches 64 sources declared in `sources.config.mjs`, turns everything into one normalized item shape, deduplicates by canonical URL and arXiv id, scores items with a source-weight × recency formula plus log-scaled engagement and a cross-source bonus, merges the result with the previous `data/items.json` so that 7 days of items survive even when a feed only shows the last 24 hours, and writes `data/items.json`, `data/digests/YYYY-MM-DD.json`, `data/digests/index.json` and `data/meta.json`. The daily brief is built deterministically from the ranked items under a hard 1,100-word budget; an optional OpenAI-compatible LLM call rewrites the "why it matters" lines and adds a 150-200 word overview, falling back silently to the heuristic text. The frontend (`index.html`, `app.js`, `styles.css`, no build step) renders the brief first, loads `items.json` lazily for the category tabs, and keeps read/saved/learn state in `localStorage`. One workflow (`.github/workflows/refresh.yml`) runs tests, runs the pipeline, commits `data/` back with the bot identity, and deploys the site to GitHub Pages.

Three things in the probe forced small, deliberate extensions of the brief's vocabulary, each called out where it appears: a `sitemap` source type (Anthropic and The Batch publish no feed but do publish `sitemap.xml` with `lastmod`), two optional extra signal keys (`hfLikes`, `ytViews`) because the data is there and free, and one extra request per run to HN's `topstories.json` because Algolia's front-page endpoint does not return stories in HN order.

## 2. Technology stack (locked)

- Runtime: Node 24 in Actions (`actions/setup-node@v7`, `node-version: 24`), `engines.node >= 22` locally (dev machine has v24.16.0). ESM everywhere (`"type": "module"`).
- Dependencies: `fast-xml-parser` 5.11.2 (moved from devDependencies to dependencies; the pipeline needs it at runtime after `npm ci`). Nothing else. No framework, no bundler, no TypeScript.
- HTTP: built-in `fetch` (undici), which transparently handles gzip/br. No request library.
- Tests: `node:test` + `node:assert/strict`, `node --test "tests/**/*.test.js"`.
- Frontend: vanilla ES2022 module, CSS custom properties, system font stack, no web fonts, one SVG favicon.
- Hosting/CI: GitHub Pages via `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5`, `actions/deploy-pages@v5`; `actions/checkout@v7`.
- Screenshots (verification only): Playwright 1.64.0 reused from `../hoshlab/node_modules`; add as a devDependency only if that proves awkward.

## 3. Repository layout

```
ahead/
  index.html  app.js  styles.css  favicon.svg          # the site; served at /, /app.js, /styles.css, /data/... via a _site staging copy (9)
  sources.config.mjs                                   # the single declarative registry (sources, link-outs, learn)
  scripts/fetch.mjs        # CLI entry: parse flags, call src/pipeline.js run(), print the per-source table, exit 0
  scripts/probe-sources.mjs# fetch+parse every source, print status/count/ms; no writes (npm run probe)
  scripts/serve.mjs        # node:http static server, PORT default 8787, MIME map, gzip (template: ai-batkahi)
  src/http.js              # fetchText(): timeout, size cap, retry, UA, Accept, per-host pacing
  src/parsers/feed.js      # rss|atom|youtube|github-releases over fast-xml-parser
  src/parsers/arxiv.js     # arXiv RSS + API fallback
  src/parsers/json.js      # hn (+ topstories rank), hf-papers, hf-models, github-search
  src/parsers/reddit.js    # Reddit Atom (external link extraction)
  src/parsers/sitemap.js   # sitemap.xml + og:* page metadata, own deadline
  src/normalize.js         # canonicalizeUrl, extractArxivId, stripHtml, cleanText, parseDate, itemId, toItem
  src/dedup.js             # mergeItems(), family logic, category precedence
  src/score.js             # score(item, now)
  src/brief.js             # buildBrief(items, previousDigests, now, { targetWords })
  src/llm.js               # editorialize(brief, env, fetchImpl)
  src/pipeline.js          # run({ sources, now, dataDir, fetchImpl, env }) -> { items, brief, meta }
  src/schema.js            # tiny validators for Item / Digest / Meta (used by tests and by the pipeline before writing)
  data/items.json  data/meta.json  data/digests/*.json  data/digests/index.json
  tests/*.test.js  tests/helpers.js  tests/fixtures/*  # fixtures captured from the real endpoints (tests/fixtures/README.md)
  .gitattributes           # tests/fixtures/** -text (already added; fixture bytes never CRLF-converted)
  docs/screenshots/
  .github/workflows/refresh.yml
  README.md
```

`_site/` (Pages staging copy) is added to `.gitignore`. `.agents/` and `data/` stay tracked (setup-notes).

## 4. Source registry: `sources.config.mjs`

The registry has three named exports: `sources` (array of fetched sources), `linkouts` (object with `leaderboards` and `labs` arrays of links shown in the UI), and `learn` (array, the curriculum). Adding a fetched source is one object literal.

### 4.1 Schema

```js
// One fetched source. Only id, name, category, type, url, weight are required.
{
  id: 'interconnects',          // stable slug: ^[A-Za-z0-9.-]+$, unique; used in meta.json, item.sources[] and UI chips
  name: 'Interconnects',        // display name
  category: 'blogs',            // research | news | labs | blogs | releases | media
  type: 'rss',                  // rss | atom | json | arxiv | hn | reddit | github | youtube | sitemap
  url: 'https://www.interconnects.ai/feed',
  weight: 7,                    // 1..10, see 5.7
  homepage: 'https://www.interconnects.ai',   // optional, shown on hover / in the source list
  family: 'interconnects',      // optional, default = id; sources sharing a family never earn a cross-source bonus together
  maxItems: 40,                 // optional, default 40; items kept from this source per run after filtering
  maxAgeDays: 7,                // optional, default 7; items whose (surfacedAt ?? publishedAt) is older are discarded at parse time (5.4)
  maxBytes: 8_000_000,          // optional, default 8 MB response cap
  longForm: true,               // optional, default false; eligible for "One deep read" even when readMinutes is unknown
  // type-specific (all optional unless the validation rule below says otherwise):
  parser: 'hf-papers',          // json only, required: hf-papers | hf-models
  fallbackUrl: '...',           // arxiv only, required: API query used when the RSS feed yields 0 items
  rankUrl: '...',               // hn only: topstories.json; when set, extra.hnRank is derived from it (5.3)
  repo: 'vllm-project/vllm',    // github releases (host github.com), required: display name for release titles
  minStars: 50,                 // github search (host api.github.com), required: floor on stargazers_count
  include: /regex/,             // sitemap, required: URL must match
  exclude: /regex/,             // sitemap: URL must not match
  template: true,               // url contains {{unix24hAgo}} / {{date7dAgo}} placeholders expanded at run time
}
```

`category` drives the tab the item lands in; `media` is the "Podcasts & Video" tab. `type` picks the parser; `rss` and `atom` both go to `parsers/feed.js`, which sniffs the actual format (Mistral serves RSS as `text/plain`, Google as `text/xml`; the header is never trusted). `type: 'github'` dispatches on the URL host: `github.com` -> releases Atom (`parsers/feed.js`, requires `repo`); `api.github.com` -> search JSON (`parsers/json.js`, requires `minStars`); any other host is a registry error. There is no `rateGroup`: request pacing is a property of the hostname and lives in `http.js` (5.2), not in the registry.

### 4.2 The initial registry (every line verified in both probe passes)

```js
export const sources = [
  // Research
  { id: 'arxiv-cs.LG', name: 'arXiv cs.LG', category: 'research', type: 'arxiv', url: 'https://rss.arxiv.org/rss/cs.LG', fallbackUrl: 'https://export.arxiv.org/api/query?search_query=cat:cs.LG&sortBy=submittedDate&sortOrder=descending&max_results=100', weight: 3, family: 'arxiv', maxItems: 60 },
  { id: 'arxiv-cs.CL', name: 'arXiv cs.CL', category: 'research', type: 'arxiv', url: 'https://rss.arxiv.org/rss/cs.CL', fallbackUrl: 'https://export.arxiv.org/api/query?search_query=cat:cs.CL&sortBy=submittedDate&sortOrder=descending&max_results=100', weight: 3, family: 'arxiv', maxItems: 60 },
  { id: 'arxiv-cs.AI', name: 'arXiv cs.AI', category: 'research', type: 'arxiv', url: 'https://rss.arxiv.org/rss/cs.AI', fallbackUrl: 'https://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=100', weight: 3, family: 'arxiv', maxItems: 60 },
  { id: 'arxiv-cs.CV', name: 'arXiv cs.CV', category: 'research', type: 'arxiv', url: 'https://rss.arxiv.org/rss/cs.CV', fallbackUrl: 'https://export.arxiv.org/api/query?search_query=cat:cs.CV&sortBy=submittedDate&sortOrder=descending&max_results=100', weight: 3, family: 'arxiv', maxItems: 60 },
  { id: 'hf-papers', name: 'HF Daily Papers', category: 'research', type: 'json', parser: 'hf-papers', url: 'https://huggingface.co/api/daily_papers?limit=100', weight: 8, maxItems: 60, homepage: 'https://huggingface.co/papers' },
  // News & discussion
  { id: 'hn-top', name: 'Hacker News', category: 'news', type: 'hn', url: 'https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points>30,created_at_i>{{unix24hAgo}}&hitsPerPage=100', template: true, weight: 5, family: 'hn', maxItems: 40 },
  { id: 'hn-front', name: 'HN front page', category: 'news', type: 'hn', url: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50', rankUrl: 'https://hacker-news.firebaseio.com/v0/topstories.json', weight: 6, family: 'hn', maxItems: 30 },
  { id: 'reddit', name: 'Reddit r/LocalLLaMA + r/MachineLearning', category: 'news', type: 'reddit', url: 'https://www.reddit.com/r/LocalLLaMA+MachineLearning/top/.rss?t=day&limit=50', weight: 4, maxItems: 50 },
  // Labs
  { id: 'openai', name: 'OpenAI', category: 'labs', type: 'rss', url: 'https://openai.com/news/rss.xml', weight: 7, maxItems: 30 },
  { id: 'anthropic', name: 'Anthropic', category: 'labs', type: 'sitemap', url: 'https://www.anthropic.com/sitemap.xml', include: /^https:\/\/www\.anthropic\.com\/(news|research|engineering)\/[^/]+$/, weight: 8, maxItems: 10, homepage: 'https://www.anthropic.com/news' },
  { id: 'deepmind', name: 'Google DeepMind', category: 'labs', type: 'rss', url: 'https://deepmind.google/blog/rss.xml', weight: 7 },
  { id: 'google-research', name: 'Google Research', category: 'labs', type: 'rss', url: 'https://research.google/blog/rss/', weight: 6 },
  { id: 'meta-newsroom-ai', name: 'Meta Newsroom (AI)', category: 'labs', type: 'rss', url: 'https://about.fb.com/news/tag/ai/feed/', weight: 5, family: 'meta' },
  { id: 'meta-engineering-ai', name: 'Engineering at Meta (AI)', category: 'labs', type: 'rss', url: 'https://engineering.fb.com/category/ai-research/feed/', weight: 5, family: 'meta' },
  { id: 'microsoft-research', name: 'Microsoft Research', category: 'labs', type: 'rss', url: 'https://www.microsoft.com/en-us/research/feed/', weight: 5 },
  { id: 'nvidia-dev', name: 'NVIDIA Technical Blog', category: 'labs', type: 'atom', url: 'https://developer.nvidia.com/blog/feed', weight: 4, maxItems: 20 },
  { id: 'hf-blog', name: 'Hugging Face Blog', category: 'labs', type: 'rss', url: 'https://huggingface.co/blog/feed.xml', weight: 5, maxItems: 20 },
  { id: 'allenai', name: 'Ai2', category: 'labs', type: 'rss', url: 'https://allenai.org/rss.xml', weight: 5 },
  { id: 'mistral', name: 'Mistral AI', category: 'labs', type: 'rss', url: 'https://mistral.ai/news/rss', weight: 6 },
  { id: 'transformer-circuits', name: 'Transformer Circuits', category: 'labs', type: 'atom', url: 'https://transformer-circuits.pub/feed.xml', weight: 7, longForm: true },
  // Deep technical blogs
  { id: 'lilog', name: "Lil'Log", category: 'blogs', type: 'rss', url: 'https://lilianweng.github.io/index.xml', weight: 7, longForm: true },
  { id: 'interconnects', name: 'Interconnects', category: 'blogs', type: 'rss', url: 'https://www.interconnects.ai/feed', weight: 7, longForm: true },
  { id: 'raschka', name: 'Ahead of AI (Raschka)', category: 'blogs', type: 'rss', url: 'https://magazine.sebastianraschka.com/feed', weight: 6, longForm: true },
  { id: 'simonw', name: 'Simon Willison', category: 'blogs', type: 'atom', url: 'https://simonwillison.net/atom/everything/', weight: 4, maxItems: 10 },
  { id: 'chiphuyen', name: 'Chip Huyen', category: 'blogs', type: 'rss', url: 'https://huyenchip.com/feed.xml', weight: 6, longForm: true },
  { id: 'eugeneyan', name: 'Eugene Yan', category: 'blogs', type: 'rss', url: 'https://eugeneyan.com/rss/', weight: 5, longForm: true },
  { id: 'hamel', name: 'Hamel Husain', category: 'blogs', type: 'rss', url: 'https://hamel.dev/index.xml', weight: 5, longForm: true },
  { id: 'semianalysis', name: 'SemiAnalysis', category: 'blogs', type: 'rss', url: 'https://newsletter.semianalysis.com/feed', weight: 7, longForm: true },
  { id: 'importai', name: 'Import AI', category: 'blogs', type: 'rss', url: 'https://importai.substack.com/feed', weight: 6 },
  { id: 'latentspace', name: 'Latent Space', category: 'blogs', type: 'rss', url: 'https://www.latent.space/feed', weight: 5 },
  { id: 'zvi', name: "Don't Worry About the Vase", category: 'blogs', type: 'rss', url: 'https://thezvi.substack.com/feed', weight: 5, longForm: true },
  { id: 'thebatch', name: 'The Batch', category: 'blogs', type: 'sitemap', url: 'https://www.deeplearning.ai/sitemap.xml', include: /^https:\/\/www\.deeplearning\.ai\/the-batch\/[^/]+\/?$/, exclude: /\/the-batch\/(tag|issue-\d+)/, weight: 4, maxItems: 10, homepage: 'https://www.deeplearning.ai/the-batch/' },
  { id: 'oneusefulthing', name: 'One Useful Thing', category: 'blogs', type: 'rss', url: 'https://www.oneusefulthing.org/feed', weight: 4 },
  { id: 'gradient', name: 'The Gradient', category: 'blogs', type: 'rss', url: 'https://thegradient.pub/rss/', weight: 5, longForm: true },
  { id: 'epoch', name: 'Epoch AI', category: 'blogs', type: 'atom', url: 'https://epoch.ai/atom.xml', weight: 6, family: 'epoch' },
  { id: 'epoch-gradient-updates', name: 'Epoch AI Gradient Updates', category: 'blogs', type: 'rss', url: 'https://epochai.substack.com/feed', weight: 5, family: 'epoch' },
  { id: 'alignmentforum', name: 'Alignment Forum', category: 'blogs', type: 'rss', url: 'https://www.alignmentforum.org/feed.xml', weight: 4, longForm: true },
  { id: 'chinai', name: 'ChinAI', category: 'blogs', type: 'rss', url: 'https://chinai.substack.com/feed', weight: 4 },
  { id: 'jalammar', name: 'Jay Alammar (Language Models newsletter)', category: 'blogs', type: 'rss', url: 'https://newsletter.languagemodels.co/feed', weight: 5, longForm: true },
  { id: 'karpathy-blog', name: 'Andrej Karpathy (blog)', category: 'blogs', type: 'rss', url: 'https://karpathy.github.io/feed.xml', weight: 8, family: 'karpathy', longForm: true },
  { id: 'karpathy-bearblog', name: 'Andrej Karpathy (bearblog)', category: 'blogs', type: 'atom', url: 'https://karpathy.bearblog.dev/feed/', weight: 7, family: 'karpathy' },
  { id: 'horace', name: 'Horace He (Thonking AI)', category: 'blogs', type: 'rss', url: 'https://www.thonking.ai/feed', weight: 6, homepage: 'https://horace.io', longForm: true },
  // Open source & releases
  { id: 'gh-rel-pytorch', name: 'PyTorch releases', category: 'releases', type: 'github', url: 'https://github.com/pytorch/pytorch/releases.atom', repo: 'pytorch/pytorch', weight: 6 },
  { id: 'gh-rel-vllm', name: 'vLLM releases', category: 'releases', type: 'github', url: 'https://github.com/vllm-project/vllm/releases.atom', repo: 'vllm-project/vllm', weight: 6 },
  { id: 'gh-rel-transformers', name: 'Transformers releases', category: 'releases', type: 'github', url: 'https://github.com/huggingface/transformers/releases.atom', repo: 'huggingface/transformers', weight: 6 },
  { id: 'gh-rel-llamacpp', name: 'llama.cpp releases', category: 'releases', type: 'github', url: 'https://github.com/ggml-org/llama.cpp/releases.atom', repo: 'ggml-org/llama.cpp', weight: 3, maxItems: 3 },
  { id: 'gh-rel-sglang', name: 'SGLang releases', category: 'releases', type: 'github', url: 'https://github.com/sgl-project/sglang/releases.atom', repo: 'sgl-project/sglang', weight: 5 },
  { id: 'gh-rel-unsloth', name: 'Unsloth releases', category: 'releases', type: 'github', url: 'https://github.com/unslothai/unsloth/releases.atom', repo: 'unslothai/unsloth', weight: 4 },
  { id: 'gh-rel-trl', name: 'TRL releases', category: 'releases', type: 'github', url: 'https://github.com/huggingface/trl/releases.atom', repo: 'huggingface/trl', weight: 5 },
  { id: 'gh-rel-torchtitan', name: 'torchtitan releases', category: 'releases', type: 'github', url: 'https://github.com/pytorch/torchtitan/releases.atom', repo: 'pytorch/torchtitan', weight: 4 },
  { id: 'gh-trending-llm', name: 'GitHub new repos: llm', category: 'releases', type: 'github', url: 'https://api.github.com/search/repositories?q=topic:llm+created:>{{date7dAgo}}&sort=stars&order=desc&per_page=30', template: true, weight: 4, family: 'gh-trending', minStars: 50, maxItems: 15 },
  { id: 'gh-trending-ml', name: 'GitHub new repos: machine-learning', category: 'releases', type: 'github', url: 'https://api.github.com/search/repositories?q=topic:machine-learning+created:>{{date7dAgo}}&sort=stars&order=desc&per_page=30', template: true, weight: 4, family: 'gh-trending', minStars: 50, maxItems: 15 },
  { id: 'gh-trending-agents', name: 'GitHub new repos: ai-agents', category: 'releases', type: 'github', url: 'https://api.github.com/search/repositories?q=topic:ai-agents+created:>{{date7dAgo}}&sort=stars&order=desc&per_page=30', template: true, weight: 4, family: 'gh-trending', minStars: 50, maxItems: 15 },
  { id: 'hf-trending', name: 'HF trending models', category: 'releases', type: 'json', parser: 'hf-models', url: 'https://huggingface.co/api/models?sort=trendingScore&limit=20', weight: 4, maxItems: 20 },
  // Podcasts & video (Latent Space episodes arrive through the 'latentspace' feed and are routed by audio enclosure)
  { id: 'pod-dwarkesh', name: 'Dwarkesh Podcast', category: 'media', type: 'rss', url: 'https://api.substack.com/feed/podcast/69345.rss', weight: 6, maxItems: 5, homepage: 'https://www.dwarkesh.com' },
  { id: 'pod-mlst', name: 'Machine Learning Street Talk', category: 'media', type: 'rss', url: 'https://anchor.fm/s/1e4a0eac/podcast/rss', weight: 5, maxItems: 5 },
  { id: 'pod-cogrev', name: 'The Cognitive Revolution', category: 'media', type: 'rss', url: 'https://feeds.megaphone.fm/RINTP3108857801', weight: 4, maxItems: 5 },
  { id: 'pod-nopriors', name: 'No Priors', category: 'media', type: 'rss', url: 'https://feeds.megaphone.fm/nopriors', weight: 4, maxItems: 5 },
  { id: 'yt-karpathy', name: 'Andrej Karpathy (YouTube)', category: 'media', type: 'youtube', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCXUPKJO5MZQN11PqgIvyuvQ', weight: 7, maxItems: 5 },
  { id: 'yt-yannic', name: 'Yannic Kilcher', category: 'media', type: 'youtube', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCZHmQk67mSJgfCCTn7xBfew', weight: 4, maxItems: 5 },
  { id: 'yt-aiexplained', name: 'AI Explained', category: 'media', type: 'youtube', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCNJ1Ymd5yFuUPtn21xtRbbw', weight: 4, maxItems: 5 },
  { id: 'yt-gpumode', name: 'GPU MODE', category: 'media', type: 'youtube', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCJgIbYl6C5no72a0NUAPcTA', weight: 5, maxItems: 5 },
  { id: 'yt-stanford', name: 'Stanford Online', category: 'media', type: 'youtube', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCBa5G_ESCn8Yd4vw5U-gIcg', weight: 2, maxItems: 5 },
  { id: 'yt-3b1b', name: '3Blue1Brown', category: 'media', type: 'youtube', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCYO_jab_esuFRV4b17AJtAw', weight: 2, maxItems: 5 },
];

export const linkouts = {
  leaderboards: [
    { name: 'LMArena', url: 'https://arena.ai/leaderboard', blurb: 'Crowd-voted pairwise model rankings (text, vision, coding).' },
    { name: 'Artificial Analysis', url: 'https://artificialanalysis.ai/', blurb: 'Independent quality, speed and price benchmarks across providers.' },
    { name: 'Scale SEAL', url: 'https://labs.scale.com/leaderboard', blurb: 'Private expert-graded evaluations, hard to contaminate.' },
    { name: 'LiveBench', url: 'https://livebench.ai/', blurb: 'Monthly-refreshed, contamination-free benchmark.' },
    { name: 'SWE-bench', url: 'https://www.swebench.com/', blurb: 'Real GitHub issues resolved end to end; the coding-agent yardstick.' },
    { name: 'Epoch AI Benchmarks', url: 'https://epoch.ai/benchmarks', blurb: 'Epoch\'s independent runs of frontier models on major benchmarks.' },
    { name: 'Open LLM Leaderboard', url: 'https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard', blurb: 'Hugging Face\'s open-weights leaderboard (archived, still useful history).' },
    { name: 'Papers with Code', url: 'https://paperswithcode.co/', blurb: 'Trending papers with code, revived by Hugging Face.' },
  ],
  labs: [
    { name: 'Meta AI blog', url: 'https://ai.meta.com/blog/', blurb: 'No feed; announcements also reach the Meta Newsroom AI feed.' },
    { name: 'alphaXiv', url: 'https://www.alphaxiv.org/explore', blurb: 'Trending arXiv papers with discussion; no public API.' },
    { name: 'AI News (smol.ai)', url: 'https://news.smol.ai/', blurb: 'Daily issues now arrive as [AINews] posts in the Latent Space feed; the smol.ai RSS stopped on 2026-09-09.' },
  ],
};

export const learn = [
  { id: 'cs336', kind: 'course', title: 'Stanford CS336: Language Modeling from Scratch', url: 'https://stanford-cs336.github.io/spring2025/' },
  { id: 'cs224n', kind: 'course', title: 'Stanford CS224N: NLP with Deep Learning', url: 'https://web.stanford.edu/class/cs224n/' },
  { id: 'cs231n', kind: 'course', title: 'Stanford CS231N: Deep Learning for Computer Vision', url: 'https://cs231n.stanford.edu/' },
  { id: 'cs285', kind: 'course', title: 'Berkeley CS285: Deep Reinforcement Learning', url: 'https://rail.eecs.berkeley.edu/deeprlcourse/' },
  { id: 'raschka-llm', kind: 'book', title: 'Build a Large Language Model (From Scratch), Raschka', url: 'https://github.com/rasbt/LLMs-from-scratch' },
  { id: 'udl', kind: 'book', title: 'Understanding Deep Learning, Prince (free PDF)', url: 'https://udlbook.github.io/udlbook/' },
  { id: 'hf-courses', kind: 'course', title: 'Hugging Face courses (LLM, Agents, Deep RL, Diffusion)', url: 'https://huggingface.co/learn' },
  { id: 'zero-to-hero', kind: 'course', title: 'Karpathy: Neural Networks: Zero to Hero', url: 'https://karpathy.ai/zero-to-hero.html' },
  { id: 'p-attention', kind: 'paper', title: 'Attention Is All You Need (2017)', url: 'https://arxiv.org/abs/1706.03762' },
  { id: 'p-gpt3', kind: 'paper', title: 'Language Models are Few-Shot Learners, GPT-3 (2020)', url: 'https://arxiv.org/abs/2005.14165' },
  { id: 'p-instructgpt', kind: 'paper', title: 'Training language models to follow instructions, InstructGPT (2022)', url: 'https://arxiv.org/abs/2203.02155' },
  { id: 'p-chinchilla', kind: 'paper', title: 'Training Compute-Optimal LLMs, Chinchilla (2022)', url: 'https://arxiv.org/abs/2203.15556' },
  { id: 'p-llama', kind: 'paper', title: 'LLaMA: Open and Efficient Foundation Language Models (2023)', url: 'https://arxiv.org/abs/2302.13971' },
  { id: 'p-deepseek-v3', kind: 'paper', title: 'DeepSeek-V3 Technical Report (2024)', url: 'https://arxiv.org/abs/2412.19437' },
  { id: 'p-deepseek-r1', kind: 'paper', title: 'DeepSeek-R1: Incentivizing Reasoning via RL (2025)', url: 'https://arxiv.org/abs/2501.12948' },
  { id: 'p-cai', kind: 'paper', title: 'Constitutional AI: Harmlessness from AI Feedback (2022)', url: 'https://arxiv.org/abs/2212.08073' },
];
```

64 fetched sources: research 5, news 3, labs 12, blogs 22, releases 12, media 10. AI News (smol.ai) from the brief is not fetched: its feed has had no item since 2026-09-09 and the issues now publish inside the Latent Space feed as `[AINews] ...` posts (11 of the 20 current items), so the 2.25 MB download would yield nothing (probe B13); it is kept as a link-out in `linkouts.labs`.

Registry validation runs at pipeline start and in a unit test: unique ids matching `^[A-Za-z0-9.-]+$` (the arXiv ids keep their category case, `arxiv-cs.LG`); `category` and `type` in their enums; `weight` an integer 1-10; `url` parses as http(s); `template` urls contain only the two known placeholders and non-template urls contain none; `arxiv` entries have `fallbackUrl`; `json` entries have `parser` in `hf-papers | hf-models`; `github` entries have host `github.com` with `repo` and a path ending `/releases.atom`, or host `api.github.com` with a path starting `/search/repositories` and an integer `minStars >= 0`; `sitemap` entries have `include` (a RegExp); `rankUrl` only on `hn` entries; `family` defaults to `id`. A bad registry is a fatal, pre-fetch error (exit 1) because it is a programmer mistake, not a runtime condition.

## 5. The pipeline (`scripts/fetch.mjs` -> `src/pipeline.js`)

### 5.1 Run orchestration

`run({ sources, now = new Date(), dataDir = 'data', fetchImpl = globalThis.fetch, env = process.env, onlySourceIds, dryRun, noLlm })` does, in order:

1. Validate the registry (4.2). Expand `template` URLs: `{{unix24hAgo}}` = `floor(now/1000) - 86400`, `{{date7dAgo}}` = `YYYY-MM-DD` of `now - 7d`.
2. Load the previous `data/items.json` (missing or unparsable -> start from an empty list and log a warning; never fatal) and the previous 14 days of `data/digests/*.json` (each file independently; a corrupt one is skipped with a warning).
3. Fetch and parse every source through the scheduler (5.2). Each source is wrapped in its own `try/catch`; the result is `{ status: 'ok' | 'empty', items: RawItem[], note? }` or `{ status: 'failed', error }`. A failing source never throws past this boundary; that is the "degrades gracefully" invariant and `pipeline.js` owns it. A 45 s per-source wall clock is the backstop: every parser is designed to finish well inside it (single fetch of at most 20 s plus parsing; the sitemap parser enforces its own 40 s deadline, 5.3), so the backstop only fires if a parser misbehaves, and then the source is `failed: 'wall clock'`.
4. Normalize raw items to `Item`s (5.4), dedup and merge within the run (5.6), then merge with the previous items (5.8), score (5.7), apply retention, the count cap and the size cap (5.8).
5. Build the brief for the UTC date of `now` (6), then optionally editorialize with the LLM (7).
6. Validate the three outputs against `src/schema.js`; write them atomically (write `*.tmp`, `rename`): `items.json`, `digests/<date>.json`, `digests/index.json` (rebuilt from the directory listing, newest first), `meta.json`. In `dryRun` nothing is written.
7. Print a table `id | status | fetched | kept | ms | note/error` sorted by category, then a summary line, and exit 0. Exit code 1 only for registry errors, an unwritable `dataDir`, or an unexpected exception outside the per-source boundary.

Whole-run budget: 8 minutes. When exceeded, sources still pending are marked `failed: 'run budget exceeded'` and the run proceeds to write outputs with what it has. The Actions job has `timeout-minutes: 20`. Pass 2 of the probe ran the whole registry in 40 s wall clock including the arXiv pacing.

### 5.2 HTTP client, pacing and scheduler (`src/http.js`)

`fetchText(url, { timeoutMs = 20000, maxBytes = 8_000_000, accept, fetchImpl })`:
- Headers: `user-agent: Ahead/<package.json version> (+https://github.com/Sudish007/ahead; personal AI dashboard)`, `accept` per type (`application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8` for feeds and sitemaps; `application/json` for json/hn; `application/vnd.github+json` plus `authorization: Bearer <GITHUB_TOKEN>` when the host is `api.github.com` and the token is set; `text/html` for sitemap page fetches). The brief's descriptive User-Agent is what made Reddit's Atom endpoint answer in the probe.
- Timeout via `AbortController`. Body is read as a stream; once more than `maxBytes` have arrived the request is aborted and `BodyTooLarge` is thrown (the 14 MB Latent Space podcast feed is the reason this exists; that feed is not in the registry, but the next one might be).
- `redirect: 'follow'` (default). Returns `{ status, text, finalUrl, contentType }`.
- Status `>= 400` throws `HttpError(status, url)`. One retry after 2 s for network errors, 5xx and 429 (for 429, wait `min(retry-after, 30s)` when the header is present). No retry for other 4xx, and no retry at all for host `www.reddit.com` (its budget is one request per minute; the next run is six hours away).
- Node's fetch decodes gzip/br itself; nothing to do.

Pacing lives here, not in the scheduler, so it applies to every request whoever issues it (sources, arXiv API fallbacks, sitemap page fetches, the HN `rankUrl`): a module-level `Map<hostname, Promise>` chains requests to the same paced host and a `Map<hostname, lastRequestAt>` enforces a minimum gap before each one. `PACING = { 'export.arxiv.org': 3000, 'rss.arxiv.org': 1000, 'api.github.com': 1000 }` (ms); hosts not in the map are not serialized. Tests inject a fake clock through `fetchText`'s options (`sleep` and `nowMs`) so pacing is unit-tested without waiting.

Scheduler (`pipeline.js`): a pool of 6 workers takes sources in registry order. Total per run: 64 source requests + 1 topstories request + 0-4 arXiv fallbacks + up to 10 article-page fetches per sitemap source. Probe pass 2: all sources answer within 1.6 s except the GitHub release feeds over 1 MB (1.5-3 s) and the arXiv API (paced); the whole registry took 40 s.

### 5.3 Parsers: source response -> `RawItem[]`

`RawItem = { title, url, publishedAt?: Date, surfacedAt?: Date, summaryHtml?, summaryText?, bodyLength?, authors?: string[], arxivId?, signals?: {...}, discussionUrl?, tag?, enclosureType?, extra?: {...} }`

Every parser receives `(body, source, ctx)` where `ctx = { now, fetchText, previousItemsByCanonicalUrl, deadlineAt }`; parsers that need a second request (arXiv fallback, HN rank, sitemap pages) go through `ctx.fetchText`, which is the paced client from 5.2.

`parsers/feed.js` (types `rss`, `atom`, `youtube`, `github` releases). fast-xml-parser options: `{ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', cdataPropName: false, parseTagValue: false, trimValues: true, processEntities: true, htmlEntities: true, isArray: (name) => ['item','entry','link','category','author','enclosure'].includes(name) }`. `XMLValidator.validate` runs first; an invalid body is `ParseError('invalid xml')`. Format sniff on the body: `<feed` -> Atom entries; `<rss`/`<rdf:RDF` -> RSS items; anything else -> `ParseError('not a feed')`. A helper `text(node)` returns a string from string | `{'#text'}` | `{'@_href'}` | array-first. Field mapping:
- title: `title` (text; Epoch uses `type="html"` CDATA, which collapses to text), required non-empty after `cleanText`.
- url: RSS `link` text, else `guid` when `isPermaLink != false` and it parses as a URL; Atom first `link[rel=alternate]`, else first `link` href. Required.
- date: `pubDate | dc:date | published | updated | issued` (first present, in this order; YouTube and Bear blog `updated` changes on edits, so `published` wins); parsed by `parseDate` (RFC 822 and ISO both go through `new Date`); invalid or missing -> `undefined`; future dates are clamped to `now`.
- summary: first non-empty of `description`, `summary`, `content:encoded`, `content`, `media:group.media:description`, `itunes:summary`. For Substack feeds `description` is the subtitle and `content:encoded` the body: both are kept, `summaryText` from the first, `bodyLength` from the longest (used for `readMinutes`).
- authors: `dc:creator`, `author.name`, `itunes:author` (split on `,` for dc:creator; max 5).
- enclosureType: `enclosure[0]['@_type']`; an `audio/*` enclosure from a `blogs`/`labs` source re-routes the item to `media` (Latent Space, Interconnects, Dwarkesh episodes).
- youtube extras: `yt:videoId`, `media:group.media:community.media:statistics['@_views']` -> `signals.ytViews`.
- github releases: tag = last path segment of the link after `/releases/tag/`, URL-decoded; entries whose tag contains `/` are dropped (pytorch `viable/strict/...`, torchtitan `ciflow/...`); title = `${repo} ${tag}` when the entry title is just the tag, else `${repo}: ${entryTitle}`; `tag` kept for the why-line; summary from `content` (HTML stripped, 600 chars).

`parsers/arxiv.js` (type `arxiv`): parse the RSS with feed.js, then: drop items whose `arxiv:announce_type` matches `/replace/`; `arxivId` from the link; strip the `^arXiv:\S+ Announce Type: \w+(-\w+)?\s*Abstract:\s*` prefix from the description; `authors` from `dc:creator`; `publishedAt` = feed pubDate (announcement day); `extra.primaryCategory` = first `<category>` (RSS) or `arxiv:primary_category['@_term']` (API). If the RSS parses but yields 0 items (cs.AI did, three times, on probe day) or fails, fetch `fallbackUrl` through `ctx.fetchText` (paced 3 s per host): `arxivId` from `<id>` (strip `vN`), `summary`, `author[].name`, `published`; `extra.via = 'api'`. Source status is `ok` if either path produced items, with `note: 'api fallback'` when the second path ran.

`parsers/json.js`:
- `hn` (type `hn`): `JSON.parse`, `Array.isArray(hits)` required. `hits[]` -> `{ title, url: hit.url || 'https://news.ycombinator.com/item?id=' + objectID, discussionUrl: HN item URL, publishedAt: created_at, signals: { hnPoints: points, hnComments: num_comments } }`. Keyword filter (5.5) applies to both HN sources. When the source has `rankUrl`, the parser fetches it once through `ctx.fetchText` (expects a JSON array of integers) and sets `extra.hnRank = ids.indexOf(Number(objectID)) + 1` for hits found within the first 30 ids; hits not found carry no rank. If the `rankUrl` fetch fails or is not an array, no item gets a rank, the source stays `ok`, and `note: 'rank unavailable'` is recorded. Algolia returns `front_page` hits sorted by points, not by position (probe N2/N7), so the rank is never taken from the hit order.
- `hf-papers`: top-level array required. `[]` -> `{ title: paper.title, url: 'https://huggingface.co/papers/' + paper.id, arxivId: paper.id, summaryText: paper.summary, authors: paper.authors[].name, publishedAt: paper.publishedAt, surfacedAt: paper.submittedOnDailyAt, signals: { hfUpvotes: paper.upvotes }, extra: { githubRepo, githubStars } }`.
- `hf-models`: top-level array required. `[]` -> `{ title: id, url: 'https://huggingface.co/' + id, summaryText: [pipeline_tag, library_name, likes + ' likes', downloads + ' downloads'].filter(Boolean).join(' · '), publishedAt: createdAt, surfacedAt: now, signals: { hfLikes: likes }, extra: { trendingScore, downloads } }`. The previous-run merge (5.8) keeps the first run's `at`, so `surfacedAt` means "first seen trending".
- `github` search (host `api.github.com`): `Array.isArray(items)` required. `items[]` with `stargazers_count >= minStars` -> `{ title: full_name, url: html_url, summaryText: description (+ ' · ' + language), publishedAt: created_at, surfacedAt: now, signals: { ghStars: stargazers_count }, extra: { topics: topics.slice(0, 6) } }`. Zero survivors is `status: 'empty'` (topic:machine-learning had nothing above 24 stars in both probe passes).

`parsers/reddit.js` (type `reddit`): Atom entries. `discussionUrl` = entry link (permalink); `content` is escaped HTML containing `<a href="...">[link]</a>`. The href is Reddit-hosted when its host equals or ends with `.reddit.com` or `.redd.it` (`www.reddit.com/gallery/...`, `i.redd.it`, `preview.redd.it`, comment permalinks); otherwise it becomes `url` (so a Reddit post about an arXiv paper or GitHub repo dedups with the HN/HF/arXiv item). Reddit-hosted or missing -> `url` = permalink (self post). `summaryText` = content with HTML stripped and the trailing `submitted by /u/... [link] [comments]` boilerplate removed. `extra.subreddit` = `category[0]['@_term']`. No engagement numbers exist in the feed, so `signals` stays empty and the why-line says "top of r/LocalLLaMA today".

`parsers/sitemap.js` (type `sitemap`, the one new type): `XMLValidator` then parse `<urlset><url><loc/><lastmod/>`. Keep URLs that match `include`, do not match `exclude`, and have a `<lastmod>` (URLs without one are skipped: 30 of 566 at Anthropic, 291 of 3,400 at deeplearning.ai are index pages) within `maxAgeDays`; sort by `lastmod` desc; take `maxItems`. For each URL whose canonical form is already in `ctx.previousItemsByCanonicalUrl`, reuse the stored title/summary/publishedAt without a fetch. For the rest, fetch the pages through `ctx.fetchText` with `timeoutMs: 8000`, `maxBytes: 1_500_000`, `accept: text/html`, concurrency 4, and read `og:title` (fallback `<title>` with a trailing ` \ Anthropic`-style suffix removed), `og:description`, `article:published_time` (fallback `lastmod`). If `article:published_time` is older than `maxAgeDays` the URL is dropped: a bumped `lastmod` on an old page is an edit, not news (Anthropic's `lastmod` equals `article:modified_time`, probe L2a). `publishedAt = surfacedAt = article:published_time ?? lastmod`, never `now`. If a page fetch fails, the item is still produced with the slug title-cased (`public-benefit-fund` -> "Public benefit fund"), no summary, `publishedAt = lastmod`, and `extra.titleFrom = 'slug'`. The parser has its own deadline, `ctx.deadlineAt`, set by the pipeline to the source's start time + 40 s (the sitemap fetch itself counts against it): when it passes, no new page fetch starts, in-flight ones are abandoned, and every remaining URL is emitted as a slug-titled item; status stays `ok` with `note: 'page fetches truncated (n of m)'`. Without the deadline the worst case would be 20 s (sitemap timeout) + 3 rounds × 8 s = 44 s; with it the parser returns by about 40 s, so the 45 s backstop in 5.1 cannot fire first unless the parser is broken.

### 5.4 Normalized item (`src/normalize.js`)

```js
Item = {
  id: 'arxiv:2610.22379' | '3f9c2a1b7d4e6f80',   // 'arxiv:<id>' for papers, else first 16 hex of sha256(canonicalUrl)
  title: string,                 // <= 200 chars, entities decoded, whitespace collapsed
  url: string,                   // the URL as given by the source (never fetched; only source feeds follow redirects); http(s) only
  canonicalUrl: string,          // dedup key material (5.5)
  sources: [{ id, url?, at }],   // every source that surfaced it; url = that source's own page (HN thread, Reddit permalink, HF paper page); at = ISO, see below
  category: 'research'|'news'|'labs'|'blogs'|'releases'|'media',
  publishedAt: ISO,              // the item's own date (earliest across sources); fallback = run time
  surfacedAt: ISO,               // max(sources[].at): when it last became "news"; drives decay, windows, retention
  summary: string,               // plain text, <= 600 chars (arXiv abstracts <= 400), sentence-trimmed
  score: number,                 // 2 decimals, see 5.7
  signals: { hnPoints?, hnComments?, hfUpvotes?, redditScore?, ghStars?, hfLikes?, ytViews? },  // only present keys
  arxivId?: '2610.22379',
  authors?: string[],            // <= 5
  readMinutes?: number,          // ceil(bodyLength / 1000); only when a feed body was available
  discussionUrl?: string,        // HN thread / Reddit permalink when url points elsewhere
  tag?: string,                  // release tag
  extra?: { ... }                // small, source-specific, never required by the UI: primaryCategory, hnRank, subreddit, titleFrom, via, topics, ...
}
```

`toItem(raw, source, now)` sets `sources[0] = { id: source.id, url: raw.discussionUrl ?? (raw.url !== itemUrl ? raw.url : undefined), at }` with

```
at = raw.surfacedAt ?? raw.publishedAt ?? now
  feed / arxiv / youtube / github releases / reddit / hn : surfacedAt undefined -> at = publishedAt (HN: created_at)
  hf-papers                                                : surfacedAt = submittedOnDailyAt
  hf-models, github search                                 : surfacedAt = now (first run's value survives the merge, 5.8)
  sitemap                                                  : surfacedAt = article:published_time ?? lastmod (never now)
```

`maxAgeDays` is applied by `toItem` against `raw.surfacedAt ?? raw.publishedAt`; items with neither date pass the filter and get `publishedAt = surfacedAt = now`. This is why HF trending models created months ago survive (their `surfacedAt` is the run time) while a six-day-old Anthropic post seen on the first run keeps its real date and does not enter the brief as fresh news.

`cleanText(html)`: decode entities (fast-xml-parser already handles XML entities; a small map handles `&nbsp; &amp; &lt; &gt; &quot; &#39; &#8217;` and numeric entities), strip tags with a regex after dropping `<script>`/`<style>` blocks, collapse whitespace, trim. `truncate(text, max)`: cut at the last sentence end before `max`, else at the last space, and append `…`. Items with an empty title or an invalid URL after normalization are skipped and counted in `meta.sources[id].skipped`.

### 5.5 URL canonicalization, arXiv ids, HN keyword filter

`canonicalizeUrl(raw)`:
1. `new URL(raw.trim())`; failure -> return `null` (item skipped). Protocol must be `http:` or `https:`.
2. `http:` -> `https:`. Host lower-cased, leading `www.` removed, default port removed.
3. Path: collapse `//` to `/` (Chip Huyen and Eugene Yan emit `https://huyenchip.com//2025/...`), drop a trailing `/index.html`, drop a trailing `/` (except the root path), percent-decode then re-encode nothing else.
4. Query: remove parameters matching `/^(utm_\w+|ref|ref_src|ref_url|source|fbclid|gclid|dclid|mc_cid|mc_eid|igshid|si|feature|_hsenc|_hsmi|mkt_tok|trk|s|t|cmpid|ncid|sr_share|share|smid)$/`; keep the rest sorted by key. Special cases: `youtube.com/watch` keeps only `v`; `youtu.be/<id>` -> `https://youtube.com/watch?v=<id>`; `news.ycombinator.com/item` keeps `id`.
5. Fragment removed.
6. arXiv family -> `https://arxiv.org/abs/<id>` (see below) with the version stripped.
7. GitHub repo URLs: owner/repo lower-cased, trailing `.git` removed; deeper paths untouched.

`extractArxivId(urlOrText)`: matches, in order, `arxiv.org/(abs|pdf|html)/<id>(v\d+)?(\.pdf)?`, `export.arxiv.org/...`, `huggingface.co/papers/<id>`, `alphaxiv.org/(abs|overview)/<id>`, and in free text `arXiv:<id>`; `<id>` is `\d{4}\.\d{4,5}` (new style) or `[a-z-]+(\.[A-Z]{2})?\/\d{7}` (old style). Returns the id without version or `null`.

HN keyword filter (`isAiStory(title, url)`): true when the URL host (minus `www.`) is, or is a subdomain of, one of `arxiv.org, huggingface.co, openai.com, anthropic.com, deepmind.google, ai.meta.com, mistral.ai, x.ai, deepseek.com, ollama.com, vllm.ai`, or the title matches the strong regex (case-insensitive): `\b(LLMs?|GPT[-\d.]*|ChatGPT|Claude|Gemini|Gemma|OpenAI|Anthropic|DeepMind|Mistral|Llama|Qwen|DeepSeek|Kimi|Grok|xAI|Hugging ?Face|transformers?|diffusion|RLHF|reinforcement learning|machine learning|deep learning|neural (net|network)s?|benchmarks?|inference|fine-?tun(e|ed|ing)|embeddings?|tokeni[sz](er|ation)|RAG|MCP|agentic|AI agents?|(language|foundation|open[- ]weights?|reasoning|vision|multimodal|frontier) models?|Nvidia|CUDA|GPUs?|TPUs?|PyTorch|JAX|vLLM|llama\.cpp|Ollama|Copilot|Codex|Cursor|Sora|Midjourney|Stable Diffusion|AGI|superintelligence|AI (safety|alignment))\b`, or the title matches `\bAI\b` case-sensitively. Bare `model`/`agent`/`alignment` deliberately do not match (the probe caught "ICE agent"). The list lives in `src/parsers/json.js` as an exported constant so the test can pin the fixture outcome: exactly these regexes keep 9 of 42 hits on `hn-algolia-bydate.json` (ids 50150434, 50148855, 50148452, 50145715, 50145507, 50145337, 50143755 via the anthropic.com host rule, 50141657, 50141429; the Flock/ICE story 50150750 is excluded) and 8 of 30 on `hn-algolia-front.json` (ids 50145337, 50135762, 50145507, 50150434, 50145715, 50148855, 50151390, 50151928; the Flock/ICE story, HN #1 at capture time, is excluded). Both verified against the committed fixtures.

### 5.6 Dedup and merge (`src/dedup.js`)

Key: `arxivId ? 'arxiv:' + arxivId : canonicalUrl`. All raw items of a run are grouped by key and merged into one `Item`:
- `sources`: union by source id; each carries its own `url` and `at`.
- `title`: from the source with the highest weight (ties: earliest `at`); for papers prefer HF Papers/arXiv titles over HN titles.
- `summary`: longest non-empty (then truncated to the cap). `authors`: from the research source if any. `readMinutes`: max.
- `signals`: per key `max`. `extra`: shallow merge, higher-weight source wins on conflicts.
- `publishedAt`: min; `surfacedAt`: max of `sources[].at`.
- `category`: precedence `research > releases > labs > blogs > media > news` across the contributing sources' categories (after the audio-enclosure re-route). An HN story about an OpenAI post becomes `labs` with `sources: [openai, hn-front]`.
- `url`: items with `arxivId` always use `https://arxiv.org/abs/<id>` (the HF Papers page stays in `sources[].url` and is shown as the HF chip link); otherwise the research/labs/blogs/releases source's URL when present, else the HN `url`; `discussionUrl`: HN thread, else Reddit permalink.

Cross-source counting uses `family`: `distinctFamilies = new Set(sources.map(s => registry[s.id].family ?? s.id)).size`. arXiv cross-lists (cs.LG + cs.AI) therefore do not look like two sources, and both HN feeds count once.

### 5.7 Scoring (`src/score.js`)

```
ageHours = max(0, (now - surfacedAt) / 3.6e6)
decay    = 0.5 ** (ageHours / 36)                         // half-life 36 h
W        = max(weight of sources)                          // 1..10
E        = 1.0*log2(1+hfUpvotes) + 0.6*log2(1+hnPoints) + 0.4*log2(1+hnComments)
         + 0.5*log2(1+ghStars)  + 0.5*log2(1+redditScore) + 0.5*log2(1+hfLikes) + 0.15*log2(1+ytViews)
X        = 4 * min(3, distinctFamilies - 1)                // cross-source bonus, capped at 12
score    = round2(W * decay + E + X)
```

Only the source weight decays, as the brief specifies; engagement and the cross-source bonus do not, so a big HN thread stays near the top of the 7-day News tab, while the brief's own freshness window (6.1) keeps the daily brief current. Worked example used as the unit test: A = HN-only, 500 points / 200 comments, 2 h old, weight 5 -> 5 × 0.9622 + 0.6 × log2(501) + 0.4 × log2(201) = 4.81 + 5.38 + 3.06 = **13.25**. B = arXiv + HF Papers (30 upvotes) + HN (40 points / 10 comments), 20 h old -> W 8 × 0.6804 = 5.44, E = log2(31) + 0.6 × log2(41) + 0.4 × log2(11) = 4.95 + 3.21 + 1.38 = 9.55, X = 4 × min(3, 3 − 1) = 8 -> **23.00**. B wins despite lower raw engagement, which is the behavior the brief asks the test to prove. Coefficients and the half-life are constants at the top of `score.js`, not in the registry; weights are in the registry.

### 5.8 Merge with the previous run, retention, caps

After in-run dedup, each item is merged with the stored item of the same `id` from the previous `items.json`: `sources[]` union where a stored source entry keeps its `at` (this is what makes `surfacedAt` for HF trending / GitHub search mean "first seen", since those parsers emit `surfacedAt = now`); `signals` max; `title`/`summary` from the fresh item unless empty; `publishedAt` min; `extra` shallow-merged with fresh keys winning. `extra.hnRank` is ephemeral: it is deleted from every stored item before the merge and exists afterwards only on items this run's `hn-front` parser ranked. Stored items not seen this run are kept unchanged (HN by-date only covers 24 h; this is how 7 days accumulate).

Retention after the merge: drop items with `surfacedAt < now - 7 d`; arXiv-only items (every source in family `arxiv`, no signals) are dropped after 3 days instead, because 240 new abstracts a day would otherwise make `items.json` mostly unread long tail. Then the count cap: keep the top 3,000 by score. Then the size cap: serialize; while `Buffer.byteLength > 2_000_000`, drop the lowest-scoring 5 % and serialize again; `meta.trimmedForSize = <items dropped>` (0 normally). Expected steady state: 1,500-2,500 items, about 1-1.5 MB raw (300-450 KB gzipped from Pages), which the frontend loads lazily. The pipeline owns the size invariant so an unattended dashboard never stalls on it; `tests/data-shape.test.js` only asserts the cap held.

### 5.9 Output files

`data/items.json`: `{ generatedAt, count, items: Item[] }`, sorted by score desc.

`data/digests/YYYY-MM-DD.json` (UTC date of the run start; only this file is ever written):
```js
{ date, generatedAt, wordCount, readingMinutes,
  overview: null | { text, source: 'llm', model },
  sections: [ { key: 'must-know'|'research'|'releases'|'labs'|'analysis'|'deep-read', title, entries: [
      { id, title, url, discussionUrl?, sourceIds: [], sourceNames: [], summary, why, whySource: 'heuristic'|'llm', publishedAt, category, score, readMinutes? } ] } ],
  itemIds: string[], deepReadId: string | null, llm: { enabled, ok } }
```
`data/digests/index.json`: `{ days: [ { date, generatedAt, wordCount, readingMinutes, entryCount } ] }`, newest first, rebuilt from the files present.

`data/meta.json`:
```js
{ generatedAt, durationMs, itemCount, newItemCount, trimmedForSize,
  sources: { [id]: { name, category, status: 'ok'|'empty'|'failed', fetched, kept, skipped, ms, httpStatus?, error?, note? } },
  okCount, emptyCount, failedCount,
  llm: { enabled: boolean, ok?: boolean, model?: string, error?: string },
  brief: { date, wordCount, readingMinutes },
  static: { leaderboards: [...], labs: [...], learn: [...] } }   // verbatim copies of linkouts/learn from the registry (8.1)
```
`status: 'empty'` means the fetch succeeded but zero items survived filtering/retention (Chip Huyen most weeks; GitHub topic:machine-learning under the star floor; pytorch releases); the UI counts only `failed` for the health dot. `error` is a short class string (`HTTP 403`, `timeout`, `body too large`, `parse error: not a feed`, `wall clock`), never a stack trace. `note` is informational (`api fallback`, `rank unavailable`, `page fetches truncated (3 of 10)`, `redirected to <finalUrl>`). Secrets never appear anywhere in `data/`.

## 6. The 5-minute brief (`src/brief.js`)

### 6.1 Candidate windows and repeat suppression

`fresh` = items with `surfacedAt >= now - 36h`. If fewer than 20 items qualify (weekends: arXiv and HF Papers publish nothing on Saturday/Sunday), widen to 72 h. `used` = union of `itemIds` from the digests of the two previous calendar days; nothing in `used` may appear in any section. The current day's own digest is regenerated from scratch on each run, so an item can move between sections during the day but never repeats across days.

### 6.2 Sections (filled in this order, each pick removed from the pool)

| key | title | count | pool |
|---|---|---|---|
| `must-know` | Must know | 4 | all fresh, by score |
| `research` | Research | 3 | category `research` |
| `releases` | Releases & tools | 3 | category `releases` |
| `labs` | From the labs | 2 | category `labs` |
| `analysis` | Analysis worth reading | 2 | category `blogs`, sorted by `(readMinutes >= 5 || longForm) ? 1 : 0` then score |
| `deep-read` | One deep read | 1 | category `blogs`, `surfacedAt` within 7 d, `(readMinutes >= 8 || longForm)`, not in this brief, not among `deepReadId`s of the last 14 digests; highest score. Fallback: relax the length rule; else the section is emitted with no entries |

A section with an empty pool is emitted with `entries: []`; the UI shows "Nothing new today" for it. Empty sections are legal in the data and the smoke test, but the live verification step requires all six populated on a weekday run.

### 6.3 Entry text

- `title`: cleaned, max 140 chars (ellipsis at a word boundary).
- `summary`: the first one or two sentences of `item.summary`, max 280 chars. Sentence split on `(?<=[.!?])\s+(?=[A-Z0-9"“])` with a guard for `e.g.`, `i.e.`, `vs.`, `et al.`, `Fig.`, `No.`. Empty when the item has no summary (HF blog, some Mistral posts).
- `why` (heuristic): the strongest one or two true statements, joined with "; ", max 160 chars, numbers compacted (`1.2k`), in this priority:
  `#{extra.hnRank} on HN front page, {points} points, {comments} comments` (only when `hnRank` is present) > `on HN front page, {points} points, {comments} comments` (an `hn-front` source without a rank) > `{points} points on HN, {comments} comments` > `{n} upvotes on HF Papers` > `also on {other family names}` > `{stars} stars in {d} days` > `new release {tag}` > `{likes} likes on Hugging Face` > `{views} views` > category fallbacks: labs `{source} announcement`, research `new on arXiv ({extra.primaryCategory})`, blogs `{source}, ~{readMinutes} min read`, media `new episode from {source}`, news `top of r/{extra.subreddit} today` / `on HN`. Every number comes from a stored field; the heuristic never infers one.
- `sourceNames`: display names of all sources, research/labs first.

### 6.4 The word budget (the "5-minute" contract)

Words are counted with `countWords(text) = text.split(/\s+/).filter(Boolean).length` over every entry's `title + summary + why + sourceNames.join(' ')`, plus the section titles and `overview.text`. Hard cap: `wordCount <= 1100`. Target: `targetWords = llmEnabled ? 880 : 1100`, so that an accepted overview (at most 220 words, 7) fits under the cap without evicting entries. Enforcement, in order, until `wordCount <= targetWords`:
1. Trim summaries to one sentence / 160 chars. Section order: `analysis` -> `labs` -> `releases` -> `research` -> `deep-read` -> `must-know`; within a section, last entry first. Pass 1 covers every section except `must-know`; pass 2 includes `must-know`.
2. Drop the last entry of `research`, then `releases`, then `labs`, then `analysis`, cycling, never below one entry each; `must-know` and `deep-read` never shrink.
3. Hard truncate every summary to 120 chars (not reachable with the caps above; exists so the invariant is unconditional).
`readingMinutes = max(1, ceil(wordCount / 220))`, which is 5 at the cap. After the LLM layer attaches an overview and replaces why-lines (7), the budget runs again with `targetWords = 1100`. `brief.js` owns this invariant and exports `countWords` for the test; the UI does not count words, it displays `digest.wordCount` and `digest.readingMinutes` as written by the pipeline.

## 7. Optional LLM editorial layer (`src/llm.js`)

Enabled only when `LLM_API_KEY` is set and non-empty and `--no-llm` is absent. `LLM_BASE_URL` defaults to `https://api.openai.com/v1`; it must parse as a URL whose protocol is `https:`, or `http:` only when the host is `localhost` or `127.0.0.1` (the key travels in the Authorization header); otherwise the layer is disabled with `meta.llm.error = 'invalid LLM_BASE_URL'`. `LLM_MODEL` defaults to `gpt-4o-mini`.

One request per run: `POST {base}/chat/completions` with `authorization: Bearer <key>`, body `{ model, temperature: 0.3, max_tokens: 1500, messages: [system, user] }` (15 why-lines plus a 200-word overview in JSON is about 850 output tokens; 1500 leaves room so truncation does not become a parse failure). No `response_format` field (Anthropic's and some other OpenAI-compatible endpoints reject it); the system prompt demands a single JSON object. System prompt (fixed text in the module): you are the editor of a one-page daily AI brief for an expert reader; using only the facts given, write `overview` (150-200 words, plain English, no hype, name the 3-5 developments that matter most and why) and `why` (map of entry id -> one line of at most 25 words saying why it matters to a researcher or founder); never invent numbers or names; output only JSON `{ "overview": string, "why": { id: string } }`. User message: JSON array of the brief's entries `{ id, section, title, summary, sourceNames, signals }` (at most 15 entries, summaries cut to 300 chars; about 2.5k tokens).

Response handling: 60 s timeout; non-2xx -> failure; `choices[0].message.content` -> take the substring from the first `{` to the last `}` -> `JSON.parse`; `overview` accepted only if a string of 80-220 words; each `why[id]` accepted only if a non-empty string <= 200 chars for an id that exists; everything else is ignored individually. Accepted text replaces the heuristic (`whySource: 'llm'`), the overview is attached, and the word budget (6.4) runs again. Any failure (network, timeout, HTTP, parse, nothing accepted) leaves the heuristic brief untouched, logs one `warn` line without the key or the response body, and records `meta.llm = { enabled: true, ok: false, error: 'HTTP 401' | 'timeout' | 'invalid JSON' | 'empty' }`. No retry; the next run tries again. The key is read from `env` inside `llm.js` only and never written anywhere.

README documents the secrets and provider settings with the base URLs verified in the probe (each answered the `chat/completions` path with a 401/400 "bad key" error, so the path and the Bearer header are right): OpenAI `https://api.openai.com/v1` (default); Anthropic `https://api.anthropic.com/v1`; Groq `https://api.groq.com/openai/v1`; Gemini `https://generativelanguage.googleapis.com/v1beta/openai`; OpenRouter `https://openrouter.ai/api/v1`. `LLM_MODEL` is "any current model id from the provider's model list" (ids rotate too fast to hard-code; the live verification step runs the pipeline once with the chosen id). Setting them: `gh secret set LLM_API_KEY` etc. The baseline needs none of this.

## 8. Frontend (`index.html`, `app.js`, `styles.css`)

### 8.1 Structure and data loading

`index.html` holds the static skeleton: `<header>` (wordmark "Ahead", digest date in UTC, "refreshed N min ago", "N min read", health dot button), `<nav aria-label="Sections">` with a `role="tablist"` of 10 buttons, a filter bar (hidden on Brief/Leaderboards/Learn/Archive), `<main>` with one `role="tabpanel"` region whose content is re-rendered, `<template>` elements for an item row and a brief entry, and a `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'">` (Pages cannot set headers; everything is same-origin so this costs nothing). Consequence for the implementer: `style-src 'self'` forbids `<style>` blocks and `style=""` attributes, so all styling is classes in `styles.css`; dynamic values (the clamp, widths) go through CSSOM (`el.style.setProperty`) or `data-*` attributes with CSS selectors, never `setAttribute('style', ...)` in markup. `<script type="module" src="app.js">`.

All data URLs are relative (`data/meta.json`, `data/digests/index.json`, `data/digests/<date>.json`, `data/items.json`) so the site works under `/ahead/`. Startup: `Promise.all([meta, index])` with `{ cache: 'no-cache' }`, then the newest digest from `index.days[0].date` fetched as `data/digests/<date>.json?v=<meta.generatedAt>` (today's digest is rewritten four times a day and Pages caches for about 10 minutes; the buster keys it to the deploy). Archive digests for earlier days are immutable and are fetched without a buster. `items.json` is fetched once, lazily, with `?v=<meta.generatedAt>`, the first time a category tab is opened or the search box receives input; while loading, the panel shows a single "Loading 7 days of items…" row. Leaderboards and Learn render from `meta.static = { leaderboards, labs, learn }`, which the pipeline copies verbatim from `sources.config.mjs` on every run. The frontend does not import the registry (it is a Node module with regexes and would otherwise have to be duplicated or bundled), yet the registry stays the single source of truth and the UI has no second list to drift.

### 8.2 Tabs, routing, keyboard

Tabs and keys: 1 Brief · 2 Research · 3 News · 4 Labs · 5 Blogs · 6 Releases · 7 Podcasts & Video · 8 Leaderboards · 9 Learn · 0 Archive. Route in `location.hash`: `#brief`, `#research`, `#news`, `#labs`, `#blogs`, `#releases`, `#media`, `#leaderboards`, `#learn`, `#archive`, `#archive/2026-10-18`. Unknown hash -> `#brief`. Range (`24h | 3d | 7d`, default `7d` as the brief describes the category tabs as "the full ranked list over the last 7 days") persists in `localStorage`; source chips and search are per-visit.

Keyboard (ignored while focus is in an input, except `Escape`, which blurs it): `j`/`k` move the cursor over visible rows (`scrollIntoView({ block: 'nearest' })`, `aria-current="true"` on the row), `o` or `Enter` opens the row's URL via `window.open(url, '_blank', 'noopener')`, `s` toggles saved, `r` toggles read, `/` focuses the search box, `Escape` clears search or blurs, digits switch tabs. The cursor resets to the first row when the list changes.

### 8.3 Rendering

Category tabs show items of that category with `surfacedAt` inside the range, sorted by score desc, filtered by the selected source chips (chips = sources of that category that have items, with counts) and by the search query (case-insensitive substring over title + summary, 2+ chars, 120 ms debounce). First 100 rows render; a "Show 100 more" button appends. A row: score pill (tabular numerals), title as `<a target="_blank" rel="noopener noreferrer">`, source chips, relative age (`title` attribute holds the absolute UTC time), signals (`▲435 · 215 comments · 1.2k★`), a two-line clamped summary, a "discussion" link when `discussionUrl` exists, and two icon buttons with `aria-label` ("Mark read" / "Save"). Read rows get `.is-read` (opacity .55); saved rows get `.is-saved`. A "Saved" chip in the filter bar switches the list to all saved items across categories (from the saved snapshot, see 8.4), newest saved first.

Brief tab: the overview paragraph when present (with a small "AI-written" tag), then the six sections with numbered entries: title link, source names, summary, why-line in a distinct color, age. Keyboard navigation works over entries too (same row contract via `data-id`/`data-url`). Archive tab: list of days from `index.json` with reading time; selecting one loads that digest into the same brief renderer; a "Catch up since <last visit>" button loads every digest dated after `lastVisit` (at most 14, in parallel), merges entries by `id` keeping the first (newest) occurrence, groups by day, and renders them in one scroll. Leaderboards: a list of name + one-line blurb + link. Learn: three groups (courses, books, papers) with a checkbox per entry and a "7/16 done" counter.

All text goes through `textContent`/`createTextNode`; nothing from the data is ever assigned to `innerHTML`. Before setting any `href`, the URL is re-parsed and must be `http(s):`; otherwise the link renders as plain text.

### 8.4 Client state in `localStorage` (all keys prefixed `ahead:`)

| key | value | notes |
|---|---|---|
| `ahead:read` | `{ [itemId]: epochMs }` | entries older than 30 days pruned on load |
| `ahead:saved` | `{ [itemId]: { title, url, sourceNames, publishedAt, category, savedAt } }` | a snapshot, so the Saved view survives items rolling out of `items.json`; never pruned automatically |
| `ahead:learn` | `{ [learnId]: epochMs }` | checkbox state |
| `ahead:lastVisit` | epochMs | read at startup into memory first, then overwritten on `visibilitychange`/`pagehide`; Catch-up uses the in-memory previous value |
| `ahead:range` | `'24h'|'3d'|'7d'` | |

Every read goes through `loadJson(key, fallback)` with `try/catch` and a shape check (`typeof === 'object'`); a corrupt value is replaced by the fallback. If `localStorage` throws (private mode, quota), the store falls back to an in-memory object for the session and the header shows nothing special; features keep working for the session.

### 8.5 Header indicators and error states

"Refreshed N min ago" is computed from `meta.generatedAt` and re-rendered every 60 s. Health dot: green when `failedCount === 0` and `generatedAt` is less than 12 h old; amber when `1 <= failedCount <= 5`; red when `failedCount > 5` or `generatedAt` is older than 12 h (the cron missed). Clicking it toggles a `<details>` listing every source with status, kept count and error class.

Load failures have two distinct states. A **404 on `meta.json`** means the pipeline has never committed data (fresh deploy): the panel shows a calm "No data yet. The first refresh runs within six hours; trigger one with `gh workflow run refresh.yml`." and no alert. **Any other failure** (network error, non-404 status, invalid JSON, a digest that parses but lacks `sections`) shows a `role="alert"` banner naming the file and HTTP status with a Retry button; Leaderboards and Learn still render from the last good `meta` or, if none, show a static message. If `items.json` fails, category tabs show the banner in the panel; Brief keeps working.

### 8.6 Visual design and accessibility

Dark by default, light under `@media (prefers-color-scheme: light)`, via custom properties: dark `--bg #0f1115`, `--fg #e7e9ee`, `--muted #9aa3ad` (6.3:1 on bg), `--accent #7ab7ff`, `--why #f0c674`; light `--bg #fafafa`, `--fg #111`, `--muted #555`, `--accent #0a58ca`, `--why #7a5200`. All text pairs are >= 4.5:1. Font: `font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-variant-numeric: tabular-nums;` 14 px body, 13 px rows, 12 px chips (never smaller). Max content width 1100 px; at `<= 640px` the tablist scrolls horizontally, rows stack, buttons stay 40 px tall. Semantic landmarks (`header`, `nav`, `main`, `footer`), `role="tab"`/`aria-selected`/`aria-controls`, `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`, `prefers-reduced-motion` disables the only transition (row opacity). Performance budget: `index.html` < 10 KB, `app.js` < 60 KB, `styles.css` < 15 KB, first paint with the brief from three small JSON fetches.

## 9. GitHub Actions: `.github/workflows/refresh.yml`

```yaml
name: Refresh data and deploy
on:
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:
  push:
    branches: [main]
    paths-ignore: ['data/**']          # recursion guard 1: the bot's data commits never retrigger
concurrency:
  group: refresh
  cancel-in-progress: false            # overlapping runs would race on the data commit
jobs:
  refresh:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: write                  # only this job pushes
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0               # full history so `git pull --rebase` cannot hit shallow-clone edge cases
          persist-credentials: true    # the default; stated because the data commit relies on it
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
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data
          if git diff --cached --quiet; then echo "no data changes"; exit 0; fi
          git commit -m "data: refresh $(date -u +%Y-%m-%dT%H:%MZ) [skip ci]"   # recursion guard 2
          git pull --rebase origin main
          git push origin HEAD:main
      - name: Stage the site
        run: |
          mkdir -p _site
          cp index.html app.js styles.css favicon.svg _site/
          cp -r data _site/data
      - uses: actions/configure-pages@v6
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

Notes: permissions are per job, so the deploy job never holds `contents: write`, and the refresh job never holds the OIDC token. `npm test` gates both the data commit and the deploy, so a broken parser cannot publish garbage; if a secret is unset the env var is empty and `llm.js` treats empty as unset. `git pull --rebase` only matters if someone pushed to `main` during the run; because only the bot writes `data/**`, conflicts cannot occur on data files, and `concurrency` prevents two bot runs from racing. If `git push` still fails (branch protection, transient outage) the job fails visibly and nothing is lost: the next scheduled run regenerates everything from sources. Three independent recursion guards: `paths-ignore: ['data/**']`, `[skip ci]` in the commit message, and GitHub's rule that pushes made with `GITHUB_TOKEN` never start workflows.

The Pages artifact is a staged copy, not the repo root: it contains exactly `index.html`, `app.js`, `styles.css`, `favicon.svg` and `data/`, so the served URL layout is identical to serving the repo root (`/`, `/app.js`, `/styles.css`, `/data/meta.json`, ...) while `node_modules`, `tests/fixtures` (2.3 MB), `src`, `scripts` and `.agents` never ship. Pages must be set to "GitHub Actions" as the source before the first run; this is a one-time setup step in the README and the live verification step (`gh api -X POST repos/Sudish007/ahead/pages -f build_type=workflow`, or Settings -> Pages -> Source -> GitHub Actions). Whether `configure-pages@v6` fails with a clear message when that step was skipped is unverified; the setup step is mandatory either way. GitHub's cron is best-effort and may lag by 10-30 minutes; the UI's "refreshed N min ago" makes that visible rather than alarming.

Repository growth: four data commits a day, each rewriting ~1 MB of JSON; git delta-compresses these well (consecutive files differ by a few hundred items). Rough estimate 30-60 MB per year, acceptable for a personal repo; squashing history is out of scope and noted in the README.

## 10. Error handling matrix

| Operation | Failure | Recoverable? | What the caller sees | Logged |
|---|---|---|---|---|
| Registry load (`sources.config.mjs`) | invalid entry, duplicate id, bad URL/template, github host without `repo`/`minStars` | fatal | `fetch.mjs` prints the offending entry and exits 1; nothing written | error |
| HTTP fetch of a source | DNS/TLS/connection error | yes (1 retry, then source failed) | `meta.sources[id] = { status: 'failed', error: 'network' }`, 0 items, run continues | warn, one line per source |
| | timeout (20 s) | same | `error: 'timeout'` | warn |
| | HTTP 4xx | yes (no retry) | `error: 'HTTP 403'`, `httpStatus` | warn |
| | HTTP 5xx / 429 | yes (1 retry with backoff; none for reddit.com) | `error: 'HTTP 503'` if the retry also fails | warn |
| | body > maxBytes | yes | `error: 'body too large'` | warn |
| | per-source 45 s backstop | yes | `error: 'wall clock'`, 0 items | warn |
| Parse | not XML/JSON, XMLValidator error, unexpected shape | yes | `error: 'parse error: <class>'` | warn |
| | 0 items after filters | yes | `status: 'empty'` (not failed); arXiv additionally triggers the API fallback | info |
| | single malformed item (no title / bad URL / bad date) | yes | item skipped (`skipped` count); bad date -> run time | debug |
| arXiv API fallback | any error | yes | source `empty` if the RSS had 0 items, else RSS items only; `note: 'api fallback failed'` | warn |
| HN `rankUrl` fetch | any error / not an array | yes | items without `extra.hnRank`; status `ok`, `note: 'rank unavailable'` | warn |
| Sitemap page fetch (og:*) | any error | yes | item still produced from the slug and `lastmod`; `extra.titleFrom = 'slug'` | warn |
| Sitemap parser deadline (40 s) | pages still pending | yes | remaining URLs emitted as slug items; `note: 'page fetches truncated (n of m)'` | warn |
| Previous `items.json` | missing | yes | start empty, `meta.note = 'no previous items'` | warn |
| | unparsable / wrong shape | yes | start empty; the broken file is overwritten by this run's output | warn |
| Previous digests | one file unparsable | yes | skipped for repeat suppression; index rebuilt without it | warn |
| Brief build | a section's pool is empty | yes | section with `entries: []` | info |
| LLM call | any (see 7) | yes | heuristic brief, `meta.llm.ok = false` with error class | warn (no key, no body) |
| `items.json` over 2 MB | after the count cap | yes | lowest-scoring items trimmed until under the cap; `meta.trimmedForSize` | warn |
| Output write | `dataDir` not writable / disk error | fatal | exit 1 after printing the path; temp file removed; previous outputs intact (atomic rename) | error |
| Output validation (`schema.js`) | an output fails the schema | fatal | exit 1 before writing; this means a bug | error |
| Run budget (8 min) | pending sources | yes | marked `failed: 'run budget exceeded'`; outputs written | warn |
| Actions: `npm test` | fail | job fails | no data commit, no deploy; previous site stays | Actions log |
| Actions: `git push` | rejected/transient | job fails | next run regenerates; nothing lost | Actions log |
| Frontend: `meta.json` 404 | first deploy, no data yet | yes | "No data yet" state, no alert | none |
| Frontend: meta/digest/index fetch | network / non-404 HTTP / JSON / shape error | yes | `role="alert"` banner with file + status + Retry; static tabs still work | console.error |
| Frontend: items.json fetch | same | yes | banner inside category panels; Brief unaffected | console.error |
| Frontend: `localStorage` | throws | yes | in-memory store for the session | console.warn once |
| Frontend: corrupt stored JSON | parse/shape error | yes | key reset to fallback | console.warn |

## 11. Input validation

External inputs and the rules applied at the trust boundary:
- Feed/JSON bodies: size-capped (8 MB; 1.5 MB for sitemap pages), format sniffed, XML validated by `XMLValidator` before parsing; JSON parsed with `JSON.parse` inside try/catch. Shape checks per parser (`Array.isArray(hits)`, top-level array for HF, `Array.isArray(items)` for GitHub search, array of integers for `rankUrl`); a wrong shape is a parse error for the whole source.
- Per item: `title` required, string, cleaned, 1-200 chars; `url` required, must parse with protocol http/https, max 2,048 chars; `publishedAt`/`surfacedAt` optional, must parse to a Date between 2000-01-01 and `now` (future -> clamped to `now`, invalid -> undefined -> `now`); `summary` optional, cleaned, <= 600; `authors` <= 5 strings <= 80 chars; numeric signals and `extra.hnRank` must be finite non-negative integers (otherwise dropped); `arxivId` must match the id regex.
- Registry: see 4.2 (fatal on failure).
- CLI flags (`scripts/fetch.mjs`): `--source <id[,id]>` (unknown id -> exit 1 with the list of valid ids), `--dry-run`, `--no-llm`, `--data-dir <path>`, `--now <ISO>` (invalid -> exit 1). Flags exist for tests and local debugging.
- Environment: `GITHUB_TOKEN` optional string (only ever sent to `api.github.com`); `LLM_API_KEY` optional, empty string treated as unset; `LLM_BASE_URL` must be `https:` (or `http:` to `localhost`/`127.0.0.1`) or the LLM layer is disabled with an error note; `LLM_MODEL` optional, default applied; `PORT` for `serve.mjs` must be an integer 1-65535 else 8787.
- LLM response: see 7 (field-by-field acceptance; anything unexpected is dropped, never fatal).
- Frontend: `location.hash` matched against the tab whitelist and `^\d{4}-\d{2}-\d{2}$` for archive dates that must also exist in `index.json`; search input used only as a string for `includes`; `localStorage` values shape-checked; every URL re-validated before use as `href`/`window.open`.

## 12. Invariants and who enforces them

| Invariant | Owner | Why there |
|---|---|---|
| A failing source never fails the run | `pipeline.js` per-source try/catch + 45 s backstop | the only place that sees all sources; parsers stay simple and may throw |
| `items.json` ids are unique, every item has `surfacedAt` within retention, and the file is under 2 MB | `dedup.js` (Map by id), the retention and size-cap steps in `pipeline.js`; checked by `schema.js` and the smoke test | dedup is where identity is defined; the schema check turns a logic bug into a loud failure instead of a corrupt site; the size cap keeps an unattended dashboard from stalling |
| Brief `wordCount <= 1100`, computed the same way everywhere in the pipeline | `brief.js` budget step, re-run after LLM; `countWords` exported for the test | single word-counting function; the UI displays the stored `wordCount`/`readingMinutes` and never recounts |
| Previous days' digests are never rewritten | `pipeline.js` writes only `digests/<today>.json`; `index.json` is derived from the directory | keeps the Archive stable and auditable |
| No secrets in `data/` or logs | `llm.js` reads the key from env and never includes it in errors; `http.js` redacts `authorization` in error messages | the two modules that touch credentials |
| Every URL in outputs is http(s) | `normalize.js` (`canonicalizeUrl` returns null otherwise -> item skipped) | one choke point before anything is stored |
| arXiv API is never hit faster than one request per 3 s | `http.js` per-host pacing (applies to every caller) | the only place all requests pass through |
| Every number in a why-line is a stored fact | `brief.js` heuristic reads only item fields; `llm.js` prompt forbids invention and accepts text only | the brief's credibility; the HN rank comes from `topstories.json`, never from hit order |
| UI never injects untrusted HTML | `app.js` render helpers use `textContent` only; CSP forbids inline script and style | defense in depth for a public static site |
| Registry is the single source of truth for sources, link-outs, learn | `sources.config.mjs`; pipeline copies `linkouts`/`learn` into `meta.static` | the UI has no second list to drift |

## 13. Testing

Unit tests are fixture-driven and offline; fixtures in `tests/fixtures/` were captured from the real endpoints during the probe and trimmed (`tests/fixtures/README.md` lists each file's upstream capture and item count; `.gitattributes` keeps them byte-exact). Every test that depends on dates pins `now = new Date('2026-10-19T12:00:00Z')`, the fixtures' capture day.

`tests/helpers.js` exports `ROOT`, `FIXTURES`, `read(name)`, `NOW`, and `fixtureFetch({ now = NOW, overrides = {} })`, which builds a `fetchImpl` from a two-level map: first an exact map from every registry URL (templates expanded with `now`), every `fallbackUrl`, and every `rankUrl` to a fixture when one exists (`arxiv-cs.LG` -> `arxiv-rss-cs.LG.xml`, `arxiv-cs.AI` -> `arxiv-rss-cs.AI-empty.xml`, all four `fallbackUrl`s -> `arxiv-api-cs.LG.xml`, `hf-papers`, `hn-top` -> `hn-algolia-bydate.json`, `hn-front` -> `hn-algolia-front.json`, `rankUrl` -> `hn-topstories.json`, `reddit`, `openai`, `anthropic` -> `anthropic-sitemap.xml`, `deepmind`, `google-research`, `meta-newsroom-ai`, `nvidia-dev`, `hf-blog`, `allenai`, `mistral`, `transformer-circuits`, `interconnects` -> `substack-interconnects.xml`, `simonw`, `alignmentforum`, `thebatch` -> `deeplearning-sitemap.xml`, `epoch`, `karpathy-bearblog`, `gh-rel-pytorch`, `gh-rel-vllm`, `gh-rel-llamacpp`, `gh-trending-llm` -> `gh-search-llm.json`, `gh-trending-ml` -> `gh-search-ml.json`, `hf-trending`, `pod-mlst`, `pod-cogrev`, `yt-gpumode`); then a fallback by kind for the rest: `arxiv` -> `arxiv-rss-cs.LG.xml` (cs.CL, cs.CV), `rss` -> `openai-news.xml`, `rss` with `category: 'media'` -> `podcast-mlst-anchor.xml`, `atom` -> `simonwillison-atom.xml`, `github` releases -> `gh-releases-vllm.xml`, `github` search -> `gh-search-llm.json`, `youtube` -> `youtube-gpumode.xml`, `sitemap` -> `anthropic-sitemap.xml`, `hn` -> `hn-algolia-front.json`, `reddit` -> `reddit-multi-rss.xml`, `json` by parser -> `hf-daily-papers.json` / `hf-trending-models.json`. With the registry in 4.2 the exact map covers 31 sources and the kind fallback the other 33 (2 arxiv, 18 rss, 2 podcast rss, 5 github releases, 1 github search, 5 youtube); `registry.test.js` asserts that every source resolves to a fixture so a new source without a mapping fails the suite instead of the pipeline test. Any `text/html` request (sitemap article pages) gets a generated page `<title>{slug} \ Site</title><meta property="og:title" content="OG {slug}"><meta property="og:description" content="Desc {slug}"><meta property="article:published_time" content="{lastmod}">`. `overrides` maps a URL to `{ status }`, `{ body }` or `{ throw: Error }`. Unmapped URLs throw, so a test cannot silently pass on a missing mapping. Responses carry the content type the real endpoint sent (`text/plain` for Mistral).

- `normalize.test.js`: `canonicalizeUrl` table (utm/ref/fbclid stripping, trailing slash, `/index.html`, http->https, `www.`, `//` path collapse, youtube/youtu.be, HN item id kept, sorted query, invalid -> null, `javascript:` -> null); `extractArxivId` (abs, pdf with `.pdf`, `v3`, `huggingface.co/papers`, alphaxiv, old-style `cs/0112017`, text prefix `arXiv:2610.22379v1 Announce Type`); `cleanText` (CDATA, entities, nested tags, scripts); `parseDate` (RFC 822 with `-0400`/`GMT`/`-0000`, ISO with offset, garbage -> undefined, future -> clamp); `toItem` `at` derivation for each parser kind and the `maxAgeDays` rule (an HF model with `createdAt` 2025 and `surfacedAt = now` passes; an undated item passes with `at = now`; a feed item 8 days old is dropped).
- `http.test.js`: pacing with an injected clock: three requests to `export.arxiv.org` issued concurrently complete at t = 0, 3000, 6000 ms; one request each to two unpaced hosts complete without waiting; retry on 503 once, no retry on 403, no retry for `www.reddit.com` 429; `maxBytes` abort; `authorization` redacted from error messages.
- `feed.test.js`: every XML fixture parses to the expected count, first title, first date and link; `mistral-news-rss.xml` parses despite `text/plain`; `hf-blog.xml` yields items with empty summaries; `substack-interconnects.xml` -> 5 items of which exactly 2 have `enclosureType` starting `audio/` and re-route to `media`, the other 3 stay `blogs`; `youtube-gpumode.xml` yields `ytViews` and uses `published` not `updated`; `epoch-atom.xml` CDATA title; `allenai-rss.xml` ISO `-08:00` date; `smol-ainews.xml` content:encoded-only items get a summary and `bodyLength`.
- `arxiv.test.js`: `arxiv-rss-cs.LG.xml` (18 items: 10 new, 3 cross, 3 replace, 2 replace-cross) -> exactly 13 kept, none of the kept ids is in the replace set `{1906.07073, 2306.02002, 2503.15889, 2307.07030, 2310.16659}`, ids extracted, abstract prefix stripped, authors split, `extra.primaryCategory === 'cs.LG'` for the first item; `arxiv-rss-cs.AI-empty.xml` -> 0 items -> fallback invoked through the injected `fetchText` with `arxiv-api-cs.LG.xml` -> 10 items with versionless ids, `extra.via = 'api'`, `extra.primaryCategory` from `arxiv:primary_category`, `note: 'api fallback'`; fallback throwing -> `status: 'empty'`, `note: 'api fallback failed'`.
- `json.test.js`: `hn-algolia-bydate.json` -> keyword filter keeps exactly the 9 listed ids and excludes 50150750; `hn-algolia-front.json` -> keeps exactly the 8 listed ids; with `rankUrl` mapped to `hn-topstories.json` every kept hit has `extra.hnRank` in 1..30 and 50145337 -> 10, 50150434 -> 4; with the `rankUrl` fetch throwing -> no `hnRank`, status `ok`, `note: 'rank unavailable'`; `hf-daily-papers.json` -> arxivId, upvotes, `surfacedAt = submittedOnDailyAt`; `hf-trending-models.json` -> `hfLikes`, `surfacedAt = now`; `gh-search-llm.json` -> `minStars: 50` keeps 8, `minStars: 100` keeps 5, `ghStars` set; `gh-search-ml.json` -> `minStars: 50` keeps 0 and the source reports `empty`.
- `reddit.test.js`: `reddit-multi-rss.xml` -> 12 items, subreddit from category, external `[link]` extraction for the 4 link posts (3 × huggingface.co, warlock.ai), permalink for the 8 Reddit-hosted ones (`i.redd.it`, `www.reddit.com/gallery/...`, comments permalinks), boilerplate removed.
- `github.test.js`: `gh-releases-pytorch.xml` -> 0 (all slash tags) and status `empty`; `gh-releases-vllm.xml` -> 3 with tags; `gh-releases-llamacpp.xml` -> `b11730`-style tags kept, `maxItems: 3` respected.
- `sitemap.test.js` (`now` pinned): `anthropic-sitemap.xml` -> exactly the 15 news/research/engineering URLs with `lastmod` within 7 days, newest first, the 30 URLs without `lastmod` skipped; `deeplearning-sitemap.xml` with the `thebatch` include/exclude -> the 2 articles within 7 days (`metas-muse-wonder-rivals-top-models`, `anthropic-gives-claude-haiku-a-big-update`), `issue-374`/`issue-373` excluded, `tag/` pages and `/the-batch/about` (no lastmod) never considered, 9 articles with `maxAgeDays: 14`; page fetch mocked to return og tags -> title/summary/publishedAt from the page; mocked to throw -> slug title, `extra.titleFrom = 'slug'`; a page whose `article:published_time` is 30 days old -> dropped; a mocked `fetchText` that never resolves plus `deadlineAt` already passed -> every URL emitted as a slug item with `note: 'page fetches truncated (n of m)'`; URLs already in `previousItemsByCanonicalUrl` -> no fetch, stored fields reused.
- `dedup.test.js`: arXiv RSS + HF Papers + HN items with the same id merge into one item with three sources, `url === 'https://arxiv.org/abs/<id>'`, the HF page in `sources[].url`; two arXiv categories count as one family; signals max; category precedence; `publishedAt` min / `surfacedAt` max; title from the heavier source; `extra` merged with `hnRank` only from the fresh run.
- `score.test.js`: the worked example from 5.7 asserts `round2(A) === 13.25`, `round2(B) === 23.00` and `B > A`; decay halves at 36 h; bonus capped at 12 with five families; missing signals contribute 0.
- `brief.test.js`: a synthetic item set with 600-char summaries -> six sections populated with the right counts, `wordCount <= 1100`, `readingMinutes <= 5`, no id from "yesterday's" digest reused, deep read not repeating a `deepReadId` from the last 14 days, weekend fallback (36 h pool too small -> 72 h), an empty pool -> `entries: []`; with `targetWords: 880` the heuristic brief fits 880 and a 220-word overview keeps the total under 1,100; the trim order is observed (the `analysis` section's last entry is trimmed before any `must-know` entry); the why-line for an item with `extra.hnRank` starts with `#`, and without it starts with `on HN front page`.
- `llm.test.js`: mocked fetch returning valid JSON -> overview and why lines applied, budget still holds; returning prose with embedded JSON -> extracted; a 300-word overview -> rejected, why-lines still accepted; returning garbage / HTTP 500 / timeout -> heuristic untouched and `meta.llm.ok === false`; the request body contains no key, `max_tokens` is 1500 and the Authorization header is set; `LLM_BASE_URL=ftp://x` and `http://api.example.com` -> disabled, `http://localhost:11434/v1` -> enabled.
- `pipeline.test.js` (integration, in-process, `now` pinned): `run()` with `fixtureFetch({ overrides: { [reddit url]: { status: 403 }, [mistral url]: { throw: new TypeError('fetch failed') } } })` and `dataDir` = a temp directory -> completes, writes four files, `meta.failedCount === 2` (reddit `HTTP 403`, mistral `network`), `meta.okCount + meta.emptyCount === 62`, `okCount >= 40`, digest validates, `items.json` ids unique and under 2 MB, `meta.sources['arxiv-cs.AI'].note === 'api fallback'`, `meta.sources['hn-front']` items carry `extra.hnRank`; a second `run()` with `now + 24 h` keeps the stored HN items (retention/merge), does not rewrite the first day's digest, and does not repeat its `itemIds`.
- `registry.test.js`: `sources.config.mjs` passes the validation rules; exactly 64 sources; every `type` has a parser; weights 1-10; ids unique; every `github` entry satisfies the host rule; `rankUrl` only on `hn`.
- `data-shape.test.js` (smoke): if `data/items.json`, `data/meta.json`, `data/digests/index.json` exist, they validate against `schema.js`, `items.json` is at most 2 MB (the pipeline's own cap), every digest listed in the index exists and has `wordCount <= 1100`; skipped with a message when `data/` is empty (fresh clone).

Integration (manual, in the brief's verification step): live `npm run fetch` with per-source counts (`>= 25` sources with items), `npm run probe`, Playwright screenshots at 1440/390 px of Brief, Research, Archive, Learn, keyboard `j`/`k`/`o` driven in Playwright (the opened URL asserted via a `popup` event), console clean, then the Actions run and the live `meta.json` over HTTP, and one pipeline run with the chosen `LLM_MODEL` if a key is configured.

## 14. Edge cases

- Weekend: all four arXiv RSS feeds are empty (`<skipDays>`), so each falls back to the API, paced 3 s apart by `http.js`, and reports `ok` with `note: 'api fallback'`; the API lists papers submitted since Friday that arXiv will announce on Monday, and their ids dedup with Monday's RSS items. HF Papers returns an empty array for Sat/Sun dates and reports `empty`. The brief widens to 72 h; Research may still be thin. Correct behavior, not a failure.
- arXiv cs.AI RSS empty on a weekday (observed three times on probe day): API fallback fills it; `note: 'api fallback'`.
- The same paper in cs.LG and cs.AI: one item, two sources, one family, no bonus.
- HN story linking to `arxiv.org/pdf/...v2`: canonicalizes to the abs URL and merges with the HF Papers / arXiv item; the merged `url` is the abs page.
- HN front page: Algolia's hit order is by points; the rank shown comes from `topstories.json`. A story on Algolia's `front_page` list that has already fallen off HN's top 30 gets no rank and the why-line says "on HN front page, N points".
- Reddit 403/429 from Actions IPs: `failed`, 0 items, amber dot; the single-request, no-retry design means no hammering.
- GitHub search unauthenticated locally (10/min): three requests, 1 s apart, fine; in Actions the token raises the limit. topic:machine-learning rarely clears the 50-star floor and reports `empty`.
- Feeds with all items sharing one date (arXiv) or no dates (rare): decay uses the shared date / run time; ordering within falls back to score then title.
- Sitemap `lastmod` bumped for an edited old page: dropped via `article:published_time`; if the page has no such tag, the item appears once with `publishedAt = lastmod` (acceptable, rare). Sitemap URLs without `lastmod` are never items.
- First run against a sitemap: up to 10 page fetches at concurrency 4; a slow publisher cannot push the source past 40 s because the parser truncates to slug titles and the next run fills the titles in (the slug items are in `previousItemsByCanonicalUrl`, but a stored item whose `extra.titleFrom === 'slug'` is re-fetched once).
- Release feeds dominated by CI tags (pytorch, torchtitan): zero items most runs; `empty`, not `failed`.
- Items older than 7 days still "trending" (HF models created months ago): kept while `surfacedAt` (first seen) is within 7 days; displayed date is the real `createdAt`.
- Clock skew / scheduled posts with future dates: clamped to `now`.
- A run straddling midnight UTC: the digest date is fixed at run start.
- Two digests regenerated for "today" during the day: entries may move between sections; `itemIds` of previous days are the only repeat filter.
- Titles with HTML or emoji, CDATA inside CDATA, numeric entities: handled by `cleanText`; tests cover the fixtures that exhibit them.
- A source that redirects permanently (SemiAnalysis did): `finalUrl` is recorded in `meta.sources[id].note` when it differs from the registry URL so the README's source list can be updated.
- `items.json` missing on first ever run: pipeline starts empty; the UI shows the "No data yet" state (8.5) until the first Actions run commits.
- `items.json` growing past 2 MB (an unusually busy week): the size cap trims the lowest-scoring items and records `trimmedForSize`; no human action needed.
- Saved items whose source item has rolled off: the snapshot in `ahead:saved` renders them with a "no longer in the 7-day window" hint.
- Very long titles (some arXiv titles exceed 200 chars): truncated at 200 with an ellipsis; the full title is in the `title` attribute.

## 15. Local development and README outline

Scripts (`package.json`): `fetch` -> `node scripts/fetch.mjs`; `probe` -> `node scripts/probe-sources.mjs`; `serve` -> `node scripts/serve.mjs` (PORT default 8787); `test` -> `node --test "tests/**/*.test.js"`. Typical loop: `npm run fetch -- --source hn-top,hf-papers --dry-run` to debug one parser, `npm run fetch` for real data, `npm run serve` and open `http://localhost:8787/`. `probe-sources.mjs` reuses `http.js` and the parsers to print `id | status | items | ms | note | finalUrl` for every registry entry, which doubles as the brief's "verify each URL actually returns data" check after any registry change.

README sections: what Ahead is; the source list by category with the alternates chosen and why (Anthropic/The Batch via sitemap, Meta via Newsroom + Engineering feeds, SemiAnalysis newsletter, Epoch atom, Jay Alammar newsletter, Horace He Substack, Reddit single multireddit request, Latent Space podcast via the publication feed, AI News via the Latent Space `[AINews]` posts instead of the stale smol.ai feed); how ranking works (formula from 5.7 with the worked example); how the brief is built and the 1,100-word rule; how to add a source (one line, `npm run probe`); the optional LLM key with provider base URLs and "any current model id"; the one-time Pages setup command; the cron schedule and how to trigger a run manually (`gh workflow run refresh.yml`); local commands; data file formats; known limits (Reddit has no scores; GitHub cron lag; repo growth).

## 16. Assumptions and risks

- Reddit may block GitHub Actions IPs entirely; the design degrades to no Reddit items without affecting anything else. If that happens consistently, the README documents it and the source stays in the registry (it works from residential IPs for local runs).
- Publishers change URLs or formats. `npm run probe` plus `meta.sources` status make this visible within one run; the registry edit is one line.
- GitHub Pages caches responses for about 10 minutes; `cache: 'no-cache'` on `meta.json`/`index.json` and the `?v=` buster on `items.json` and today's digest keep the UI consistent with the latest deploy.
- The LLM layer is a convenience; its quality depends on the model chosen. It can never block or alter the data layer. Model ids were not verified in the probe; the live step verifies the chosen one.
- `items.json` size is the main performance risk; retention rules, the 3,000-item cap and the 2 MB size cap guard it.
- `configure-pages@v6` behavior when Pages is not yet enabled is unverified; the one-time setup command is a mandatory step, not a fallback.
- The `sitemap` type, the `hfLikes`/`ytViews` signals and the `topstories.json` request are the only deviations from the brief's vocabulary; all are additive and documented here and in the README.

## 17. Deviations from the brief, for the reviewer

All additive; none changes the ARCHITECTURE section's decisions.

| Brief says | Design does | Why |
|---|---|---|
| type ∈ rss, atom, json, arxiv, hn, reddit, github, youtube | adds `sitemap` | Anthropic and The Batch have no feed; their `sitemap.xml` + `og:*` page tags are stable and verified (probe L2a, B12a, both passes). Link-out was the alternative; losing Anthropic from "From the labs" was judged worse. |
| signals: hnPoints, hnComments, hfUpvotes, redditScore, ghStars | also optional `hfLikes`, `ytViews` | present in the HF models and YouTube responses at no cost; `redditScore` stays in the shape but is never populated because Reddit's Atom feed carries no counts (probe N4). |
| item shape as listed | adds `surfacedAt`, `readMinutes`, `discussionUrl`, `authors`, `tag`, `extra` | `surfacedAt` separates "when it became news" from the item's own date so an old post that tops HN today ranks and displays truthfully; `authors` is required by the brief's arXiv bullet; the rest feed the why-lines. |
| HN via Algolia | one extra request per run to `hacker-news.firebaseio.com/v0/topstories.json` | Algolia's `front_page` hits are sorted by points, not position (probe N2/N7); the true rank is a 4.5 KB unauthenticated request away and the why-line must not print a fake number. |
| AI News (smol.ai) as a fetched source | not fetched; link-out in the Labs panel | feed stale since 2026-09-09 in both passes; the issues publish inside the Latent Space feed (`[AINews]` posts), which is fetched (probe B13). |
| Reddit `top.json` with `.rss` fallback per subreddit | one multireddit `.rss` request | JSON is 403 everywhere; Reddit allows one unauthenticated request per minute (probe N3-N6). |
| Latent Space podcast feed | episodes taken from the Latent Space publication feed via audio enclosures | the podcast feed is 14 MB per fetch; the publication feed has the same episodes (probe P3). |
| upload-pages-artifact of "the site root" | a `_site` staging copy of index.html, app.js, styles.css, favicon.svg, data/ | the served URL layout is identical to the repo root; `node_modules`, tests, `src`, `scripts` and `.agents` stay out of the artifact. |
| category tabs "over the last 7 days" with a 24h/3d/7d toggle | default range `7d`, toggle persisted | literal reading of the brief. |
| registry `{ id, name, category, type, url, weight, ... }` | adds optional `family`, `maxItems`, `maxAgeDays`, `maxBytes`, `longForm`, `fallbackUrl`, `rankUrl`, `include`/`exclude`, `minStars`, `repo`, `parser`, `template` | all optional for a plain feed; a one-line source is still `{ id, name, category, type, url, weight }`. |

## 18. Responses to the design review (iteration 1 -> 2)

All 7 MEDIUM and 16 NIT findings are addressed; none is backlogged or ignored. Fixture changes were made in this iteration and verified with fast-xml-parser 5.11.2 (`%TEMP%\ahead-probe\verify-fixtures2.mjs`).

| # | Sev | Response |
|---|---|---|
| 1 | MED | **Addressed.** 5.4 now defines `sources[0].at = raw.surfacedAt ?? raw.publishedAt ?? now` per parser kind (feeds/arXiv/HN/Reddit/YouTube/GitHub releases -> publishedAt; HF papers -> submittedOnDailyAt; HF models/GitHub search -> now; sitemap -> `article:published_time ?? lastmod`, never now) and states that `maxAgeDays` compares against `raw.surfacedAt ?? raw.publishedAt` with undated items passing. 4.1 and 14 reference the same rule. |
| 2 | MED | **Addressed.** 5.3 sitemap: page fetches at concurrency 4, `timeoutMs 8000`, own deadline `start + 40 s`, remaining URLs emitted as slug items, status `ok`, `note: 'page fetches truncated (n of m)'`. 5.1 calls the 45 s wall clock a backstop (`error: 'wall clock'`). Worst-case arithmetic (44 s) stated. Error matrix (10) has both rows. |
| 3 | MED | **Addressed, with the optional variant.** Probe pass 2 confirmed the hit order is by points and that `topstories.json` (same minute) contains all 30 front-page hits within its first 30 ids. The `hn-front` entry gets `rankUrl`; the parser derives `extra.hnRank`, falls back to no rank on any failure (`note: 'rank unavailable'`), and the why-line prints `#n` only when the rank exists (6.3). `extra.hnRank` is ephemeral across runs (5.8). The fixture pair `hn-algolia-front.json` + `hn-topstories.json` is committed. Probe N2 corrected, N7 added. |
| 4 | MED | **Addressed.** `substack-interconnects.xml` re-trimmed to items 0-3 and 17 of the raw capture: 5 items, 2 `audio/mpeg` enclosures (verified). `feed.test.js` asserts 2 audio -> `media`, 3 -> `blogs`. README row corrected. |
| 5 | MED | **Addressed.** `arxiv-rss-cs.LG.xml` re-trimmed to 10 new + 3 cross + 3 replace + 2 replace-cross (18 items; 13 kept; verified). `arxiv.test.js` asserts 13 kept and no kept id in the five replace ids. README row corrected. |
| 6 | MED | **Addressed.** 13 specifies `tests/helpers.js` `fixtureFetch` with the exact-URL map (templates and `fallbackUrl`/`rankUrl` included) and the by-kind fallback, generated HTML for article pages, and unmapped URLs throwing. `pipeline.test.js` asserts `failedCount === 2` and `okCount + emptyCount === 62` (registry is 64 after finding 19). |
| 7 | MED | **Addressed.** Pacing moved into `http.js` (5.2): per-host promise chain + minimum gap for `export.arxiv.org`/`rss.arxiv.org`/`api.github.com`, applied to every request including fallbacks, sitemap pages and `rankUrl`; `rateGroup` removed from the registry. 14 rewrites the weekend case: four API fallbacks paced 3 s apart, status `ok` with `note: 'api fallback'`, ids dedup with Monday's RSS. New `http.test.js` with an injected clock. |
| 8 | NIT | **Addressed.** 5.7 states 13.25 and 23.00 (recomputed); `score.test.js` asserts both `round2` values and `B > A`. |
| 9 | NIT | **Addressed.** 12 no longer claims the UI reuses `countWords`; 6.4 and 12 say the UI displays the stored `wordCount`/`readingMinutes`. |
| 10 | NIT | **Addressed.** 6.4: explicit trim order (analysis -> labs -> releases -> research -> deep-read -> must-know, last entry first; must-know only in pass 2); `targetWords = 880` when the LLM is enabled, overview acceptance tightened to 80-220 words so 880 + 220 = 1,100 without eviction; `max_tokens` 1500 (7). `brief.test.js` covers the order and the 880 target. |
| 11 | NIT | **Addressed.** 4.1: `github` dispatch by host with `repo` / `minStars` required and validated (4.2 rules, `registry.test.js`); `parser` comment is `hf-papers | hf-models`; `extra.primaryCategory` defined in 5.3 (RSS `<category>[0]`, verified present in the fixture; API `arxiv:primary_category@term`) and used by the research why-line. |
| 12 | NIT | **Addressed.** 5.3: sitemap URLs without `lastmod` are skipped (30 of 566 Anthropic, 291 of 3,400 deeplearning.ai). All date-dependent tests pin `now = 2026-10-19T12:00:00Z` (13); the Anthropic assertion is 15 URLs at that instant. |
| 13 | NIT | **Addressed.** New fixture `deeplearning-sitemap.xml` (18 of 3,400 URLs: 10 newest articles, `/the-batch/about` without lastmod, 2 `issue-NNN`, 2 `tag/`, 3 non-batch). `sitemap.test.js` asserts 2 articles within 7 days, 9 within 14, issues excluded, tags and about never considered. |
| 14 | NIT | **Addressed.** `json.test.js` asserts `minStars: 100` keeps 5 of `gh-search-llm.json`, and the new `gh-search-ml.json` (5 repos, 24..11 stars) keeps 0 with `minStars: 50` and reports `empty`. |
| 15 | NIT | **Addressed.** 5.3 reddit: Reddit-hosted when the host equals or ends with `.reddit.com` or `.redd.it`; `reddit.test.js` lists the 4 external / 8 hosted split. |
| 16 | NIT | **Addressed.** 5.6: items with `arxivId` always use `https://arxiv.org/abs/<id>`; the HF page stays in `sources[].url` as the HF chip link; `dedup.test.js` asserts it. |
| 17 | NIT | **Addressed.** 9: per-job `permissions` (`refresh`: `contents: write`; `deploy`: `pages: write`, `id-token: write`), `persist-credentials: true` stated explicitly with the reason. |
| 18 | NIT | **Addressed.** 8.1: today's digest is fetched with `?v=<meta.generatedAt>`; archived days are immutable and fetched plainly. |
| 19 | NIT | **Addressed (dropped).** Re-probed: still stale (newest 2026-09-09, 2.25 MB) while 11 of 20 Latent Space items are `[AINews]` posts. Removed from `sources`, added to `linkouts.labs` with a one-line explanation, listed in 17 as a deviation from the brief's source list; registry is 64. The `smol-ainews.xml` fixture stays as a parser edge case. |
| 20 | NIT | **Addressed.** 7: "any current model id from the provider's model list", verified once in the live step; the five provider base URLs were probed (all answer `chat/completions` with a bad-key 401/400, so the Anthropic compatibility path and Bearer auth are confirmed to exist); `LLM_BASE_URL` must be `https:` unless the host is `localhost`/`127.0.0.1` (7, 11, `llm.test.js`). |
| 21 | NIT | **Addressed.** 5.4 `url` comment: "the URL as given by the source (never fetched; only source feeds follow redirects)". |
| 22 | NIT | **Addressed.** 5.8: after the 3,000-item cap the pipeline trims the lowest-scoring 5 % until the serialized file is under 2 MB and records `meta.trimmedForSize`; `data-shape.test.js` only asserts the cap held; 12 and 14 updated. |
| 23 | NIT | **Addressed.** 8.5: a 404 on `meta.json` is the "No data yet" state with no alert; every other failure is the `role="alert"` banner; 10 and 14 agree. 8.1 spells out the CSP consequence: classes in `styles.css` and CSSOM only, no `style=""` attributes. |

Review items marked unverified, now resolved where possible: live HTTP results re-probed in pass 2 (70/70 at 200); the Anthropic OpenAI-compatible endpoint exists and reads the Bearer header (401 "Invalid Anthropic API Key"); model ids remain deliberately unverified (live step). Still unverified: `configure-pages@v6` behavior without prior Pages enablement (the setup command is mandatory, 9 and 16). The brief's own text was not available to this iteration either; fidelity is argued in 17 against the brief as quoted in the task prompt (sources, type enum, outputs, cron, deploy actions, permissions).

