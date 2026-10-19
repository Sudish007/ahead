# Fixtures

Real responses captured by the design-phase source probe on 2026-10-19 (see .agents/tasks/ahead-build/source-probe.md). Large feeds are trimmed to N items (the first N unless the row says otherwise); the XML envelope is preserved so parsers see the real namespaces, CDATA and date formats. Never edit fixture bytes by hand; regenerate from the raw captures. `.gitattributes` marks this directory `-text` so CRLF conversion cannot alter them.

| file | upstream capture | items | note |
|---|---|---|---|
| arxiv-rss-cs.LG.xml | arxiv-rss-cs.LG.xml | 18 (10 new, 3 cross, 3 replace, 2 replace-cross) | arXiv RSS: shared pubDate, all four arxiv:announce_type values, description prefix, <category> |
| arxiv-rss-cs.AI-empty.xml | arxiv-rss-cs.AI.xml | all | arXiv RSS with zero items (observed 2026-10-19) |
| arxiv-api-cs.LG.xml | arxiv-api-cs.LG.xml | 10 | arXiv API Atom fallback: versioned ids, summary, published, arxiv:primary_category |
| hf-daily-papers.json | hf-daily-papers.json | 12 | HF daily papers JSON |
| hn-algolia-bydate.json | hn-algolia-bydate.json | all | HN Algolia search_by_date (42 hits, needs keyword filter) |
| hn-algolia-front.json | reprobe-hn-front.json | all | HN Algolia front_page (30 hits, sorted by points, captured 2026-10-19T14:06Z together with hn-topstories.json) |
| hn-topstories.json | reprobe-hn-topstories.json | all | HN Firebase /v0/topstories.json (500 ids in rank order, same minute as hn-algolia-front.json) |
| reddit-multi-rss.xml | reddit-multi-rss.xml | 12 | Reddit multireddit Atom: category term=subreddit, escaped HTML content, no scores |
| openai-news.xml | openai-news.xml | 15 | OpenAI RSS: CDATA titles/descriptions, GMT pubDate |
| deepmind-blog.xml | deepmind-blog.xml | 10 | DeepMind RSS: single-line, media:thumbnail |
| hf-blog.xml | hf-blog.xml | 10 | HF blog RSS: no description element |
| mistral-news-rss.xml | mistral-rss-alt.xml | all | Mistral RSS served as text/plain; some items lack description |
| anthropic-sitemap.xml | anthropic-alt-sitemap.xml | all | Anthropic sitemap.xml with lastmod (sitemap source type); 30 of 566 URLs have no lastmod |
| deeplearning-sitemap.xml | reprobe-thebatch.xml | 18 of 3,400 | deeplearning.ai sitemap: 10 newest /the-batch/<slug> articles, /the-batch/about (no lastmod), 2 issue-NNN, 2 tag/, 3 non-batch URLs |
| transformer-circuits-feed.xml | transformer-circuits-feed-guess.xml | all | Transformer Circuits Atom with category term=note|paper |
| epoch-atom.xml | epoch-atom-discovered.xml | 10 | Epoch AI Atom: CDATA in title type=html, multiple authors |
| allenai-rss.xml | allenai-rss-discovered.xml | 8 | Ai2 RSS: ISO pubDate with -08:00, HTML+img inside CDATA description |
| substack-interconnects.xml | interconnects.xml | 5 (items 0-3 and 17) | Substack RSS: dc:creator, content:encoded, 2 audio/mpeg enclosures (podcast posts) among 5 items |
| simonwillison-atom.xml | simonw.xml | 8 | Atom with summary type=html escaped |
| alignmentforum.xml | alignmentforum.xml | 2 | RSS with long HTML CDATA descriptions |
| gh-releases-pytorch.xml | gh-releases-pytorch--pytorch.xml | all | GitHub releases Atom polluted by viable/strict tags (filter test) |
| gh-releases-vllm.xml | gh-releases-vllm-project--vllm.xml | 3 | GitHub releases Atom: normal version tags |
| gh-releases-llamacpp.xml | gh-releases-ggml-org--llama.cpp.xml | 4 | GitHub releases Atom: bNNNN build tags |
| gh-search-llm.json | gh-search-llm.json | 8 | GitHub search API repositories (stars 947..73; minStars 100 keeps 5) |
| gh-search-ml.json | gh-search-ml.json | 5 | GitHub search API repositories, all under the 50-star floor (stars 24..11; minStars 50 keeps 0 -> status empty) |
| hf-trending-models.json | hf-trending-models.json | all | HF models sorted by trendingScore |
| youtube-gpumode.xml | yt-gpumode.xml | 6 | YouTube channel Atom: yt:videoId, media:group, media:statistics |
| podcast-cognitive-revolution.xml | pod-cogrev.xml | 5 | Megaphone podcast RSS: plain description, itunes tags |
| podcast-mlst-anchor.xml | pod-mlst.xml | 5 | Anchor podcast RSS: CDATA HTML descriptions |
| google-research.xml | google-research-rss.xml | 8 | Google Research RSS |
| nvidia-dev-blog-atom.xml | nvidia-dev-blog.xml | 8 | NVIDIA technical blog Atom with CDATA |
| meta-newsroom-ai.xml | meta-newsroom-ai-tag.xml | 3 | Meta Newsroom AI tag RSS |
| karpathy-bearblog-atom.xml | karpathy-bearblog.xml | 3 | Bear blog Atom |
| smol-ainews.xml | smol-ainews.xml | 2 | AINews RSS, content:encoded only (parser edge case; the source itself is not in the registry: feed stale since 2026-09-09) |
