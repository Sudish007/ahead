import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, fixtureFor } from './helpers.js';
import { validateConfig, ConfigError } from '../src/schema.js';
import { buildRegistry, sourceInfo, codePointCompare } from '../src/registry.js';

const BASELINE_IDS = [
  'arxiv-cs.LG', 'arxiv-cs.CL', 'arxiv-cs.AI', 'arxiv-cs.CV', 'hf-papers',
  'hn-top', 'hn-front', 'reddit',
  'openai', 'anthropic', 'deepmind', 'google-research', 'meta-newsroom-ai', 'meta-engineering-ai', 'microsoft-research', 'nvidia-dev', 'hf-blog', 'allenai', 'mistral', 'transformer-circuits',
  'lilog', 'interconnects', 'raschka', 'simonw', 'chiphuyen', 'eugeneyan', 'hamel', 'semianalysis', 'importai', 'latentspace', 'zvi', 'thebatch', 'oneusefulthing', 'gradient', 'epoch', 'epoch-gradient-updates', 'alignmentforum', 'chinai', 'jalammar', 'karpathy-blog', 'karpathy-bearblog', 'horace',
  'gh-rel-pytorch', 'gh-rel-vllm', 'gh-rel-transformers', 'gh-rel-llamacpp', 'gh-rel-sglang', 'gh-rel-unsloth', 'gh-rel-trl', 'gh-rel-torchtitan', 'gh-trending-llm', 'gh-trending-ml', 'gh-trending-agents', 'hf-trending',
  'pod-dwarkesh', 'pod-mlst', 'pod-cogrev', 'pod-nopriors', 'yt-karpathy', 'yt-yannic', 'yt-aiexplained', 'yt-gpumode', 'yt-stanford', 'yt-3b1b',
];

test('production config validates and contains the 64 baseline ids', () => {
  assert.equal(validateConfig(CONFIG), true);
  assert.equal(BASELINE_IDS.length, 64);
  const ids = new Set(CONFIG.sources.map((s) => s.id));
  for (const id of BASELINE_IDS) assert.ok(ids.has(id), `missing ${id}`);
  assert.ok(CONFIG.sources.length >= 64);
  assert.equal(ids.size, CONFIG.sources.length);
  const counts = {};
  for (const s of CONFIG.sources) counts[s.category] = (counts[s.category] ?? 0) + 1;
  assert.deepEqual(counts, { research: 5, news: 3, labs: 12, blogs: 22, releases: 12, media: 10 });
  for (const s of CONFIG.sources) {
    assert.ok(Number.isInteger(s.weight) && s.weight >= 1 && s.weight <= 10, s.id);
    if ('rankUrl' in s) assert.equal(s.type, 'hn');
    if (s.type === 'github') assert.match(new URL(s.url.replace(/\{\{\w+\}\}/g, 'x')).hostname, /^(api\.)?github\.com$/);
  }
});

test('every source resolves to an exact fixture or a kind fallback', () => {
  for (const s of CONFIG.sources) assert.ok(fixtureFor(s), `${s.id} has no fixture`);
});

test('the three more link-outs keep their tab assignments', () => {
  const byName = Object.fromEntries(CONFIG.linkouts.more.map((l) => [l.name, l.tab]));
  assert.equal(byName.alphaXiv, 'research');
  assert.equal(byName['Meta AI blog'], 'labs');
  assert.equal(byName['AI News (smol.ai)'], 'blogs');
  assert.equal(CONFIG.linkouts.leaderboards.length, 8);
  assert.equal(CONFIG.learn.length, 16);
});

function withSource(patch, index = 9) {
  const sources = CONFIG.sources.map((s) => ({ ...s }));
  Object.assign(sources[index], patch);
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete sources[index][k];
  return { ...CONFIG, sources };
}

const invalidCases = [
  ['blank name', { name: '  ' }, 'sources[9].name'],
  ['blank family', { family: '' }, 'sources[9].family'],
  ['non-HTTP homepage', { homepage: 'ftp://x' }, 'sources[9].homepage'],
  ['non-HTTP fallbackUrl', { fallbackUrl: 'javascript:1' }, 'sources[9].fallbackUrl'],
  ['non-HTTP rankUrl on hn', { rankUrl: 'nope' }, 'sources[6].rankUrl', 6],
  ['rankUrl on non-hn', { rankUrl: 'https://x.test/' }, 'sources[9].rankUrl'],
  ['zero maxItems', { maxItems: 0 }, 'sources[9].maxItems'],
  ['float maxBytes', { maxBytes: 1.5 }, 'sources[9].maxBytes'],
  ['unsafe maxBytes', { maxBytes: 2 ** 53 }, 'sources[9].maxBytes'],
  ['NaN maxAgeDays', { maxAgeDays: NaN }, 'sources[9].maxAgeDays'],
  ['zero maxAgeDays', { maxAgeDays: 0 }, 'sources[9].maxAgeDays'],
  ['string longForm', { longForm: 'yes' }, 'sources[9].longForm'],
  ['string template', { template: 'true' }, 'sources[9].template'],
  ['non-RegExp include', { include: 'x' }, 'sources[9].include'],
  ['global include', { include: /x/g }, 'sources[9].include'],
  ['sticky exclude', { exclude: /x/y }, 'sources[9].exclude'],
  ['bad weight', { weight: 11 }, 'sources[9].weight'],
  ['bad category', { category: 'misc' }, 'sources[9].category'],
  ['duplicate id', { id: 'openai' }, 'sources[9].id'],
  ['id with space', { id: 'a b' }, 'sources[9].id'],
  ['template placeholder without flag', { url: 'https://x.test/{{unix24hAgo}}' }, 'sources[9].url'],
  ['unknown placeholder', { url: 'https://x.test/{{nope}}', template: true }, 'sources[9].url'],
  ['arxiv without fallbackUrl', { fallbackUrl: undefined }, 'sources[0].fallbackUrl', 0],
  ['json without parser', { parser: undefined }, 'sources[4].parser', 4],
  ['json with unknown parser', { parser: 'x' }, 'sources[4].parser', 4],
  ['sitemap without include', { include: undefined }, 'sources[9].include'],
  ['github release without repo', { repo: undefined }, 'sources[42].repo', 42],
  ['github release malformed repo', { repo: 'nope' }, 'sources[42].repo', 42],
  ['github search without minStars', { minStars: undefined }, 'sources[50].minStars', 50],
  ['github other host', { url: 'https://gitlab.com/x/y/releases.atom' }, 'sources[42].url', 42],
];

for (const [name, patch, field, index] of invalidCases) {
  test(`invalid config: ${name} names ${field}`, () => {
    const cfg = withSource(patch, index ?? 9);
    assert.throws(() => validateConfig(cfg), (err) => err instanceof ConfigError && err.message.startsWith(field), `expected ${field}`);
  });
}

test('invalid linkouts and learn entries are rejected with exact paths', () => {
  const bad = (fn, field) => assert.throws(() => validateConfig(fn()), (err) => err instanceof ConfigError && err.message.startsWith(field));
  bad(() => ({ ...CONFIG, linkouts: { ...CONFIG.linkouts, leaderboards: [{ name: 'x', url: 'ftp://x', blurb: 'y' }] } }), 'linkouts.leaderboards[0].url');
  bad(() => ({ ...CONFIG, linkouts: { ...CONFIG.linkouts, more: [{ name: 'x', url: 'https://x.test/', blurb: 'y', tab: 'news' }] } }), 'linkouts.more[0].tab');
  bad(() => ({ ...CONFIG, linkouts: { leaderboards: [], more: null } }), 'linkouts.more');
  bad(() => ({ ...CONFIG, learn: [CONFIG.learn[0], { ...CONFIG.learn[1], id: CONFIG.learn[0].id }] }), 'learn[1].id');
  bad(() => ({ ...CONFIG, learn: [{ ...CONFIG.learn[0], kind: 'video' }] }), 'learn[0].kind');
  bad(() => ({ ...CONFIG, learn: [{ ...CONFIG.learn[0], title: ' ' }] }), 'learn[0].title');
  bad(() => ({ ...CONFIG, learn: [{ ...CONFIG.learn[0], url: 'mailto:x' }] }), 'learn[0].url');
  bad(() => ({ ...CONFIG, sources: [] }), 'sources');
});

test('a valid addition covered by a kind fixture passes without changing the baseline', () => {
  const cfg = { ...CONFIG, sources: [...CONFIG.sources, { id: 'extra-blog', name: 'Extra', category: 'blogs', type: 'rss', url: 'https://extra.test/feed', weight: 3 }] };
  assert.equal(validateConfig(cfg), true);
  assert.ok(fixtureFor(cfg.sources.at(-1)));
});

test('registry build and unknown-source fallback', () => {
  const registry = buildRegistry(CONFIG.sources);
  assert.equal(registry.get('openai').registryIndex, 8);
  assert.equal(registry.get('openai').family, 'openai');
  assert.equal(registry.get('meta-newsroom-ai').family, 'meta');
  assert.equal(registry.get('openai').parser, null);
  assert.deepEqual(sourceInfo(registry, 'gone'), { id: 'gone', name: 'gone', family: 'gone', weight: 1, longForm: false, registryIndex: Infinity, category: null, type: null, parser: null });
  assert.ok(codePointCompare('a', 'b') < 0);
  assert.ok(codePointCompare('Z', 'a') < 0);
  assert.equal(codePointCompare('x', 'x'), 0);
  assert.ok(codePointCompare('ab', 'a') > 0);
});
