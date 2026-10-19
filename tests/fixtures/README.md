# Fixtures

Real responses captured by the design-phase source probe on 2026-10-19 (see .agents/tasks/ahead-build/source-probe.md). Large feeds are trimmed to the first N items; the XML envelope is preserved so parsers see the real namespaces, CDATA and date formats.

| file | upstream | items | note |
|---|---|---|---|
| arxiv-rss-cs.LG.xml | arxiv-rss-cs.LG.xml | 25 | arXiv RSS: shared pubDate, arxiv:announce_type new/cross/replace, description prefix |
| arxiv-rss-cs.AI-empty.xml | arxiv-rss-cs.AI.xml | all | arXiv RSS with zero items (observed 2026-10-19) |
| arxiv-api-cs.LG.xml | arxiv-api-cs.LG.xml | 10 | arXiv API Atom fallback: versioned ids, summary, published |
| hf-daily-papers.json | hf-daily-papers.json | 12 | HF daily papers JSON |
| hn-algolia-bydate.json | hn-algolia-bydate.json | all | HN Algolia search_by_date (42 hits, needs keyword filter) |
| hn-algolia-front.json | hn-algolia-front.json | all | HN Algolia front_page |
| reddit-multi-rss.xml | reddit-multi-rss.xml | 12 | Reddit multireddit Atom: category term=subreddit, escaped HTML content, no scores |
| openai-news.xml | openai-news.xml | 15 | OpenAI RSS: CDATA titles/descriptions, GMT pubDate |
| deepmind-blog.xml | deepmind-blog.xml | 10 | DeepMind RSS: single-line, media:thumbnail |
| hf-blog.xml | hf-blog.xml | 10 | HF blog RSS: no description element |
| mistral-news-rss.xml | mistral-rss-alt.xml | all | Mistral RSS served as text/plain; some items lack description |
| anthropic-sitemap.xml | anthropic-alt-sitemap.xml | all | Anthropic sitemap.xml with lastmod (sitemap source type) |
| transformer-circuits-feed.xml | transformer-circuits-feed-guess.xml | all | Transformer Circuits Atom with category term=note|paper |
| epoch-atom.xml | epoch-atom-discovered.xml | 10 | Epoch AI Atom: CDATA in title type=html, multiple authors |
| allenai-rss.xml | allenai-rss-discovered.xml | 8 | Ai2 RSS: ISO pubDate with -08:00, HTML+img inside CDATA description |
| substack-interconnects.xml | interconnects.xml | 3 | Substack RSS: dc:creator, content:encoded, audio enclosures on podcast posts |
| simonwillison-atom.xml | simonw.xml | 8 | Atom with summary type=html escaped |
| alignmentforum.xml | alignmentforum.xml | 2 | RSS with long HTML CDATA descriptions |
| gh-releases-pytorch.xml | gh-releases-pytorch--pytorch.xml | all | GitHub releases Atom polluted by viable/strict tags (filter test) |
| gh-releases-vllm.xml | gh-releases-vllm-project--vllm.xml | 3 | GitHub releases Atom: normal version tags |
| gh-releases-llamacpp.xml | gh-releases-ggml-org--llama.cpp.xml | 4 | GitHub releases Atom: bNNNN build tags |
| gh-search-llm.json | gh-search-llm.json | 8 | GitHub search API repositories |
| hf-trending-models.json | hf-trending-models.json | all | HF models sorted by trendingScore |
| youtube-gpumode.xml | yt-gpumode.xml | 6 | YouTube channel Atom: yt:videoId, media:group, media:statistics |
| podcast-cognitive-revolution.xml | pod-cogrev.xml | 5 | Megaphone podcast RSS: plain description, itunes tags |
| podcast-mlst-anchor.xml | pod-mlst.xml | 5 | Anchor podcast RSS: CDATA HTML descriptions |
| google-research.xml | google-research-rss.xml | 8 | Google Research RSS |
| nvidia-dev-blog-atom.xml | nvidia-dev-blog.xml | 8 | NVIDIA technical blog Atom with CDATA |
| meta-newsroom-ai.xml | meta-newsroom-ai-tag.xml | 3 | Meta Newsroom AI tag RSS |
| karpathy-bearblog-atom.xml | karpathy-bearblog.xml | 3 | Bear blog Atom |
| smol-ainews.xml | smol-ainews.xml | 2 | AINews RSS (716 items upstream, content:encoded only) |
