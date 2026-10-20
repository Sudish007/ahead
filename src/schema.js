// Validators for the static configuration and for every output file.
import { canonicalizeUrl, isHttpUrl } from './normalize.js';
import { countDigestWords } from './brief.js';

export const CATEGORIES = ['research', 'news', 'labs', 'blogs', 'releases', 'media'];
export const TYPES = ['rss', 'atom', 'json', 'arxiv', 'hn', 'reddit', 'github', 'youtube', 'sitemap'];
export const SIGNAL_KEYS = ['hnPoints', 'hnComments', 'hfUpvotes', 'redditScore', 'ghStars', 'hfLikes', 'ytViews'];
export const SECTION_KEYS = ['must-know', 'research', 'releases', 'labs', 'analysis', 'deep-read'];
/** Highest precedence first. */
export const CATEGORY_PRECEDENCE = ['research', 'releases', 'labs', 'blogs', 'media', 'news'];
export const PARSERS = ['hf-papers', 'hf-models'];
export const LEARN_KINDS = ['course', 'book', 'paper'];
export const MORE_TABS = ['research', 'labs', 'blogs'];
export const STATUSES = ['ok', 'empty', 'failed'];

const ID_RE = /^[A-Za-z0-9.-]+$/;
const ARXIV_ID_RE = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TEMPLATE_RE = /\{\{(\w+)\}\}/g;
const TEMPLATE_KEYS = new Set(['unix24hAgo', 'date7dAgo']);
export const MAX_ITEMS_BYTES = 2_000_000;
export const RETENTION_MS = 7 * 86_400_000;

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}
export class SchemaError extends Error {
  constructor(message) { super(message); this.name = 'SchemaError'; }
}

const fail = (path, what) => { throw new ConfigError(`${path} ${what}`); };
const sfail = (path, what) => { throw new SchemaError(`${path} ${what}`); };

export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isIso = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;

function substituteTemplate(url) {
  return url.replace(TEMPLATE_RE, (_, key) => (key === 'unix24hAgo' ? '1700000000' : '2026-01-01'));
}

/** `https://host/path/` with nothing else: the Worker allows a page URL when its normalized href starts with this string. */
function isRelayPagePrefix(v) {
  if (typeof v !== 'string') return false;
  let u;
  try { u = new URL(v); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.pathname.endsWith('/') && u.href === v;
}

// ---------------------------------------------------------------------------
// Static configuration

export function validateConfig({ sources, linkouts, learn } = {}) {
  if (!Array.isArray(sources) || sources.length === 0) fail('sources', 'must be a non-empty array');
  const ids = new Set();
  sources.forEach((s, i) => validateSource(s, `sources[${i}]`, ids));
  validateLinkouts(linkouts);
  validateLearn(learn);
  return true;
}

function validateSource(s, p, ids) {
  if (!isPlainObject(s)) fail(p, 'must be a plain object');
  for (const key of ['id', 'name', 'category', 'type', 'url']) {
    if (!isNonEmptyString(s[key])) fail(`${p}.${key}`, 'must be a non-empty string');
  }
  if (!ID_RE.test(s.id)) fail(`${p}.id`, 'must match ^[A-Za-z0-9.-]+$');
  if (ids.has(s.id)) fail(`${p}.id`, `duplicates "${s.id}"`);
  ids.add(s.id);
  if (!CATEGORIES.includes(s.category)) fail(`${p}.category`, `must be one of ${CATEGORIES.join('|')}`);
  if (!TYPES.includes(s.type)) fail(`${p}.type`, `must be one of ${TYPES.join('|')}`);
  if (!Number.isInteger(s.weight) || s.weight < 1 || s.weight > 10) fail(`${p}.weight`, 'must be an integer from 1 through 10');
  if ('template' in s && typeof s.template !== 'boolean') fail(`${p}.template`, 'must be a boolean');
  if ('longForm' in s && typeof s.longForm !== 'boolean') fail(`${p}.longForm`, 'must be a boolean');
  // Relay fields feed relay/build-allowlist.mjs: only plain feed/sitemap sources can be relayed (the Worker knows one URL per
  // id, so templated URLs cannot), and a relayed sitemap needs the page prefix the Worker allows article fetches under.
  if ('viaRelay' in s && typeof s.viaRelay !== 'boolean') fail(`${p}.viaRelay`, 'must be a boolean');
  if (s.viaRelay === true && !['rss', 'atom', 'sitemap'].includes(s.type)) fail(`${p}.viaRelay`, 'is allowed only on type rss|atom|sitemap');
  if (s.viaRelay === true && s.template === true) fail(`${p}.viaRelay`, 'is not allowed with template');
  if ('relayPagePrefix' in s) {
    if (s.type !== 'sitemap') fail(`${p}.relayPagePrefix`, 'is allowed only on type sitemap');
    if (!isRelayPagePrefix(s.relayPagePrefix)) fail(`${p}.relayPagePrefix`, 'must be an https URL ending with / and without credentials, query or fragment');
  }
  if (s.type === 'sitemap' && s.viaRelay === true && !('relayPagePrefix' in s)) fail(`${p}.relayPagePrefix`, 'is required for sitemap sources with viaRelay');
  const placeholders = [...s.url.matchAll(TEMPLATE_RE)].map((m) => m[1]);
  if (s.template === true) {
    for (const k of placeholders) if (!TEMPLATE_KEYS.has(k)) fail(`${p}.url`, `uses unknown placeholder {{${k}}}`);
  } else if (placeholders.length) {
    fail(`${p}.url`, 'contains template placeholders but template is not true');
  }
  if (!isHttpUrl(substituteTemplate(s.url))) fail(`${p}.url`, 'must be an HTTP(S) URL');
  if ('family' in s && !isNonEmptyString(s.family)) fail(`${p}.family`, 'must be a non-empty string');
  for (const key of ['homepage', 'fallbackUrl', 'rankUrl']) {
    if (key in s && !(typeof s[key] === 'string' && isHttpUrl(s[key]))) fail(`${p}.${key}`, 'must be an HTTP(S) URL');
  }
  for (const key of ['maxItems', 'maxBytes']) {
    if (key in s && !(Number.isSafeInteger(s[key]) && s[key] > 0)) fail(`${p}.${key}`, 'must be a positive safe integer');
  }
  if ('maxAgeDays' in s && !(typeof s.maxAgeDays === 'number' && Number.isFinite(s.maxAgeDays) && s.maxAgeDays > 0)) {
    fail(`${p}.maxAgeDays`, 'must be a finite number greater than zero');
  }
  for (const key of ['include', 'exclude']) {
    if (!(key in s)) continue;
    if (!(s[key] instanceof RegExp)) fail(`${p}.${key}`, 'must be a RegExp');
    if (s[key].global || s[key].sticky) fail(`${p}.${key}`, 'must not use the g or y flag');
  }
  if ('rankUrl' in s && s.type !== 'hn') fail(`${p}.rankUrl`, 'is allowed only on type hn');
  switch (s.type) {
    case 'arxiv':
      if (!('fallbackUrl' in s)) fail(`${p}.fallbackUrl`, 'is required for type arxiv');
      break;
    case 'json':
      if (!PARSERS.includes(s.parser)) fail(`${p}.parser`, `must be one of ${PARSERS.join('|')}`);
      break;
    case 'sitemap':
      if (!('include' in s)) fail(`${p}.include`, 'is required for type sitemap');
      break;
    case 'github': {
      const u = new URL(substituteTemplate(s.url));
      if (u.hostname === 'github.com') {
        if (!(typeof s.repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.repo))) fail(`${p}.repo`, 'must be owner/name for github.com release feeds');
        if (!u.pathname.endsWith('/releases.atom')) fail(`${p}.url`, 'must end with /releases.atom for github.com');
      } else if (u.hostname === 'api.github.com') {
        if (!u.pathname.startsWith('/search/repositories')) fail(`${p}.url`, 'must be a /search/repositories query for api.github.com');
        if (!isNonNegInt(s.minStars)) fail(`${p}.minStars`, 'must be a non-negative safe integer for api.github.com');
      } else {
        fail(`${p}.url`, 'must use host github.com or api.github.com for type github');
      }
      break;
    }
    default:
      break;
  }
}

function validateLink(l, p, withTab) {
  if (!isPlainObject(l)) fail(p, 'must be a plain object');
  if (!isNonEmptyString(l.name)) fail(`${p}.name`, 'must be a non-empty string');
  if (!isNonEmptyString(l.blurb)) fail(`${p}.blurb`, 'must be a non-empty string');
  if (!(typeof l.url === 'string' && isHttpUrl(l.url))) fail(`${p}.url`, 'must be an HTTP(S) URL');
  if (withTab && !MORE_TABS.includes(l.tab)) fail(`${p}.tab`, `must be one of ${MORE_TABS.join('|')}`);
}

function validateLinkouts(linkouts) {
  if (!isPlainObject(linkouts)) fail('linkouts', 'must be a plain object');
  if (!Array.isArray(linkouts.leaderboards)) fail('linkouts.leaderboards', 'must be an array');
  if (!Array.isArray(linkouts.more)) fail('linkouts.more', 'must be an array');
  linkouts.leaderboards.forEach((l, i) => validateLink(l, `linkouts.leaderboards[${i}]`, false));
  linkouts.more.forEach((l, i) => validateLink(l, `linkouts.more[${i}]`, true));
}

function validateLearn(learn) {
  if (!Array.isArray(learn)) fail('learn', 'must be an array');
  const ids = new Set();
  learn.forEach((e, i) => {
    const p = `learn[${i}]`;
    if (!isPlainObject(e)) fail(p, 'must be a plain object');
    if (!(isNonEmptyString(e.id) && ID_RE.test(e.id))) fail(`${p}.id`, 'must match ^[A-Za-z0-9.-]+$');
    if (ids.has(e.id)) fail(`${p}.id`, `duplicates "${e.id}"`);
    ids.add(e.id);
    if (!LEARN_KINDS.includes(e.kind)) fail(`${p}.kind`, `must be one of ${LEARN_KINDS.join('|')}`);
    if (!isNonEmptyString(e.title)) fail(`${p}.title`, 'must be a non-empty string');
    if (!(typeof e.url === 'string' && isHttpUrl(e.url))) fail(`${p}.url`, 'must be an HTTP(S) URL');
  });
}

// ---------------------------------------------------------------------------
// Items

export function validateItem(item, p = 'item') {
  if (!isPlainObject(item)) sfail(p, 'must be a plain object');
  if (!(typeof item.id === 'string' && (/^arxiv:.+$/.test(item.id) || /^[0-9a-f]{16}$/.test(item.id)))) sfail(`${p}.id`, 'must be arxiv:<id> or 16 hex chars');
  if (!(typeof item.title === 'string' && item.title.length >= 1 && item.title.length <= 200)) sfail(`${p}.title`, 'must be 1..200 chars');
  if (!(typeof item.url === 'string' && item.url.length <= 2048 && isHttpUrl(item.url))) sfail(`${p}.url`, 'must be an HTTP(S) URL <= 2048 chars');
  if (!(typeof item.canonicalUrl === 'string' && isHttpUrl(item.canonicalUrl))) sfail(`${p}.canonicalUrl`, 'must be an HTTP(S) URL');
  if (!Array.isArray(item.sources) || item.sources.length === 0) sfail(`${p}.sources`, 'must be a non-empty array');
  let maxAt = -Infinity;
  const seen = new Set();
  item.sources.forEach((s, i) => {
    const sp = `${p}.sources[${i}]`;
    if (!isPlainObject(s)) sfail(sp, 'must be a plain object');
    if (!isNonEmptyString(s.id)) sfail(`${sp}.id`, 'must be a non-empty string');
    if (seen.has(s.id)) sfail(`${sp}.id`, 'is duplicated');
    seen.add(s.id);
    if ('url' in s && !(typeof s.url === 'string' && isHttpUrl(s.url))) sfail(`${sp}.url`, 'must be an HTTP(S) URL');
    if (!isIso(s.at)) sfail(`${sp}.at`, 'must be an ISO timestamp');
    maxAt = Math.max(maxAt, Date.parse(s.at));
  });
  if (!CATEGORIES.includes(item.category)) sfail(`${p}.category`, 'is not a known category');
  if (!isIso(item.publishedAt)) sfail(`${p}.publishedAt`, 'must be an ISO timestamp');
  if (!isIso(item.surfacedAt)) sfail(`${p}.surfacedAt`, 'must be an ISO timestamp');
  if (Date.parse(item.surfacedAt) !== maxAt) sfail(`${p}.surfacedAt`, 'must equal max(sources[].at)');
  if (!(typeof item.summary === 'string' && item.summary.length <= 600)) sfail(`${p}.summary`, 'must be a string <= 600 chars');
  if (!(typeof item.score === 'number' && Number.isFinite(item.score))) sfail(`${p}.score`, 'must be a finite number');
  if (!isPlainObject(item.signals)) sfail(`${p}.signals`, 'must be an object');
  const keys = Object.keys(item.signals);
  let last = -1;
  for (const k of keys) {
    const idx = SIGNAL_KEYS.indexOf(k);
    if (idx < 0) sfail(`${p}.signals.${k}`, 'is not a known signal');
    if (idx <= last) sfail(`${p}.signals`, 'keys must follow schema order');
    last = idx;
    const v = item.signals[k];
    if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0)) sfail(`${p}.signals.${k}`, 'must be a finite non-negative number');
  }
  if ('arxivId' in item && !(typeof item.arxivId === 'string' && ARXIV_ID_RE.test(item.arxivId))) sfail(`${p}.arxivId`, 'must be an arXiv id');
  if ('arxivId' in item && item.id !== `arxiv:${item.arxivId}`) sfail(`${p}.id`, 'must be arxiv:<arxivId> for papers');
  if ('authors' in item) {
    if (!Array.isArray(item.authors) || item.authors.length === 0 || item.authors.length > 5) sfail(`${p}.authors`, 'must be 1..5 names');
    item.authors.forEach((a, i) => { if (!(isNonEmptyString(a) && a.length <= 80)) sfail(`${p}.authors[${i}]`, 'must be a non-empty string <= 80 chars'); });
  }
  if ('readMinutes' in item && !(Number.isSafeInteger(item.readMinutes) && item.readMinutes > 0)) sfail(`${p}.readMinutes`, 'must be a positive integer');
  if ('discussionUrl' in item && !(typeof item.discussionUrl === 'string' && isHttpUrl(item.discussionUrl))) sfail(`${p}.discussionUrl`, 'must be an HTTP(S) URL');
  if ('tag' in item && !isNonEmptyString(item.tag)) sfail(`${p}.tag`, 'must be a non-empty string');
  if ('extra' in item) {
    if (!isPlainObject(item.extra) || Object.keys(item.extra).length === 0) sfail(`${p}.extra`, 'must be a non-empty object when present');
    const ek = Object.keys(item.extra);
    for (let i = 1; i < ek.length; i++) if (!(ek[i - 1] < ek[i])) sfail(`${p}.extra`, 'keys must be in code-point order');
    if ('hnRank' in item.extra && !isNonNegInt(item.extra.hnRank)) sfail(`${p}.extra.hnRank`, 'must be a non-negative integer');
    for (const k of ['hnFrontCurrent', 'redditTopCurrent']) if (k in item.extra && item.extra[k] !== true) sfail(`${p}.extra.${k}`, 'must be exactly true when present');
    for (const k of ek) if (item.extra[k] === undefined || item.extra[k] === null) sfail(`${p}.extra.${k}`, 'must not be undefined or null');
  }
  return true;
}

export function validateItemsFile(file, { now } = {}) {
  if (!isPlainObject(file)) sfail('items', 'must be an object');
  if (!isIso(file.generatedAt)) sfail('items.generatedAt', 'must be an ISO timestamp');
  if (!Array.isArray(file.items)) sfail('items.items', 'must be an array');
  if (file.count !== file.items.length) sfail('items.count', 'must equal items.length');
  const ids = new Set();
  const nowMs = now ? new Date(now).getTime() : undefined;
  file.items.forEach((item, i) => {
    validateItem(item, `items.items[${i}]`);
    if (ids.has(item.id)) sfail(`items.items[${i}].id`, `duplicates "${item.id}"`);
    ids.add(item.id);
    if (nowMs !== undefined && Date.parse(item.surfacedAt) < nowMs - RETENTION_MS) sfail(`items.items[${i}].surfacedAt`, 'is outside the retention window');
  });
  if (Buffer.byteLength(JSON.stringify(file)) > MAX_ITEMS_BYTES) sfail('items', `exceeds ${MAX_ITEMS_BYTES} bytes`);
  return true;
}

// ---------------------------------------------------------------------------
// Digests

export function validateDigest(digest) {
  const p = 'digest';
  if (!isPlainObject(digest)) sfail(p, 'must be an object');
  if (!(typeof digest.date === 'string' && DATE_RE.test(digest.date))) sfail(`${p}.date`, 'must be YYYY-MM-DD');
  if (!isIso(digest.generatedAt)) sfail(`${p}.generatedAt`, 'must be an ISO timestamp');
  if (digest.overview !== null) {
    const o = digest.overview;
    if (!isPlainObject(o) || !isNonEmptyString(o.text) || o.source !== 'llm' || !isNonEmptyString(o.model)) sfail(`${p}.overview`, 'must be null or { text, source: "llm", model }');
  }
  if (!Array.isArray(digest.sections) || digest.sections.length !== SECTION_KEYS.length) sfail(`${p}.sections`, `must have ${SECTION_KEYS.length} sections`);
  const ids = [];
  const seen = new Set();
  digest.sections.forEach((sec, i) => {
    const sp = `${p}.sections[${i}]`;
    if (!isPlainObject(sec)) sfail(sp, 'must be an object');
    if (sec.key !== SECTION_KEYS[i]) sfail(`${sp}.key`, `must be ${SECTION_KEYS[i]}`);
    if (!isNonEmptyString(sec.title)) sfail(`${sp}.title`, 'must be a non-empty string');
    if (!Array.isArray(sec.entries)) sfail(`${sp}.entries`, 'must be an array');
    sec.entries.forEach((e, j) => {
      const ep = `${sp}.entries[${j}]`;
      if (!isPlainObject(e)) sfail(ep, 'must be an object');
      if (!isNonEmptyString(e.id)) sfail(`${ep}.id`, 'must be a non-empty string');
      if (seen.has(e.id)) sfail(`${ep}.id`, 'is duplicated');
      seen.add(e.id);
      ids.push(e.id);
      if (!isNonEmptyString(e.title)) sfail(`${ep}.title`, 'must be a non-empty string');
      if (!(typeof e.url === 'string' && isHttpUrl(e.url))) sfail(`${ep}.url`, 'must be an HTTP(S) URL');
      if ('discussionUrl' in e && !(typeof e.discussionUrl === 'string' && isHttpUrl(e.discussionUrl))) sfail(`${ep}.discussionUrl`, 'must be an HTTP(S) URL');
      if (!Array.isArray(e.sourceIds) || e.sourceIds.length === 0 || !e.sourceIds.every(isNonEmptyString)) sfail(`${ep}.sourceIds`, 'must be non-empty strings');
      if (!Array.isArray(e.sourceNames) || e.sourceNames.length === 0 || !e.sourceNames.every(isNonEmptyString)) sfail(`${ep}.sourceNames`, 'must be non-empty strings');
      if (typeof e.summary !== 'string') sfail(`${ep}.summary`, 'must be a string');
      if (!isNonEmptyString(e.why)) sfail(`${ep}.why`, 'must be a non-empty string');
      if (/\b(?:undefined|NaN|null)\b/.test(e.why)) sfail(`${ep}.why`, 'contains an invalid operand');
      if (!['heuristic', 'llm'].includes(e.whySource)) sfail(`${ep}.whySource`, 'must be heuristic or llm');
      if (!isIso(e.publishedAt)) sfail(`${ep}.publishedAt`, 'must be an ISO timestamp');
      if (!CATEGORIES.includes(e.category)) sfail(`${ep}.category`, 'is not a known category');
      if (!(typeof e.score === 'number' && Number.isFinite(e.score))) sfail(`${ep}.score`, 'must be a finite number');
      if ('readMinutes' in e && !(Number.isSafeInteger(e.readMinutes) && e.readMinutes > 0)) sfail(`${ep}.readMinutes`, 'must be a positive integer');
      if ('signals' in e) sfail(`${ep}.signals`, 'must not be serialized');
    });
  });
  if (!Array.isArray(digest.itemIds) || JSON.stringify(digest.itemIds) !== JSON.stringify(ids)) sfail(`${p}.itemIds`, 'must equal the section-order entry ids');
  const deep = digest.sections.find((s) => s.key === 'deep-read')?.entries[0]?.id ?? null;
  if (digest.deepReadId !== deep) sfail(`${p}.deepReadId`, 'must match the deep-read entry');
  const words = countDigestWords(digest);
  if (digest.wordCount !== words) sfail(`${p}.wordCount`, `must equal recount ${words}`);
  if (words > 1100) sfail(`${p}.wordCount`, 'exceeds 1100');
  if (digest.readingMinutes !== Math.max(1, Math.ceil(words / 220))) sfail(`${p}.readingMinutes`, 'must equal max(1, ceil(wordCount/220))');
  if (!isPlainObject(digest.llm) || typeof digest.llm.enabled !== 'boolean' || typeof digest.llm.ok !== 'boolean' || Object.keys(digest.llm).length !== 2) sfail(`${p}.llm`, 'must be { enabled, ok }');
  return true;
}

export function validateDigestIndex(index, digestsByDate) {
  if (!isPlainObject(index) || !Array.isArray(index.days)) sfail('index.days', 'must be an array');
  const lookup = digestsByDate instanceof Map ? digestsByDate : new Map(Object.entries(digestsByDate ?? {}));
  index.days.forEach((d, i) => {
    const p = `index.days[${i}]`;
    if (!isPlainObject(d)) sfail(p, 'must be an object');
    if (!(typeof d.date === 'string' && DATE_RE.test(d.date))) sfail(`${p}.date`, 'must be YYYY-MM-DD');
    if (i > 0 && !(d.date < index.days[i - 1].date)) sfail(`${p}.date`, 'must be newest first and unique');
    if (!isIso(d.generatedAt)) sfail(`${p}.generatedAt`, 'must be an ISO timestamp');
    if (!isNonNegInt(d.wordCount)) sfail(`${p}.wordCount`, 'must be a non-negative integer');
    if (!(Number.isSafeInteger(d.readingMinutes) && d.readingMinutes >= 1)) sfail(`${p}.readingMinutes`, 'must be a positive integer');
    if (!isNonNegInt(d.entryCount)) sfail(`${p}.entryCount`, 'must be a non-negative integer');
    const digest = lookup.get(d.date);
    if (digest) {
      if (d.entryCount !== digest.itemIds.length) sfail(`${p}.entryCount`, 'must equal the digest itemIds.length');
      if (d.wordCount !== digest.wordCount) sfail(`${p}.wordCount`, 'must equal the digest wordCount');
      if (d.readingMinutes !== digest.readingMinutes) sfail(`${p}.readingMinutes`, 'must equal the digest readingMinutes');
      if (d.generatedAt !== digest.generatedAt) sfail(`${p}.generatedAt`, 'must equal the digest generatedAt');
    }
  });
  return true;
}

// ---------------------------------------------------------------------------
// Meta

export function validateMeta(meta, registryIds) {
  const p = 'meta';
  if (!isPlainObject(meta)) sfail(p, 'must be an object');
  if (!isIso(meta.generatedAt)) sfail(`${p}.generatedAt`, 'must be an ISO timestamp');
  if (!(typeof meta.durationMs === 'number' && meta.durationMs >= 0)) sfail(`${p}.durationMs`, 'must be a non-negative number');
  for (const k of ['itemCount', 'newItemCount', 'trimmedForSize']) if (!isNonNegInt(meta[k])) sfail(`${p}.${k}`, 'must be a non-negative integer');
  if (!isPlainObject(meta.sources)) sfail(`${p}.sources`, 'must be an object');
  const counts = { ok: 0, empty: 0, failed: 0 };
  for (const [id, s] of Object.entries(meta.sources)) {
    const sp = `${p}.sources.${id}`;
    if (!isPlainObject(s)) sfail(sp, 'must be an object');
    if (!isNonEmptyString(s.name)) sfail(`${sp}.name`, 'must be a non-empty string');
    if (!CATEGORIES.includes(s.category)) sfail(`${sp}.category`, 'is not a known category');
    if (!STATUSES.includes(s.status)) sfail(`${sp}.status`, 'must be ok|empty|failed');
    counts[s.status]++;
    for (const k of ['fetched', 'kept', 'skipped']) if (!isNonNegInt(s[k])) sfail(`${sp}.${k}`, 'must be a non-negative integer');
    if (s.skipped !== s.fetched - s.kept) sfail(`${sp}.skipped`, 'must equal fetched - kept');
    if (!(typeof s.ms === 'number' && s.ms >= 0)) sfail(`${sp}.ms`, 'must be a non-negative number');
    if ('httpStatus' in s && !Number.isInteger(s.httpStatus)) sfail(`${sp}.httpStatus`, 'must be an integer');
    if ('error' in s && !(isNonEmptyString(s.error) && s.error.length <= 120 && !/\n/.test(s.error))) sfail(`${sp}.error`, 'must be a short class string');
    if ('detail' in s && !(isNonEmptyString(s.detail) && s.detail.length <= 400 && !/[\n\r]/.test(s.detail))) sfail(`${sp}.detail`, 'must be a single line of at most 400 chars');
    if ('note' in s && !isNonEmptyString(s.note)) sfail(`${sp}.note`, 'must be a non-empty string');
    if ('homepage' in s && !(typeof s.homepage === 'string' && isHttpUrl(s.homepage))) sfail(`${sp}.homepage`, 'must be an HTTP(S) URL');
    if (s.status === 'failed' && !('error' in s)) sfail(`${sp}.error`, 'is required for failed sources');
  }
  if (registryIds) {
    const want = [...registryIds].sort();
    const have = Object.keys(meta.sources).sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) sfail(`${p}.sources`, 'keys must equal the registry ids');
  }
  if (meta.okCount !== counts.ok || meta.emptyCount !== counts.empty || meta.failedCount !== counts.failed) sfail(`${p}.okCount`, 'status counts must match sources');
  for (const k of ['sitemapSkipped', 'sitemapCache']) {
    if (!isPlainObject(meta[k])) sfail(`${p}.${k}`, 'must be an object');
    for (const [sid, m] of Object.entries(meta[k])) {
      if (!isPlainObject(m)) sfail(`${p}.${k}.${sid}`, 'must be an object');
      if (Object.keys(m).length > 30) sfail(`${p}.${k}.${sid}`, 'must have at most 30 entries');
    }
  }
  if (!isPlainObject(meta.llm) || typeof meta.llm.enabled !== 'boolean' || typeof meta.llm.ok !== 'boolean') sfail(`${p}.llm`, 'must have boolean enabled/ok');
  if ('model' in meta.llm && !isNonEmptyString(meta.llm.model)) sfail(`${p}.llm.model`, 'must be a non-empty string');
  if ('error' in meta.llm && !isNonEmptyString(meta.llm.error)) sfail(`${p}.llm.error`, 'must be a non-empty string');
  if (!isPlainObject(meta.brief) || !(typeof meta.brief.date === 'string' && DATE_RE.test(meta.brief.date)) || !isNonNegInt(meta.brief.wordCount) || !isNonNegInt(meta.brief.readingMinutes)) sfail(`${p}.brief`, 'must be { date, wordCount, readingMinutes }');
  if (!isPlainObject(meta.static)) sfail(`${p}.static`, 'must be an object');
  for (const k of ['leaderboards', 'more', 'learn']) if (!Array.isArray(meta.static[k])) sfail(`${p}.static.${k}`, 'must be an array');
  return true;
}

// ---------------------------------------------------------------------------
// Previous sitemap state (advisory: never fatal)

const isNormalizedIso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const MIN_DATE = Date.parse('2000-01-01T00:00:00Z');

export function validateSitemapState(meta, sitemapSourceIds, logger) {
  const out = { sitemapSkipped: {}, sitemapCache: {} };
  const allowed = new Set(sitemapSourceIds);
  let warned = false;
  const warn = (msg) => { if (!warned && logger?.warn) { logger.warn(msg); warned = true; } };
  if (!isPlainObject(meta)) return out;
  for (const key of ['sitemapSkipped', 'sitemapCache']) {
    const top = meta[key];
    if (top === undefined) continue;
    if (!isPlainObject(top)) { warn(`previous meta.${key} ignored: not an object`); continue; }
    for (const [sid, map] of Object.entries(top)) {
      if (!allowed.has(sid)) continue;
      if (!isPlainObject(map)) { warn(`previous meta.${key}.${sid} ignored: not an object`); continue; }
      const entries = [];
      for (const [url, value] of Object.entries(map)) {
        if (!(typeof url === 'string' && url.length <= 2048 && isHttpUrl(url) && canonicalizeUrl(url) === url)) { warn(`previous meta.${key}.${sid} has an invalid URL key`); continue; }
        if (key === 'sitemapSkipped') {
          if (!isNormalizedIso(value)) { warn(`previous meta.${key}.${sid} has an invalid marker`); continue; }
          entries.push([url, value, value]);
        } else {
          const ok = isPlainObject(value)
            && Object.keys(value).length === 4
            && isNormalizedIso(value.lastmod)
            && typeof value.title === 'string' && value.title.trim() === value.title && value.title.length >= 1 && value.title.length <= 200
            && typeof value.summary === 'string' && value.summary.length <= 600
            && isNormalizedIso(value.publishedAt) && Date.parse(value.publishedAt) >= MIN_DATE;
          if (!ok) { warn(`previous meta.${key}.${sid} has an invalid cache entry`); continue; }
          entries.push([url, value, value.lastmod]);
        }
      }
      entries.sort((a, b) => (Date.parse(b[2]) - Date.parse(a[2])) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      out[key][sid] = Object.fromEntries(entries.slice(0, 30).map(([u, v]) => [u, v]));
    }
  }
  return out;
}
