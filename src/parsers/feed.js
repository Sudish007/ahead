// RSS / Atom / YouTube / GitHub-releases feeds over fast-xml-parser.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ParseError } from '../http.js';
import { cleanText, isHttpUrl, parseDate } from '../normalize.js';
import { applySelection, finiteNonNegative } from './common.js';

export const FXP_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => ['item', 'entry', 'link', 'category', 'author', 'enclosure'].includes(name),
};

const SPONSORS_RE = /(?:^|\s)Sponsors:(?=\s|$)/;
const SUMMARY_FIELDS = ['description', 'summary', 'content:encoded', 'content', 'media:group.media:description', 'itunes:summary'];

export function sniffFormat(body) {
  const s = String(body);
  const candidates = [
    ['atom', s.search(/<feed[\s>]/)],
    ['rss', s.search(/<rss[\s>]/)],
    ['rss', s.search(/<rdf:RDF[\s>]/)],
  ].filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  return candidates.length ? candidates[0][0] : null;
}

/** Text of a node: string | { '#text' } | { '@_href' } | array-first. */
export function text(node) {
  if (node === undefined || node === null) return '';
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (typeof node === 'object') {
    if (typeof node['#text'] === 'string') return node['#text'];
    if (typeof node['@_href'] === 'string') return node['@_href'];
    return '';
  }
  return '';
}

function get(node, path) {
  let cur = node;
  for (const key of path.split('.')) {
    if (cur === undefined || cur === null) return undefined;
    if (Array.isArray(cur)) cur = cur[0];
    if (cur === undefined || cur === null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Validate + parse a feed body and return its records in native order. */
export function decodeFeed(body) {
  const s = String(body ?? '');
  const valid = XMLValidator.validate(s);
  if (valid !== true) throw new ParseError('invalid xml');
  const format = sniffFormat(s);
  if (!format) throw new ParseError('not a feed');
  const doc = new XMLParser(FXP_OPTIONS).parse(s);
  if (format === 'atom') {
    const feed = Array.isArray(doc.feed) ? doc.feed[0] : doc.feed;
    if (!feed || typeof feed !== 'object') throw new ParseError('not a feed');
    return { format, records: Array.isArray(feed.entry) ? feed.entry : [] };
  }
  const rss = doc.rss ?? doc['rdf:RDF'];
  if (!rss || typeof rss !== 'object') throw new ParseError('not a feed');
  const channel = rss.channel ? (Array.isArray(rss.channel) ? rss.channel[0] : rss.channel) : rss;
  const items = Array.isArray(channel?.item) ? channel.item : Array.isArray(rss.item) ? rss.item : [];
  return { format, records: items, channel };
}

function entryUrl(e, format) {
  if (format === 'rss') {
    const link = text(e.link).trim();
    if (link && isHttpUrl(link)) return link;
    const guid = Array.isArray(e.guid) ? e.guid[0] : e.guid;
    const isPerma = guid && typeof guid === 'object' ? guid['@_isPermaLink'] : undefined;
    const g = text(guid).trim();
    if (g && isPerma !== 'false' && isHttpUrl(g)) return g;
    const atomLink = Array.isArray(e['atom:link']) ? e['atom:link'] : e['atom:link'] ? [e['atom:link']] : [];
    for (const l of atomLink) { const h = text(l).trim(); if (isHttpUrl(h)) return h; }
    return '';
  }
  const links = Array.isArray(e.link) ? e.link : e.link ? [e.link] : [];
  const alt = links.find((l) => l && typeof l === 'object' && (l['@_rel'] === 'alternate' || l['@_rel'] === undefined));
  const chosen = alt ?? links[0];
  const href = text(chosen).trim();
  return isHttpUrl(href) ? href : '';
}

function entryDate(e, now) {
  for (const key of ['pubDate', 'dc:date', 'published', 'updated', 'issued']) {
    const v = text(e[key]).trim();
    if (v) {
      const d = parseDate(v, now);
      if (d) return d;
    }
  }
  return undefined;
}

function entryAuthors(e) {
  const out = [];
  const push = (name) => { const n = cleanText(name); if (n && !out.includes(n)) out.push(n); };
  const creator = text(e['dc:creator']).trim();
  if (creator) creator.split(',').forEach(push);
  const authors = Array.isArray(e.author) ? e.author : e.author ? [e.author] : [];
  for (const a of authors) {
    if (a && typeof a === 'object' && 'name' in a) push(text(a.name));
    else if (typeof a === 'string') push(a);
  }
  const itunes = text(e['itunes:author']).trim();
  if (itunes) push(itunes);
  return out.slice(0, 5);
}

function summaryFields(e, isMedia) {
  const candidates = [];
  for (const path of SUMMARY_FIELDS) {
    const raw = text(get(e, path));
    if (!raw) continue;
    const cleaned = cleanText(raw);
    if (!cleaned) continue;
    candidates.push(cleaned);
  }
  const bodyLength = candidates.reduce((m, c) => Math.max(m, c.length), 0);
  let summaryText = '';
  for (const c of candidates) {
    let t = c;
    if (isMedia) {
      const m = SPONSORS_RE.exec(t);
      if (m) t = t.slice(0, m.index).trim();
    }
    if (t) { summaryText = t; break; }
  }
  return { summaryText, bodyLength };
}

function releaseTag(url) {
  const m = /\/releases\/tag\/([^?#]+)/.exec(url);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/** parseFeed(body, source, ctx) -> { status, items, fetched, kept, note? } */
export function parseFeed(body, source, ctx) {
  const { format, records } = decodeFeed(body);
  const isRelease = source.type === 'github';
  const fetched = records.length;
  const out = [];
  records.forEach((e, nativeIndex) => {
    if (!e || typeof e !== 'object') return;
    let title = cleanText(text(e.title));
    const url = entryUrl(e, format);
    if (!title || !url) return;
    const raw = { nativeIndex, title, url };
    const publishedAt = entryDate(e, ctx.now);
    if (publishedAt) raw.publishedAt = publishedAt;
    const enclosures = Array.isArray(e.enclosure) ? e.enclosure : e.enclosure ? [e.enclosure] : [];
    const encType = enclosures[0] && typeof enclosures[0] === 'object' ? enclosures[0]['@_type'] : undefined;
    if (typeof encType === 'string' && encType) raw.enclosureType = encType;
    let category = source.category;
    if (typeof encType === 'string' && /^audio\//i.test(encType) && (category === 'blogs' || category === 'labs')) category = 'media';
    if (category !== source.category) raw.category = category;
    if (isRelease) {
      const tag = releaseTag(url);
      if (!tag || tag.includes('/')) return;
      raw.tag = tag;
      raw.title = title === tag ? `${source.repo} ${tag}` : `${source.repo}: ${title}`;
    }
    const { summaryText, bodyLength } = summaryFields(e, category === 'media');
    if (summaryText) raw.summaryText = summaryText;
    if (bodyLength > 0) raw.bodyLength = bodyLength;
    const authors = entryAuthors(e);
    if (authors.length) raw.authors = authors;
    const views = finiteNonNegative(get(e, 'media:group.media:community.media:statistics')?.['@_views']);
    if (views !== undefined) raw.signals = { ytViews: views };
    out.push(raw);
  });
  return applySelection(out, source, ctx, fetched);
}
