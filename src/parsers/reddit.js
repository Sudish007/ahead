// Reddit multireddit Atom: permalink discussion, external [link] targets, subreddit tag, current-top marker.
import { cleanText, decodeEntities, isHttpUrl, parseDate } from '../normalize.js';
import { decodeFeed, text } from './feed.js';
import { applySelection } from './common.js';

const BOILERPLATE_RE = /\s*submitted by\s+\/u\/[\s\S]*?\[comments\]\s*$/;

export function isRedditHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'reddit.com' || host.endsWith('.reddit.com') || host === 'redd.it' || host.endsWith('.redd.it');
  } catch {
    return true;
  }
}

function linkTarget(html) {
  const decoded = decodeEntities(String(html ?? ''));
  const m = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*\[link\]\s*<\/a>/i.exec(decoded);
  return m ? m[1] : null;
}

export function parseReddit(body, source, ctx) {
  const { records } = decodeFeed(body);
  const fetched = records.length;
  const out = [];
  records.forEach((e, nativeIndex) => {
    if (!e || typeof e !== 'object') return;
    const title = cleanText(text(e.title));
    const links = Array.isArray(e.link) ? e.link : e.link ? [e.link] : [];
    const permalink = text(links.find((l) => l && typeof l === 'object' && (l['@_rel'] === 'alternate' || l['@_rel'] === undefined)) ?? links[0]).trim();
    if (!title || !isHttpUrl(permalink)) return;
    const content = text(e.content);
    const target = linkTarget(content);
    const external = target && isHttpUrl(target) && !isRedditHost(target) ? target : null;
    const raw = { nativeIndex, title, url: external ?? permalink, discussionUrl: permalink, extra: { redditTopCurrent: true } };
    const publishedAt = parseDate(text(e.published).trim() || text(e.updated).trim(), ctx.now);
    if (publishedAt) raw.publishedAt = publishedAt;
    const summary = cleanText(content).replace(BOILERPLATE_RE, '').trim();
    if (summary) raw.summaryText = summary;
    const cats = Array.isArray(e.category) ? e.category : e.category ? [e.category] : [];
    const term = cats[0] && typeof cats[0] === 'object' ? cats[0]['@_term'] : undefined;
    if (typeof term === 'string' && term.trim()) raw.extra.subreddit = term.trim();
    const authors = (Array.isArray(e.author) ? e.author : e.author ? [e.author] : [])
      .map((a) => cleanText(a && typeof a === 'object' ? text(a.name) : a)).filter(Boolean);
    if (authors.length) raw.authors = authors.slice(0, 5);
    out.push(raw);
  });
  return applySelection(out, source, ctx, fetched);
}
