import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW, read } from './helpers.js';
import { parseHn, parseHfPapers, parseHfModels, parseGithubSearch, isAiStory, isHfModelId } from '../src/parsers/json.js';
import { ParseError } from '../src/http.js';

const rank = read('hn-topstories.json');
const mkCtx = (rankBody = rank, calls = []) => ({
  now: NOW,
  logger: { warn: (m) => calls.push(m) },
  fetchText: async (url) => { calls.push(url); if (rankBody instanceof Error) throw rankBody; return { status: 200, text: rankBody, finalUrl: url }; },
  calls,
});
const HN_TOP = { id: 'hn-top', category: 'news', type: 'hn', url: 'https://hn.algolia.com/api/v1/search_by_date?x', maxItems: 40 };
const HN_FRONT = { id: 'hn-front', category: 'news', type: 'hn', url: 'https://hn.algolia.com/api/v1/search?tags=front_page', rankUrl: 'https://hacker-news.firebaseio.com/v0/topstories.json', maxItems: 30 };
const idOf = (i) => i.discussionUrl.split('=')[1];

test('HN bydate keyword filter keeps exactly 9 of 42 and excludes the Flock/ICE story', async () => {
  const r = await parseHn(read('hn-algolia-bydate.json'), HN_TOP, mkCtx());
  assert.equal(r.fetched, 42);
  assert.equal(r.kept, 9);
  assert.deepEqual(r.items.map(idOf), ['50150434', '50148855', '50148452', '50145715', '50145507', '50145337', '50143755', '50141657', '50141429']);
  assert.ok(!r.items.map(idOf).includes('50150750'));
  assert.ok(r.items.every((i) => i.extra === undefined || i.extra.hnFrontCurrent === undefined));
  assert.ok(r.items.every((i) => Number.isInteger(i.signals.hnPoints) && Number.isInteger(i.signals.hnComments)));
});

test('HN front page keeps 8 of 30; maxItems 3 keeps native order; ranks from topstories', async () => {
  const ctx = mkCtx();
  const r = await parseHn(read('hn-algolia-front.json'), HN_FRONT, ctx);
  assert.equal(r.fetched, 30);
  assert.equal(r.kept, 8);
  assert.deepEqual(r.items.map(idOf), ['50145337', '50135762', '50145507', '50150434', '50145715', '50148855', '50151390', '50151928']);
  assert.ok(r.items.every((i) => i.extra.hnFrontCurrent === true));
  assert.ok(r.items.every((i) => Number.isInteger(i.extra.hnRank) && i.extra.hnRank >= 1 && i.extra.hnRank <= 30));
  assert.equal(r.items.find((i) => idOf(i) === '50145337').extra.hnRank, 10);
  assert.equal(r.items.find((i) => idOf(i) === '50150434').extra.hnRank, 4);
  assert.equal(ctx.calls.filter((c) => c === HN_FRONT.rankUrl).length, 1);
  const capped = await parseHn(read('hn-algolia-front.json'), { ...HN_FRONT, maxItems: 3 }, mkCtx());
  assert.deepEqual(capped.items.map(idOf), ['50145337', '50135762', '50145507']);
  assert.equal(capped.kept, 3);
});

test('failed rank fetch leaves no rank, keeps ok and the marker, notes rank unavailable', async () => {
  const r = await parseHn(read('hn-algolia-front.json'), HN_FRONT, mkCtx(new TypeError('fetch failed')));
  assert.equal(r.status, 'ok');
  assert.equal(r.note, 'rank unavailable');
  assert.ok(r.items.every((i) => i.extra.hnRank === undefined && i.extra.hnFrontCurrent === true));
  const bad = await parseHn(read('hn-algolia-front.json'), HN_FRONT, mkCtx('{"not":"an array"}'));
  assert.equal(bad.note, 'rank unavailable');
});

test('isAiStory host and title rules', () => {
  assert.equal(isAiStory('Anything', 'https://www.anthropic.com/news/x'), true);
  assert.equal(isAiStory('Anything', 'https://blog.openai.com/x'), true);
  assert.equal(isAiStory('ICE agent detained at protest', 'https://example.com'), false);
  assert.equal(isAiStory('A new model of governance', 'https://example.com'), false);
  assert.equal(isAiStory('Show HN: AI tool for notes', 'https://example.com'), true);
  assert.equal(isAiStory('Fine-tuning Llama on a laptop', 'https://example.com'), true);
  assert.equal(isAiStory('Rain in Spain', 'https://example.com'), false);
  assert.equal(isAiStory('said the dog', 'https://example.com'), false);
});

test('HN malformed hits are dropped individually and never produce undefined labels', async () => {
  const doc = JSON.parse(read('hn-algolia-bydate.json'));
  doc.hits.push({ title: 'LLM story without id', url: 'https://x.test/a' });
  doc.hits.push({ objectID: '12.5', title: 'LLM story bad id', url: 'https://x.test/b' });
  doc.hits.push({ objectID: '999', title: 'LLM story bad url', url: 'javascript:alert(1)' });
  doc.hits.push({ objectID: '1000', title: 'LLM story no url', created_at: '2026-10-19T10:00:00Z', points: 'many', num_comments: -3 });
  const r = await parseHn(JSON.stringify(doc), HN_TOP, mkCtx());
  assert.equal(r.fetched, 46);
  assert.equal(r.kept, 10);
  assert.equal(r.fetched - r.kept, 36);
  const last = r.items.at(-1);
  assert.equal(last.url, 'https://news.ycombinator.com/item?id=1000');
  assert.deepEqual(last.signals, undefined);
  assert.ok(!JSON.stringify(r.items).includes('undefined'));
  await assert.rejects(parseHn('{"hits": 1}', HN_TOP, mkCtx()), ParseError);
  await assert.rejects(parseHn('not json', HN_TOP, mkCtx()), ParseError);
});

test('HF Papers: id, upvotes, surfaced date, D3 mapping and cap', () => {
  const src = { id: 'hf-papers', category: 'research', type: 'json', parser: 'hf-papers', maxItems: 60 };
  const r = parseHfPapers(read('hf-daily-papers.json'), src, mkCtx());
  assert.equal(r.fetched, 12);
  assert.equal(r.kept, 12);
  assert.equal(r.items[0].arxivId, '2610.22306');
  assert.equal(r.items[0].url, 'https://huggingface.co/papers/2610.22306');
  assert.equal(r.items[0].surfacedAt.toISOString(), '2026-10-19T00:00:00.000Z');
  assert.equal(r.items[0].publishedAt.toISOString(), '2026-10-15T00:00:00.000Z');
  assert.deepEqual(r.items[4].signals, { hfUpvotes: 88 });
  assert.equal(r.items.filter((i) => i.extra && 'githubStars' in i.extra).length, 7);
  assert.equal(r.items.filter((i) => i.extra && 'githubRepo' in i.extra).length, 7);
  assert.deepEqual(r.items[2].extra, { githubStars: 10, githubRepo: 'https://github.com/SeerRay-Lab/Xiaomi-Lens-0' });
  assert.equal(r.items[1].extra, undefined);
  for (const i of r.items) {
    assert.ok(Object.keys(i.extra ?? {}).every((k) => ['githubStars', 'githubRepo'].includes(k)));
    assert.ok(Object.keys(i.signals ?? {}).every((k) => k === 'hfUpvotes'));
  }
  assert.ok(r.items[0].authors.length >= 1);
  const capped = parseHfPapers(read('hf-daily-papers.json'), { ...src, maxItems: 4 }, mkCtx());
  assert.deepEqual(capped.items.map((i) => i.arxivId), ['2610.22306', '2610.21482', '2610.23279', '2610.23751']);
});

test('HF Papers malformed records drop individually', () => {
  const doc = JSON.parse(read('hf-daily-papers.json'));
  doc.push({ paper: { title: 'no id' } });
  doc.push({ paper: { id: '2610.99999' } });
  doc.push({ nope: true });
  doc.push({ paper: { id: '2610.99998', title: 'ok', upvotes: 'NaN', githubStars: -4, githubRepo: '' } });
  const r = parseHfPapers(JSON.stringify(doc), { id: 'hf-papers', category: 'research', type: 'json', parser: 'hf-papers', maxItems: 60 }, mkCtx());
  assert.equal(r.fetched, 16);
  assert.equal(r.kept, 13);
  const last = r.items.at(-1);
  assert.equal(last.signals, undefined);
  assert.equal(last.extra, undefined);
  assert.throws(() => parseHfPapers('{"x":1}', { parser: 'hf-papers' }, mkCtx()), ParseError);
});

test('HF Models: likes, first-seen, trending cap, D3 summary format', () => {
  const src = { id: 'hf-trending', category: 'releases', type: 'json', parser: 'hf-models', maxItems: 20 };
  const r = parseHfModels(read('hf-trending-models.json'), src, mkCtx());
  assert.equal(r.fetched, 20);
  assert.equal(r.kept, 20);
  assert.equal(r.items[0].title, 'deepseek-ai/DeepSeek-V4.1-Flash-1017');
  assert.equal(r.items[0].summaryText, 'image-text-to-text · transformers · 1,548 likes · 17,924 downloads');
  assert.deepEqual(r.items[0].signals, { hfLikes: 1548 });
  assert.deepEqual(r.items[0].extra, { downloads: 17924, trendingScore: 1422, pipelineTag: 'image-text-to-text', libraryName: 'transformers' });
  assert.equal(r.items[0].surfacedAt, NOW);
  assert.equal(r.items[0].publishedAt.toISOString(), '2026-10-17T02:40:38.000Z');
  const drama = r.items.find((i) => i.title === 'fishaudio/drama-3');
  assert.equal(drama.summaryText, 'text-to-speech · 731 likes · 11,795 downloads');
  assert.ok(!('libraryName' in drama.extra));
  assert.ok(!JSON.stringify(r.items).includes('undefined'));
  assert.equal(parseHfModels(read('hf-trending-models.json'), { ...src, maxItems: 3 }, mkCtx()).items.length, 3);
});

test('isHfModelId (D2) table', () => {
  assert.equal(isHfModelId('owner/model.name'), true);
  assert.equal(isHfModelId('deepseek-ai/DeepSeek-V4.1-Flash-1017'), true);
  assert.equal(isHfModelId('gpt2'), false);
  assert.equal(isHfModelId('owner/..'), false);
  assert.equal(isHfModelId('model..name/x'), false);
  assert.equal(isHfModelId('owner/name.'), false);
  assert.equal(isHfModelId('a/b/c'), false);
  assert.equal(isHfModelId('-x/y'), false);
  assert.equal(isHfModelId(`${'a'.repeat(100)}/${'b'.repeat(100)}`), false);
  assert.equal(isHfModelId(42), false);
});

test('HF Models malformed records drop; invalid optional fields are omitted', () => {
  const doc = JSON.parse(read('hf-trending-models.json'));
  doc.push({ id: 'owner/..', likes: 5 });
  doc.push({ id: 'a/b/c' });
  doc.push({ modelId: 'ok/model', likes: 'lots', downloads: null, trendingScore: -1, library_name: '', pipeline_tag: 'x' });
  const r = parseHfModels(JSON.stringify(doc), { id: 'hf-trending', category: 'releases', type: 'json', parser: 'hf-models', maxItems: 40 }, mkCtx());
  assert.equal(r.fetched, 23);
  assert.equal(r.kept, 21);
  const last = r.items.at(-1);
  assert.equal(last.summaryText, 'x');
  assert.equal(last.signals, undefined);
  assert.deepEqual(last.extra, { pipelineTag: 'x' });
  assert.ok(!/undefined likes/.test(JSON.stringify(r.items)));
});

test('GitHub search: star floors 50 -> 8, 100 -> 5, ML fixture -> empty; malformed records dropped', () => {
  const src = (minStars) => ({ id: 'gh-trending-llm', category: 'releases', type: 'github', url: 'https://api.github.com/search/repositories?q=x', minStars, maxItems: 15 });
  const a = parseGithubSearch(read('gh-search-llm.json'), src(50), mkCtx());
  assert.equal(a.fetched, 8); assert.equal(a.kept, 8);
  assert.equal(a.items[0].title, 'outcrawlai/scout');
  assert.deepEqual(a.items[0].signals, { ghStars: 947 });
  assert.equal(a.items[0].surfacedAt, NOW);
  assert.equal(a.items[0].extra.topics.length, 6);
  assert.ok(a.items[0].summaryText.endsWith('· TypeScript'));
  assert.equal(parseGithubSearch(read('gh-search-llm.json'), src(100), mkCtx()).kept, 5);
  const ml = parseGithubSearch(read('gh-search-ml.json'), { ...src(50), id: 'gh-trending-ml' }, mkCtx());
  assert.equal(ml.status, 'empty'); assert.equal(ml.fetched, 5); assert.equal(ml.kept, 0);
  const doc = JSON.parse(read('gh-search-llm.json'));
  doc.items.push({ html_url: 'https://github.com/x/y', stargazers_count: 500 });
  doc.items.push({ full_name: 'x/y', html_url: 'ftp://github.com/x/y', stargazers_count: 500 });
  doc.items.push({ full_name: 'x/z', html_url: 'https://github.com/x/z', stargazers_count: 'many' });
  doc.items.push({ full_name: 'x/w', html_url: 'https://github.com/x/w', stargazers_count: -5 });
  const bad = parseGithubSearch(JSON.stringify(doc), src(50), mkCtx());
  assert.equal(bad.fetched, 12); assert.equal(bad.kept, 8);
  assert.ok(!JSON.stringify(bad.items).includes('undefined'));
  assert.throws(() => parseGithubSearch('[]', src(50), mkCtx()), ParseError);
});
