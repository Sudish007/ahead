import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NOW, CONFIG, fixtureFetch, quietLogger } from './helpers.js';
import { run } from '../src/pipeline.js';
import { mergeItems, mergePrevious } from '../src/dedup.js';
import { score, compareRank } from '../src/score.js';
import { buildBrief } from '../src/brief.js';
import { buildRegistry } from '../src/registry.js';
import { toItem } from '../src/normalize.js';

const SOURCES = [
  { id: 'arxiv-cs.LG', name: 'arXiv cs.LG', category: 'research', type: 'arxiv', url: 'https://a.test/', weight: 3, family: 'arxiv' },
  { id: 'hf-papers', name: 'HF Daily Papers', category: 'research', type: 'json', parser: 'hf-papers', url: 'https://hf.test/', weight: 8 },
  { id: 'hn-top', name: 'Hacker News', category: 'news', type: 'hn', url: 'https://hn.test/', weight: 5, family: 'hn' },
  { id: 'hn-front', name: 'HN front page', category: 'news', type: 'hn', url: 'https://hnf.test/', weight: 6, family: 'hn' },
  { id: 'reddit', name: 'Reddit', category: 'news', type: 'reddit', url: 'https://r.test/', weight: 4 },
  { id: 'openai', name: 'OpenAI', category: 'labs', type: 'rss', url: 'https://o.test/', weight: 7 },
  { id: 'blog', name: 'Blog', category: 'blogs', type: 'rss', url: 'https://b.test/', weight: 6, longForm: true },
  { id: 'blog2', name: 'Blog2', category: 'blogs', type: 'rss', url: 'https://b2.test/', weight: 6 },
];
const registry = buildRegistry(SOURCES);
const T = (h) => new Date(NOW.getTime() - h * 3.6e6);

function seededShuffle(arr, seed) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function candidates() {
  const out = [];
  const mk = (sourceId, raw, nativeIndex = 0) => {
    const src = registry.get(sourceId);
    const item = toItem({ nativeIndex, ...raw }, src, NOW);
    out.push({ ...item, registryIndex: src.registryIndex, nativeIndex });
  };
  // exact ties everywhere: same score inputs, same dates, titles that differ only in code point
  for (let i = 0; i < 6; i++) {
    const url = `https://example.com/story-${i}`;
    mk('hn-top', { title: `Story ${i} on HN`, url, discussionUrl: `https://news.ycombinator.com/item?id=${100 + i}`, publishedAt: T(2), signals: { hnPoints: 50, hnComments: 5 }, summaryText: 'same length', extra: { k: 'hn', s: i } }, i);
    mk('reddit', { title: `Story ${i} on Reddit`, url, discussionUrl: `https://reddit.com/r/x/${i}`, publishedAt: T(2), summaryText: 'same lengtH', extra: { k: 'rd', subreddit: 'x', redditTopCurrent: true } }, i);
    mk('blog', { title: `Story ${i} from Blog`, url, publishedAt: T(2), summaryText: 'longest summary here', authors: ['B'], bodyLength: 9000 }, i);
    mk('blog2', { title: `Story ${i} from Blog2`, url, publishedAt: T(2), summaryText: 'longest summary herE', authors: ['C'], tag: `t${i}` }, i);
  }
  for (let i = 0; i < 4; i++) {
    const id = `2610.0000${i}`;
    mk('arxiv-cs.LG', { title: `Paper ${i}`, url: `https://arxiv.org/abs/${id}`, arxivId: id, publishedAt: T(3), summaryText: 'abstract', authors: ['A'], extra: { primaryCategory: 'cs.LG' } }, i);
    mk('hf-papers', { title: `Paper ${i} HF`, url: `https://huggingface.co/papers/${id}`, arxivId: id, publishedAt: T(30), surfacedAt: T(1), signals: { hfUpvotes: 10 }, authors: ['H'] }, i);
    mk('hn-front', { title: `Paper ${i} HN`, url: `https://arxiv.org/pdf/${id}v2`, discussionUrl: `https://news.ycombinator.com/item?id=${200 + i}`, publishedAt: T(1), signals: { hnPoints: 50, hnComments: 5 }, extra: { hnFrontCurrent: true, hnRank: i + 1 } }, i);
  }
  for (let i = 0; i < 3; i++) mk('openai', { title: `Lab post ${i}`, url: `https://openai.com/p/${i}`, publishedAt: T(4), summaryText: 'lab' }, i);
  return out;
}

const finish = (cands) => {
  const items = mergeItems(cands, registry);
  for (const it of items) it.score = score(it, NOW, registry);
  items.sort(compareRank);
  return items;
};

test('shuffled candidates produce byte-identical items and brief sections', () => {
  const base = finish(candidates());
  const baseJson = JSON.stringify(base);
  const baseBrief = JSON.stringify(buildBrief(base, [], NOW, { targetWords: 1100, registry }).digest.sections);
  for (const seed of [1, 7, 42, 1234, 99991]) {
    const items = finish(seededShuffle(candidates(), seed));
    assert.equal(JSON.stringify(items), baseJson, `seed ${seed}`);
    assert.equal(JSON.stringify(buildBrief(items, [], NOW, { targetWords: 1100, registry }).digest.sections), baseBrief, `brief seed ${seed}`);
  }
  assert.ok(base.length >= 13);
  assert.ok(base.slice(0, 4).every((i) => i.arxivId), 'papers with three families rank first');
});

test('two-run: a stored high-weight title survives a later low-weight sighting; permutations are byte-identical', () => {
  const stored = finish(candidates()).map((it) => ({ ...it }));
  const freshCands = candidates().filter((c) => c.sources[0].id === 'reddit' || c.sources[0].id === 'hn-top').map((c) => ({ ...c, title: `${c.title} (fresh)`, sources: [{ ...c.sources[0], at: T(0).toISOString() }] }));
  const fresh = finish(freshCands);
  const merged = mergePrevious(stored, fresh, registry);
  const story0 = merged.find((i) => i.canonicalUrl === 'https://example.com/story-0');
  assert.equal(story0.title, 'Story 0 from Blog', 'stored weight-6 blog title beats fresh weight-5 HN');
  assert.ok(story0.sources.some((s) => s.id === 'hn-top'));
  const baseline = JSON.stringify(merged.sort(compareRank));
  for (const seed of [3, 11, 500]) {
    const s2 = seededShuffle(stored, seed);
    const f2 = seededShuffle(fresh.map((it) => ({ ...it, sources: seededShuffle(it.sources, seed + 1) })), seed + 2);
    const m2 = mergePrevious(s2, f2, registry).sort(compareRank);
    assert.equal(JSON.stringify(m2), baseline, `permutation ${seed}`);
  }
  // every aggregate authority function decides its field identically under permutation
  const a = stored.find((i) => i.canonicalUrl === 'https://example.com/story-1');
  const b = { ...fresh.find((i) => i.canonicalUrl === 'https://example.com/story-1') };
  b.sources = [...b.sources].reverse();
  const [x] = mergePrevious([a], [b], registry);
  const [y] = mergePrevious([{ ...a, sources: [...a.sources].reverse() }], [fresh.find((i) => i.canonicalUrl === 'https://example.com/story-1')], registry);
  assert.equal(JSON.stringify(x), JSON.stringify(y));
});

test('reversed worker completion order yields byte-identical pipeline output', async () => {
  const delayed = (reverse) => {
    const inner = fixtureFetch({ now: NOW });
    let n = 0;
    return async (url, init) => {
      const k = n++;
      const ms = reverse ? Math.max(0, 40 - k) : Math.min(40, k);
      await new Promise((r) => setTimeout(r, ms % 7));
      return inner(url, init);
    };
  };
  const a = await run({ ...CONFIG, now: NOW, dataDir: mkdtempSync(path.join(tmpdir(), 'ahead-det-')), fetchImpl: delayed(false), env: {}, logger: quietLogger(), dryRun: true });
  const b = await run({ ...CONFIG, now: NOW, dataDir: mkdtempSync(path.join(tmpdir(), 'ahead-det-')), fetchImpl: delayed(true), env: {}, logger: quietLogger(), dryRun: true });
  assert.equal(JSON.stringify(a.items), JSON.stringify(b.items));
  assert.equal(JSON.stringify(a.digest.sections), JSON.stringify(b.digest.sections));
  assert.deepEqual(a.sourceResults.map((r) => [r.id, r.status, r.fetched, r.kept]), b.sourceResults.map((r) => [r.id, r.status, r.fetched, r.kept]));
});
