// In-run dedup by canonical URL / arXiv id, and the previous-run merge with aggregate authority tuples.
import { codePointCompare, sourceInfo } from './registry.js';
import { orderedExtra, orderedSignals, SIGNAL_ORDER } from './normalize.js';

export const CATEGORY_PRECEDENCE = ['research', 'releases', 'labs', 'blogs', 'media', 'news'];
export const CATEGORY_RANK = { news: 0, media: 1, blogs: 2, labs: 3, releases: 4, research: 5 };
const EPHEMERAL = ['hnRank', 'hnFrontCurrent', 'redditTopCurrent'];

const categoryRank = (c) => CATEGORY_RANK[c] ?? -1;
const higherCategory = (a, b) => (categoryRank(a) >= categoryRank(b) ? a : b);

export function distinctFamilies(item, registry) {
  return new Set((item.sources ?? []).map((s) => sourceInfo(registry, s.id).family)).size;
}

/** Total order over candidates: weight desc, at asc, registryIndex asc, id code-point asc. */
export function compareProvenance(a, b, registry) {
  const ia = sourceInfo(registry, a.sources[0].id);
  const ib = sourceInfo(registry, b.sources[0].id);
  return (ib.weight - ia.weight)
    || (Date.parse(a.sources[0].at) - Date.parse(b.sources[0].at))
    || (ia.registryIndex - ib.registryIndex)
    || codePointCompare(a.sources[0].id, b.sources[0].id);
}

function sortSources(sources, registry) {
  return [...sources].sort((a, b) => {
    const ia = sourceInfo(registry, a.id).registryIndex;
    const ib = sourceInfo(registry, b.id).registryIndex;
    if (ia !== ib) return ia === Infinity ? 1 : ib === Infinity ? -1 : ia - ib;
    return codePointCompare(a.id, b.id);
  });
}

const minIso = (...values) => {
  const ts = values.filter((v) => typeof v === 'string').map((v) => Date.parse(v)).filter(Number.isFinite);
  return ts.length ? new Date(Math.min(...ts)).toISOString() : undefined;
};
const maxIso = (values) => new Date(Math.max(...values.map((v) => Date.parse(v)))).toISOString();

function mergeSignals(list) {
  const out = {};
  for (const key of SIGNAL_ORDER) {
    let best;
    for (const s of list) {
      const v = s?.[key];
      if (typeof v === 'number' && Number.isFinite(v) && (best === undefined || v > best)) best = v;
    }
    if (best !== undefined) out[key] = best;
  }
  return out;
}

export function stripEphemeral(item) {
  const copy = structuredClone(item);
  if (copy.extra) {
    for (const k of EPHEMERAL) delete copy.extra[k];
    if (Object.keys(copy.extra).length === 0) delete copy.extra;
  }
  return copy;
}

/** Merge the current run's per-source candidates into Items (score placeholder 0). */
export function mergeItems(candidates, registry) {
  const groups = new Map();
  for (const c of candidates) {
    const key = c.arxivId ? `arxiv:${c.arxivId}` : c.canonicalUrl;
    if (!groups.has(key)) groups.set(key, new Map());
    const perSource = groups.get(key);
    const sid = c.sources[0].id;
    const prev = perSource.get(sid);
    if (!prev || (c.nativeIndex ?? Infinity) < (prev.nativeIndex ?? Infinity)) perSource.set(sid, c);
  }
  const out = [];
  for (const perSource of groups.values()) {
    const cands = [...perSource.values()].sort((a, b) => compareProvenance(a, b, registry));
    out.push(mergeGroup(cands, registry));
  }
  return out;
}

function mergeGroup(cands, registry) {
  const first = cands[0];
  const arxivId = cands.find((c) => c.arxivId)?.arxivId;
  const paperClass = (c) => {
    const info = sourceInfo(registry, c.sources[0].id);
    return arxivId && (info.type === 'arxiv' || info.parser === 'hf-papers') ? 1 : 0;
  };
  const byTitle = cands.filter((c) => c.title).sort((a, b) => (paperClass(b) - paperClass(a)) || compareProvenance(a, b, registry));
  const sources = sortSources(cands.map((c) => ({ ...c.sources[0] })), registry);
  const category = cands.map((c) => c.category).reduce(higherCategory);
  const byUrl = [...cands].sort((a, b) => (categoryRank(b.category) - categoryRank(a.category)) || compareProvenance(a, b, registry));
  const canonicalUrl = arxivId ? `https://arxiv.org/abs/${arxivId}` : first.canonicalUrl;
  const item = {
    id: arxivId ? `arxiv:${arxivId}` : first.id,
    title: byTitle[0].title,
    url: arxivId ? canonicalUrl : byUrl[0].url,
    canonicalUrl,
    sources,
    category,
    publishedAt: minIso(...cands.map((c) => c.publishedAt)),
    surfacedAt: maxIso(sources.map((s) => s.at)),
    summary: '',
    score: 0,
    signals: mergeSignals(cands.map((c) => c.signals)),
  };
  const summaries = cands.filter((c) => c.summary).sort((a, b) => (b.summary.length - a.summary.length) || compareProvenance(a, b, registry));
  if (summaries.length) item.summary = summaries[0].summary;
  if (arxivId) item.arxivId = arxivId;
  const withAuthors = cands.filter((c) => Array.isArray(c.authors) && c.authors.length)
    .sort((a, b) => (Number(b.category === 'research') - Number(a.category === 'research')) || compareProvenance(a, b, registry));
  if (withAuthors.length) item.authors = withAuthors[0].authors.slice(0, 5);
  const read = cands.map((c) => c.readMinutes).filter((v) => Number.isSafeInteger(v) && v > 0);
  if (read.length) item.readMinutes = Math.max(...read);
  const discClass = (c) => { const t = sourceInfo(registry, c.sources[0].id).type; return t === 'hn' ? 2 : t === 'reddit' ? 1 : 0; };
  const disc = cands.filter((c) => c.discussionUrl).sort((a, b) => (discClass(b) - discClass(a)) || compareProvenance(a, b, registry));
  if (disc.length) item.discussionUrl = disc[0].discussionUrl;
  const tagged = cands.find((c) => c.tag);
  if (tagged) item.tag = tagged.tag;
  const extra = {};
  for (const c of cands) {
    if (!c.extra) continue;
    for (const [k, v] of Object.entries(c.extra)) {
      if (v === undefined || v === null) continue;
      if (EPHEMERAL.includes(k)) {
        const info = sourceInfo(registry, c.sources[0].id);
        if ((k === 'hnRank' || k === 'hnFrontCurrent') && !(c.sources[0].id === 'hn-front' || info.type === 'hn')) continue;
        if (k === 'redditTopCurrent' && info.type !== 'reddit') continue;
      }
      if (!(k in extra)) extra[k] = v;
    }
  }
  const ordered = orderedExtra(extra);
  if (ordered) item.extra = ordered;
  return item;
}

// ---------------------------------------------------------------------------
// Invalidations and previous-run merge

export function applyInvalidations(previousItems, invalidations, registry, logger) {
  if (!invalidations?.length) return previousItems;
  const byCanonical = new Map();
  for (const inv of invalidations) {
    if (!byCanonical.has(inv.canonicalUrl)) byCanonical.set(inv.canonicalUrl, []);
    byCanonical.get(inv.canonicalUrl).push(inv);
  }
  const out = [];
  for (const item of previousItems) {
    const invs = byCanonical.get(item.canonicalUrl);
    if (!invs) { out.push(item); continue; }
    const removeIds = new Set(invs.map((i) => i.sourceId));
    const remaining = item.sources.filter((s) => !removeIds.has(s.id));
    if (remaining.length === item.sources.length) { out.push(item); continue; }
    if (remaining.length === 0) {
      logger?.info?.(`dropping ${item.id}: sitemap attribution proven stale and no source remains`);
      continue;
    }
    const copy = structuredClone(item);
    copy.sources = remaining;
    if (copy.extra) { delete copy.extra.titleFrom; if (!Object.keys(copy.extra).length) delete copy.extra; }
    copy.publishedAt = minIso(copy.publishedAt, ...invs.map((i) => i.provenPublishedAt)) ?? copy.publishedAt;
    copy.surfacedAt = maxIso(remaining.map((s) => s.at));
    const cats = remaining.map((s) => sourceInfo(registry, s.id).category).filter((c) => c && c in CATEGORY_RANK);
    if (cats.length) copy.category = cats.reduce(higherCategory);
    out.push(copy);
  }
  return out;
}

function sourceAuthority(registry, s) {
  const info = sourceInfo(registry, s.id);
  return [info.weight, -Date.parse(s.at), -info.registryIndex, s.id];
}
export function compareAuthority(a, b) {
  const n = Math.min(a.length, b.length) - 1;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      if (a[i] === -Infinity) return -1;
      if (b[i] === -Infinity) return 1;
      return a[i] > b[i] ? 1 : -1;
    }
  }
  return -codePointCompare(a[n], b[n]); // smaller id is stronger
}
export function bestAuthority(item, registry) {
  const tuples = item.sources.map((s) => sourceAuthority(registry, s));
  return tuples.reduce((best, t) => (compareAuthority(t, best) > 0 ? t : best));
}
export const titleAuthority = (item, registry) => [
  Number(Boolean(item.arxivId) && item.sources.some(({ id }) => { const i = sourceInfo(registry, id); return i.type === 'arxiv' || i.parser === 'hf-papers'; })),
  ...bestAuthority(item, registry),
];
export const urlAuthority = (item, registry) => [categoryRank(item.category), ...bestAuthority(item, registry)];
export const authorAuthority = (item, registry) => [Number(item.category === 'research'), ...bestAuthority(item, registry)];
export const discussionAuthority = (item, registry) => [
  item.sources.some(({ id }) => sourceInfo(registry, id).type === 'hn') ? 2
    : item.sources.some(({ id }) => sourceInfo(registry, id).type === 'reddit') ? 1 : 0,
  ...bestAuthority(item, registry),
];

/** Pick by authority: stronger wins; exact tie -> fresh. */
function pick(storedVal, freshVal, storedAuth, freshAuth) {
  return compareAuthority(storedAuth, freshAuth) > 0 ? storedVal : freshVal;
}

export function mergePair(stored, fresh, registry) {
  const sA = bestAuthority(stored, registry);
  const fA = bestAuthority(fresh, registry);
  const byId = new Map();
  for (const s of stored.sources) byId.set(s.id, { ...s });
  for (const s of fresh.sources) {
    const prev = byId.get(s.id);
    if (!prev) { byId.set(s.id, { ...s }); continue; }
    const merged = { id: s.id };
    const url = (typeof s.url === 'string' && s.url) ? s.url : prev.url;
    if (url) merged.url = url;
    merged.at = minIso(prev.at, s.at);
    byId.set(s.id, merged);
  }
  const sources = sortSources([...byId.values()], registry);
  const arxivId = fresh.arxivId ?? stored.arxivId;
  const category = higherCategory(stored.category, fresh.category);
  const out = {
    id: fresh.id,
    title: (stored.title && fresh.title) ? pick(stored.title, fresh.title, titleAuthority(stored, registry), titleAuthority(fresh, registry)) : (fresh.title || stored.title),
    url: arxivId ? `https://arxiv.org/abs/${arxivId}` : pick(stored.url, fresh.url, urlAuthority(stored, registry), urlAuthority(fresh, registry)),
    canonicalUrl: fresh.canonicalUrl,
    sources,
    category,
    publishedAt: minIso(stored.publishedAt, fresh.publishedAt),
    surfacedAt: maxIso(sources.map((s) => s.at)),
    summary: '',
    score: 0,
    signals: mergeSignals([stored.signals, fresh.signals]),
  };
  if (stored.summary || fresh.summary) {
    if (stored.summary.length !== fresh.summary.length) out.summary = stored.summary.length > fresh.summary.length ? stored.summary : fresh.summary;
    else out.summary = pick(stored.summary, fresh.summary, sA, fA);
  }
  if (arxivId) out.arxivId = arxivId;
  const sAuth = stored.authors?.length ? stored.authors : null;
  const fAuth = fresh.authors?.length ? fresh.authors : null;
  if (sAuth && fAuth) out.authors = pick(sAuth, fAuth, authorAuthority(stored, registry), authorAuthority(fresh, registry));
  else if (sAuth || fAuth) out.authors = sAuth ?? fAuth;
  const reads = [stored.readMinutes, fresh.readMinutes].filter((v) => Number.isSafeInteger(v) && v > 0);
  if (reads.length) out.readMinutes = Math.max(...reads);
  if (stored.discussionUrl && fresh.discussionUrl) out.discussionUrl = pick(stored.discussionUrl, fresh.discussionUrl, discussionAuthority(stored, registry), discussionAuthority(fresh, registry));
  else if (stored.discussionUrl || fresh.discussionUrl) out.discussionUrl = stored.discussionUrl ?? fresh.discussionUrl;
  if (stored.tag && fresh.tag) out.tag = pick(stored.tag, fresh.tag, sA, fA);
  else if (stored.tag || fresh.tag) out.tag = stored.tag ?? fresh.tag;
  const extra = {};
  const sx = stored.extra ?? {};
  const fx = fresh.extra ?? {};
  for (const k of new Set([...Object.keys(sx), ...Object.keys(fx)])) {
    if (EPHEMERAL.includes(k)) { if (k in fx) extra[k] = fx[k]; continue; }
    if (k in sx && k in fx) extra[k] = pick(sx[k], fx[k], sA, fA);
    else extra[k] = k in sx ? sx[k] : fx[k];
  }
  const ordered = orderedExtra(extra);
  if (ordered) out.extra = ordered;
  return out;
}

/** Union previous (already stripped/invalidated) items with fresh items; carry forward unmatched previous items. */
export function mergePrevious(previousItems, freshItems, registry, logger) {
  const freshById = new Map(freshItems.map((f) => [f.id, f]));
  const out = [];
  const consumed = new Set();
  for (const stored of previousItems) {
    const fresh = freshById.get(stored.id);
    if (!fresh) { out.push(stored); continue; }
    consumed.add(stored.id);
    const sameArxiv = (stored.arxivId ?? null) === (fresh.arxivId ?? null);
    if (!sameArxiv || stored.canonicalUrl !== fresh.canonicalUrl) {
      logger?.warn?.(`stored item ${stored.id} disagrees with the fresh item on arxivId/canonicalUrl; discarding the stored copy`);
      out.push(fresh);
      continue;
    }
    out.push(mergePair(stored, fresh, registry));
  }
  for (const fresh of freshItems) if (!consumed.has(fresh.id)) out.push(fresh);
  return out;
}

export { orderedSignals };
