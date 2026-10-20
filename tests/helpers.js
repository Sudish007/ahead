// Shared test helpers: config, fixtures, the offline fixture fetch and the in-process pipeline runner.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sources, linkouts, learn } from '../sources.config.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
export const CONFIG = { sources, linkouts, learn };
export const NOW = new Date('2026-10-19T12:00:00Z');

export const read = (name) => readFileSync(path.join(FIXTURES, name), 'utf8');

export function expandUrl(url, now) {
  const unix24hAgo = Math.floor(now.getTime() / 1000) - 86_400;
  const date7dAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  return url.replace(/\{\{unix24hAgo\}\}/g, String(unix24hAgo)).replace(/\{\{date7dAgo\}\}/g, date7dAgo);
}

const XML = 'application/xml';
const JSONT = 'application/json';
export const EXACT = {
  'arxiv-cs.LG': ['arxiv-rss-cs.LG.xml', 'application/rss+xml'],
  'arxiv-cs.AI': ['arxiv-rss-cs.AI-empty.xml', 'application/rss+xml'],
  'hf-papers': ['hf-daily-papers.json', JSONT],
  'hn-top': ['hn-algolia-bydate.json', JSONT],
  'hn-front': ['hn-algolia-front.json', JSONT],
  reddit: ['reddit-multi-rss.xml', 'application/atom+xml'],
  openai: ['openai-news.xml', 'application/rss+xml'],
  anthropic: ['anthropic-sitemap.xml', XML],
  deepmind: ['deepmind-blog.xml', 'application/rss+xml'],
  'google-research': ['google-research.xml', 'text/xml'],
  'meta-newsroom-ai': ['meta-newsroom-ai.xml', 'application/rss+xml'],
  'nvidia-dev': ['nvidia-dev-blog-atom.xml', 'application/atom+xml'],
  'hf-blog': ['hf-blog.xml', 'application/rss+xml'],
  allenai: ['allenai-rss.xml', 'application/rss+xml'],
  mistral: ['mistral-news-rss.xml', 'text/plain'],
  'transformer-circuits': ['transformer-circuits-feed.xml', 'application/atom+xml'],
  interconnects: ['substack-interconnects.xml', 'application/rss+xml'],
  simonw: ['simonwillison-atom.xml', 'application/atom+xml'],
  alignmentforum: ['alignmentforum.xml', 'application/rss+xml'],
  thebatch: ['deeplearning-sitemap.xml', XML],
  epoch: ['epoch-atom.xml', 'application/atom+xml'],
  'karpathy-bearblog': ['karpathy-bearblog-atom.xml', 'application/atom+xml'],
  'gh-rel-pytorch': ['gh-releases-pytorch.xml', 'application/atom+xml'],
  'gh-rel-vllm': ['gh-releases-vllm.xml', 'application/atom+xml'],
  'gh-rel-llamacpp': ['gh-releases-llamacpp.xml', 'application/atom+xml'],
  'gh-trending-llm': ['gh-search-llm.json', JSONT],
  'gh-trending-ml': ['gh-search-ml.json', JSONT],
  'hf-trending': ['hf-trending-models.json', JSONT],
  'pod-mlst': ['podcast-mlst-anchor.xml', 'application/rss+xml'],
  'pod-cogrev': ['podcast-cognitive-revolution.xml', 'application/rss+xml'],
  'yt-gpumode': ['youtube-gpumode.xml', 'application/atom+xml'],
};
export const FALLBACK_FIXTURE = ['arxiv-api-cs.LG.xml', 'application/atom+xml'];
export const RANK_FIXTURE = ['hn-topstories.json', JSONT];

/** Fixture by source kind when no exact mapping exists; null when the kind is unsupported. */
export function kindFixture(source) {
  switch (source.type) {
    case 'arxiv': return ['arxiv-rss-cs.LG.xml', 'application/rss+xml'];
    case 'rss': return source.category === 'media' ? ['podcast-mlst-anchor.xml', 'application/rss+xml'] : ['openai-news.xml', 'application/rss+xml'];
    case 'atom': return ['simonwillison-atom.xml', 'application/atom+xml'];
    case 'github': return new URL(expandUrl(source.url, NOW)).hostname === 'api.github.com' ? ['gh-search-llm.json', JSONT] : ['gh-releases-vllm.xml', 'application/atom+xml'];
    case 'youtube': return ['youtube-gpumode.xml', 'application/atom+xml'];
    case 'sitemap': return ['anthropic-sitemap.xml', XML];
    case 'hn': return ['hn-algolia-front.json', JSONT];
    case 'reddit': return ['reddit-multi-rss.xml', 'application/atom+xml'];
    case 'json': return source.parser === 'hf-models' ? ['hf-trending-models.json', JSONT] : source.parser === 'hf-papers' ? ['hf-daily-papers.json', JSONT] : null;
    default: return null;
  }
}

export function fixtureFor(source) {
  return EXACT[source.id] ?? kindFixture(source);
}

let lastmodMap;
function lastmodByLoc() {
  if (lastmodMap) return lastmodMap;
  lastmodMap = new Map();
  for (const f of ['anthropic-sitemap.xml', 'deeplearning-sitemap.xml']) {
    const xml = read(f);
    for (const m of xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?\s*<\/url>/g)) {
      if (m[2]) lastmodMap.set(m[1].trim(), new Date(m[2].trim()).toISOString());
    }
  }
  return lastmodMap;
}

export function pageHtml(url) {
  const slug = new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'page';
  const lastmod = lastmodByLoc().get(url) ?? NOW.toISOString();
  return `<!doctype html><html><head><title>${slug} \\ Site</title><meta property="og:title" content="OG ${slug}"><meta property="og:description" content="Desc ${slug}"><meta property="article:published_time" content="${lastmod}"></head><body></body></html>`;
}

function headerOf(init, name) {
  const h = init?.headers;
  if (!h) return undefined;
  if (typeof h.get === 'function') return h.get(name);
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}

/** Offline fetch: exact map, kind fallback, generated sitemap pages, overrides. Unmapped URLs throw. */
export function fixtureFetch({ now = NOW, overrides = {}, calls } = {}) {
  const map = new Map();
  for (const s of sources) {
    const fx = fixtureFor(s);
    if (fx) map.set(expandUrl(s.url, now), fx);
    if (s.fallbackUrl) map.set(s.fallbackUrl, FALLBACK_FIXTURE);
    if (s.rankUrl) map.set(s.rankUrl, RANK_FIXTURE);
  }
  return async function fetchImpl(url, init = {}) {
    const key = String(url);
    if (Array.isArray(calls)) calls.push({ url: key, init });
    const ov = overrides[key];
    if (ov) {
      if (ov.throw) throw ov.throw;
      const extra = ov.headers ?? {};
      if (ov.status !== undefined && ov.body === undefined) return new Response('', { status: ov.status, headers: { 'content-type': 'text/plain', ...extra } });
      return new Response(ov.body ?? '', { status: ov.status ?? 200, headers: { 'content-type': ov.contentType ?? 'application/octet-stream', ...extra } });
    }
    const accept = headerOf(init, 'accept') ?? '';
    if (/text\/html/.test(accept)) {
      return new Response(pageHtml(key), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    const fx = map.get(key);
    if (!fx) throw new Error(`fixtureFetch: unmapped URL ${key}`);
    return new Response(read(fx[0]), { status: 200, headers: { 'content-type': fx[1] } });
  };
}

/** Run the real pipeline in-process against fixtures. */
export async function runFixture(options = {}) {
  const { run } = await import('../src/pipeline.js');
  const { overrides, calls, ...rest } = options;
  return run({ ...CONFIG, now: NOW, fetchImpl: fixtureFetch({ now: rest.now ?? NOW, overrides, calls }), env: {}, logger: quietLogger(), ...rest });
}

export function quietLogger(sink = []) {
  const push = (level) => (...a) => sink.push([level, a.map(String).join(' ')]);
  const logger = { warn: push('warn'), info: push('info'), error: push('error'), debug: () => {} };
  logger.sink = sink;
  return logger;
}
