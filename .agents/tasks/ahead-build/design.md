# Ahead — technical design

Companion to `source-probe.md` (same folder), which records what every source URL actually returned on 2026-10-19. This document fixes every architectural decision the implementation needs; the brief's ARCHITECTURE section is taken as given and is not re-argued here.

## 1. Overview

Ahead is a static single-page site plus a Node data pipeline. The pipeline (`scripts/fetch.mjs`, logic in `src/`) runs in GitHub Actions every 6 hours, fetches 65 sources declared in `sources.config.mjs`, turns everything into one normalized item shape, deduplicates by canonical URL and arXiv id, scores items with a source-weight × recency formula plus log-scaled engagement and a cross-source bonus, merges the result with the previous `data/items.json` so that 7 days of items survive even when a feed only shows the last 24 hours, and writes `data/items.json`, `data/digests/YYYY-MM-DD.json`, `data/digests/index.json` and `data/meta.json`. The daily brief is built deterministically from the ranked items under a hard 1,100-word budget; an optional OpenAI-compatible LLM call rewrites the "why it matters" lines and adds a 150-200 word overview, falling back silently to the heuristic text. The frontend (`index.html`, `app.js`, `styles.css`, no build step) renders the brief first, loads `items.json` lazily for the category tabs, and keeps read/saved/learn state in `localStorage`. One workflow (`.github/workflows/refresh.yml`) runs tests, runs the pipeline, commits `data/` back with the bot identity, and deploys the site to GitHub Pages.

Two things in the probe forced small, deliberate extensions of the brief's vocabulary, both called out where they appear: a `sitemap` source type (Anthropic and The Batch publish no feed but do publish `sitemap.xml` with `lastmod`), and two optional extra signal keys (`hfLikes`, `ytViews`) because the data is there and free.

## 2. Technology stack (locked)

- Runtime: Node 24 in Actions (`actions/setup-node@v7`, `node-version: 24`), `engines.node >= 22` locally (dev machine has v24.16.0). ESM everywhere (`"type": "module"`).
- Dependencies: `fast-xml-parser` 5.11.2 (moved from devDependencies to dependencies; the pipeline needs it at runtime after `npm ci`). Nothing else. No framework, no bundler, no TypeScript.
- HTTP: built-in `fetch` (undici), which transparently handles gzip. No request library.
- Tests: `node:test` + `node:assert/strict`, `node --test "tests/**/*.test.js"`.
- Frontend: vanilla ES2022 module, CSS custom properties, system font stack, no web fonts, one SVG favicon.
- Hosting/CI: GitHub Pages via `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5`, `actions/deploy-pages@v5`; `actions/checkout@v7`.
- Screenshots (verification only): Playwright 1.64.0 reused from `../hoshlab/node_modules`; add as a devDependency only if that proves awkward.

## 3. Repository layout

```
ahead/
  index.html  app.js  styles.css  favicon.svg          # the site (served from repo root via a _site staging copy)
  sources.config.mjs                                   # the single declarative registry (sources, link-outs, learn)
  scripts/fetch.mjs        # CLI entry: parse flags, call src/pipeline.js run(), print the per-source table, exit 0
  scripts/probe-sources.mjs# fetch+parse every source, print status/count/ms; no writes (npm run probe)
  scripts/serve.mjs        # node:http static server, PORT default 8787, MIME map, gzip (template: ai-batkahi)
  src/http.js              # fetchText(): timeout, size cap, retry, UA, Accept
  src/parsers/feed.js      # rss|atom|youtube|github-releases over fast-xml-parser
  src/parsers/arxiv.js     # arXiv RSS + API fallback
  src/parsers/json.js      # hn, hf-papers, hf-models, github-search
  src/parsers/reddit.js    # Reddit Atom (external link extraction)
  src/parsers/sitemap.js   # sitemap.xml + og:* page metadata
  src/normalize.js         # canonicalizeUrl, extractArxivId, stripHtml, cleanText, parseDate, itemId
  src/dedup.js             # mergeItems(), family logic, category precedence
  src/score.js             # score(item, now)
  src/brief.js             # buildBrief(items, previousDigests, now)
  src/llm.js               # editorialize(brief, env, fetchImpl)
  src/pipeline.js          # run({ sources, now, dataDir, fetchImpl, env }) -> { items, brief, meta }
  src/schema.js            # tiny validators for Item / Digest / Meta (used by tests and by the pipeline before writing)
  data/items.json  data/meta.json  data/digests/*.json  data/digests/index.json
  tests/*.test.js  tests/helpers.js  tests/fixtures/*  # fixtures already captured (see tests/fixtures/README.md)
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
  id: 'interconnects',          // stable slug: [a-z0-9.-]+, unique; used in meta.json, item.sources[] and UI chips
  name: 'Interconnects',        // display name
  category: 'blogs',            // research | news | labs | blogs | releases | media
  type: 'rss',                  // rss | atom | json | arxiv | hn | reddit | github | youtube | sitemap
  url: 'https://www.interconnects.ai/feed',
  weight: 7,                    // 1..10, see 6.5
  homepage: 'https://www.interconnects.ai',   // optional, shown on hover / in the source list
  family: 'interconnects',      // optional, default = id; sources sharing a family never earn a cross-source bonus together
  maxItems: 40,                 // optional, default 40; items kept from this source per run after filtering
  maxAgeDays: 7,                // optional, default 7; older items are discarded at parse time
  maxBytes: 8_000_000,          // optional, default 8 MB response cap
  rateGroup: 'arxiv-api',       // optional, default = hostname; sources in one group are fetched sequentially (5.2)
  longForm: true,               // optional, default false; eligible for "One deep read" even when readMinutes is unknown
  // type-specific (all optional):
  parser: 'hf-papers',          // json only: hf-papers | hf-models | hn | github-search (hn/github have their own type)
  fallbackUrl: '...',           // arxiv only: API query used when the RSS feed yields 0 items
  repo: 'vllm-project/vllm',    // github releases: display name for release titles
  minStars: 50,                 // github search: floor on stargazers_count
  include: /regex/,             // sitemap: URL must match
  exclude: /regex/,             // sitemap: URL must not match
  template: true,               // url contains {{unix24hAgo}} / {{date7dAgo}} placeholders expanded at run time
}
```

`category` drives the tab the item lands in; `media` is the "Podcasts & Video" tab. `type` picks the parser; `rss` and `atom` both go to `parsers/feed.js`, which sniffs the actual format (Mistral serves RSS as `text/plain`, Google as `text/xml`; the header is never trusted).

### 4.2 The initial registry (every line was verified in the probe)

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
  { id: 'hn-front', name: 'HN front page', category: 'news', type: 'hn', url: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50', weight: 6, family: 'hn', maxItems: 30 },
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
  { id: 'smol-ainews', name: 'AI News (smol.ai)', category: 'blogs', type: 'rss', url: 'https://news.smol.ai/rss.xml', weight: 3, maxItems: 5 },
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

Registry validation runs at pipeline start and in a unit test: unique ids, valid category/type, weight integer 1-10, url parses as http(s), `template` urls contain only known placeholders, `arxiv` entries have `fallbackUrl`, `sitemap` entries have `include`. A bad registry is a fatal, pre-fetch error (exit 1) because it is a programmer mistake, not a runtime condition.

## 5. The pipeline (`scripts/fetch.mjs` -> `src/pipeline.js`)

### 5.1 Run orchestration

`run({ sources, now = new Date(), dataDir = 'data', fetchImpl = globalThis.fetch, env = process.env, onlySourceIds, dryRun, noLlm })` does, in order:

1. Validate the registry (4.2). Expand `template` URLs: `{{unix24hAgo}}` = `floor(now/1000) - 86400`, `{{date7dAgo}}` = `YYYY-MM-DD` of `now - 7d`.
2. Load the previous `data/items.json` (missing or unparsable -> start from an empty list and log a warning; never fatal) and the previous 14 days of `data/digests/*.json` (each file independently; a corrupt one is skipped with a warning).
3. Fetch and parse every source through the scheduler (5.2). Each source is wrapped in its own `try/catch` with a 45 s wall clock; the result is either `{ status: 'ok' | 'empty', items: RawItem[] }` or `{ status: 'failed', error }`. A failing source never throws past this boundary; that is the "degrades gracefully" invariant and `pipeline.js` owns it.
4. Normalize raw items to `Item`s (5.4), dedup and merge within the run (5.6), then merge with the previous items (5.8), score (5.7), apply retention and caps (5.8).
5. Build the brief for the UTC date of `now` (6), then optionally editorialize with the LLM (7).
6. Validate the three outputs against `src/schema.js`; write them atomically (write `*.tmp`, `rename`): `items.json`, `digests/<date>.json`, `digests/index.json` (rebuilt from the directory listing, newest first), `meta.json`. In `dryRun` nothing is written.
7. Print a table `id | status | fetched | kept | ms | error` sorted by category, then a summary line, and exit 0. Exit code 1 only for registry errors, an unwritable `dataDir`, or an unexpected exception outside the per-source boundary.

Whole-run budget: 8 minutes. When exceeded, sources still pending are marked `failed: 'run budget exceeded'` and the run proceeds to write outputs with what it has. The Actions job has `timeout-minutes: 20`.

### 5.2 HTTP client and scheduler (`src/http.js`)

`fetchText(url, { timeoutMs = 20000, maxBytes = 8_000_000, accept, fetchImpl })`:
- Headers: `user-agent: Ahead/<package.json version> (+https://github.com/Sudish007/ahead; personal AI dashboard)`, `accept` per type (`application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8` for feeds; `application/json` for json/hn; `application/vnd.github+json` plus `authorization: Bearer <GITHUB_TOKEN>` when the host is `api.github.com` and the token is set; `text/html` for sitemap page fetches). The brief's descriptive User-Agent is what made Reddit's Atom endpoint answer in the probe.
- Timeout via `AbortController`. Body is read as a stream; once more than `maxBytes` have arrived the request is aborted and `BodyTooLarge` is thrown (the 14 MB Latent Space podcast feed is the reason this exists; that feed is not in the registry, but the next one might be).
- `redirect: 'follow'` (default). Returns `{ status, text, finalUrl, contentType }`.
- Status `>= 400` throws `HttpError(status, url)`. One retry after 2 s for network errors, 5xx and 429 (for 429, wait `min(retry-after, 30s)` when the header is present). No retry for other 4xx.
- Node's fetch decodes gzip/br itself; nothing to do.

Scheduler: sources are grouped by `rateGroup` (default = hostname). Within a group requests run sequentially with a minimum gap: `export.arxiv.org` 3,000 ms (arXiv API terms), `rss.arxiv.org` 1,000 ms, `api.github.com` 1,000 ms, `www.reddit.com` irrelevant (one request), default 0. Groups run with a concurrency of 6. Total per run: 65 source requests + 0-4 arXiv fallbacks + sitemap page fetches (10 max per sitemap source). Observed in the probe, all sources answer within 1.1 s except arXiv RSS (~1 s each) and the 2-4 MB podcast feeds; a cold run should finish in well under 2 minutes.

### 5.3 Parsers: source response -> `RawItem[]`

`RawItem = { title, url, publishedAt?: Date, surfacedAt?: Date, summaryHtml?, summaryText?, bodyLength?, authors?: string[], arxivId?, signals?: {...}, discussionUrl?, tag?, enclosureType?, rank?, extra?: {...} }`

`parsers/feed.js` (types `rss`, `atom`, `youtube`, `github` releases). fast-xml-parser options: `{ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', cdataPropName: false, parseTagValue: false, trimValues: true, processEntities: true, htmlEntities: true, isArray: (name) => ['item','entry','link','category','author','enclosure'].includes(name) }`. Format sniff on the body: `<feed` -> Atom entries; `<rss`/`<rdf:RDF` -> RSS items; anything else -> `ParseError('not a feed')`. A helper `text(node)` returns a string from string | `{'#text'}` | `{'@_href'}` | array-first. Field mapping:
- title: `title` (text; Epoch uses `type="html"` CDATA, which collapses to text), required non-empty after `cleanText`.
- url: RSS `link` text, else `guid` when `isPermaLink != false` and it parses as a URL; Atom first `link[rel=alternate]`, else first `link` href. Required.
- date: `pubDate | dc:date | published | updated | issued`; parsed by `parseDate` (RFC 822 and ISO both go through `new Date`); invalid or missing -> `undefined` (normalize fills `now`); future dates are clamped to `now`.
- summary: first non-empty of `description`, `summary`, `content:encoded`, `content`, `media:group.media:description`, `itunes:summary`. For Substack feeds `description` is the subtitle and `content:encoded` the body: both are kept, `summaryText` from the first, `bodyLength` from the longest (used for `readMinutes`).
- authors: `dc:creator`, `author.name`, `itunes:author` (split on `,` for dc:creator; max 5).
- enclosureType: `enclosure[0]['@_type']`; audio enclosure from a `blogs`/`labs` source re-routes the item to `media` (Latent Space, Interconnects, Dwarkesh episodes).
- youtube extras: `yt:videoId`, `media:group.media:community.media:statistics['@_views']` -> `signals.ytViews`.
- github releases: tag = last path segment of the link after `/releases/tag/`, URL-decoded; entries whose tag contains `/` are dropped (pytorch `viable/strict/...`, torchtitan `ciflow/...`); title = `${repo} ${tag}` when the entry title is just the tag, else `${repo}: ${entryTitle}`; `tag` kept for the why-line; summary from `content` (HTML stripped, 600 chars).

`parsers/arxiv.js` (type `arxiv`): parse the RSS with feed.js, then: drop items whose `arxiv:announce_type` matches `/replace/`; `arxivId` from the link; strip the `^arXiv:\S+ Announce Type: \w+(-\w+)?\s*Abstract:\s*` prefix from the description; `authors` from `dc:creator`; `publishedAt` = feed pubDate (announcement day). If the RSS parses but yields 0 items (cs.AI did, twice, on probe day) or fails, fetch `fallbackUrl` (Atom): `arxivId` from `<id>` (strip `vN`), `summary`, `author[].name`, `published`; mark `extra.via = 'api'`. Source status is `ok` if either path produced items; `meta.sources[id].note = 'api fallback'` records which path ran.

`parsers/json.js`:
- `hn` (types `hn`): `hits[]` -> `{ title, url: hit.url || 'https://news.ycombinator.com/item?id=' + objectID, discussionUrl: HN item URL, publishedAt: created_at, signals: { hnPoints: points, hnComments: num_comments }, rank: index + 1 (front page only) }`. Keyword filter (5.5) applies to both HN sources.
- `hf-papers`: `[]` -> `{ title: paper.title, url: 'https://huggingface.co/papers/' + paper.id, arxivId: paper.id, summaryText: paper.summary, authors: paper.authors[].name, publishedAt: paper.publishedAt, surfacedAt: paper.submittedOnDailyAt, signals: { hfUpvotes: paper.upvotes }, extra: { githubRepo, githubStars } }`.
- `hf-models`: `[]` -> `{ title: id, url: 'https://huggingface.co/' + id, summaryText: [pipeline_tag, library_name, likes + ' likes', downloads + ' downloads'].filter(Boolean).join(' · '), publishedAt: createdAt, signals: { hfLikes: likes }, extra: { trendingScore, downloads } }`. `surfacedAt` is set by the pipeline to the first run that saw it (5.8).
- `github` search (host `api.github.com`): `items[]` with `stargazers_count >= minStars` -> `{ title: full_name, url: html_url, summaryText: description (+ ' · ' + language), publishedAt: created_at, signals: { ghStars: stargazers_count }, extra: { topics: topics.slice(0, 6) } }`.

`parsers/reddit.js` (type `reddit`): Atom entries. `discussionUrl` = entry link (permalink); `content` is escaped HTML containing `<a href="...">[link]</a>`; when that href's host is not reddit.com/redd.it, it becomes `url` (so a Reddit post about an arXiv paper or GitHub repo dedups with the HN/HF/arXiv item), otherwise `url` = permalink (self post). `summaryText` = content with HTML stripped and the trailing `submitted by /u/... [link] [comments]` boilerplate removed. `extra.subreddit` = `category['@_term']`. No engagement numbers exist in the feed, so `signals` stays empty and the why-line says "top of r/LocalLLaMA today".

`parsers/sitemap.js` (type `sitemap`, the one new type): parse `<urlset><url><loc/><lastmod/>`; keep URLs matching `include` and not `exclude`, with `lastmod` within `maxAgeDays`; sort by `lastmod` desc; take `maxItems`. For each URL whose canonical form is not already in the previous `items.json`, fetch the page (timeout 15 s, `maxBytes` 1.5 MB, at most 10 fetches per source per run) and read `og:title` (fallback `<title>`), `og:description`, `article:published_time` (fallback `lastmod`). If `article:published_time` is older than `maxAgeDays` the URL is skipped: a bumped `lastmod` on an old page is an edit, not news. If the page fetch fails, the item is still produced with the slug title-cased (`public-benefit-fund` -> "Public benefit fund"), no summary, `publishedAt = lastmod`, and `extra.titleFrom = 'slug'`. Known URLs reuse the stored title/summary without a fetch.

### 5.4 Normalized item (`src/normalize.js`)

```js
Item = {
  id: 'arxiv:2610.22379' | '3f9c2a1b7d4e6f80',   // 'arxiv:<id>' for papers, else first 16 hex of sha256(canonicalUrl)
  title: string,                 // <= 200 chars, entities decoded, whitespace collapsed
  url: string,                   // best display/open URL (original, redirects followed, http(s) only)
  canonicalUrl: string,          // dedup key material (5.5)
  sources: [{ id, url?, at }],   // every source that surfaced it; url = that source's own page (HN thread, Reddit permalink, HF paper page); at = ISO when that source surfaced it
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
  extra?: { ... }                // small, source-specific, never required by the UI
}
```

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

HN keyword filter (`isAiStory(title, url)`): true when the URL host (minus `www.`) is, or is a subdomain of, one of `arxiv.org, huggingface.co, openai.com, anthropic.com, deepmind.google, ai.meta.com, mistral.ai, x.ai, deepseek.com, ollama.com, vllm.ai`, or the title matches the strong regex (case-insensitive): `\b(LLMs?|GPT[-\d.]*|ChatGPT|Claude|Gemini|Gemma|OpenAI|Anthropic|DeepMind|Mistral|Llama|Qwen|DeepSeek|Kimi|Grok|xAI|Hugging ?Face|transformers?|diffusion|RLHF|reinforcement learning|machine learning|deep learning|neural (net|network)s?|benchmarks?|inference|fine-?tun(e|ed|ing)|embeddings?|tokeni[sz](er|ation)|RAG|MCP|agentic|AI agents?|(language|foundation|open[- ]weights?|reasoning|vision|multimodal|frontier) models?|Nvidia|CUDA|GPUs?|TPUs?|PyTorch|JAX|vLLM|llama\.cpp|Ollama|Copilot|Codex|Cursor|Sora|Midjourney|Stable Diffusion|AGI|superintelligence|AI (safety|alignment))\b`, or the title matches `\bAI\b` case-sensitively. Bare `model`/`agent`/`alignment` deliberately do not match (the probe caught "ICE agent"). The list lives in `src/parsers/json.js` as an exported constant so the test can pin the fixture outcome: exactly these regexes keep 9 of 42 hits on `hn-algolia-bydate.json` (ids 50150434, 50148855, 50148452, 50145715, 50145507, 50145337, 50143755 via the anthropic.com host rule, 50141657, 50141429; the Flock/ICE story 50150750 is excluded) and 7 of 30 on `hn-algolia-front.json` (verified during the design phase).

### 5.6 Dedup and merge (`src/dedup.js`)

Key: `arxivId ? 'arxiv:' + arxivId : canonicalUrl`. All raw items of a run are grouped by key and merged into one `Item`:
- `sources`: union by source id; each carries its own `url` and `at`.
- `title`: from the source with the highest weight (ties: earliest `at`); for papers prefer HF Papers/arXiv titles over HN titles.
- `summary`: longest non-empty (then truncated to the cap). `authors`: from the research source if any. `readMinutes`: max.
- `signals`: per key `max`.
- `publishedAt`: min; `surfacedAt`: max of `sources[].at`.
- `category`: precedence `research > releases > labs > blogs > media > news` across the contributing sources' categories (after the audio-enclosure re-route). An HN story about an OpenAI post becomes `labs` with `sources: [openai, hn-front]`.
- `url`: the research/labs/blogs/releases source's URL when present, else the HN `url`; `discussionUrl`: HN thread, else Reddit permalink.

Cross-source counting uses `family`: `distinctFamilies = new Set(sources.map(s => registry[s.id].family ?? s.id)).size`. arXiv cross-lists (cs.LG + cs.AI) therefore do not look like two sources, and both HN feeds count once.

### 5.7 Scoring (`src/score.js`)

```
ageHours = max(0, (now - surfacedAt) / 3.6e6)
decay    = 0.5 ** (ageHours / 36)                         // half-life 36 h
W        = max(weight of sources)                          // 1..10
E        = 1.0*log2(1+hfUpvotes) + 0.6*log2(1+hnPoints) + 0.4*log2(1+hnComments)
         + 0.5*log2(1+ghStars)  + 0.5*log2(1+redditScore) + 0.5*log2(1+hfLikes) + 0.15*log2(1+ytViews)
X        = 4 * min(3, distinctFamilies - 1)                // cross-source bonus
score    = round2(W * decay + E + X)
```

Only the source weight decays, as the brief specifies; engagement and the cross-source bonus do not, so a big HN thread stays near the top of the 7-day News tab, while the brief's own freshness window (6.1) keeps the daily brief current. Worked example used as the unit test: A = HN-only, 500 points / 200 comments, 2 h old, weight 5 -> 5×0.96 + 5.38 + 3.06 = 13.2. B = arXiv + HF Papers (30 upvotes) + HN (40 points / 10 comments), 20 h old -> W 8×0.68 = 5.44, E = 4.95 + 3.21 + 1.38 = 9.54, X = 8 -> 22.98. B wins despite lower raw engagement, which is the behavior the brief asks the test to prove. Coefficients and the half-life are constants at the top of `score.js`, not in the registry; weights are in the registry.

### 5.8 Merge with the previous run, retention, caps

After in-run dedup, each item is merged with the stored item of the same `id` from the previous `items.json`: `sources[]` union where a stored source entry keeps its `at` (this is what makes `surfacedAt` for HF trending / GitHub search mean "first seen", since those parsers emit `surfacedAt = now`); `signals` max; `title`/`summary` from the fresh item unless empty; `publishedAt` min. Stored items not seen this run are kept unchanged (HN by-date only covers 24 h; this is how 7 days accumulate).

Retention after the merge: drop items with `surfacedAt < now - 7 d`; arXiv-only items (every source in family `arxiv`, no signals) are dropped after 3 days instead, because 240 new abstracts a day would otherwise make `items.json` mostly unread long tail. Then the global cap: keep the top 3,000 by score. Expected steady state: 1,500-2,500 items, about 1-1.5 MB raw (300-450 KB gzipped from Pages), which the frontend loads lazily. If the file exceeds 2.5 MB the test `tests/data-shape.test.js` fails loudly so the caps get revisited rather than the site silently slowing down.

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
{ generatedAt, durationMs, itemCount, newItemCount,
  sources: { [id]: { name, category, status: 'ok'|'empty'|'failed', fetched, kept, skipped, ms, httpStatus?, error?, note? } },
  okCount, emptyCount, failedCount,
  llm: { enabled: boolean, ok?: boolean, model?: string, error?: string },
  brief: { date, wordCount, readingMinutes },
  static: { leaderboards: [...], labs: [...], learn: [...] } }   // verbatim copies of linkouts/learn from the registry (8.1)
```
`status: 'empty'` means the fetch succeeded but zero items survived filtering/retention (Chip Huyen most weeks; arXiv on weekends); the UI counts only `failed` for the health dot. `error` is a short class string (`HTTP 403`, `timeout`, `body too large`, `parse error: not a feed`), never a stack trace. Secrets never appear anywhere in `data/`.

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
- `why` (heuristic): the strongest one or two true statements, joined with "; ", max 160 chars, numbers compacted (`1.2k`):
  `#{rank} on HN front page, {comments} comments` > `{points} points on HN, {comments} comments` > `{n} upvotes on HF Papers` > `also on {other family names}` > `{stars} stars in {d} days` > `new release {tag}` > `{likes} likes on Hugging Face` > `{views} views` > category fallbacks: labs `{source} announcement`, research `new on arXiv ({primary category})`, blogs `{source}, ~{readMinutes} min read`, media `new episode from {source}`, news `top of r/{sub} today` / `on HN`.
- `sourceNames`: display names of all sources, research/labs first.

### 6.4 The word budget (the "5-minute" contract)

Words are counted with `text.split(/\s+/).filter(Boolean).length` over every entry's `title + summary + why + sourceNames.join(' ')`, plus the section titles and `overview.text`. Target: `wordCount <= 1100`. Enforcement, in order, until it fits:
1. Trim summaries to one sentence / 160 chars, starting from the lowest-ranked entry of the lowest-priority section (`deep-read` is trimmed last, `must-know` never below two sentences first pass).
2. Drop the last entry of `research`, then `releases`, then `labs`, then `analysis` (never below one entry each; `must-know` never shrinks).
3. Hard truncate every summary to 120 chars (not reachable with the caps above; exists so the invariant is unconditional).
`readingMinutes = max(1, ceil(wordCount / 220))`, which is 5 at the cap. The budget runs again after the LLM overview is attached (7). `brief.js` owns this invariant; `tests/brief.test.js` proves it on fixture items whose summaries are all at the 600-char cap.

## 7. Optional LLM editorial layer (`src/llm.js`)

Enabled only when `LLM_API_KEY` is set and `--no-llm` is absent. `LLM_BASE_URL` defaults to `https://api.openai.com/v1` and must parse as an http(s) URL (otherwise the layer is disabled with `meta.llm.error = 'invalid LLM_BASE_URL'`); `LLM_MODEL` defaults to `gpt-4o-mini`.

One request per run: `POST {base}/chat/completions` with `authorization: Bearer <key>`, body `{ model, temperature: 0.3, max_tokens: 900, messages: [system, user] }`. No `response_format` field (Anthropic's and some other OpenAI-compatible endpoints reject it); the system prompt demands a single JSON object. System prompt (fixed text in the module): you are the editor of a one-page daily AI brief for an expert reader; using only the facts given, write `overview` (150-200 words, plain English, no hype, name the 3-5 developments that matter most and why) and `why` (map of entry id -> one line of at most 25 words saying why it matters to a researcher or founder); never invent numbers or names; output only JSON `{ "overview": string, "why": { id: string } }`. User message: JSON array of the brief's entries `{ id, section, title, summary, sourceNames, signals }` (at most 15 entries, summaries cut to 300 chars; about 2.5k tokens).

Response handling: 60 s timeout; non-2xx -> failure; `choices[0].message.content` -> take the substring from the first `{` to the last `}` -> `JSON.parse`; `overview` accepted only if a string of 80-260 words; each `why[id]` accepted only if a non-empty string <= 200 chars for an id that exists; everything else is ignored individually. Accepted text replaces the heuristic (`whySource: 'llm'`), the overview is attached, and the word budget (6.4) runs again. Any failure (network, timeout, HTTP, parse, nothing accepted) leaves the heuristic brief untouched, logs one `warn` line without the key or the response body, and records `meta.llm = { enabled: true, ok: false, error: 'HTTP 401' | 'timeout' | 'invalid JSON' | 'empty' }`. No retry; the next run tries again. The key is read from `env` inside `llm.js` only and never written anywhere.

README documents the secrets and provider settings: OpenAI (defaults); Anthropic `LLM_BASE_URL=https://api.anthropic.com/v1`, `LLM_MODEL=claude-3-5-haiku-latest`; Groq `https://api.groq.com/openai/v1`; Gemini `https://generativelanguage.googleapis.com/v1beta/openai`; OpenRouter `https://openrouter.ai/api/v1`. Setting them: `gh secret set LLM_API_KEY` etc. The baseline needs none of this.

## 8. Frontend (`index.html`, `app.js`, `styles.css`)

### 8.1 Structure and data loading

`index.html` holds the static skeleton: `<header>` (wordmark "Ahead", digest date in UTC, "refreshed N min ago", "N min read", health dot button), `<nav aria-label="Sections">` with a `role="tablist"` of 10 buttons, a filter bar (hidden on Brief/Leaderboards/Learn/Archive), `<main>` with one `role="tabpanel"` region whose content is re-rendered, `<template>` elements for an item row and a brief entry, and a `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'">` (Pages cannot set headers; everything is same-origin so this costs nothing). `<script type="module" src="app.js">`.

All data URLs are relative (`data/meta.json`, `data/digests/index.json`, `data/digests/<date>.json`, `data/items.json`) so the site works under `/ahead/`. Startup: `Promise.all([meta, index])` with `{ cache: 'no-cache' }`, then the newest digest from `index.days[0].date`. `items.json` is fetched once, lazily, with `?v=<meta.generatedAt>` as a cache buster, the first time a category tab is opened or the search box receives input; while loading, the panel shows a single "Loading 7 days of items…" row. Leaderboards and Learn render from `meta.static = { leaderboards, labs, learn }`, which the pipeline copies verbatim from `sources.config.mjs` on every run. The frontend does not import the registry (it is a Node module with regexes and would otherwise have to be duplicated or bundled), yet the registry stays the single source of truth and the UI has no second list to drift.

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

"Refreshed N min ago" is computed from `meta.generatedAt` and re-rendered every 60 s. Health dot: green when `failedCount === 0` and `generatedAt` is less than 12 h old; amber when `1 <= failedCount <= 5`; red when `failedCount > 5` or `generatedAt` is older than 12 h (the cron missed). Clicking it toggles a `<details>` listing every source with status, kept count and error class. If `meta.json` or the digest fails to load, a `role="alert"` banner names the file and HTTP status with a Retry button; Leaderboards and Learn still render from the last good `meta` or, if none, show a static message. If `items.json` fails, category tabs show the banner in the panel; Brief keeps working. A digest file that parses but lacks `sections` is treated as a load failure.

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
permissions:
  contents: write
  pages: write
  id-token: write
concurrency:
  group: refresh
  cancel-in-progress: false            # overlapping runs would race on the data commit
jobs:
  refresh:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0               # full history so `git pull --rebase` cannot hit shallow-clone edge cases
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
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
```

Notes: `npm test` gates both the data commit and the deploy, so a broken parser cannot publish garbage; if a secret is unset the env var is empty and `llm.js` treats empty as unset. `git pull --rebase` only matters if someone pushed to `main` during the run; because only the bot writes `data/**`, conflicts cannot occur on data files, and `concurrency` prevents two bot runs from racing. If `git push` still fails (branch protection, transient outage) the job fails visibly and nothing is lost: the next scheduled run regenerates everything from sources. The Pages artifact is a staged copy, not the repo root, so `node_modules`, tests and `.agents` never ship. Pages must be set to "GitHub Actions" as the source (`gh api -X POST repos/Sudish007/ahead/pages -f build_type=workflow`); the first deploy fails with a clear error otherwise. GitHub's cron is best-effort and may lag by 10-30 minutes; the UI's "refreshed N min ago" makes that visible rather than alarming.

Repository growth: four data commits a day, each rewriting ~1 MB of JSON; git delta-compresses these well (consecutive files differ by a few hundred items). Rough estimate 30-60 MB per year, acceptable for a personal repo; squashing history is out of scope and noted in the README.

## 10. Error handling matrix

| Operation | Failure | Recoverable? | What the caller sees | Logged |
|---|---|---|---|---|
| Registry load (`sources.config.mjs`) | invalid entry, duplicate id, bad URL/template | fatal | `fetch.mjs` prints the offending entry and exits 1; nothing written | error |
| HTTP fetch of a source | DNS/TLS/connection error | yes (1 retry, then source failed) | `meta.sources[id] = { status: 'failed', error: 'network' }`, 0 items, run continues | warn, one line per source |
| | timeout (20 s) | same | `error: 'timeout'` | warn |
| | HTTP 4xx | yes (no retry) | `error: 'HTTP 403'`, `httpStatus` | warn |
| | HTTP 5xx / 429 | yes (1 retry with backoff) | `error: 'HTTP 503'` if the retry also fails | warn |
| | body > maxBytes | yes | `error: 'body too large'` | warn |
| Parse | not XML/JSON, XMLValidator error, unexpected shape | yes | `error: 'parse error: <class>'` | warn |
| | 0 items after filters | yes | `status: 'empty'` (not failed); arXiv additionally triggers the API fallback | info |
| | single malformed item (no title / bad URL / bad date) | yes | item skipped (`skipped` count); bad date -> run time | debug |
| Sitemap page fetch (og:*) | any error | yes | item still produced from the slug and `lastmod`; `extra.titleFrom = 'slug'` | warn |
| Previous `items.json` | missing | yes | start empty, `meta.note = 'no previous items'` | warn |
| | unparsable / wrong shape | yes | start empty; the broken file is overwritten by this run's output | warn |
| Previous digests | one file unparsable | yes | skipped for repeat suppression; index rebuilt without it | warn |
| Brief build | a section's pool is empty | yes | section with `entries: []` | info |
| LLM call | any (see 7) | yes | heuristic brief, `meta.llm.ok = false` with error class | warn (no key, no body) |
| Output write | `dataDir` not writable / disk error | fatal | exit 1 after printing the path; temp file removed; previous outputs intact (atomic rename) | error |
| Output validation (`schema.js`) | an output fails the schema | fatal | exit 1 before writing; this means a bug | error |
| Run budget (8 min) | pending sources | yes | marked `failed: 'run budget exceeded'`; outputs written | warn |
| Actions: `npm test` | fail | job fails | no data commit, no deploy; previous site stays | Actions log |
| Actions: `git push` | rejected/transient | job fails | next run regenerates; nothing lost | Actions log |
| Frontend: meta/digest/index fetch | network/HTTP/JSON error | yes | `role="alert"` banner with file + status + Retry; static tabs still work | console.error |
| Frontend: items.json fetch | same | yes | banner inside category panels; Brief unaffected | console.error |
| Frontend: `localStorage` | throws | yes | in-memory store for the session | console.warn once |
| Frontend: corrupt stored JSON | parse/shape error | yes | key reset to fallback | console.warn |

## 11. Input validation

External inputs and the rules applied at the trust boundary:
- Feed/JSON bodies: size-capped (8 MB; 1.5 MB for sitemap pages), format sniffed, XML validated by `XMLValidator` before parsing; JSON parsed with `JSON.parse` inside try/catch. Shape checks per parser (`Array.isArray(hits)` etc.); a wrong shape is a parse error for the whole source.
- Per item: `title` required, string, cleaned, 1-200 chars; `url` required, must parse with protocol http/https, max 2,048 chars; `publishedAt` optional, must parse to a Date between 2000-01-01 and `now` (future -> clamped to `now`, invalid -> `now`); `summary` optional, cleaned, <= 600; `authors` <= 5 strings <= 80 chars; numeric signals must be finite non-negative integers (otherwise dropped); `arxivId` must match the id regex.
- Registry: see 4.2 (fatal on failure).
- CLI flags (`scripts/fetch.mjs`): `--source <id[,id]>` (unknown id -> exit 1 with the list of valid ids), `--dry-run`, `--no-llm`, `--data-dir <path>`, `--now <ISO>` (invalid -> exit 1). Flags exist for tests and local debugging.
- Environment: `GITHUB_TOKEN` optional string (only ever sent to `api.github.com`); `LLM_API_KEY` optional, empty string treated as unset; `LLM_BASE_URL` must parse as http(s) or the LLM layer is disabled with an error note; `LLM_MODEL` optional, defaults applied; `PORT` for `serve.mjs` must be an integer 1-65535 else 8787.
- LLM response: see 7 (field-by-field acceptance; anything unexpected is dropped, never fatal).
- Frontend: `location.hash` matched against the tab whitelist and `^\d{4}-\d{2}-\d{2}$` for archive dates that must also exist in `index.json`; search input used only as a string for `includes`; `localStorage` values shape-checked; every URL re-validated before use as `href`/`window.open`.

## 12. Invariants and who enforces them

| Invariant | Owner | Why there |
|---|---|---|
| A failing source never fails the run | `pipeline.js` per-source try/catch + wall clock | the only place that sees all sources; parsers stay simple and may throw |
| `items.json` ids are unique and every item has `surfacedAt` within retention | `dedup.js` (Map by id) and the retention step in `pipeline.js`; checked by `schema.js` before writing | dedup is where identity is defined; the schema check turns a logic bug into a loud failure instead of a corrupt site |
| Brief `wordCount <= 1100`, computed the same way everywhere | `brief.js` budget step, re-run after LLM | single word-counting function exported and reused by the test and the UI's reading-time display |
| Previous days' digests are never rewritten | `pipeline.js` writes only `digests/<today>.json`; `index.json` is derived from the directory | keeps the Archive stable and auditable |
| No secrets in `data/` or logs | `llm.js` reads the key from env and never includes it in errors; `http.js` redacts `authorization` in error messages | the two modules that touch credentials |
| Every URL in outputs is http(s) | `normalize.js` (`canonicalizeUrl` returns null otherwise -> item skipped) | one choke point before anything is stored |
| UI never injects untrusted HTML | `app.js` render helpers use `textContent` only; CSP forbids inline script | defense in depth for a public static site |
| Registry is the single source of truth for sources, link-outs, learn | `sources.config.mjs`; pipeline copies `linkouts`/`learn` into `meta.static` | the UI has no second list to drift |

## 13. Testing

Unit tests (fixture-driven, no network; fixtures in `tests/fixtures/` were captured from the real endpoints during the probe and trimmed, see `tests/fixtures/README.md`; add a `.gitattributes` line `tests/fixtures/** -text` so git's CRLF conversion on Windows never alters fixture bytes):
- `normalize.test.js`: `canonicalizeUrl` table (utm/ref/fbclid stripping, trailing slash, `/index.html`, http->https, `www.`, `//` path collapse, youtube/youtu.be, HN item id kept, sorted query, invalid -> null, `javascript:` -> null); `extractArxivId` (abs, pdf with `.pdf`, `v3`, `huggingface.co/papers`, alphaxiv, old-style `cs/0112017`, text prefix `arXiv:2610.22379v1 Announce Type`); `cleanText` (CDATA, entities, nested tags, scripts); `parseDate` (RFC 822 with `-0400`/`GMT`/`-0000`, ISO with offset, garbage -> undefined, future -> clamp).
- `feed.test.js`: every XML fixture parses to the expected count, first title, first date and link; `mistral-news-rss.xml` parses despite `text/plain`; `hf-blog.xml` yields items with empty summaries; `substack-interconnects.xml` detects 2 audio enclosures -> `media`; `youtube-gpumode.xml` yields `ytViews`; `epoch-atom.xml` CDATA title; `allenai-rss.xml` ISO `-08:00` date.
- `arxiv.test.js`: `arxiv-rss-cs.LG.xml` -> only `new`/`cross` kept, ids extracted, abstract prefix stripped, authors split; `arxiv-rss-cs.AI-empty.xml` -> 0 items -> fallback invoked with `arxiv-api-cs.LG.xml` -> 10 items with versionless ids.
- `json.test.js`: HN fixture -> keyword filter keeps the expected ids and excludes the Flock/ICE story; front-page ranks; `hf-daily-papers.json` -> arxivId, upvotes, `surfacedAt = submittedOnDailyAt`; `hf-trending-models.json` -> `hfLikes`; `gh-search-llm.json` -> `minStars` floor and `ghStars`.
- `reddit.test.js`: `reddit-multi-rss.xml` -> 12 items, subreddit from category, external `[link]` extraction for link posts, permalink for self posts, boilerplate removed.
- `github.test.js`: `gh-releases-pytorch.xml` -> 0 (all slash tags); `gh-releases-vllm.xml` -> 3 with tags; `gh-releases-llamacpp.xml` -> `b11730`-style tags kept, `maxItems: 3` respected.
- `sitemap.test.js`: `anthropic-sitemap.xml` with a fixed `now` -> the 15 recent news/research/engineering URLs, correct ordering, include/exclude regexes; page-meta fetch mocked to return an HTML string with `og:*` tags, and mocked to throw -> slug title fallback.
- `dedup.test.js`: arXiv RSS + HF Papers + HN items with the same id merge into one item with three sources, two families counted for cross-listing scenarios, signals max, category precedence, `publishedAt` min / `surfacedAt` max, title from the heavier source.
- `score.test.js`: the worked example from 5.7 (B beats A); decay halves at 36 h; bonus capped at 12; missing signals contribute 0.
- `brief.test.js`: a synthetic item set with 600-char summaries -> six sections populated with the right counts, `wordCount <= 1100`, `readingMinutes <= 5`, no id from "yesterday's" digest reused, deep read not repeating a `deepReadId` from the last 14 days, weekend fallback (36 h pool too small -> 72 h), an empty pool -> `entries: []`.
- `llm.test.js`: mocked fetch returning valid JSON -> overview and why lines applied, budget still holds; returning prose with embedded JSON -> extracted; returning garbage / HTTP 500 / timeout -> heuristic untouched and `meta.llm.ok === false`; the request body contains no key and the Authorization header is set; `LLM_BASE_URL=ftp://x` -> disabled.
- `pipeline.test.js` (integration, in-process): `run()` with `fetchImpl` mapping each registry URL to a fixture body, one URL throwing and one returning 403, `dataDir` = a temp directory -> completes, writes four files, `meta.sources` shows two `failed`, `okCount >= 20`, digest validates, `items.json` ids unique, a second `run()` with a later `now` keeps the stored HN items (retention/merge) and does not rewrite yesterday's digest.
- `registry.test.js`: `sources.config.mjs` passes the validation rules; every `type` has a parser; weights 1-10; ids unique.
- `data-shape.test.js` (smoke): if `data/items.json`, `data/meta.json`, `data/digests/index.json` exist, they validate against `schema.js`, `items.json` is under 2.5 MB, every digest listed in the index exists and has `wordCount <= 1100`; skipped with a message when `data/` is empty (fresh clone).

Integration (manual, in the brief's verification step): live `npm run fetch` with per-source counts (`>= 25` sources with items), `npm run probe`, Playwright screenshots at 1440/390 px of Brief, Research, Archive, Learn, keyboard `j`/`k`/`o` driven in Playwright (the opened URL asserted via a `popup` event), console clean, then the Actions run and the live `meta.json` over HTTP.

## 14. Edge cases

- Weekend: arXiv RSS has no items and HF Papers returns an empty array for Sat/Sun dates; sources report `empty`, the brief widens to 72 h, Research may still be thin; this is correct behavior, not a failure.
- arXiv cs.AI RSS empty on a weekday (observed): API fallback fills it; `note: 'api fallback'`.
- The same paper in cs.LG and cs.AI: one item, two sources, one family, no bonus.
- HN story linking to `arxiv.org/pdf/...v2`: canonicalizes to the abs URL and merges with the HF Papers / arXiv item.
- Reddit 403/429 from Actions IPs: `failed`, 0 items, amber dot; the single-request design means no repeated hammering.
- GitHub search unauthenticated locally (10/min): three requests, 1 s apart, fine; in Actions the token raises the limit.
- Feeds with all items sharing one date (arXiv) or no dates (rare): decay uses the shared date / run time; ordering within falls back to score then title.
- Sitemap `lastmod` bumped for an edited old page: skipped via `article:published_time`; if the page has no such tag, the item appears once (acceptable, rare).
- Release feeds dominated by CI tags (pytorch, torchtitan): zero items most runs; `empty`, not `failed`.
- Items older than 7 days still "trending" (HF models created months ago): kept while `surfacedAt` (first seen) is within 7 days; displayed date is the real `createdAt`.
- Clock skew / scheduled posts with future dates: clamped to `now`.
- A run straddling midnight UTC: the digest date is fixed at run start.
- Two digests regenerated for "today" during the day: entries may move between sections; `itemIds` of previous days are the only repeat filter.
- Titles with HTML or emoji, CDATA inside CDATA, numeric entities: handled by `cleanText`; tests cover the fixtures that exhibit them.
- A source that redirects permanently (SemiAnalysis did): `finalUrl` is recorded in `meta.sources[id].note` when it differs from the registry URL so the README's source list can be updated.
- `items.json` missing on first ever run: pipeline starts empty; UI shows "no data yet" until the first Actions run commits.
- Saved items whose source item has rolled off: the snapshot in `ahead:saved` renders them with a "no longer in the 7-day window" hint.
- Very long titles (some arXiv titles exceed 200 chars): truncated at 200 with an ellipsis; the full title is in the `title` attribute.

## 15. Local development and README outline

Scripts (`package.json`): `fetch` -> `node scripts/fetch.mjs`; `probe` -> `node scripts/probe-sources.mjs`; `serve` -> `node scripts/serve.mjs` (PORT default 8787); `test` -> `node --test "tests/**/*.test.js"`. Typical loop: `npm run fetch -- --source hn-top,hf-papers --dry-run` to debug one parser, `npm run fetch` for real data, `npm run serve` and open `http://localhost:8787/`. `probe-sources.mjs` reuses `http.js` and the parsers to print `id | status | items | ms | error | finalUrl` for every registry entry, which doubles as the brief's "verify each URL actually returns data" check after any registry change.

README sections: what Ahead is; the source list by category with the alternates chosen and why (Anthropic/The Batch via sitemap, Meta via Newsroom + Engineering feeds, SemiAnalysis newsletter, Epoch atom, Jay Alammar newsletter, Horace He Substack, Reddit single multireddit request, Latent Space podcast via the publication feed); how ranking works (formula from 5.7 with the worked example); how the brief is built and the 1,100-word rule; how to add a source (one line, `npm run probe`); the optional LLM key with provider examples; the cron schedule and how to trigger a run manually (`gh workflow run refresh.yml`); local commands; data file formats; known limits (Reddit has no scores; GitHub cron lag; repo growth).

## 16. Assumptions and risks

- Reddit may block GitHub Actions IPs entirely; the design degrades to no Reddit items without affecting anything else. If that happens consistently, the README documents it and the source stays in the registry (it works from residential IPs for local runs).
- Publishers change URLs or formats. `npm run probe` plus `meta.sources` status make this visible within one run; the registry edit is one line.
- GitHub Pages caches responses for about 10 minutes; `cache: 'no-cache'` on `meta.json` and the `?v=` buster on `items.json` keep the UI consistent with the latest deploy.
- The LLM layer is a convenience; its quality depends on the model chosen. It can never block or alter the data layer.
- `items.json` size is the main performance risk; retention rules and the 2.5 MB test guard it.
- The `sitemap` type and the `hfLikes`/`ytViews` signals are the only deviations from the brief's vocabulary; both are additive and documented here and in the README.

## 17. Deviations from the brief, for the reviewer

All additive; none changes the ARCHITECTURE section's decisions.

| Brief says | Design does | Why |
|---|---|---|
| type ∈ rss, atom, json, arxiv, hn, reddit, github, youtube | adds `sitemap` | Anthropic and The Batch have no feed; their `sitemap.xml` + `og:*` page tags are stable and verified (probe L2a, B12a). Link-out was the alternative; losing Anthropic from "From the labs" was judged worse. |
| signals: hnPoints, hnComments, hfUpvotes, redditScore, ghStars | also optional `hfLikes`, `ytViews` | present in the HF models and YouTube responses at no cost; `redditScore` stays in the shape but is never populated because Reddit's Atom feed carries no counts (probe N4). |
| item shape as listed | adds `surfacedAt`, `readMinutes`, `discussionUrl`, `authors`, `tag`, `extra` | `surfacedAt` separates "when it became news" from the item's own date so an old post that tops HN today ranks and displays truthfully; `authors` is required by the brief's arXiv bullet; the rest feed the why-lines. |
| Reddit `top.json` with `.rss` fallback per subreddit | one multireddit `.rss` request | JSON is 403 everywhere; Reddit allows one unauthenticated request per minute (probe N3-N6). |
| Latent Space podcast feed | episodes taken from the Latent Space publication feed via audio enclosures | the podcast feed is 14 MB per fetch; the publication feed has the same episodes (probe P3). |
| upload-pages-artifact of "the site root" | a `_site` staging copy of index.html, app.js, styles.css, favicon.svg, data/ | keeps node_modules, tests and `.agents` out of the deployed artifact. |
| category tabs "over the last 7 days" with a 24h/3d/7d toggle | default range `7d`, toggle persisted | literal reading of the brief. |
| registry `{ id, name, category, type, url, weight, ... }` | adds optional `family`, `rateGroup`, `maxItems`, `maxAgeDays`, `maxBytes`, `longForm`, `fallbackUrl`, `include`/`exclude`, `minStars`, `repo`, `parser`, `template` | all optional; a one-line source is still `{ id, name, category, type, url, weight }`. |
