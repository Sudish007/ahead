// sitemap.xml sources (publishers without a feed): lastmod window, og:* page metadata,
// source-scoped skip/cache maps and invalidations.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ACCEPT, ParseError } from '../http.js';
import { canonicalizeUrl, cleanText, decodeEntities, isHttpUrl, parseDate, truncate } from '../normalize.js';
import { FXP_OPTIONS, text } from './feed.js';
import { codePointCompare } from '../registry.js';

export const CONSIDER_LIMIT = 30;
export const PAGE_FETCH_LIMIT = 10;
export const PAGE_CONCURRENCY = 4;
export const PAGE_TIMEOUT_MS = 8000;
export const PAGE_MAX_BYTES = 1_500_000;
export const PAGE_BUDGET_MS = 40_000;
export const MAP_LIMIT = 30;
const TITLE_SUFFIX_RE = /\s*[\\|·–—-]\s*[^\\|·–—-]{1,40}$/;

const SITEMAP_FXP = { ...FXP_OPTIONS, isArray: (name) => ['url'].includes(name) };

export function decodeSitemap(body) {
  const s = String(body ?? '');
  if (XMLValidator.validate(s) !== true) throw new ParseError('invalid xml');
  const doc = new XMLParser(SITEMAP_FXP).parse(s);
  const urlset = Array.isArray(doc.urlset) ? doc.urlset[0] : doc.urlset;
  if (!urlset || typeof urlset !== 'object') throw new ParseError('not a sitemap');
  return Array.isArray(urlset.url) ? urlset.url : [];
}

export function slugTitle(url) {
  let path;
  try { path = new URL(url).pathname; } catch { path = String(url); }
  const seg = path.split('/').filter(Boolean).pop() ?? '';
  let slug;
  try { slug = decodeURIComponent(seg); } catch { slug = seg; }
  const words = slug.replace(/\.[a-z0-9]+$/i, '').split(/[-_]+/).filter(Boolean);
  if (!words.length) return '';
  const joined = words.join(' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

function metaContent(html, property) {
  const re = new RegExp(`<meta\\s+[^>]*?(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i');
  const m = re.exec(html);
  if (!m) return '';
  const c = /content=["']([^"']*)["']/i.exec(m[0]) ?? /content=([^\s>]+)/i.exec(m[0]);
  return c ? decodeEntities(c[1]).trim() : '';
}

export function extractPageMeta(html) {
  const h = String(html ?? '');
  let title = cleanText(metaContent(h, 'og:title'));
  if (!title) {
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(h);
    const original = cleanText(t ? t[1] : '');
    if (original) {
      const stripped = original.replace(TITLE_SUFFIX_RE, '').trim();
      title = stripped.length >= 10 ? stripped : original;
    }
  }
  const description = cleanText(metaContent(h, 'og:description'));
  const publishedTime = metaContent(h, 'article:published_time');
  return { title, description, publishedTime };
}

function normalizeLastmod(value) {
  const t = Date.parse(String(value ?? '').trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Prune one source's skip/cache map to current in-window sitemap records with a matching lastmod; cap at 30. */
export function pruneSitemapMap(map, currentByCanonical, lastmodOf) {
  const entries = [];
  for (const [url, value] of Object.entries(map)) {
    const cur = currentByCanonical.get(url);
    if (!cur) continue;
    const stored = lastmodOf(value);
    if (stored !== cur.lastmod) continue;
    entries.push([url, value, stored]);
  }
  entries.sort((a, b) => (Date.parse(b[2]) - Date.parse(a[2])) || codePointCompare(a[0], b[0]));
  return Object.fromEntries(entries.slice(0, MAP_LIMIT).map(([u, v]) => [u, v]));
}

export async function parseSitemap(body, source, ctx) {
  const records = decodeSitemap(body);
  const fetched = records.length;
  const now = ctx.now;
  const nowMs = typeof ctx.nowMs === 'function' ? ctx.nowMs : Date.now;
  const maxAgeDays = source.maxAgeDays ?? 7;
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const maxItems = source.maxItems ?? 40;
  const logger = ctx.logger;

  // 1. record guards + include/exclude
  const valid = [];
  records.forEach((r, nativeIndex) => {
    if (!r || typeof r !== 'object') return;
    const loc = text(r.loc).trim();
    if (!(loc && loc.length <= 2048 && isHttpUrl(loc))) return;
    const lastmod = normalizeLastmod(text(r.lastmod));
    if (!lastmod) return;
    const canonicalUrl = canonicalizeUrl(loc);
    if (!canonicalUrl) return;
    if (source.include && !source.include.test(loc)) return;
    if (source.exclude && source.exclude.test(loc)) return;
    valid.push({ nativeIndex, loc, lastmod, canonicalUrl });
  });
  // 2. native order: lastmod desc, stable
  valid.sort((a, b) => (Date.parse(b.lastmod) - Date.parse(a.lastmod)) || (a.nativeIndex - b.nativeIndex));
  const inWindow = valid.filter((r) => Date.parse(r.lastmod) >= cutoff);
  const currentByCanonical = new Map(inWindow.map((r) => [r.canonicalUrl, r]));
  const candidates = inWindow.slice(0, CONSIDER_LIMIT);

  // 3. state
  const skipped = { ...(ctx.previousSitemapSkipped ?? {}) };
  const cache = { ...(ctx.previousSitemapCache ?? {}) };
  const invalidations = [];
  const prior = ctx.previousItemsByCanonicalUrl;
  const slots = new Array(candidates.length).fill(null);
  const toFetch = [];

  const invalidate = (canonicalUrl, provenPublishedAt) => {
    const prev = prior && typeof prior.get === 'function' ? prior.get(canonicalUrl) : undefined;
    if (prev && Array.isArray(prev.sources) && prev.sources.some((s) => s && s.id === source.id)) {
      invalidations.push({ sourceId: source.id, canonicalUrl, provenPublishedAt });
    }
  };
  const dropOld = (c, provenPublishedAt) => {
    delete cache[c.canonicalUrl];
    skipped[c.canonicalUrl] = c.lastmod;
    invalidate(c.canonicalUrl, provenPublishedAt);
  };

  candidates.forEach((c, i) => {
    const marker = skipped[c.canonicalUrl];
    if (marker !== undefined) {
      if (marker === c.lastmod) return; // exact skip: no request, no item
      delete skipped[c.canonicalUrl];
    }
    const cached = cache[c.canonicalUrl];
    if (cached && cached.lastmod === c.lastmod) {
      const publishedAt = new Date(cached.publishedAt);
      if (publishedAt.getTime() < cutoff) { dropOld(c, cached.publishedAt); return; }
      const raw = { nativeIndex: c.nativeIndex, title: cached.title, url: c.loc, publishedAt, surfacedAt: publishedAt, extra: { titleFrom: 'page' } };
      if (cached.summary) raw.summaryText = cached.summary;
      slots[i] = raw;
      return;
    }
    if (cached) delete cache[c.canonicalUrl];
    toFetch.push(i);
  });

  const slugItem = (c) => {
    const d = new Date(c.lastmod);
    const title = slugTitle(c.loc) || c.loc;
    return { nativeIndex: c.nativeIndex, title, url: c.loc, publishedAt: d, surfacedAt: d, extra: { titleFrom: 'slug' } };
  };

  // 4. page fetches
  const pageDeadlineAt = Math.min(ctx.sourceStartedAtMs + PAGE_BUDGET_MS, ctx.deadlineAt);
  const attempted = toFetch.slice(0, PAGE_FETCH_LIMIT);
  const unattempted = toFetch.slice(PAGE_FETCH_LIMIT);
  let attemptedCount = 0;
  let deadlinePassed = false;

  const fetchOne = async (i) => {
    const c = candidates[i];
    if (nowMs() >= pageDeadlineAt) { deadlinePassed = true; slots[i] = slugItem(c); return; }
    attemptedCount++;
    try {
      const res = await ctx.fetchText(c.loc, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES, accept: ACCEPT.html, deadlineAt: pageDeadlineAt });
      const meta = extractPageMeta(res.text);
      const title = truncate(meta.title, 200);
      if (!title) throw new ParseError('no title');
      const lastmodDate = new Date(c.lastmod);
      const published = parseDate(meta.publishedTime, now) ?? lastmodDate;
      const publishedIso = published.toISOString();
      if (published.getTime() < cutoff) { dropOld(c, publishedIso); return; }
      const summary = truncate(meta.description, 600);
      cache[c.canonicalUrl] = { lastmod: c.lastmod, title, summary, publishedAt: publishedIso };
      const raw = { nativeIndex: c.nativeIndex, title, url: c.loc, publishedAt: published, surfacedAt: published, extra: { titleFrom: 'page' } };
      if (summary) raw.summaryText = summary;
      slots[i] = raw;
    } catch (err) {
      logger?.warn?.(`${source.id}: page fetch failed for ${c.loc} (${err?.message ?? err})`);
      slots[i] = slugItem(c);
    }
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < attempted.length) {
      const i = attempted[cursor++];
      await fetchOne(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, attempted.length) }, worker));
  for (const i of unattempted) slots[i] = slugItem(candidates[i]);

  // 5. items in native order, then maxItems
  const emitted = slots.filter(Boolean);
  const items = emitted.slice(0, maxItems);
  const out = { status: items.length ? 'ok' : 'empty', items, fetched, kept: items.length };
  const needed = toFetch.length;
  if (needed > attemptedCount && (unattempted.length > 0 || deadlinePassed)) {
    out.note = `page fetches truncated (${attemptedCount} of ${needed})`;
    logger?.warn?.(`${source.id}: ${out.note}`);
  }
  out.sitemapSkipped = pruneSitemapMap(skipped, currentByCanonical, (v) => v);
  out.sitemapCache = pruneSitemapMap(cache, currentByCanonical, (v) => v && v.lastmod);
  const seen = new Set();
  out.invalidations = invalidations
    .filter((inv) => { const k = `${inv.sourceId}\u0000${inv.canonicalUrl}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => codePointCompare(a.sourceId, b.sourceId) || codePointCompare(a.canonicalUrl, b.canonicalUrl));
  return out;
}
