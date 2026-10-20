import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW } from './helpers.js';
import { score, round2, compareRank, HALF_LIFE_HOURS, CROSS_BONUS, CROSS_CAP } from '../src/score.js';
import { buildRegistry } from '../src/registry.js';

const registry = buildRegistry([
  { id: 'hn', name: 'HN', category: 'news', type: 'hn', url: 'https://h.test/', weight: 5, family: 'hn' },
  { id: 'arxiv', name: 'arXiv', category: 'research', type: 'arxiv', url: 'https://a.test/', weight: 3, family: 'arxiv' },
  { id: 'arxiv2', name: 'arXiv2', category: 'research', type: 'arxiv', url: 'https://a2.test/', weight: 3, family: 'arxiv' },
  { id: 'hf', name: 'HF', category: 'research', type: 'json', url: 'https://f.test/', weight: 8 },
  { id: 'r', name: 'R', category: 'news', type: 'reddit', url: 'https://r.test/', weight: 4 },
  { id: 'b', name: 'B', category: 'blogs', type: 'rss', url: 'https://b.test/', weight: 6 },
  { id: 'c', name: 'C', category: 'blogs', type: 'rss', url: 'https://c.test/', weight: 6 },
]);
const at = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3.6e6).toISOString();

test('worked example: A = 13.25, B = 23.00, B > A', () => {
  const A = { sources: [{ id: 'hn', at: at(2) }], surfacedAt: at(2), signals: { hnPoints: 500, hnComments: 200 } };
  const B = { sources: [{ id: 'arxiv', at: at(20) }, { id: 'hf', at: at(20) }, { id: 'hn', at: at(20) }], surfacedAt: at(20), signals: { hnPoints: 40, hnComments: 10, hfUpvotes: 30 } };
  assert.equal(round2(score(A, NOW, registry)), 13.25);
  assert.equal(round2(score(B, NOW, registry)), 23);
  assert.ok(score(B, NOW, registry) > score(A, NOW, registry));
});

test('decay halves at 36 h; missing signals contribute 0', () => {
  assert.equal(HALF_LIFE_HOURS, 36);
  const fresh = { sources: [{ id: 'b', at: at(0) }], surfacedAt: at(0), signals: {} };
  const half = { sources: [{ id: 'b', at: at(36) }], surfacedAt: at(36), signals: {} };
  assert.equal(score(fresh, NOW, registry), 6);
  assert.equal(score(half, NOW, registry), 3);
  const future = { sources: [{ id: 'b', at: at(-5) }], surfacedAt: at(-5), signals: {} };
  assert.equal(score(future, NOW, registry), 6, 'negative age clamps to 0');
});

test('cross-source bonus uses families and caps at 12; unknown ids weigh 1 in their own family', () => {
  assert.equal(CROSS_BONUS * CROSS_CAP, 12);
  const sameFamily = { sources: [{ id: 'arxiv', at: at(0) }, { id: 'arxiv2', at: at(0) }], surfacedAt: at(0), signals: {} };
  assert.equal(score(sameFamily, NOW, registry), 3);
  const five = { sources: [{ id: 'hn', at: at(0) }, { id: 'arxiv', at: at(0) }, { id: 'hf', at: at(0) }, { id: 'r', at: at(0) }, { id: 'b', at: at(0) }], surfacedAt: at(0), signals: {} };
  assert.equal(score(five, NOW, registry), 8 + 12);
  const unknown = { sources: [{ id: 'gone', at: at(0) }], surfacedAt: at(0), signals: {} };
  assert.equal(score(unknown, NOW, registry), 1);
  const unknownPlus = { sources: [{ id: 'gone', at: at(0) }, { id: 'b', at: at(0) }], surfacedAt: at(0), signals: {} };
  assert.equal(score(unknownPlus, NOW, registry), 6 + 4);
});

test('compareRank: score desc, surfaced desc, code-point title asc, id asc', () => {
  const items = [
    { id: 'd', title: 'b', score: 1, surfacedAt: at(1) },
    { id: 'c', title: 'a', score: 1, surfacedAt: at(1) },
    { id: 'b', title: 'Z', score: 1, surfacedAt: at(1) },
    { id: 'a', title: 'x', score: 1, surfacedAt: at(0) },
    { id: 'e', title: 'x', score: 2, surfacedAt: at(5) },
    { id: 'f', title: 'a', score: 1, surfacedAt: at(1) },
  ];
  const sorted = [...items].sort(compareRank).map((i) => i.id);
  assert.deepEqual(sorted, ['e', 'a', 'b', 'c', 'f', 'd']);
  assert.ok(!compareRank.toString().includes('localeCompare'));
});
