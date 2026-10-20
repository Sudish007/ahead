import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW } from './helpers.js';
import { resolveLlmConfig, editorialize, numberTokens, SYSTEM_PROMPT } from '../src/llm.js';
import { buildBrief, finalizeDigest, countWords } from '../src/brief.js';
import { buildRegistry } from '../src/registry.js';
import { validateDigest, validateDigestIndex } from '../src/schema.js';

const registry = buildRegistry([
  { id: 'hn-top', name: 'Hacker News', category: 'news', type: 'hn', url: 'https://hn.test/', weight: 5, family: 'hn' },
  { id: 'hf-papers', name: 'HF Daily Papers', category: 'research', type: 'json', parser: 'hf-papers', url: 'https://hf.test/', weight: 8 },
  { id: 'blog', name: 'Deep Blog', category: 'blogs', type: 'rss', url: 'https://b.test/', weight: 6, longForm: true },
]);
const T = (h) => new Date(NOW.getTime() - h * 3.6e6).toISOString();
function items() {
  const out = [];
  let n = 0;
  const mk = (category, sources, signals, extra = {}) => {
    n++;
    out.push({ id: `item${n}`, title: `Title ${n} about things`, url: `https://example.com/${n}`, canonicalUrl: `https://example.com/${n}`, sources, category, publishedAt: T(2), surfacedAt: T(2), summary: 'Summary sentence one. Summary sentence two.', score: 100 - n, signals, ...extra });
  };
  for (let i = 0; i < 6; i++) mk('news', [{ id: 'hn-top', at: T(2) }], { hnPoints: 1200, hnComments: 40 });
  for (let i = 0; i < 3; i++) mk('research', [{ id: 'hf-papers', at: T(2) }], { hfUpvotes: 33 });
  for (let i = 0; i < 3; i++) mk('blogs', [{ id: 'blog', at: T(2) }], {}, { readMinutes: 12 });
  return out;
}
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const words = (n, prefix = 'w') => Array.from({ length: n }, (_, i) => `${prefix}${LETTERS[i % 26]}${LETTERS[Math.floor(i / 26) % 26]}`).join(' ');
const brief = (target = 880) => buildBrief(items(), [], NOW, { targetWords: target, registry });
const CONFIG = { eligible: true, endpoint: 'https://api.openai.com/v1/chat/completions', model: 'test-model', key: 'sk-SECRET' };
const reply = (obj, status = 200) => new Response(JSON.stringify({ choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] }), { status, headers: { 'content-type': 'application/json' } });
function mockFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r;
  };
  return { fetchImpl, calls };
}

test('resolveLlmConfig states', () => {
  assert.deepEqual(resolveLlmConfig({}, {}), { eligible: false, meta: { enabled: false, ok: false } });
  assert.deepEqual(resolveLlmConfig({ LLM_API_KEY: 'k', LLM_MODEL: 'm' }, { noLlm: true }), { eligible: false, meta: { enabled: false, ok: false } });
  assert.deepEqual(resolveLlmConfig({ LLM_API_KEY: 'k' }, {}), { eligible: false, meta: { enabled: false, ok: false, error: 'LLM_MODEL unset' } });
  assert.deepEqual(resolveLlmConfig({ LLM_API_KEY: 'k', LLM_MODEL: '  ' }, {}).meta, { enabled: false, ok: false, error: 'LLM_MODEL unset' });
  const ok = resolveLlmConfig({ LLM_API_KEY: ' k ', LLM_MODEL: 'm' }, {});
  assert.equal(ok.eligible, true);
  assert.equal(ok.endpoint, 'https://api.openai.com/v1/chat/completions');
  assert.equal(ok.key, 'k');
  assert.deepEqual(ok.meta, { enabled: true, ok: false, model: 'm' });
  assert.equal(resolveLlmConfig({ LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_BASE_URL: 'https://example.com/v1/' }, {}).endpoint, 'https://example.com/v1/chat/completions');
  assert.equal(resolveLlmConfig({ LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_BASE_URL: 'https://example.com/' }, {}).endpoint, 'https://example.com/chat/completions');
  assert.equal(resolveLlmConfig({ LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_BASE_URL: 'http://localhost:11434/v1' }, {}).endpoint, 'http://localhost:11434/v1/chat/completions');
  for (const bad of ['ftp://x', 'http://example.com/v1', 'https://u:p@example.com/v1', 'https://example.com/v1?tenant=x', 'https://example.com/v1#frag', 'not a url']) {
    const r = resolveLlmConfig({ LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_BASE_URL: bad }, {});
    assert.equal(r.eligible, false, bad);
    assert.deepEqual(r.meta, { enabled: false, ok: false, model: 'm', error: 'invalid LLM_BASE_URL' });
  }
});

test('numberTokens extraction and normalization', () => {
  assert.deepEqual(numberTokens('#4 on HN, 1,200 points, +3.5% up, 2k stars, 10x'), ['4', '1200', '3.5%', '2k', '10x']);
  assert.deepEqual(numberTokens('no numbers'), []);
});

test('valid JSON applies overview and why lines within budget; embedded JSON is extracted', async () => {
  const b = brief();
  const ids = b.digest.itemIds;
  const overview = words(170);
  const { fetchImpl, calls } = mockFetch([reply(`Here you go:\n${JSON.stringify({ overview, why: { [ids[0]]: 'Matters because 1,200 points shows demand.', [ids[1]]: 'Signals broad interest.' } })}\nthanks`)]);
  const result = await editorialize(b, CONFIG, fetchImpl);
  assert.deepEqual(result, { enabled: true, ok: true, model: 'test-model' });
  assert.equal(b.digest.overview.text, overview);
  assert.equal(b.digest.overview.source, 'llm');
  const e0 = b.digest.sections.flatMap((s) => s.entries).find((e) => e.id === ids[0]);
  assert.equal(e0.why, 'Matters because 1,200 points shows demand.');
  assert.equal(e0.whySource, 'llm');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CONFIG.endpoint);
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-SECRET');
  assert.equal(calls[0].body.max_tokens, 1500);
  assert.equal(calls[0].body.model, 'test-model');
  assert.equal(calls[0].body.temperature, 0.3);
  assert.ok(!('response_format' in calls[0].body));
  assert.ok(!calls[0].init.body.includes('SECRET'));
  assert.equal(calls[0].body.messages[0].content, SYSTEM_PROMPT);
  const sent = JSON.parse(calls[0].body.messages[1].content);
  assert.ok(sent.length <= 15);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['id', 'section', 'signals', 'sourceNames', 'summary', 'title']);
  assert.equal(sent[0].signals.hnPoints, 1200, 'D1: signals come from facts');
  finalizeDigest(b.digest);
  assert.ok(b.digest.wordCount <= 1100);
  validateDigest(b.digest);
});

test('overview boundaries: only 150 and 200 words accepted; invented numbers reject only the overview', async () => {
  for (const [n, accepted] of [[149, false], [150, true], [200, true], [201, false]]) {
    const b = brief();
    const { fetchImpl } = mockFetch([reply({ overview: words(n), why: { [b.digest.itemIds[0]]: 'Fine line.' } })]);
    const r = await editorialize(b, CONFIG, fetchImpl);
    assert.equal(r.ok, true);
    assert.equal(b.digest.overview !== null, accepted, `${n} words`);
  }
  const b = brief();
  const { fetchImpl } = mockFetch([reply({ overview: `${words(160)} up 90%`, why: { [b.digest.itemIds[0]]: 'Still fine.' } })]);
  const r = await editorialize(b, CONFIG, fetchImpl);
  assert.deepEqual(r, { enabled: true, ok: true, model: 'test-model' });
  assert.equal(b.digest.overview, null);
  const b2 = brief();
  const { fetchImpl: f2 } = mockFetch([reply({ overview: `${words(160)} we saw 1,200 points and 33 upvotes`, why: {} })]);
  const r2 = await editorialize(b2, CONFIG, f2);
  assert.equal(r2.ok, true);
  assert.ok(b2.digest.overview.text.includes('1,200'), 'overview may reuse any entry number');
});

test('why rejections: invented number, cross-entry number, 26 words, unknown id; accepted comma normalization', async () => {
  const b = brief();
  const ids = b.digest.itemIds;
  const newsId = ids[0];
  const paperId = b.digest.sections.find((s) => s.key === 'research').entries[0].id;
  const before = Object.fromEntries(b.digest.sections.flatMap((s) => s.entries).map((e) => [e.id, e.why]));
  const { fetchImpl } = mockFetch([reply({ why: {
    [newsId]: 'Up 90% this week.',
    [paperId]: 'Got 1,200 points on HN.',
    [ids[2]]: words(26),
    [ids[3]]: 'A 1,200 point thread with 40 comments.',
    nope: 'Unknown id.',
  } })]);
  const r = await editorialize(b, CONFIG, fetchImpl);
  assert.equal(r.ok, true);
  const after = Object.fromEntries(b.digest.sections.flatMap((s) => s.entries).map((e) => [e.id, e]));
  assert.equal(after[newsId].why, before[newsId]); assert.equal(after[newsId].whySource, 'heuristic');
  assert.equal(after[paperId].why, before[paperId]);
  assert.equal(after[ids[2]].why, before[ids[2]]);
  assert.equal(after[ids[3]].why, 'A 1,200 point thread with 40 comments.');
  assert.equal(after[ids[3]].whySource, 'llm');
});

test('failure states: garbage, 500, timeout, nothing accepted -> enabled true ok false with error', async () => {
  const cases = [
    [[reply('not json at all')], 'invalid JSON'],
    [[new Response('err', { status: 500 })], 'HTTP 500'],
    [[new Response('nope', { status: 401 })], 'HTTP 401'],
    [[Object.assign(new Error('aborted'), { name: 'AbortError' })], 'timeout'],
    [[new TypeError('fetch failed')], 'network'],
    [[reply({ overview: 'short', why: { zzz: 'x' } })], 'empty'],
    [[new Response(JSON.stringify({ choices: [] }), { status: 200 })], 'empty'],
  ];
  for (const [responses, error] of cases) {
    const b = brief();
    const snapshot = JSON.stringify(b.digest);
    const { fetchImpl } = mockFetch(responses);
    const r = await editorialize(b, CONFIG, fetchImpl);
    assert.deepEqual(r, { enabled: true, ok: false, model: 'test-model', error }, error);
    assert.equal(JSON.stringify(b.digest), snapshot, 'heuristic brief untouched');
  }
});

test('400 mentioning max_tokens retries once with max_completion_tokens; other 400 does not', async () => {
  const b = brief();
  const { fetchImpl, calls } = mockFetch([new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens'" } }), { status: 400 }), reply({ why: { [b.digest.itemIds[0]]: 'ok' } })]);
  const r = await editorialize(b, CONFIG, fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.max_tokens, 1500);
  assert.ok(!('max_tokens' in calls[1].body));
  assert.equal(calls[1].body.max_completion_tokens, 1500);
  const b2 = brief();
  const { fetchImpl: f2, calls: c2 } = mockFetch([new Response(JSON.stringify({ error: 'bad model' }), { status: 400 })]);
  const r2 = await editorialize(b2, CONFIG, f2);
  assert.deepEqual(r2, { enabled: true, ok: false, model: 'test-model', error: 'HTTP 400' });
  assert.equal(c2.length, 1);
});

test('post-LLM budget may drop entries; finalized ids/counts match survivors', async () => {
  const b = brief();
  const ids = b.digest.itemIds;
  const why = Object.fromEntries(ids.map((id) => [id, words(25, 'q')]));
  const { fetchImpl } = mockFetch([reply({ overview: words(200), why })]);
  const r = await editorialize(b, CONFIG, fetchImpl);
  assert.equal(r.ok, true);
  finalizeDigest(b.digest);
  assert.ok(b.digest.wordCount <= 1100);
  assert.deepEqual(b.digest.itemIds, b.digest.sections.flatMap((s) => s.entries.map((e) => e.id)));
  assert.equal(b.digest.deepReadId, b.digest.sections[5].entries[0]?.id ?? null);
  assert.equal(countWords(b.digest.overview.text), 200);
  b.digest.llm = { enabled: true, ok: true };
  validateDigest(b.digest);
  const index = { days: [{ date: b.digest.date, generatedAt: b.digest.generatedAt, wordCount: b.digest.wordCount, readingMinutes: b.digest.readingMinutes, entryCount: b.digest.itemIds.length }] };
  validateDigestIndex(index, new Map([[b.digest.date, b.digest]]));
});
