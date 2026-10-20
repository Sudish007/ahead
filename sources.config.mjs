// The single declarative registry: fetched sources, UI link-outs and the learn list.
// Adding a fetched source is one object literal; run `npm run probe` afterwards.

const arxivApi = (cat) =>
  `https://export.arxiv.org/api/query?search_query=cat:${cat}&sortBy=submittedDate&sortOrder=descending&max_results=100`;
const ghSearch = (topic) =>
  `https://api.github.com/search/repositories?q=topic:${topic}+created:>{{date7dAgo}}&sort=stars&order=desc&per_page=30`;
const yt = (channelId) => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

export const sources = [
  // Research
  { id: 'arxiv-cs.LG', name: 'arXiv cs.LG', category: 'research', type: 'arxiv', url: 'https://rss.arxiv.org/rss/cs.LG', fallbackUrl: arxivApi('cs.LG'), weight: 3, family: 'arxiv', maxItems: 60 },
  { id: 'arxiv-cs.CL', name: 'arXiv cs.CL', category: 'research', type: 'arxiv', url: 'https://rss.arxiv.org/rss/cs.CL', fallbackUrl: arxivApi('cs.CL'), weight: 3, family: 'arxiv', maxItems: 60 },
  { id: 'arxiv-cs.AI', name: 'arXiv cs.AI', category: 'research', type: 'arxiv', url: 'https://rss.arxiv.org/rss/cs.AI', fallbackUrl: arxivApi('cs.AI'), weight: 3, family: 'arxiv', maxItems: 60 },
  { id: 'arxiv-cs.CV', name: 'arXiv cs.CV', category: 'research', type: 'arxiv', url: 'https://rss.arxiv.org/rss/cs.CV', fallbackUrl: arxivApi('cs.CV'), weight: 3, family: 'arxiv', maxItems: 60 },
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
  { id: 'importai', name: 'Import AI', category: 'blogs', type: 'rss', url: 'https://importai.substack.com/feed', weight: 6, viaRelay: true },
  { id: 'latentspace', name: 'Latent Space', category: 'blogs', type: 'rss', url: 'https://www.latent.space/feed', weight: 5 },
  { id: 'zvi', name: "Don't Worry About the Vase", category: 'blogs', type: 'rss', url: 'https://thezvi.substack.com/feed', weight: 5, longForm: true, viaRelay: true },
  { id: 'thebatch', name: 'The Batch', category: 'blogs', type: 'sitemap', url: 'https://www.deeplearning.ai/sitemap.xml', include: /^https:\/\/www\.deeplearning\.ai\/the-batch\/[^/]+\/?$/, exclude: /\/the-batch\/(tag|issue-\d+)/, weight: 4, maxItems: 10, homepage: 'https://www.deeplearning.ai/the-batch/', viaRelay: true, relayPagePrefix: 'https://www.deeplearning.ai/the-batch/' },
  { id: 'oneusefulthing', name: 'One Useful Thing', category: 'blogs', type: 'rss', url: 'https://www.oneusefulthing.org/feed', weight: 4 },
  { id: 'gradient', name: 'The Gradient', category: 'blogs', type: 'rss', url: 'https://thegradient.pub/rss/', weight: 5, longForm: true },
  { id: 'epoch', name: 'Epoch AI', category: 'blogs', type: 'atom', url: 'https://epoch.ai/atom.xml', weight: 6, family: 'epoch' },
  { id: 'epoch-gradient-updates', name: 'Epoch AI Gradient Updates', category: 'blogs', type: 'rss', url: 'https://epochai.substack.com/feed', weight: 5, family: 'epoch', viaRelay: true },
  { id: 'alignmentforum', name: 'Alignment Forum', category: 'blogs', type: 'rss', url: 'https://www.alignmentforum.org/feed.xml', weight: 4, longForm: true },
  { id: 'chinai', name: 'ChinAI', category: 'blogs', type: 'rss', url: 'https://chinai.substack.com/feed', weight: 4, viaRelay: true },
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
  { id: 'gh-trending-llm', name: 'GitHub new repos: llm', category: 'releases', type: 'github', url: ghSearch('llm'), template: true, weight: 4, family: 'gh-trending', minStars: 50, maxItems: 15 },
  { id: 'gh-trending-ml', name: 'GitHub new repos: machine-learning', category: 'releases', type: 'github', url: ghSearch('machine-learning'), template: true, weight: 4, family: 'gh-trending', minStars: 50, maxItems: 15 },
  { id: 'gh-trending-agents', name: 'GitHub new repos: ai-agents', category: 'releases', type: 'github', url: ghSearch('ai-agents'), template: true, weight: 4, family: 'gh-trending', minStars: 50, maxItems: 15 },
  { id: 'hf-trending', name: 'HF trending models', category: 'releases', type: 'json', parser: 'hf-models', url: 'https://huggingface.co/api/models?sort=trendingScore&limit=20', weight: 4, maxItems: 20 },
  // Podcasts & video (Latent Space episodes arrive through the 'latentspace' feed and are routed by audio enclosure)
  { id: 'pod-dwarkesh', name: 'Dwarkesh Podcast', category: 'media', type: 'rss', url: 'https://api.substack.com/feed/podcast/69345.rss', weight: 6, maxItems: 5, homepage: 'https://www.dwarkesh.com', viaRelay: true },
  { id: 'pod-mlst', name: 'Machine Learning Street Talk', category: 'media', type: 'rss', url: 'https://anchor.fm/s/1e4a0eac/podcast/rss', weight: 5, maxItems: 5 },
  { id: 'pod-cogrev', name: 'The Cognitive Revolution', category: 'media', type: 'rss', url: 'https://feeds.megaphone.fm/RINTP3108857801', weight: 4, maxItems: 5 },
  { id: 'pod-nopriors', name: 'No Priors', category: 'media', type: 'rss', url: 'https://feeds.megaphone.fm/nopriors', weight: 4, maxItems: 5 },
  { id: 'yt-karpathy', name: 'Andrej Karpathy (YouTube)', category: 'media', type: 'youtube', url: yt('UCXUPKJO5MZQN11PqgIvyuvQ'), weight: 7, maxItems: 5 },
  { id: 'yt-yannic', name: 'Yannic Kilcher', category: 'media', type: 'youtube', url: yt('UCZHmQk67mSJgfCCTn7xBfew'), weight: 4, maxItems: 5 },
  { id: 'yt-aiexplained', name: 'AI Explained', category: 'media', type: 'youtube', url: yt('UCNJ1Ymd5yFuUPtn21xtRbbw'), weight: 4, maxItems: 5 },
  { id: 'yt-gpumode', name: 'GPU MODE', category: 'media', type: 'youtube', url: yt('UCJgIbYl6C5no72a0NUAPcTA'), weight: 5, maxItems: 5 },
  { id: 'yt-stanford', name: 'Stanford Online', category: 'media', type: 'youtube', url: yt('UCBa5G_ESCn8Yd4vw5U-gIcg'), weight: 2, maxItems: 5 },
  { id: 'yt-3b1b', name: '3Blue1Brown', category: 'media', type: 'youtube', url: yt('UCYO_jab_esuFRV4b17AJtAw'), weight: 2, maxItems: 5 },
];

export const linkouts = {
  leaderboards: [
    { name: 'LMArena', url: 'https://arena.ai/leaderboard', blurb: 'Crowd-voted pairwise model rankings (text, vision, coding).' },
    { name: 'Artificial Analysis', url: 'https://artificialanalysis.ai/', blurb: 'Independent quality, speed and price benchmarks across providers.' },
    { name: 'Scale SEAL', url: 'https://labs.scale.com/leaderboard', blurb: 'Private expert-graded evaluations, hard to contaminate.' },
    { name: 'LiveBench', url: 'https://livebench.ai/', blurb: 'Monthly-refreshed, contamination-free benchmark.' },
    { name: 'SWE-bench', url: 'https://www.swebench.com/', blurb: 'Real GitHub issues resolved end to end; the coding-agent yardstick.' },
    { name: 'Epoch AI Benchmarks', url: 'https://epoch.ai/benchmarks', blurb: "Epoch's independent runs of frontier models on major benchmarks." },
    { name: 'Open LLM Leaderboard', url: 'https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard', blurb: "Hugging Face's open-weights leaderboard (archived, still useful history)." },
    { name: 'Papers with Code', url: 'https://paperswithcode.co/', blurb: 'Trending papers with code, revived by Hugging Face.' },
  ],
  more: [
    { name: 'alphaXiv', url: 'https://www.alphaxiv.org/explore', blurb: 'Trending arXiv papers with discussion; no public API.', tab: 'research' },
    { name: 'Meta AI blog', url: 'https://ai.meta.com/blog/', blurb: 'No feed; announcements also reach the Meta Newsroom AI feed.', tab: 'labs' },
    { name: 'AI News (smol.ai)', url: 'https://news.smol.ai/', blurb: 'Daily issues now arrive as [AINews] posts in the Latent Space feed; the smol.ai RSS stopped on 2026-09-09.', tab: 'blogs' },
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
