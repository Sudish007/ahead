// URL canonicalization, arXiv ids, text cleaning, dates and the RawItem -> Item step.
import { createHash } from 'node:crypto';

export const MIN_DATE_MS = Date.parse('2000-01-01T00:00:00Z');
export const SIGNAL_ORDER = ['hnPoints', 'hnComments', 'hfUpvotes', 'redditScore', 'ghStars', 'hfLikes', 'ytViews'];

const TRACKING_RE = /^(utm_\w+|ref|ref_src|ref_url|source|fbclid|gclid|dclid|mc_cid|mc_eid|igshid|si|feature|_hsenc|_hsmi|mkt_tok|trk|s|t|cmpid|ncid|sr_share|share|smid)$/;
const NEW_ID = '\\d{4}\\.\\d{4,5}';
const OLD_ID = '[a-z-]+(?:\\.[A-Z]{2})?\\/\\d{7}';
const ID = `(${NEW_ID}|${OLD_ID})`;
const ARXIV_PATTERNS = [
  new RegExp(`arxiv\\.org\\/(?:abs|pdf|html)\\/${ID}(?:v\\d+)?(?:\\.pdf)?`),
  new RegExp(`huggingface\\.co\\/papers\\/${ID}`),
  new RegExp(`alphaxiv\\.org\\/(?:abs|overview)\\/${ID}`),
  new RegExp(`arXiv:${ID}`),
];
export const ARXIV_ID_RE = new RegExp(`^${ID}$`);

export function isHttpUrl(s) {
  if (typeof s !== 'string') return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function extractArxivId(s) {
  if (typeof s !== 'string') return null;
  for (const re of ARXIV_PATTERNS) {
    const m = re.exec(s);
    if (m) return m[1];
  }
  return null;
}

function codePointLess(a, b) {
  const l = Array.from(a); const r = Array.from(b);
  for (let i = 0; i < Math.min(l.length, r.length); i++) {
    const d = l[i].codePointAt(0) - r[i].codePointAt(0);
    if (d) return d;
  }
  return l.length - r.length;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function canonicalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let host = u.hostname.toLowerCase().replace(/^www\./, '');
  let port = u.port;
  if (port === '80' || port === '443') port = '';
  // arXiv family -> abs URL without version
  if (/(^|\.)arxiv\.org$/.test(host)) {
    const id = extractArxivId(u.href);
    if (id) return `https://arxiv.org/abs/${id}`;
  }
  // youtu.be/<id> -> youtube watch
  if (host === 'youtu.be') {
    const id = u.pathname.replace(/^\/+/, '').split('/')[0];
    if (id) return `https://youtube.com/watch?v=${id}`;
  }
  let path = u.pathname.replace(/\/{2,}/g, '/');
  path = path.replace(/\/index\.html$/, '');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '') path = '/';
  if (host === 'github.com') {
    const segs = path.split('/').filter(Boolean);
    if (segs.length === 2) {
      path = `/${segs[0].toLowerCase()}/${segs[1].toLowerCase().replace(/\.git$/, '')}`;
    }
  }
  // query
  const rawQuery = u.search.startsWith('?') ? u.search.slice(1) : u.search;
  const pairs = rawQuery === '' ? [] : rawQuery.split('&').filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? [p, null] : [p.slice(0, i), p.slice(i + 1)];
  });
  let kept;
  if ((host === 'youtube.com' || host === 'm.youtube.com') && path === '/watch') {
    host = 'youtube.com';
    kept = pairs.filter(([k]) => safeDecode(k) === 'v').slice(0, 1);
  } else if (host === 'news.ycombinator.com' && path === '/item') {
    kept = pairs.filter(([k]) => safeDecode(k) === 'id').slice(0, 1);
  } else {
    kept = pairs.filter(([k]) => !TRACKING_RE.test(safeDecode(k)));
    kept.sort((a, b) => codePointLess(a[0], b[0]));
  }
  const query = kept.map(([k, v]) => (v === null ? k : `${k}=${v}`)).join('&');
  return `https://${host}${port ? `:${port}` : ''}${path}${query ? `?${query}` : ''}`;
}

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»',
  bull: '•', middot: '·', times: '×', deg: '°', euro: '€', pound: '£', shy: '', zwj: '', zwnj: '',
};

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return body in NAMED_ENTITIES ? NAMED_ENTITIES[body] : m;
  });
}

export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|blockquote|pre|section|article|header|footer|figure|figcaption|img|hr)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
}

export function cleanText(html) {
  if (html === undefined || html === null) return '';
  const decodedOnce = decodeEntities(String(html));
  return decodeEntities(stripHtml(decodedOnce)).replace(/\s+/g, ' ').trim();
}

/** Cut at the last sentence end before `max`, else the last space, and append an ellipsis. */
export function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const limit = Math.max(1, max - 1);
  let cut = -1;
  for (let i = limit - 1; i >= 1; i--) {
    if ('.!?'.includes(s[i]) && /\s/.test(s[i + 1] ?? ' ')) { cut = i + 1; break; }
  }
  if (cut < 0) {
    const sp = s.lastIndexOf(' ', limit);
    cut = sp >= Math.floor(limit / 2) ? sp : limit;
  }
  return `${s.slice(0, cut).trimEnd()}…`;
}

/** Cut at a word boundary (no sentence preference) and append an ellipsis. */
export function cutAtWord(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const limit = Math.max(1, max - 1);
  const sp = s.lastIndexOf(' ', limit);
  const cut = sp >= Math.floor(limit / 2) ? sp : limit;
  return `${s.slice(0, cut).trimEnd()}…`;
}

export function parseDate(value, now = new Date()) {
  if (value === undefined || value === null || value === '') return undefined;
  let d;
  if (value instanceof Date) d = new Date(value.getTime());
  else if (typeof value === 'number') d = new Date(value);
  else d = new Date(String(value).trim());
  const t = d.getTime();
  if (!Number.isFinite(t) || t < MIN_DATE_MS) return undefined;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (Number.isFinite(nowMs) && t > nowMs) return new Date(nowMs);
  return d;
}

export function itemId(canonicalUrl, arxivId) {
  if (arxivId) return `arxiv:${arxivId}`;
  return createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 16);
}

export const finiteNonNeg = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

export function orderedSignals(signals) {
  const out = {};
  if (!signals || typeof signals !== 'object') return out;
  for (const k of SIGNAL_ORDER) {
    const v = finiteNonNeg(signals[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function orderedExtra(extra) {
  if (!extra || typeof extra !== 'object') return undefined;
  const keys = Object.keys(extra).filter((k) => extra[k] !== undefined && extra[k] !== null).sort(codePointLess);
  if (keys.length === 0) return undefined;
  const out = {};
  for (const k of keys) out[k] = extra[k];
  return out;
}

export function normalizeAuthors(list) {
  if (!Array.isArray(list)) return undefined;
  const out = [];
  for (const a of list) {
    const name = cleanText(a);
    if (name && name.length <= 80) out.push(name);
    if (out.length === 5) break;
  }
  return out.length ? out : undefined;
}

/**
 * Turn a parser RawItem into a per-source normalized Item (score placeholder 0).
 * Returns null for an invalid record (the caller increments `skipped`).
 */
export function toItem(raw, source, now) {
  if (!raw || typeof raw !== 'object') return null;
  const title = truncate(cleanText(raw.title), 200);
  if (!title) return null;
  if (!(typeof raw.url === 'string' && raw.url.length <= 2048 && isHttpUrl(raw.url))) return null;
  const arxivId = raw.arxivId ?? extractArxivId(raw.url) ?? undefined;
  if (arxivId !== undefined && !ARXIV_ID_RE.test(arxivId)) return null;
  const canonicalUrl = arxivId ? `https://arxiv.org/abs/${arxivId}` : canonicalizeUrl(raw.url);
  if (!canonicalUrl) return null;
  const publishedAt = parseDate(raw.publishedAt, now);
  const surfacedAt = parseDate(raw.surfacedAt, now);
  const at = surfacedAt ?? publishedAt ?? now;
  const maxAgeDays = source.maxAgeDays ?? 7;
  if (at.getTime() < now.getTime() - maxAgeDays * 86_400_000) return null;
  const itemUrl = arxivId ? canonicalUrl : raw.url;
  const discussionUrl = isHttpUrl(raw.discussionUrl) ? raw.discussionUrl : undefined;
  const sourceUrl = discussionUrl ?? (raw.url !== itemUrl ? raw.url : undefined);
  let category = raw.category ?? source.category;
  if (typeof raw.enclosureType === 'string' && /^audio\//i.test(raw.enclosureType) && (source.category === 'blogs' || source.category === 'labs')) {
    category = 'media';
  }
  const summaryLimit = source.type === 'arxiv' ? 400 : 600;
  const summaryRaw = typeof raw.summaryText === 'string' && raw.summaryText.trim() ? raw.summaryText : raw.summaryHtml;
  const summary = truncate(cleanText(summaryRaw), summaryLimit);
  const item = {
    id: itemId(canonicalUrl, arxivId),
    title,
    url: itemUrl,
    canonicalUrl,
    sources: [{ id: source.id, ...(sourceUrl ? { url: sourceUrl } : {}), at: at.toISOString() }],
    category,
    publishedAt: (publishedAt ?? at).toISOString(),
    surfacedAt: at.toISOString(),
    summary,
    score: 0,
    signals: orderedSignals(raw.signals),
  };
  if (arxivId) item.arxivId = arxivId;
  const authors = normalizeAuthors(raw.authors);
  if (authors) item.authors = authors;
  const bodyLength = finiteNonNeg(raw.bodyLength);
  if (bodyLength !== undefined && bodyLength > 0) item.readMinutes = Math.ceil(bodyLength / 1000);
  if (discussionUrl) item.discussionUrl = discussionUrl;
  if (typeof raw.tag === 'string' && raw.tag.trim()) item.tag = raw.tag.trim();
  const extra = orderedExtra(raw.extra);
  if (extra) item.extra = extra;
  return item;
}
