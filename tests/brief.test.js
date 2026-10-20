import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW } from './helpers.js';
import { buildBrief, heuristicWhy, orderSources, countWords, countDigestWords, enforceBudget, finalizeDigest, splitSentences, compact, SECTIONS } from '../src/brief.js';
import { buildRegistry } from '../src/registry.js';
import { validateDigest } from '../src/schema.js';

const SOURCES = [
  { id: 'arxiv-cs.LG', name: 'arXiv cs.LG', category: 'research', type: 'arxiv', url: 'https://a.test/', weight: 3, family: 'arxiv' },
  { id: 'hf-papers', name: 'HF Daily Papers', category: 'research', type: 'json', parser: 'hf-papers', url: 'https://hf.test/', weight: 8 },
  { id: 'hn-top', name: 'Hacker News', category: 'news', type: 'hn', url: 'https://hn.test/', weight: 5, family: 'hn' },
  { id: 'hn-front', name: 'HN front page', category: 'news', type: 'hn', url: 'https://hnf.test/', weight: 6, family: 'hn' },
  { id: 'reddit', name: 'Reddit', category: 'news', type: 'reddit', url: 'https://r.test/', weight: 4 },
  { id: 'openai', name: 'OpenAI', category: 'labs', type: 'rss', url: 'https://o.test/', weight: 7 },
  { id: 'anthropic', name: 'Anthropic', category: 'labs', type: 'sitemap', url: 'https://an.test/', weight: 8 },
  { id: 'blog', name: 'Deep Blog', category: 'blogs', type: 'rss', url: 'https://b.test/', weight: 6, longForm: true },
  { id: 'short', name: 'Short Blog', category: 'blogs', type: 'rss', url: 'https://s.test/', weight: 5 },
  { id: 'latentspace', name: 'Latent Space', category: 'blogs', type: 'rss', url: 'https://l.test/', weight: 5 },
  { id: 'gh-trending-llm', name: 'GitHub new repos: llm', category: 'releases', type: 'github', url: 'https://api.github.com/x', weight: 4, family: 'gh-trending', minStars: 50 },
  { id: 'gh-rel-vllm', name: 'vLLM releases', category: 'releases', type: 'github', url: 'https://github.com/vllm-project/vllm/releases.atom', weight: 6, repo: 'vllm-project/vllm' },
  { id: 'hf-trending', name: 'HF trending models', category: 'releases', type: 'json', parser: 'hf-models', url: 'https://hft.test/', weight: 4 },
  { id: 'yt', name: 'YT', category: 'media', type: 'youtube', url: 'https://yt.test/', weight: 5 },
];
const registry = buildRegistry(SOURCES);
const T = (h) => new Date(NOW.getTime() - h * 3.6e6).toISOString();
let counter = 0;
function item(over = {}) {
  const n = ++counter;
  const at = over.surfacedAt ?? T(2);
  const sources = over.sources ?? [{ id: 'hn-top', at }];
  return {
    id: over.id ?? `id${String(n).padStart(4, '0')}`,
    title: over.title ?? `Item ${n} title`,
    url: over.url ?? `https://example.com/${n}`,
    canonicalUrl: `https://example.com/${n}`,
    sources,
    category: over.category ?? 'news',
    publishedAt: over.publishedAt ?? at,
    surfacedAt: at,
    summary: over.summary ?? 'A first sentence about the thing. A second sentence with detail. A third sentence that should not appear.',
    score: over.score ?? 10,
    signals: over.signals ?? {},
    ...(over.extra ? { extra: over.extra } : {}),
    ...(over.readMinutes ? { readMinutes: over.readMinutes } : {}),
    ...(over.tag ? { tag: over.tag } : {}),
    ...(over.discussionUrl ? { discussionUrl: over.discussionUrl } : {}),
  };
}
const synth = () => {
  counter = 0;
  const items = [];
  for (let i = 0; i < 8; i++) items.push(item({ category: 'news', score: 50 - i }));
  for (let i = 0; i < 5; i++) items.push(item({ category: 'research', score: 40 - i, sources: [{ id: 'hf-papers', at: T(3) }], signals: { hfUpvotes: 10 + i } }));
  for (let i = 0; i < 5; i++) items.push(item({ category: 'releases', score: 30 - i, sources: [{ id: 'hf-trending', at: T(3) }], signals: { hfLikes: 100 } }));
  for (let i = 0; i < 4; i++) items.push(item({ category: 'labs', score: 20 - i, sources: [{ id: 'openai', at: T(4) }] }));
  for (let i = 0; i < 4; i++) items.push(item({ category: 'blogs', score: 15 - i, sources: [{ id: 'blog', at: T(5) }], readMinutes: 12 }));
  for (let i = 0; i < 3; i++) items.push(item({ category: 'blogs', score: 9 - i, sources: [{ id: 'short', at: T(5) }], readMinutes: 2 }));
  return items;
};

test('sections fill with required counts, used ids excluded, deep read from the independent pool', () => {
  const items = synth();
  const used = items[0].id;
  const yesterday = { date: NOW.toISOString().slice(0, 10).replace(/19$/, '18'), itemIds: [used], deepReadId: items[12 + 5 + 4].id };
  const { digest, facts } = buildBrief(items, [yesterday], NOW, { targetWords: 1100, registry });
  const counts = Object.fromEntries(digest.sections.map((s) => [s.key, s.entries.length]));
  assert.deepEqual(counts, { 'must-know': 4, research: 3, releases: 3, labs: 2, analysis: 2, 'deep-read': 1 });
  assert.ok(!digest.itemIds.includes(used));
  assert.ok(!digest.itemIds.includes(yesterday.deepReadId), 'recent deepReadId excluded');
  assert.equal(new Set(digest.itemIds).size, digest.itemIds.length);
  const analysis = digest.sections.find((s) => s.key === 'analysis').entries;
  assert.ok(analysis.every((e) => e.sourceIds.includes('blog')), 'long-form first');
  assert.deepEqual([...facts.keys()], digest.itemIds);
  assert.ok(facts.get(digest.sections[1].entries[0].id).signals.hfUpvotes >= 10);
  assert.ok(!JSON.stringify(digest).includes('"signals"'));
  assert.equal(digest.date, '2026-10-19');
  assert.ok(digest.readingMinutes <= 5);
  validateDigest(digest);
});

test('36 h pool widens to 72 h only when fewer than 20 remain after used', () => {
  counter = 0;
  const recent = Array.from({ length: 10 }, () => item({ surfacedAt: T(10), score: 50 }));
  const older = Array.from({ length: 10 }, () => item({ surfacedAt: T(60), score: 80 }));
  const { digest } = buildBrief([...recent, ...older], [], NOW, { targetWords: 1100, registry });
  assert.ok(older.some((o) => digest.itemIds.includes(o.id)), 'older items used when the 36 h pool is thin');
  counter = 0;
  const many = Array.from({ length: 25 }, () => item({ surfacedAt: T(10), score: 50 }));
  const older2 = Array.from({ length: 10 }, () => item({ surfacedAt: T(60), score: 80 }));
  const { digest: d2 } = buildBrief([...many, ...older2], [], NOW, { targetWords: 1100, registry });
  assert.ok(!older2.some((o) => d2.itemIds.includes(o.id)), '36 h pool suffices');
});

test('a five-day-old deep read is selected from the independent pool and stays out of the first five sections', () => {
  const items = synth().filter((i) => i.category !== 'blogs');
  const deep = item({ category: 'blogs', surfacedAt: T(5 * 24), sources: [{ id: 'blog', at: T(5 * 24) }], readMinutes: 20, score: 3 });
  const { digest } = buildBrief([...items, deep], [], NOW, { targetWords: 1100, registry });
  assert.equal(digest.deepReadId, deep.id);
  assert.equal(digest.sections.find((s) => s.key === 'analysis').entries.length, 0);
  assert.equal(digest.sections.find((s) => s.key === 'labs').entries.length, 2);
});

test('empty pools emit entries: [] and still validate', () => {
  const { digest } = buildBrief([], [], NOW, { targetWords: 1100, registry });
  assert.ok(digest.sections.every((s) => s.entries.length === 0));
  assert.equal(digest.deepReadId, null);
  assert.deepEqual(digest.itemIds, []);
  assert.equal(digest.readingMinutes, 1);
  validateDigest(digest);
});

test('[AINews] may enter Must know but never Analysis or Deep read', () => {
  counter = 0;
  const ainews = item({ title: '[AINews] big roundup', category: 'blogs', sources: [{ id: 'latentspace', at: T(1) }], score: 99, readMinutes: 30 });
  const blog = item({ category: 'blogs', sources: [{ id: 'blog', at: T(1) }], score: 5, readMinutes: 10 });
  const { digest } = buildBrief([ainews, blog], [], NOW, { targetWords: 1100, registry });
  assert.ok(digest.sections[0].entries.some((e) => e.id === ainews.id));
  assert.ok(!digest.sections.find((s) => s.key === 'analysis').entries.some((e) => e.id === ainews.id));
  assert.notEqual(digest.deepReadId, ainews.id);
});

test('D4 ordering: primary-first sourceNames, {source} = primary, also-on skips primary family and hn', () => {
  const it = item({
    category: 'research', signals: { hnPoints: 120, hnComments: 8 },
    sources: [{ id: 'gone', at: T(1) }, { id: 'hn-top', at: T(1) }, { id: 'arxiv-cs.LG', at: T(3) }, { id: 'hf-papers', at: T(2) }, { id: 'hn-front', at: T(1) }],
  });
  const ordered = orderSources(it, registry).map((s) => s.id);
  assert.deepEqual(ordered, ['hf-papers', 'hn-front', 'hn-top', 'arxiv-cs.LG', 'gone']);
  const why = heuristicWhy(it, NOW, registry);
  assert.equal(why, '120 points on HN, 8 comments; also on arXiv cs.LG, gone');
  const noSignal = item({ category: 'labs', sources: [{ id: 'openai', at: T(1) }, { id: 'anthropic', at: T(2) }] });
  assert.equal(heuristicWhy(noSignal, NOW, registry), 'also on OpenAI');
  const { digest } = buildBrief([it], [], NOW, { targetWords: 1100, registry });
  assert.deepEqual(digest.sections[0].entries[0].sourceNames, ['HF Daily Papers', 'HN front page', 'Hacker News', 'arXiv cs.LG', 'gone']);
  assert.deepEqual(digest.sections[0].entries[0].sourceIds, ordered);
});

test('why-line HN clauses and present-tense gating', () => {
  const ranked = item({ signals: { hnPoints: 435, hnComments: 215 }, extra: { hnFrontCurrent: true, hnRank: 4 }, sources: [{ id: 'hn-front', at: T(1) }] });
  assert.equal(heuristicWhy(ranked, NOW, registry), '#4 on HN front page, 435 points, 215 comments');
  const marker = item({ signals: { hnPoints: 1200 }, extra: { hnFrontCurrent: true }, sources: [{ id: 'hn-front', at: T(1) }] });
  assert.equal(heuristicWhy(marker, NOW, registry), 'on HN front page, 1.2k points');
  const historical = item({ signals: { hnPoints: 50, hnComments: 7 }, sources: [{ id: 'hn-front', at: T(30) }] });
  assert.equal(heuristicWhy(historical, NOW, registry), '50 points on HN, 7 comments');
  assert.ok(!/front page/.test(heuristicWhy(historical, NOW, registry)));
  const commentsOnly = item({ signals: { hnComments: 7 }, sources: [{ id: 'hn-top', at: T(1) }] });
  assert.equal(heuristicWhy(commentsOnly, NOW, registry), '7 comments on HN');
});

test('why-line fallbacks never stringify undefined; reddit top-today only with the marker', () => {
  const top = item({ extra: { redditTopCurrent: true, subreddit: 'LocalLLaMA' }, sources: [{ id: 'reddit', at: T(1) }] });
  assert.equal(heuristicWhy(top, NOW, registry), 'top of r/LocalLLaMA today');
  const retained = item({ extra: { subreddit: 'LocalLLaMA' }, sources: [{ id: 'reddit', at: T(1) }] });
  assert.equal(heuristicWhy(retained, NOW, registry), 'from r/LocalLLaMA');
  const hnNoSignals = item({ sources: [{ id: 'hn-top', at: T(1) }] });
  assert.equal(heuristicWhy(hnNoSignals, NOW, registry), 'on HN');
  const unknownNews = item({ sources: [{ id: 'gone', at: T(1) }] });
  assert.equal(heuristicWhy(unknownNews, NOW, registry), 'new discussion');
  assert.equal(heuristicWhy(item({ category: 'research', sources: [{ id: 'arxiv-cs.LG', at: T(1) }], extra: { primaryCategory: 'cs.LG' } }), NOW, registry), 'new on arXiv (cs.LG)');
  assert.equal(heuristicWhy(item({ category: 'research', sources: [{ id: 'arxiv-cs.LG', at: T(1) }] }), NOW, registry), 'new research paper');
  assert.equal(heuristicWhy(item({ category: 'blogs', sources: [{ id: 'blog', at: T(1) }], readMinutes: 7 }), NOW, registry), 'Deep Blog, ~7 min read');
  assert.equal(heuristicWhy(item({ category: 'blogs', sources: [{ id: 'blog', at: T(1) }] }), NOW, registry), 'Deep Blog analysis');
  assert.equal(heuristicWhy(item({ category: 'labs', sources: [{ id: 'openai', at: T(1) }] }), NOW, registry), 'OpenAI announcement');
  assert.equal(heuristicWhy(item({ category: 'releases', sources: [{ id: 'gh-rel-vllm', at: T(1) }] }), NOW, registry), 'vLLM releases release');
  assert.equal(heuristicWhy(item({ category: 'media', sources: [{ id: 'yt', at: T(1) }] }), NOW, registry), 'new episode from YT');
  assert.equal(heuristicWhy(item({ category: 'blogs', sources: [{ id: 'gone', at: T(1) }] }), NOW, registry), 'gone analysis');
});

test('factual clauses: upvotes, stars with repository age, release tag, likes, views; no repeats; 160-char join rule', () => {
  const paper = item({ category: 'research', signals: { hfUpvotes: 30 }, sources: [{ id: 'hf-papers', at: T(1) }, { id: 'arxiv-cs.LG', at: T(2) }] });
  assert.equal(heuristicWhy(paper, NOW, registry), '30 upvotes on HF Papers; also on arXiv cs.LG');
  const onlyUpvotes = item({ category: 'research', signals: { hfUpvotes: 1500 }, sources: [{ id: 'hf-papers', at: T(1) }] });
  assert.equal(heuristicWhy(onlyUpvotes, NOW, registry), '1.5k upvotes on HF Papers');
  const stars = (publishedAt) => item({ category: 'releases', signals: { ghStars: 1234 }, sources: [{ id: 'gh-trending-llm', at: T(0) }], publishedAt });
  assert.equal(heuristicWhy(stars(NOW.toISOString()), NOW, registry), '1,234 stars in 1 day');
  assert.equal(heuristicWhy(stars(T(24)), NOW, registry), '1,234 stars in 1 day');
  assert.equal(heuristicWhy(stars(new Date(NOW.getTime() - 24 * 3.6e6 - 1).toISOString()), NOW, registry), '1,234 stars in 2 days');
  assert.equal(heuristicWhy(stars('not a date'), NOW, registry), '1,234 stars on GitHub');
  assert.equal(heuristicWhy(stars(new Date(NOW.getTime() + 1000).toISOString()), NOW, registry), '1,234 stars on GitHub');
  const release = item({ category: 'releases', tag: 'v0.32.0', sources: [{ id: 'gh-rel-vllm', at: T(1) }] });
  assert.equal(heuristicWhy(release, NOW, registry), 'new release v0.32.0');
  const model = item({ category: 'releases', signals: { hfLikes: 17980 }, sources: [{ id: 'hf-trending', at: T(1) }] });
  assert.equal(heuristicWhy(model, NOW, registry), '18k likes on Hugging Face');
  const video = item({ category: 'media', signals: { ytViews: 2_500_000 }, sources: [{ id: 'yt', at: T(1) }] });
  assert.equal(heuristicWhy(video, NOW, registry), '2.5m views');
  const long = item({ signals: { hnPoints: 5 }, sources: [{ id: 'hn-top', at: T(1) }, ...Array.from({ length: 12 }, (_, i) => ({ id: `very-long-unknown-source-name-number-${i}`, at: T(2) }))] });
  const why = heuristicWhy(long, NOW, registry);
  assert.equal(why, '5 points on HN', 'second clause dropped when the join exceeds 160 chars');
  assert.ok(why.length <= 160);
  assert.equal(compact(999), '999'); assert.equal(compact(1000), '1k'); assert.equal(compact(1234567), '1.2m');
});

test('sentence split guards abbreviations; entry summary is 1-2 sentences <= 280 chars', () => {
  assert.deepEqual(splitSentences('We use e.g. GPUs. Then we train. Done!'), ['We use e.g. GPUs.', 'Then we train.', 'Done!']);
  assert.deepEqual(splitSentences('See Fig. 3 for details. Next sentence.'), ['See Fig. 3 for details.', 'Next sentence.']);
  const { digest } = buildBrief([item({ summary: 'One. Two. Three.' })], [], NOW, { targetWords: 1100, registry });
  assert.equal(digest.sections[0].entries[0].summary, 'One. Two.');
  const longSentence = `${'word '.repeat(80)}end.`;
  const { digest: d2 } = buildBrief([item({ summary: longSentence })], [], NOW, { targetWords: 1100, registry });
  assert.ok(d2.sections[0].entries[0].summary.length <= 280);
});

test('word budget: 840 target fits with readingMinutes <= 5; a 260-word overview survives under 1,100; Analysis trims before Must know', () => {
  const items = synth().map((i) => ({ ...i, summary: `${'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu. '.repeat(8)}`.trim() }));
  const { digest } = buildBrief(items, [], NOW, { targetWords: 840, registry });
  assert.ok(digest.wordCount <= 840);
  assert.ok(digest.readingMinutes <= 5);
  const analysis = digest.sections.find((s) => s.key === 'analysis').entries;
  const must = digest.sections[0].entries;
  assert.ok(analysis.at(-1).summary.length <= must[0].summary.length, 'analysis trimmed before must-know');
  digest.overview = { text: Array.from({ length: 260 }, (_, i) => `w${i}`).join(' '), source: 'llm', model: 'm' };
  enforceBudget(digest, 1100);
  finalizeDigest(digest);
  assert.ok(digest.wordCount <= 1100);
  assert.equal(countWords(digest.overview.text), 260, 'the largest accepted overview fits without trimming it');
  validateDigest(digest);
});

test('adversarial one-letter tokens: summaries empty, titles/why capped at 12 words, labels -> three + "+N sources", complete sourceIds, bounds', () => {
  counter = 0;
  const tokens = (n) => Array.from({ length: n }, () => 'x').join(' ');
  const longNames = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: `Very long source label number ${i} words`, category: 'news', type: 'rss', url: `https://s${i}.test/`, weight: 2 + (i % 5) }));
  const wide = buildRegistry([...SOURCES, ...longNames]);
  const many = longNames.map((s) => ({ id: s.id, at: T(1) }));
  const cats = ['news', 'news', 'news', 'news', 'research', 'research', 'research', 'releases', 'releases', 'releases', 'labs', 'labs', 'blogs', 'blogs', 'blogs'];
  const items = cats.map((category, i) => item({ category, title: tokens(70), summary: tokens(140), sources: many, score: 100 - i, readMinutes: 20 }));
  const { digest } = buildBrief(items, [], NOW, { targetWords: 880, registry: wide });
  const entries = digest.sections.flatMap((s) => s.entries);
  assert.ok(entries.length >= 9 && entries.length <= 15, `stage 2 never drops below one entry per section (${entries.length})`);
  assert.equal(digest.sections[0].entries.length, 4, 'must-know never shrinks');
  assert.equal(digest.sections[5].entries.length, 1, 'deep-read never shrinks');
  assert.ok(digest.wordCount <= 880);
  for (const e of entries) {
    e.why = tokens(100);
    e.whySource = 'llm';
  }
  digest.overview = { text: Array.from({ length: 260 }, (_, i) => `o${i}`).join(' '), source: 'llm', model: 'm' };
  enforceBudget(digest, 1100);
  finalizeDigest(digest);
  const after = digest.sections.flatMap((s) => s.entries);
  assert.ok(after.every((e) => e.summary === ''), 'stage 4 empties every summary');
  assert.ok(after.every((e) => countWords(e.title) <= 12 && countWords(e.why) <= 12), 'stage 5 caps every title and why');
  assert.ok(after.every((e) => e.sourceNames.length === 4 && e.sourceNames[3] === '+27 sources' && e.sourceNames.slice(0, 3).every((l) => countWords(l) <= 6)), 'stage 6 trims every label list');
  assert.ok(after.every((e) => e.sourceIds.length === 30), 'sourceIds stay complete');
  assert.ok(digest.wordCount <= 1100, `wordCount ${digest.wordCount}`);
  assert.equal(digest.wordCount, countDigestWords(digest));
  assert.equal(countWords(digest.overview.text), 260, 'the overview is never trimmed');
  digest.overview = null;
  enforceBudget(digest, 880);
  finalizeDigest(digest);
  assert.ok(digest.wordCount <= 880);
  validateDigest(digest);
});

test('finalizeDigest derives identity fields from surviving entries', () => {
  const { digest } = buildBrief(synth(), [], NOW, { targetWords: 1100, registry });
  digest.sections[1].entries.pop();
  finalizeDigest(digest);
  assert.deepEqual(digest.itemIds, digest.sections.flatMap((s) => s.entries.map((e) => e.id)));
  assert.equal(digest.deepReadId, digest.sections[5].entries[0].id);
  assert.equal(digest.wordCount, countDigestWords(digest));
  assert.equal(digest.readingMinutes, Math.max(1, Math.ceil(digest.wordCount / 220)));
  assert.deepEqual(SECTIONS.map((s) => s.key), ['must-know', 'research', 'releases', 'labs', 'analysis', 'deep-read']);
});
