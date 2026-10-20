// JSON sources: Hacker News (Algolia + topstories rank), HF Daily Papers, HF trending models, GitHub search.
import { ACCEPT, ParseError } from '../http.js';
import { ARXIV_ID_RE, cleanText, extractArxivId, isHttpUrl, parseDate } from '../normalize.js';
import { applySelection, finiteNonNegative, isNonEmptyString, nonNegativeInteger } from './common.js';

export const AI_HOSTS = ['arxiv.org', 'huggingface.co', 'openai.com', 'anthropic.com', 'deepmind.google', 'ai.meta.com', 'mistral.ai', 'x.ai', 'deepseek.com', 'ollama.com', 'vllm.ai'];
export const AI_TITLE_STRONG = /\b(LLMs?|GPT[-\d.]*|ChatGPT|Claude|Gemini|Gemma|OpenAI|Anthropic|DeepMind|Mistral|Llama|Qwen|DeepSeek|Kimi|Grok|xAI|Hugging ?Face|transformers?|diffusion|RLHF|reinforcement learning|machine learning|deep learning|neural (net|network)s?|benchmarks?|inference|fine-?tun(e|ed|ing)|embeddings?|tokeni[sz](er|ation)|RAG|MCP|agentic|AI agents?|(language|foundation|open[- ]weights?|reasoning|vision|multimodal|frontier) models?|Nvidia|CUDA|GPUs?|TPUs?|PyTorch|JAX|vLLM|llama\.cpp|Ollama|Copilot|Codex|Cursor|Sora|Midjourney|Stable Diffusion|AGI|superintelligence|AI (safety|alignment))\b/i;
export const AI_TITLE_CASED = /\bAI\b/;
const HF_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseJson(body) {
  try { return JSON.parse(String(body)); } catch { throw new ParseError('invalid json'); }
}

export function isAiStory(title, url) {
  if (typeof url === 'string') {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      if (AI_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
    } catch { /* ignore */ }
  }
  const t = String(title ?? '');
  return AI_TITLE_STRONG.test(t) || AI_TITLE_CASED.test(t);
}

/** D2: Hugging Face repository id guard. */
export function isHfModelId(id) {
  if (typeof id !== 'string' || id.length > 200 || !HF_MODEL_ID_RE.test(id)) return false;
  return id.split('/').every((seg) => !seg.includes('..') && !seg.endsWith('.'));
}

// ---------------------------------------------------------------------------
// Hacker News

export async function parseHn(body, source, ctx) {
  const doc = parseJson(body);
  if (!isPlain(doc) || !Array.isArray(doc.hits)) throw new ParseError('unexpected shape');
  const fetched = doc.hits.length;
  const isFront = source.id === 'hn-front' || /front_page/.test(source.url ?? '');
  const out = [];
  doc.hits.forEach((hit, nativeIndex) => {
    if (!isPlain(hit)) return;
    const title = cleanText(hit.title);
    if (!title) return;
    const objectId = String(hit.objectID);
    if (!/^\d+$/.test(objectId)) return;
    const hasUrl = isNonEmptyString(hit.url);
    if (hasUrl && !isHttpUrl(hit.url)) return;
    const hnUrl = `https://news.ycombinator.com/item?id=${objectId}`;
    const url = hasUrl ? hit.url : hnUrl;
    if (!isAiStory(title, url)) return;
    const raw = { nativeIndex, title, url, discussionUrl: hnUrl, objectId };
    const publishedAt = parseDate(hit.created_at, ctx.now);
    if (publishedAt) raw.publishedAt = publishedAt;
    const signals = {};
    const points = nonNegativeInteger(hit.points);
    const comments = nonNegativeInteger(hit.num_comments);
    if (points !== undefined) signals.hnPoints = points;
    if (comments !== undefined) signals.hnComments = comments;
    if (Object.keys(signals).length) raw.signals = signals;
    if (isFront) raw.extra = { hnFrontCurrent: true };
    out.push(raw);
  });
  let note;
  if (source.rankUrl) {
    let ids = null;
    try {
      const res = await ctx.fetchText(source.rankUrl, { accept: ACCEPT.json });
      const parsed = JSON.parse(res.text);
      if (Array.isArray(parsed) && parsed.every((n) => Number.isInteger(n))) ids = parsed;
    } catch { ids = null; }
    if (ids) {
      const top = ids.slice(0, 30);
      for (const raw of out) {
        const idx = top.indexOf(Number(raw.objectId));
        if (idx >= 0) raw.extra = { ...(raw.extra ?? {}), hnRank: idx + 1 };
      }
    } else {
      note = 'rank unavailable';
      ctx.logger?.warn?.(`${source.id}: rank unavailable`);
    }
  }
  for (const raw of out) delete raw.objectId;
  return applySelection(out, source, ctx, fetched, note);
}

// ---------------------------------------------------------------------------
// Hugging Face Daily Papers

export function parseHfPapers(body, source, ctx) {
  const arr = parseJson(body);
  if (!Array.isArray(arr)) throw new ParseError('unexpected shape');
  const fetched = arr.length;
  const out = [];
  arr.forEach((el, nativeIndex) => {
    const paper = isPlain(el) ? el.paper : undefined;
    if (!isPlain(paper)) return;
    const title = cleanText(paper.title);
    if (!title) return;
    const idText = typeof paper.id === 'string' ? paper.id.trim() : '';
    const arxivId = ARXIV_ID_RE.test(idText) ? idText : extractArxivId(idText);
    if (!arxivId) return;
    const raw = { nativeIndex, title, url: `https://huggingface.co/papers/${arxivId}`, arxivId };
    if (isNonEmptyString(paper.summary)) raw.summaryText = paper.summary;
    if (Array.isArray(paper.authors)) {
      const names = paper.authors.map((a) => (isPlain(a) ? a.name : undefined)).filter(isNonEmptyString);
      if (names.length) raw.authors = names.slice(0, 5);
    }
    const publishedAt = parseDate(paper.publishedAt, ctx.now);
    if (publishedAt) raw.publishedAt = publishedAt;
    const surfacedAt = parseDate(paper.submittedOnDailyAt, ctx.now);
    if (surfacedAt) raw.surfacedAt = surfacedAt;
    const upvotes = finiteNonNegative(paper.upvotes);
    if (upvotes !== undefined) raw.signals = { hfUpvotes: upvotes };
    const extra = {};
    const stars = finiteNonNegative(paper.githubStars);
    if (stars !== undefined) extra.githubStars = stars;
    if (isNonEmptyString(paper.githubRepo)) extra.githubRepo = paper.githubRepo;
    if (Object.keys(extra).length) raw.extra = extra;
    out.push(raw);
  });
  return applySelection(out, source, ctx, fetched);
}

// ---------------------------------------------------------------------------
// Hugging Face trending models

const enUS = new Intl.NumberFormat('en-US');

export function parseHfModels(body, source, ctx) {
  const arr = parseJson(body);
  if (!Array.isArray(arr)) throw new ParseError('unexpected shape');
  const fetched = arr.length;
  const out = [];
  arr.forEach((m, nativeIndex) => {
    if (!isPlain(m)) return;
    const id = m.id ?? m.modelId;
    if (!isHfModelId(id)) return;
    const raw = { nativeIndex, title: id, url: `https://huggingface.co/${id}`, surfacedAt: ctx.now };
    const publishedAt = parseDate(m.createdAt, ctx.now);
    if (publishedAt) raw.publishedAt = publishedAt;
    const likes = finiteNonNegative(m.likes);
    const downloads = finiteNonNegative(m.downloads);
    const trending = finiteNonNegative(m.trendingScore);
    const parts = [];
    const extra = {};
    if (isNonEmptyString(m.pipeline_tag)) { parts.push(m.pipeline_tag.trim()); extra.pipelineTag = m.pipeline_tag.trim(); }
    if (isNonEmptyString(m.library_name)) { parts.push(m.library_name.trim()); extra.libraryName = m.library_name.trim(); }
    if (likes !== undefined) { parts.push(`${enUS.format(likes)} likes`); raw.signals = { hfLikes: likes }; }
    if (downloads !== undefined) { parts.push(`${enUS.format(downloads)} downloads`); extra.downloads = downloads; }
    if (trending !== undefined) extra.trendingScore = trending;
    if (parts.length) raw.summaryText = parts.join(' · ');
    if (isNonEmptyString(m.author)) raw.authors = [m.author.trim()];
    if (Object.keys(extra).length) raw.extra = extra;
    out.push(raw);
  });
  return applySelection(out, source, ctx, fetched);
}

// ---------------------------------------------------------------------------
// GitHub search (new repositories by topic)

export function parseGithubSearch(body, source, ctx) {
  const doc = parseJson(body);
  if (!isPlain(doc) || !Array.isArray(doc.items)) throw new ParseError('unexpected shape');
  const fetched = doc.items.length;
  const minStars = source.minStars ?? 0;
  const out = [];
  doc.items.forEach((r, nativeIndex) => {
    if (!isPlain(r)) return;
    if (!(isNonEmptyString(r.full_name) && /^[^\s/]+\/[^\s/]+$/.test(r.full_name))) return;
    if (!isHttpUrl(r.html_url)) return;
    const stars = nonNegativeInteger(r.stargazers_count);
    if (stars === undefined) return;
    if (stars < minStars) return;
    const raw = { nativeIndex, title: r.full_name, url: r.html_url, surfacedAt: ctx.now, signals: { ghStars: stars } };
    const publishedAt = parseDate(r.created_at, ctx.now);
    if (publishedAt) raw.publishedAt = publishedAt;
    const parts = [];
    if (isNonEmptyString(r.description)) parts.push(cleanText(r.description));
    if (isNonEmptyString(r.language)) parts.push(r.language.trim());
    if (parts.length) raw.summaryText = parts.join(' · ');
    if (Array.isArray(r.topics)) {
      const topics = r.topics.filter(isNonEmptyString).slice(0, 6);
      if (topics.length) raw.extra = { topics };
    }
    out.push(raw);
  });
  return applySelection(out, source, ctx, fetched);
}
