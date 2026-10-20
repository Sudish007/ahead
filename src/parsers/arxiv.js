// arXiv source runner: RSS primary with API (Atom) fallback. Owns both requests.
import { errorClass } from '../http.js';
import { cleanText, extractArxivId, parseDate } from '../normalize.js';
import { decodeFeed, text } from './feed.js';
import { applySelection } from './common.js';

const ANNOUNCE_PREFIX_RE = /^arXiv:\S+\s+Announce Type:\s*\w+(?:-\w+)?\s*Abstract:\s*/;

function rssRecords(records, ctx) {
  const out = [];
  records.forEach((e, nativeIndex) => {
    if (!e || typeof e !== 'object') return;
    const announce = text(e['arxiv:announce_type']).trim();
    if (/replace/.test(announce)) return;
    const link = text(e.link).trim();
    const arxivId = extractArxivId(link) ?? extractArxivId(text(e.guid)) ?? extractArxivId(text(e.description));
    if (!arxivId) return;
    const title = cleanText(text(e.title));
    if (!title) return;
    const raw = { nativeIndex, title, url: `https://arxiv.org/abs/${arxivId}`, arxivId };
    const desc = cleanText(text(e.description)).replace(ANNOUNCE_PREFIX_RE, '').trim();
    if (desc) raw.summaryText = desc;
    const creator = text(e['dc:creator']).trim();
    if (creator) {
      const authors = creator.split(',').map((a) => cleanText(a)).filter(Boolean).slice(0, 5);
      if (authors.length) raw.authors = authors;
    }
    const publishedAt = parseDate(text(e.pubDate).trim() || text(e['dc:date']).trim(), ctx.now);
    if (publishedAt) raw.publishedAt = publishedAt;
    const cats = Array.isArray(e.category) ? e.category : e.category ? [e.category] : [];
    const primary = cleanText(text(cats[0]));
    if (primary) raw.extra = { primaryCategory: primary };
    out.push(raw);
  });
  return out;
}

function apiRecords(records, ctx) {
  const out = [];
  records.forEach((e, nativeIndex) => {
    if (!e || typeof e !== 'object') return;
    const arxivId = extractArxivId(text(e.id).trim());
    if (!arxivId) return;
    const title = cleanText(text(e.title));
    if (!title) return;
    const raw = { nativeIndex, title, url: `https://arxiv.org/abs/${arxivId}`, arxivId, extra: { via: 'api' } };
    const summary = cleanText(text(e.summary));
    if (summary) raw.summaryText = summary;
    const authors = (Array.isArray(e.author) ? e.author : e.author ? [e.author] : [])
      .map((a) => cleanText(a && typeof a === 'object' ? text(a.name) : a)).filter(Boolean).slice(0, 5);
    if (authors.length) raw.authors = authors;
    const publishedAt = parseDate(text(e.published).trim() || text(e.updated).trim(), ctx.now);
    if (publishedAt) raw.publishedAt = publishedAt;
    const pc = Array.isArray(e['arxiv:primary_category']) ? e['arxiv:primary_category'][0] : e['arxiv:primary_category'];
    const term = pc && typeof pc === 'object' ? pc['@_term'] : undefined;
    if (typeof term === 'string' && term.trim()) raw.extra.primaryCategory = term.trim();
    out.push(raw);
  });
  return out;
}

async function fetchApi(source, ctx) {
  const res = await ctx.fetchText(source.fallbackUrl);
  const { records } = decodeFeed(res.text);
  const result = applySelection(apiRecords(records, ctx), source, ctx, records.length, 'api fallback');
  result.httpStatus = res.status;
  result.finalUrl = res.finalUrl;
  result.requestedUrl = source.fallbackUrl;
  return result;
}

export async function fetchArxivSource(source, ctx) {
  let primaryError;
  let rssRecordsDecoded = null;
  let res;
  try {
    res = await ctx.fetchText(source.url);
    rssRecordsDecoded = decodeFeed(res.text).records;
  } catch (err) {
    primaryError = err;
  }
  if (rssRecordsDecoded && rssRecordsDecoded.length > 0) {
    const result = applySelection(rssRecords(rssRecordsDecoded, ctx), source, ctx, rssRecordsDecoded.length);
    result.httpStatus = res.status;
    result.finalUrl = res.finalUrl;
    return result;
  }
  try {
    return await fetchApi(source, ctx);
  } catch (fallbackError) {
    const fb = errorClass(fallbackError);
    if (primaryError) {
      ctx.logger?.warn?.(`${source.id}: primary failed (${errorClass(primaryError)}) and api fallback failed (${fb})`);
      return { status: 'failed', items: [], fetched: 0, kept: 0, error: fb, ...(fallbackError.status ? { httpStatus: fallbackError.status } : {}) };
    }
    ctx.logger?.warn?.(`${source.id}: valid empty RSS and api fallback failed (${fb})`);
    return { status: 'empty', items: [], fetched: 0, kept: 0, note: 'api fallback failed', httpStatus: res.status, finalUrl: res.finalUrl };
  }
}
