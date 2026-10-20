import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW } from './helpers.js';
import { mergeItems, mergePrevious, applyInvalidations, stripEphemeral, compareProvenance, bestAuthority, titleAuthority, urlAuthority, authorAuthority, discussionAuthority, compareAuthority } from '../src/dedup.js';
import { buildRegistry, sourceInfo } from '../src/registry.js';
import { toItem } from '../src/normalize.js';

const SOURCES = [
  { id: 'arxiv-cs.LG', name: 'arXiv cs.LG', category: 'research', type: 'arxiv', url: 'https://a.test/', weight: 3, family: 'arxiv' },
  { id: 'arxiv-cs.AI', name: 'arXiv cs.AI', category: 'research', type: 'arxiv', url: 'https://a2.test/', weight: 3, family: 'arxiv' },
  { id: 'hf-papers', name: 'HF Daily Papers', category: 'research', type: 'json', parser: 'hf-papers', url: 'https://hf.test/', weight: 8 },
  { id: 'hn-top', name: 'Hacker News', category: 'news', type: 'hn', url: 'https://hn.test/', weight: 5, family: 'hn' },
  { id: 'hn-front', name: 'HN front page', category: 'news', type: 'hn', url: 'https://hnf.test/', weight: 6, family: 'hn' },
  { id: 'reddit', name: 'Reddit', category: 'news', type: 'reddit', url: 'https://r.test/', weight: 4 },
  { id: 'openai', name: 'OpenAI', category: 'labs', type: 'rss', url: 'https://o.test/', weight: 7 },
  { id: 'blog', name: 'Blog', category: 'blogs', type: 'rss', url: 'https://b.test/', weight: 6 },
  { id: 'blog2', name: 'Blog2', category: 'blogs', type: 'rss', url: 'https://b2.test/', weight: 6 },
  { id: 'anthropic', name: 'Anthropic', category: 'labs', type: 'sitemap', url: 'https://an.test/', weight: 8 },
];
const registry = buildRegistry(SOURCES);
const src = (id) => registry.get(id);
const T = (h) => new Date(NOW.getTime() - h * 3.6e6);

function cand(sourceId, raw, nativeIndex = 0) {
  const item = toItem({ nativeIndex, ...raw }, src(sourceId), NOW);
  assert.ok(item, `candidate for ${sourceId} must be valid`);
  return { ...item, registryIndex: src(sourceId).registryIndex, nativeIndex };
}

test('arXiv + HF Papers + HN merge into one paper item', () => {
  const cands = [
    cand('hn-top', { title: 'Show HN: cool paper', url: 'https://arxiv.org/pdf/2610.22379v2', discussionUrl: 'https://news.ycombinator.com/item?id=1', publishedAt: T(1), signals: { hnPoints: 100, hnComments: 20 } }),
    cand('arxiv-cs.LG', { title: 'Paper Title From arXiv', url: 'https://arxiv.org/abs/2610.22379', arxivId: '2610.22379', publishedAt: T(10), summaryText: 'Short abstract.', authors: ['A. Author'], extra: { primaryCategory: 'cs.LG' } }),
    cand('hf-papers', { title: 'Paper Title From HF', url: 'https://huggingface.co/papers/2610.22379', arxivId: '2610.22379', publishedAt: T(30), surfacedAt: T(5), summaryText: 'A much longer abstract than the arXiv one.', signals: { hfUpvotes: 30 }, authors: ['B. Author', 'C. Author'] }),
  ];
  const [item] = mergeItems(cands, registry);
  assert.equal(item.id, 'arxiv:2610.22379');
  assert.equal(item.url, 'https://arxiv.org/abs/2610.22379');
  assert.equal(item.canonicalUrl, 'https://arxiv.org/abs/2610.22379');
  assert.deepEqual(item.sources.map((s) => s.id), ['arxiv-cs.LG', 'hf-papers', 'hn-top']);
  assert.equal(item.sources[1].url, 'https://huggingface.co/papers/2610.22379');
  assert.equal(item.sources[2].url, 'https://news.ycombinator.com/item?id=1');
  assert.equal(item.title, 'Paper Title From HF', 'paper-title class beats HN; HF weight beats arXiv');
  assert.equal(item.category, 'research');
  assert.equal(item.publishedAt, T(30).toISOString());
  assert.equal(item.surfacedAt, T(1).toISOString());
  assert.equal(item.summary, 'A much longer abstract than the arXiv one.');
  assert.deepEqual(Object.keys(item.signals), ['hnPoints', 'hnComments', 'hfUpvotes']);
  assert.deepEqual(item.authors, ['B. Author', 'C. Author']);
  assert.equal(item.discussionUrl, 'https://news.ycombinator.com/item?id=1');
  assert.deepEqual(item.extra, { primaryCategory: 'cs.LG' });
  assert.equal(item.arxivId, '2610.22379');
});

test('paper-title class: HN weight 6 does not beat arXiv weight 3 for a paper title', () => {
  const cands = [
    cand('hn-front', { title: 'HN headline', url: 'https://arxiv.org/abs/2610.00001', publishedAt: T(1), extra: { hnFrontCurrent: true, hnRank: 3 } }),
    cand('arxiv-cs.LG', { title: 'Real paper title', url: 'https://arxiv.org/abs/2610.00001', arxivId: '2610.00001', publishedAt: T(2) }),
  ];
  const [item] = mergeItems(cands, registry);
  assert.equal(item.title, 'Real paper title');
  assert.deepEqual(item.extra, { hnFrontCurrent: true, hnRank: 3 });
});

test('field rules: url category precedence, longest summary, max signals, tag, extra per key, same-source duplicates', () => {
  const url = 'https://example.com/post';
  const cands = [
    cand('hn-top', { title: 'HN title', url, discussionUrl: 'https://news.ycombinator.com/item?id=2', publishedAt: T(1), summaryText: 'short', signals: { hnPoints: 5 }, extra: { k: 'hn' } }, 7),
    cand('hn-top', { title: 'HN duplicate later', url, discussionUrl: 'https://news.ycombinator.com/item?id=3', publishedAt: T(1), signals: { hnPoints: 50 } }, 9),
    cand('blog', { title: 'Blog title', url: `${url}?utm_source=x`, publishedAt: T(3), summaryText: 'a medium summary', extra: { k: 'blog', only: 1 } }),
    cand('openai', { title: 'OpenAI title', url: `${url}/`, publishedAt: T(2), summaryText: 'the longest summary of them all', signals: { hnPoints: 2 }, tag: 'v1' }),
    cand('reddit', { title: 'Reddit title', url, discussionUrl: 'https://reddit.com/r/x/comments/1', publishedAt: T(4), extra: { subreddit: 'x', redditTopCurrent: true } }),
  ];
  const [item] = mergeItems(cands, registry);
  assert.equal(item.url, 'https://example.com/post/', 'labs url beats blogs/news');
  assert.equal(item.title, 'OpenAI title', 'weight 7 wins the title');
  assert.equal(item.category, 'labs');
  assert.equal(item.summary, 'the longest summary of them all');
  assert.deepEqual(item.signals, { hnPoints: 5 }, 'same-source duplicate keeps the smallest nativeIndex');
  assert.equal(item.discussionUrl, 'https://news.ycombinator.com/item?id=2', 'HN beats Reddit for discussion');
  assert.equal(item.tag, 'v1');
  assert.deepEqual(item.extra, { k: 'blog', only: 1, redditTopCurrent: true, subreddit: 'x' });
  assert.deepEqual(item.sources.map((s) => s.id), ['hn-top', 'reddit', 'openai', 'blog']);
  assert.equal(item.publishedAt, T(4).toISOString());
});

test('compareProvenance is a total order: weight, at, registry index, id', () => {
  const a = cand('blog', { title: 'x', url: 'https://x.test/1', publishedAt: T(1) });
  const b = cand('blog2', { title: 'x', url: 'https://x.test/1', publishedAt: T(1) });
  assert.ok(compareProvenance(a, b, registry) < 0, 'earlier registry index first on ties');
  const earlier = cand('blog2', { title: 'x', url: 'https://x.test/1', publishedAt: T(2) });
  assert.ok(compareProvenance(earlier, a, registry) < 0, 'earlier at first');
  const unknownA = { sources: [{ id: 'zz', at: T(1).toISOString() }] };
  const unknownB = { sources: [{ id: 'aa', at: T(1).toISOString() }] };
  assert.ok(compareProvenance(unknownB, unknownA, registry) < 0);
  assert.deepEqual(sourceInfo(registry, 'zz').weight, 1);
});

test('stripEphemeral removes exactly the three current-run markers', () => {
  const s = stripEphemeral({ id: 'x', extra: { hnRank: 3, hnFrontCurrent: true, redditTopCurrent: true, subreddit: 'r' } });
  assert.deepEqual(s.extra, { subreddit: 'r' });
  const t = stripEphemeral({ id: 'x', extra: { hnRank: 3 } });
  assert.equal(t.extra, undefined);
});

function stored(over) {
  return {
    id: 'abc', title: 'Stored title', url: 'https://example.com/a', canonicalUrl: 'https://example.com/a',
    sources: [{ id: 'blog', at: T(30).toISOString() }], category: 'blogs', publishedAt: T(30).toISOString(), surfacedAt: T(30).toISOString(),
    summary: 'stored summary text', score: 1, signals: { hnPoints: 10 }, ...over,
  };
}

test('previous/fresh table: union sources, min at, title by authority, max signals, extra union, ephemeral only from fresh', () => {
  const prev = stripEphemeral(stored({ extra: { hnRank: 2, hnFrontCurrent: true, k: 'old', onlyOld: 1 }, authors: ['Old'], tag: 't1', readMinutes: 4 }));
  const fresh = stored({
    title: 'Fresh title', sources: [{ id: 'hn-top', url: 'https://news.ycombinator.com/item?id=9', at: T(1).toISOString() }], category: 'news',
    publishedAt: T(1).toISOString(), surfacedAt: T(1).toISOString(), summary: 'fresh', signals: { hnPoints: 50, hnComments: 3 }, extra: { k: 'new', onlyNew: 1 }, readMinutes: 2, discussionUrl: 'https://news.ycombinator.com/item?id=9',
  });
  const [m] = mergePrevious([prev], [fresh], registry);
  assert.deepEqual(m.sources.map((s) => s.id), ['hn-top', 'blog']);
  assert.equal(m.title, 'Stored title', 'stored weight 6 beats fresh weight 5');
  assert.equal(m.category, 'blogs');
  assert.equal(m.publishedAt, T(30).toISOString());
  assert.equal(m.surfacedAt, T(1).toISOString());
  assert.equal(m.summary, 'stored summary text');
  assert.deepEqual(m.signals, { hnPoints: 50, hnComments: 3 });
  assert.deepEqual(m.extra, { k: 'old', onlyNew: 1, onlyOld: 1 });
  assert.deepEqual(m.authors, ['Old']);
  assert.equal(m.tag, 't1');
  assert.equal(m.readMinutes, 4);
  assert.equal(m.discussionUrl, 'https://news.ycombinator.com/item?id=9');
  assert.equal(m.url, 'https://example.com/a');
  // fresh ephemeral markers pass through; stored ones were stripped
  const fresh2 = { ...fresh, extra: { hnFrontCurrent: true, hnRank: 1 } };
  const [m2] = mergePrevious([prev], [fresh2], registry);
  assert.equal(m2.extra.hnFrontCurrent, true);
  assert.equal(m2.extra.hnRank, 1);
});

test('same source id: at = min(stored, fresh); fresh non-empty source url wins; exact tie -> fresh', () => {
  const prev = stored({ sources: [{ id: 'blog', url: 'https://old.test/', at: T(10).toISOString() }], title: 'Old' });
  const fresh = stored({ sources: [{ id: 'blog', url: 'https://new.test/', at: T(1).toISOString() }], title: 'New', summary: 'stored summary text' });
  const [m] = mergePrevious([prev], [fresh], registry);
  assert.deepEqual(m.sources, [{ id: 'blog', url: 'https://new.test/', at: T(10).toISOString() }]);
  assert.equal(m.title, 'Old', 'the earlier source instant is the stronger authority');
  assert.equal(m.summary, 'stored summary text');
  const freshSameAt = stored({ sources: [{ id: 'blog', at: T(10).toISOString() }], title: 'New', summary: 'stored summary text' });
  const [tie] = mergePrevious([prev], [freshSameAt], registry);
  assert.equal(tie.title, 'New', 'identical authority -> fresh');
  assert.equal(tie.sources[0].url, 'https://old.test/', 'stored url kept when fresh has none');
});

test('carry-forward keeps unmatched previous items; mismatched canonical URL discards the stored copy with a warning', () => {
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };
  const prev = stored();
  const other = stored({ id: 'zzz', canonicalUrl: 'https://example.com/z', url: 'https://example.com/z' });
  const fresh = stored({ canonicalUrl: 'https://example.com/DIFFERENT', url: 'https://example.com/DIFFERENT', title: 'Fresh' });
  const out = mergePrevious([prev, other], [fresh], registry, logger);
  assert.equal(out.length, 2);
  assert.equal(out.find((i) => i.id === 'abc').title, 'Fresh');
  assert.ok(out.find((i) => i.id === 'zzz'));
  assert.equal(warnings.length, 1);
});

test('authority tuples decide their fields', () => {
  const research = stored({ id: 'arxiv:2610.1', arxivId: '2610.1', category: 'research', sources: [{ id: 'arxiv-cs.LG', at: T(5).toISOString() }], authors: ['Paper Author'] });
  const news = stored({ id: 'arxiv:2610.1', arxivId: '2610.1', category: 'news', sources: [{ id: 'hn-front', at: T(1).toISOString() }], authors: ['HN Poster'], discussionUrl: 'https://news.ycombinator.com/item?id=1', title: 'HN title', url: 'https://example.com/hn' });
  assert.ok(compareAuthority(titleAuthority(research, registry), titleAuthority(news, registry)) > 0, 'paper class beats weight');
  assert.ok(compareAuthority(bestAuthority(news, registry), bestAuthority(research, registry)) > 0, 'raw weight favors hn-front');
  assert.ok(compareAuthority(urlAuthority(research, registry), urlAuthority(news, registry)) > 0, 'research category rank wins url');
  assert.ok(compareAuthority(authorAuthority(research, registry), authorAuthority(news, registry)) > 0);
  assert.ok(compareAuthority(discussionAuthority(news, registry), discussionAuthority(research, registry)) > 0);
  const [m] = mergePrevious([research], [news], registry);
  assert.equal(m.title, 'Stored title');
  assert.equal(m.url, 'https://arxiv.org/abs/2610.1');
  assert.deepEqual(m.authors, ['Paper Author']);
  assert.equal(m.discussionUrl, 'https://news.ycombinator.com/item?id=1');
  assert.equal(m.category, 'research');
  const unknown = stored({ sources: [{ id: 'gone', at: T(1).toISOString() }] });
  const tuple = bestAuthority(unknown, registry);
  assert.equal(tuple[0], 1);
  assert.equal(tuple[2], -Infinity);
  assert.equal(discussionAuthority(unknown, registry)[0], 0);
  assert.equal(titleAuthority({ ...unknown, arxivId: '2610.1' }, registry)[0], 0);
});

test('applyInvalidations: sitemap-only item disappears; sitemap+HN item keeps HN with corrected metadata', () => {
  const key = 'https://anthropic.com/news/x';
  const only = stored({ id: 'only', canonicalUrl: key, url: 'https://www.anthropic.com/news/x', category: 'labs', sources: [{ id: 'anthropic', at: T(2).toISOString() }], extra: { titleFrom: 'slug' } });
  const both = stored({ id: 'both', canonicalUrl: key, url: 'https://www.anthropic.com/news/x', category: 'labs', sources: [{ id: 'anthropic', at: T(2).toISOString() }, { id: 'hn-top', url: 'https://news.ycombinator.com/item?id=5', at: T(40).toISOString() }], extra: { titleFrom: 'slug', k: 1 }, publishedAt: T(2).toISOString(), surfacedAt: T(2).toISOString() });
  const inv = [{ sourceId: 'anthropic', canonicalUrl: key, provenPublishedAt: T(500).toISOString() }];
  const out = applyInvalidations([only, both], inv, registry, { info() {} });
  assert.equal(out.length, 1);
  const kept = out[0];
  assert.equal(kept.id, 'both');
  assert.deepEqual(kept.sources.map((s) => s.id), ['hn-top']);
  assert.deepEqual(kept.extra, { k: 1 });
  assert.equal(kept.publishedAt, T(500).toISOString());
  assert.equal(kept.surfacedAt, T(40).toISOString());
  assert.equal(kept.category, 'news');
  const unknownOnly = stored({ id: 'u', canonicalUrl: key, sources: [{ id: 'anthropic', at: T(2).toISOString() }, { id: 'gone', at: T(3).toISOString() }], category: 'labs' });
  const [u] = applyInvalidations([unknownOnly], inv, registry);
  assert.equal(u.category, 'labs', 'unknown-only remainder preserves the prior category');
  assert.deepEqual(applyInvalidations([only], [{ sourceId: 'thebatch', canonicalUrl: key, provenPublishedAt: T(500).toISOString() }], registry), [only], 'other source id does not touch the item');
});
