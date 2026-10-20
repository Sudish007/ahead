import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW, read, pageHtml } from './helpers.js';
import { parseSitemap, extractPageMeta, slugTitle } from '../src/parsers/sitemap.js';
import { canonicalizeUrl } from '../src/normalize.js';

const ANTHROPIC = { id: 'anthropic', category: 'labs', type: 'sitemap', url: 'https://www.anthropic.com/sitemap.xml', include: /^https:\/\/www\.anthropic\.com\/(news|research|engineering)\/[^/]+$/, weight: 8, maxItems: 10 };
const BATCH = { id: 'thebatch', category: 'blogs', type: 'sitemap', url: 'https://www.deeplearning.ai/sitemap.xml', include: /^https:\/\/www\.deeplearning\.ai\/the-batch\/[^/]+\/?$/, exclude: /\/the-batch\/(tag|issue-\d+)/, weight: 4, maxItems: 10 };
const START = NOW.getTime();

/** ctx with a scripted page fetch. `pages(url)` returns html | Error | { html } ; records every call. */
function makeCtx({ pages = (url) => pageHtml(url), nowMs, startedAt = START, deadlineAt = START + 45_000, skipped = {}, cache = {}, prior = new Map(), clock } = {}) {
  const calls = [];
  const warnings = [];
  let t = nowMs ?? startedAt;
  return {
    now: NOW,
    nowMs: clock ?? (() => t),
    logger: { warn: (m) => warnings.push(m) },
    sourceStartedAtMs: startedAt,
    deadlineAt,
    previousSitemapSkipped: skipped,
    previousSitemapCache: cache,
    previousItemsByCanonicalUrl: prior,
    fetchText: async (url, opts) => {
      calls.push({ url, opts });
      const r = pages(url);
      if (r instanceof Error) throw r;
      return { status: 200, text: typeof r === 'string' ? r : r.html, finalUrl: url, contentType: 'text/html' };
    },
    calls,
    warnings,
    advance: (ms) => { t += ms; },
  };
}

test('Anthropic: 15 in-window URLs with maxItems 30, 10 with the registry cap, lastmod normalized, 30 no-lastmod skipped', async () => {
  const ctx = makeCtx();
  const r = await parseSitemap(read('anthropic-sitemap.xml'), { ...ANTHROPIC, maxItems: 30 }, ctx);
  assert.equal(r.fetched, 566);
  assert.equal(r.kept, 15);
  assert.equal(r.status, 'ok');
  const dates = r.items.map((i) => i.publishedAt.getTime());
  for (let i = 1; i < dates.length; i++) assert.ok(dates[i - 1] >= dates[i], 'descending lastmod');
  assert.equal(r.items[0].url, 'https://www.anthropic.com/news/public-benefit-fund');
  assert.equal(r.items[0].title, 'OG public-benefit-fund');
  assert.equal(r.items[0].summaryText, 'Desc public-benefit-fund');
  assert.equal(r.items[0].extra.titleFrom, 'page');
  assert.equal(ctx.calls.length, 10, 'at most ten page fetches');
  assert.equal(r.items.filter((i) => i.extra.titleFrom === 'slug').length, 5);
  assert.equal(r.note, 'page fetches truncated (10 of 15)');
  for (const v of Object.values(r.sitemapCache)) assert.equal(new Date(v.lastmod).toISOString(), v.lastmod);
  assert.equal(Object.keys(r.sitemapCache).length, 10);
  const capped = await parseSitemap(read('anthropic-sitemap.xml'), ANTHROPIC, makeCtx());
  assert.equal(capped.kept, 10);
  assert.deepEqual(capped.items.map((i) => i.url), r.items.slice(0, 10).map((i) => i.url));
});

test('The Batch: 2 articles in 7 days, 9 with maxAgeDays 14; issues excluded; tag/about never considered', async () => {
  const ctx = makeCtx();
  const r = await parseSitemap(read('deeplearning-sitemap.xml'), BATCH, ctx);
  assert.equal(r.fetched, 18);
  assert.equal(r.kept, 2);
  assert.deepEqual(r.items.map((i) => i.url.split('/').pop()), ['metas-muse-wonder-rivals-top-models', 'anthropic-gives-claude-haiku-a-big-update']);
  assert.ok(!ctx.calls.some((c) => /issue-|\/tag\/|\/about/.test(c.url)));
  const wide = await parseSitemap(read('deeplearning-sitemap.xml'), { ...BATCH, maxAgeDays: 14 }, makeCtx());
  assert.equal(wide.kept, 9);
  assert.ok(wide.items.every((i) => !/issue-\d+/.test(i.url)));
});

test('page success, throw (slug fallback), old page date (drop + skip marker)', async () => {
  const sitemap = read('deeplearning-sitemap.xml');
  const ok = await parseSitemap(sitemap, BATCH, makeCtx());
  assert.equal(ok.items[0].title, 'OG metas-muse-wonder-rivals-top-models');
  assert.equal(ok.items[0].publishedAt.toISOString(), '2026-10-14T19:17:00.000Z');
  const key = canonicalizeUrl('https://www.deeplearning.ai/the-batch/metas-muse-wonder-rivals-top-models');
  assert.deepEqual(Object.keys(ok.sitemapCache).sort(), [key, canonicalizeUrl('https://www.deeplearning.ai/the-batch/anthropic-gives-claude-haiku-a-big-update')].sort());
  assert.equal(ok.sitemapCache[key].title, 'OG metas-muse-wonder-rivals-top-models');

  const thrown = await parseSitemap(sitemap, BATCH, makeCtx({ pages: () => new Error('boom') }));
  assert.equal(thrown.kept, 2);
  assert.equal(thrown.items[0].title, 'Metas muse wonder rivals top models');
  assert.equal(thrown.items[0].extra.titleFrom, 'slug');
  assert.equal(thrown.items[0].summaryText, undefined);
  assert.equal(thrown.items[0].publishedAt.toISOString(), '2026-10-14T19:17:00.000Z');
  assert.deepEqual(thrown.sitemapCache, {});
  assert.equal(thrown.note, undefined);

  const oldPage = (url) => `<title>x</title><meta property="og:title" content="Old"><meta property="article:published_time" content="2026-09-01T00:00:00Z">`;
  const old = await parseSitemap(sitemap, BATCH, makeCtx({ pages: oldPage }));
  assert.equal(old.kept, 0);
  assert.equal(old.status, 'empty');
  assert.equal(old.sitemapSkipped[key], '2026-10-14T19:17:00.000Z');
  assert.deepEqual(old.sitemapCache, {});
  assert.deepEqual(old.invalidations, []);
});

test('passed page deadline emits slugs with a truncated note; 8 s sitemap download leaves 32 s', async () => {
  const sitemap = read('deeplearning-sitemap.xml');
  const passed = makeCtx({ nowMs: START + 41_000 });
  const r = await parseSitemap(sitemap, BATCH, passed);
  assert.equal(passed.calls.length, 0);
  assert.ok(r.items.every((i) => i.extra.titleFrom === 'slug'));
  assert.equal(r.note, 'page fetches truncated (0 of 2)');
  assert.equal(r.status, 'ok');
  const slow = makeCtx({ nowMs: START + 8000 });
  await parseSitemap(sitemap, BATCH, slow);
  assert.ok(slow.calls.length === 2);
  for (const c of slow.calls) {
    assert.equal(c.opts.deadlineAt, START + 40_000);
    assert.equal(c.opts.deadlineAt - slow.nowMs(), 32_000);
    assert.equal(c.opts.timeoutMs, 8000);
    assert.equal(c.opts.maxBytes, 1_500_000);
    assert.equal(c.opts.accept, 'text/html');
  }
  const earlyDeadline = makeCtx({ deadlineAt: START + 20_000 });
  await parseSitemap(sitemap, BATCH, earlyDeadline);
  assert.ok(earlyDeadline.calls.every((c) => c.opts.deadlineAt === START + 20_000));
});

test('cache: exact hit -> no request; other source / HN prior item / changed lastmod -> request', async () => {
  const sitemap = read('deeplearning-sitemap.xml');
  const first = await parseSitemap(sitemap, BATCH, makeCtx());
  const hit = makeCtx({ cache: first.sitemapCache });
  const r = await parseSitemap(sitemap, BATCH, hit);
  assert.equal(hit.calls.length, 0);
  assert.deepEqual(r.items.map((i) => [i.title, i.summaryText, i.publishedAt.toISOString(), i.extra.titleFrom]), first.items.map((i) => [i.title, i.summaryText, i.publishedAt.toISOString(), i.extra.titleFrom]));
  assert.deepEqual(r.sitemapCache, first.sitemapCache);
  // pipeline narrows maps by source id: the same URLs cached under another id are not visible here
  const other = makeCtx({ cache: {} });
  await parseSitemap(sitemap, BATCH, other);
  assert.equal(other.calls.length, 2);
  // an HN-only prior item is never a metadata cache
  const key = canonicalizeUrl('https://www.deeplearning.ai/the-batch/metas-muse-wonder-rivals-top-models');
  const prior = new Map([[key, { id: 'x', canonicalUrl: key, title: 'HN title', sources: [{ id: 'hn-top', at: NOW.toISOString() }] }]]);
  const hn = makeCtx({ prior });
  await parseSitemap(sitemap, BATCH, hn);
  assert.equal(hn.calls.length, 2);
  // changed lastmod removes the stale entry and refetches
  const changed = structuredClone(first.sitemapCache);
  changed[key].lastmod = '2026-10-01T00:00:00.000Z';
  const ch = makeCtx({ cache: changed });
  const r2 = await parseSitemap(sitemap, BATCH, ch);
  assert.equal(ch.calls.length, 1);
  assert.equal(r2.sitemapCache[key].lastmod, '2026-10-14T19:17:00.000Z');
});

test('skip markers: same version -> zero requests; changed version -> one request', async () => {
  const sitemap = read('deeplearning-sitemap.xml');
  const key = canonicalizeUrl('https://www.deeplearning.ai/the-batch/metas-muse-wonder-rivals-top-models');
  const same = makeCtx({ skipped: { [key]: '2026-10-14T19:17:00.000Z' } });
  const r = await parseSitemap(sitemap, BATCH, same);
  assert.equal(same.calls.filter((c) => c.url.includes('metas-muse')).length, 0);
  assert.equal(r.kept, 1);
  assert.equal(r.sitemapSkipped[key], '2026-10-14T19:17:00.000Z');
  const changed = makeCtx({ skipped: { [key]: '2026-10-01T00:00:00.000Z' } });
  const r2 = await parseSitemap(sitemap, BATCH, changed);
  assert.equal(changed.calls.filter((c) => c.url.includes('metas-muse')).length, 1);
  assert.equal(r2.kept, 2);
  assert.equal(r2.sitemapSkipped[key], undefined);
});

test('two-run invalidation: run 1 slug, run 2 proves the page old', async () => {
  const sitemap = read('deeplearning-sitemap.xml');
  const key = canonicalizeUrl('https://www.deeplearning.ai/the-batch/metas-muse-wonder-rivals-top-models');
  const run1 = await parseSitemap(sitemap, BATCH, makeCtx({ pages: (u) => (u.includes('metas-muse') ? new Error('boom') : pageHtml(u)) }));
  assert.equal(run1.items.find((i) => i.url.includes('metas-muse')).extra.titleFrom, 'slug');
  const prior = new Map([[key, { id: 'p', canonicalUrl: key, sources: [{ id: 'thebatch', at: '2026-10-14T19:17:00.000Z' }] }]]);
  const oldPage = (u) => (u.includes('metas-muse') ? '<meta property="og:title" content="Old piece"><meta property="article:published_time" content="2026-09-20T10:00:00Z">' : pageHtml(u));
  const run2 = await parseSitemap(sitemap, BATCH, makeCtx({ pages: oldPage, cache: run1.sitemapCache, prior }));
  assert.deepEqual(run2.invalidations, [{ sourceId: 'thebatch', canonicalUrl: key, provenPublishedAt: '2026-09-20T10:00:00.000Z' }]);
  assert.equal(run2.sitemapSkipped[key], '2026-10-14T19:17:00.000Z');
  assert.ok(!run2.items.some((i) => i.url.includes('metas-muse')));
  // no invalidation when the prior item does not carry this source
  const hnOnly = new Map([[key, { id: 'p', canonicalUrl: key, sources: [{ id: 'hn-top', at: NOW.toISOString() }] }]]);
  const run2b = await parseSitemap(sitemap, BATCH, makeCtx({ pages: oldPage, prior: hnOnly }));
  assert.deepEqual(run2b.invalidations, []);
  // an exact cached page that ages out follows the same path with the cached publishedAt
  const cache = { [key]: { lastmod: '2026-10-14T19:17:00.000Z', title: 'Cached', summary: '', publishedAt: '2026-09-25T00:00:00.000Z' } };
  const run3 = await parseSitemap(sitemap, BATCH, makeCtx({ cache, prior }));
  assert.deepEqual(run3.invalidations, [{ sourceId: 'thebatch', canonicalUrl: key, provenPublishedAt: '2026-09-25T00:00:00.000Z' }]);
  assert.equal(run3.sitemapCache[key], undefined);
});

test('maps prune absent/out-of-window/version-mismatched entries and cap at 30', async () => {
  const sitemap = read('anthropic-sitemap.xml');
  const stale = {};
  for (let i = 0; i < 40; i++) stale[`https://anthropic.com/news/gone-${i}`] = `2026-10-18T00:00:${String(i % 60).padStart(2, '0')}.000Z`;
  stale[canonicalizeUrl('https://www.anthropic.com/news/public-benefit-fund')] = '2026-01-01T00:00:00.000Z'; // version mismatch
  const r = await parseSitemap(sitemap, { ...ANTHROPIC, maxItems: 30 }, makeCtx({ skipped: stale, pages: () => new Error('x') }));
  assert.deepEqual(r.sitemapSkipped, {});
  const manyCache = {};
  const dates = [...sitemap.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)];
  const inWindow = dates.filter((m) => ANTHROPIC.include.test(m[1]) && Date.parse(m[2]) >= START - 7 * 86_400_000);
  assert.equal(inWindow.length, 15);
  for (const m of dates.filter((d) => ANTHROPIC.include.test(d[1]))) manyCache[canonicalizeUrl(m[1])] = { lastmod: new Date(m[2]).toISOString(), title: 'T', summary: '', publishedAt: new Date(m[2]).toISOString() };
  assert.ok(Object.keys(manyCache).length > 30);
  const r2 = await parseSitemap(sitemap, { ...ANTHROPIC, maxItems: 30, maxAgeDays: 400 }, makeCtx({ cache: manyCache }));
  assert.equal(Object.keys(r2.sitemapCache).length, 30);
  const ordered = Object.values(r2.sitemapCache).map((v) => Date.parse(v.lastmod));
  for (let i = 1; i < ordered.length; i++) assert.ok(ordered[i - 1] >= ordered[i]);
});

test('<title> suffix strip rule and og:title precedence', () => {
  assert.equal(extractPageMeta('<title>Redesigning source control for agents | Anthropic</title>').title, 'Redesigning source control for agents');
  assert.equal(extractPageMeta('<title>Short | Anthropic</title>').title, 'Short | Anthropic');
  assert.equal(extractPageMeta('<title>A long enough title - Site</title><meta property="og:title" content="OG wins">').title, 'OG wins');
  assert.equal(extractPageMeta('<title>Why models forget - The Batch</title>').title, 'Why models forget');
  assert.equal(extractPageMeta('<title>Sparse autoencoders in practice · Transformer Circuits Thread · more</title>').title, 'Sparse autoencoders in practice · Transformer Circuits Thread');
  assert.equal(extractPageMeta('<meta name="og:description" content="D &amp; E">').description, 'D & E');
  assert.equal(slugTitle('https://www.anthropic.com/news/public-benefit-fund'), 'Public benefit fund');
});

test('malformed loc/lastmod records increment skipped while valid siblings remain', async () => {
  const body = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>ftp://www.anthropic.com/news/a</loc><lastmod>2026-10-18T00:00:00Z</lastmod></url>
    <url><loc>not a url</loc><lastmod>2026-10-18T00:00:00Z</lastmod></url>
    <url><loc>https://www.anthropic.com/news/no-lastmod</loc></url>
    <url><loc>https://www.anthropic.com/news/bad-lastmod</loc><lastmod>yesterday</lastmod></url>
    <url><loc>https://www.anthropic.com/news/good</loc><lastmod>2026-10-18T10:00:00+02:00</lastmod></url>
  </urlset>`;
  const r = await parseSitemap(body, ANTHROPIC, makeCtx({ pages: () => new Error('offline') }));
  assert.equal(r.fetched, 5);
  assert.equal(r.kept, 1);
  assert.equal(r.items[0].url, 'https://www.anthropic.com/news/good');
  assert.equal(r.items[0].publishedAt.toISOString(), '2026-10-18T08:00:00.000Z');
  assert.equal(r.items[0].title, 'Good');
});
