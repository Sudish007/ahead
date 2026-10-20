import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CONFIG, NOW, ROOT, read, runFixture, quietLogger, expandUrl } from './helpers.js';
import { validateDigest, validateItemsFile, validateMeta, validateDigestIndex } from '../src/schema.js';
import { buildRegistry } from '../src/registry.js';
import { heuristicWhy } from '../src/brief.js';

const registry = buildRegistry(CONFIG.sources);
const urlOf = (id, now = NOW) => expandUrl(CONFIG.sources.find((s) => s.id === id).url, now);
const tmp = () => mkdtempSync(path.join(tmpdir(), 'ahead-test-'));
const readJson = (dir, rel) => JSON.parse(readFileSync(path.join(dir, rel), 'utf8'));
const FORCED = { [urlOf('reddit')]: { status: 403 }, [urlOf('mistral')]: { throw: new TypeError('fetch failed') } };

test('full fixture run: contract, files, counts, failures, digest, meta', async () => {
  const dataDir = tmp();
  const logger = quietLogger();
  const calls = [];
  const originalLog = console.log;
  const originalInfo = console.info;
  let logged = 0;
  console.log = () => { logged++; };
  console.info = () => { logged++; };
  let result;
  try {
    result = await runFixture({ dataDir, logger, overrides: FORCED, calls });
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
  }
  assert.equal(logged, 0, 'run() never writes to stdout');
  for (const f of readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(path.join(ROOT, 'src', f), 'utf8');
    const uses = (src.match(/console\.(log|info|warn|error|debug)/g) ?? []).length;
    assert.equal(uses, f === 'pipeline.js' ? 3 : 0, `${f} must not call console directly (defaultLogger excepted)`);
  }
  assert.equal(result.diagnostic, false);
  for (const k of ['items', 'digest', 'digestIndex', 'meta', 'sourceResults']) assert.ok(k in result, k);
  assert.deepEqual(result.sourceResults.map((r) => r.id), CONFIG.sources.map((s) => s.id), 'registry order');
  for (const rel of ['items.json', 'meta.json', 'digests/index.json', 'digests/2026-10-19.json']) assert.ok(existsSync(path.join(dataDir, rel)), rel);
  assert.ok(!readdirSync(dataDir).some((f) => f.endsWith('.tmp')));
  const { meta } = result;
  assert.equal(meta.failedCount, 2);
  assert.equal(meta.sources.reddit.status, 'failed');
  assert.equal(meta.sources.reddit.error, 'HTTP 403');
  assert.equal(meta.sources.reddit.httpStatus, 403);
  assert.equal(meta.sources.mistral.error, 'network');
  assert.equal(meta.okCount + meta.emptyCount, CONFIG.sources.length - 2);
  assert.ok(meta.okCount >= 40, `okCount ${meta.okCount}`);
  assert.equal(meta.sources['arxiv-cs.AI'].note, 'api fallback');
  assert.equal(meta.sources['arxiv-cs.AI'].fetched, 10);
  assert.equal(meta.sources['hn-top'].fetched, 42);
  assert.equal(meta.sources['hn-top'].kept, 9);
  assert.equal(meta.sources['hn-top'].skipped, 33);
  assert.deepEqual(meta.static, structuredClone({ ...CONFIG.linkouts, learn: CONFIG.learn }));
  assert.equal(meta.sources.anthropic.homepage, 'https://www.anthropic.com/news');
  assert.ok(!('homepage' in meta.sources.openai));
  assert.equal(meta.itemCount, result.items.length);
  assert.equal(meta.newItemCount, result.items.length);
  assert.equal(meta.trimmedForSize, 0);
  assert.deepEqual(meta.llm, { enabled: false, ok: false });
  assert.deepEqual(result.digest.llm, { enabled: false, ok: false });
  assert.deepEqual(Object.keys(meta.sources).sort(), CONFIG.sources.map((s) => s.id).sort());
  validateMeta(meta, registry.keys());
  validateDigest(result.digest);
  validateItemsFile(readJson(dataDir, 'items.json'), { now: NOW });
  validateDigestIndex(result.digestIndex, new Map([[result.digest.date, result.digest]]));
  assert.equal(new Set(result.items.map((i) => i.id)).size, result.items.length);
  assert.ok(result.items.length > 100);
  const front = result.items.filter((i) => i.sources.some((s) => s.id === 'hn-front'));
  assert.equal(front.length, 8);
  assert.ok(front.every((i) => i.extra.hnFrontCurrent === true && Number.isInteger(i.extra.hnRank) && i.extra.hnRank >= 1 && i.extra.hnRank <= 30));
  assert.ok(logger.sink.some(([lvl, m]) => lvl === 'warn' && /reddit/.test(m)));
  assert.ok(logger.sink.some(([lvl, m]) => lvl === 'warn' && /mistral/.test(m)));
  assert.ok(!calls.some((c) => /openai\.com\/v1|chat\/completions/.test(c.url)), 'no LLM call without a key');
  assert.ok(Object.keys(meta.sitemapCache.anthropic).length > 0);
  assert.ok(Object.keys(meta.sitemapCache.anthropic).length <= 30);
  assert.equal(readJson(dataDir, 'digests/index.json').days[0].entryCount, result.digest.itemIds.length);
  assert.equal(readJson(dataDir, 'meta.json').brief.wordCount, result.digest.wordCount);
});

test('reddit survivors carry redditTopCurrent; the why-line says top of r/<sub> today', async () => {
  const dataDir = tmp();
  const result = await runFixture({ dataDir });
  const reddit = result.items.filter((i) => i.sources.some((s) => s.id === 'reddit'));
  assert.equal(reddit.length, 12);
  assert.ok(reddit.every((i) => i.extra.redditTopCurrent === true && typeof i.extra.subreddit === 'string'));
  const self = reddit.find((i) => i.sources.length === 1 && Object.keys(i.signals).length === 0);
  assert.match(heuristicWhy(self, NOW, registry), /^top of r\/(LocalLLaMA|MachineLearning) today$/);
});

test('same-day second run strips ephemeral markers from retained items and never claims present tense', async () => {
  const dataDir = tmp();
  const run1 = await runFixture({ dataDir });
  const story = run1.items.find((i) => i.extra?.hnRank === 4);
  assert.ok(story);
  const later = new Date(NOW.getTime() + 6 * 3.6e6);
  const front = JSON.parse(read('hn-algolia-front.json'));
  front.hits = front.hits.filter((h) => h.objectID !== '50150434');
  const redditXml = read('reddit-multi-rss.xml');
  const firstEntry = redditXml.slice(redditXml.indexOf('<entry>'), redditXml.indexOf('</entry>') + 8);
  const run2 = await runFixture({ dataDir, now: later, overrides: {
    [urlOf('hn-front', later)]: { body: JSON.stringify(front), contentType: 'application/json' },
    [urlOf('reddit', later)]: { body: redditXml.replace(firstEntry, ''), contentType: 'application/atom+xml' },
  } });
  const retained = run2.items.find((i) => i.id === story.id);
  assert.ok(retained, 'story retained through the 7-day window');
  assert.ok(retained.sources.some((s) => s.id === 'hn-front'));
  assert.equal(retained.extra?.hnFrontCurrent, undefined);
  assert.equal(retained.extra?.hnRank, undefined);
  assert.notEqual(retained.score, story.score);
  const why = heuristicWhy(retained, later, registry);
  assert.ok(!/front page/.test(why), why);
  assert.ok(/points on HN/.test(why));
  const entry = run2.digest.sections.flatMap((s) => s.entries).find((e) => e.id === story.id);
  if (entry) assert.ok(!/front page/.test(entry.why));
  const stillCurrent = run2.items.filter((i) => i.extra?.hnFrontCurrent);
  assert.equal(stillCurrent.length, 7);
  // Reddit: the first post vanished from the current feed
  const vanished = run1.items.find((i) => i.sources.some((s) => s.id === 'reddit') && /Harness2/.test(i.title));
  const vanishedNow = run2.items.find((i) => i.id === vanished.id);
  assert.ok(vanishedNow);
  assert.equal(vanishedNow.extra.redditTopCurrent, undefined);
  assert.equal(vanishedNow.extra.subreddit, 'LocalLLaMA');
  assert.equal(heuristicWhy(vanishedNow, later, registry), 'from r/LocalLLaMA');
  assert.equal(run2.meta.sources.reddit.kept, 11);
  // Reddit request failure variant
  const run3 = await runFixture({ dataDir, now: later, overrides: { [urlOf('reddit', later)]: { status: 429 } } });
  const afterFailure = run3.items.find((i) => i.id === vanished.id);
  assert.equal(afterFailure.extra.redditTopCurrent, undefined);
  assert.equal(heuristicWhy(afterFailure, later, registry), 'from r/LocalLLaMA');
  assert.equal(run3.meta.sources.reddit.status, 'failed');
});

test('next-day run: newItemCount, sitemap cache reuse, immutable prior digest, no cross-day repeats, index equality', async () => {
  const dataDir = tmp();
  const calls1 = [];
  const run1 = await runFixture({ dataDir, calls: calls1 });
  const day1Bytes = readFileSync(path.join(dataDir, 'digests/2026-10-19.json'));
  const tomorrow = new Date(NOW.getTime() + 24 * 3.6e6);
  const calls2 = [];
  const run2 = await runFixture({ dataDir, now: tomorrow, calls: calls2 });
  const pages = (calls) => calls.filter((c) => (c.init?.headers?.accept ?? '').startsWith('text/html')).length;
  assert.ok(pages(calls1) >= 12, `run 1 fetched ${pages(calls1)} pages`);
  assert.ok(pages(calls2) < pages(calls1), `run 2 reused the cache (${pages(calls2)} < ${pages(calls1)})`);
  assert.deepEqual(readFileSync(path.join(dataDir, 'digests/2026-10-19.json')), day1Bytes, 'prior digest untouched');
  assert.equal(run2.digest.date, '2026-10-20');
  const day1 = new Set(run1.digest.itemIds);
  assert.ok(run2.digest.itemIds.every((id) => !day1.has(id)), 'no repeats across days');
  const ids1 = new Set(run1.items.map((i) => i.id));
  assert.equal(run2.meta.newItemCount, run2.items.filter((i) => !ids1.has(i.id)).length);
  assert.ok(run2.meta.newItemCount < run2.items.length);
  assert.deepEqual(run2.digestIndex.days.map((d) => d.date), ['2026-10-20', '2026-10-19']);
  assert.equal(run2.digestIndex.days[0].entryCount, run2.digest.itemIds.length);
  assert.equal(run2.digestIndex.days[1].entryCount, run1.digest.itemIds.length);
  assert.deepEqual(readJson(dataDir, 'digests/index.json'), run2.digestIndex);
  validateDigest(run2.digest);
  assert.ok(run2.items.every((i) => Date.parse(i.surfacedAt) >= tomorrow.getTime() - 7 * 86_400_000));
});

test('sitemap invalidation: sitemap-only item disappears; sitemap+HN item keeps HN with corrected metadata', async () => {
  const dataDir = tmp();
  const loc = 'https://www.deeplearning.ai/the-batch/metas-muse-wonder-rivals-top-models';
  const run1 = await runFixture({ dataDir, overrides: { [loc]: { throw: new TypeError('page down') } } });
  const slug = run1.items.find((i) => i.url === loc);
  assert.equal(slug.extra.titleFrom, 'slug');
  assert.equal(slug.title, 'Metas muse wonder rivals top models');
  const oldPage = '<meta property="og:title" content="Old piece"><meta property="article:published_time" content="2026-09-20T10:00:00Z">';
  const later = new Date(NOW.getTime() + 3.6e6);
  const run2 = await runFixture({ dataDir, now: later, overrides: { [loc]: { body: oldPage, contentType: 'text/html' } } });
  assert.ok(!run2.items.some((i) => i.id === slug.id), 'sitemap-only item dropped');
  assert.equal(run2.meta.sitemapSkipped.thebatch[slug.canonicalUrl], '2026-10-14T19:17:00.000Z');
  // variant: the prior item also carries historical HN attribution
  const run3 = await runFixture({ dataDir: tmp(), overrides: { [loc]: { throw: new TypeError('page down') } } });
  const dir3 = tmp();
  const run3b = await runFixture({ dataDir: dir3, overrides: { [loc]: { throw: new TypeError('page down') } } });
  void run3;
  const file = readJson(dir3, 'items.json');
  const stored = file.items.find((i) => i.url === loc);
  stored.sources.push({ id: 'hn-top', url: 'https://news.ycombinator.com/item?id=424242', at: '2026-10-18T00:00:00.000Z' });
  stored.sources.sort((a, b) => (a.id === 'hn-top' ? -1 : 1));
  stored.surfacedAt = stored.sources.map((s) => s.at).sort().at(-1);
  stored.signals = { hnPoints: 77 };
  writeFileSync(path.join(dir3, 'items.json'), JSON.stringify(file));
  const run4 = await runFixture({ dataDir: dir3, now: later, overrides: { [loc]: { body: oldPage, contentType: 'text/html' } } });
  const kept = run4.items.find((i) => i.id === stored.id);
  assert.ok(kept, 'survives through HN');
  assert.deepEqual(kept.sources.map((s) => s.id), ['hn-top']);
  assert.equal(kept.extra?.titleFrom, undefined);
  assert.equal(kept.publishedAt, '2026-09-20T10:00:00.000Z');
  assert.equal(kept.category, 'news');
  assert.equal(kept.surfacedAt, '2026-10-18T00:00:00.000Z');
  assert.ok(kept.score > 0);
  void run3b;
});

test('diagnostic mode returns selected sources only and never builds a brief or writes', async () => {
  const dataDir = tmp();
  const calls = [];
  const r = await runFixture({ dataDir, onlySourceIds: ['hf-papers', 'hn-top'], dryRun: true, calls, env: { LLM_API_KEY: 'k', LLM_MODEL: 'm' } });
  assert.equal(r.diagnostic, true);
  assert.deepEqual(r.sourceResults.map((s) => s.id), ['hf-papers', 'hn-top'], 'registry order, not request order');
  assert.ok(!('digest' in r));
  assert.ok(r.items.length > 0);
  assert.ok(r.items.every((i) => i.sources.every((s) => ['hn-top', 'hf-papers'].includes(s.id))));
  assert.ok(!existsSync(path.join(dataDir, 'items.json')));
  assert.ok(!calls.some((c) => /chat\/completions/.test(c.url)));
  await assert.rejects(runFixture({ dataDir, onlySourceIds: ['hn-top'], dryRun: false }), /dryRun/);
  await assert.rejects(runFixture({ dataDir, onlySourceIds: ['nope'], dryRun: true }), /unknown source/);
  await assert.rejects(runFixture({ dataDir, onlySourceIds: [], dryRun: true }), /non-empty/);
});

const CLOUDFLARE_403 = {
  [urlOf('importai')]: { status: 403, body: '<html><body>Just a moment...</body></html>', contentType: 'text/html', headers: { server: 'cloudflare', 'cf-ray': 'abc-BOM' } },
};

test('a blocked source gets a short specific error and records the response evidence as detail', async () => {
  const logger = quietLogger();
  const r = await runFixture({ dataDir: tmp(), logger, onlySourceIds: ['importai'], dryRun: true, overrides: CLOUDFLARE_403 });
  assert.equal(r.sourceResults.length, 1);
  const [importai] = r.sourceResults;
  assert.equal(importai.status, 'failed');
  assert.equal(importai.error, 'blocked: 403 Cloudflare');
  assert.equal(importai.httpStatus, 403);
  assert.match(importai.detail, /server=cloudflare/);
  assert.equal(importai.detail, 'server=cloudflare; cf-ray=abc-BOM; content-type=text/html; body="Just a moment..."');
  assert.ok(logger.sink.some(([lvl, m]) => lvl === 'warn' && m === `importai: blocked: 403 Cloudflare [${importai.detail}]`), 'warn line carries the detail');
});

test('on the Actions runner (GITHUB_ACTIONS=true) a Cloudflare 403 reads "blocked from GitHub runner"', async () => {
  const r = await runFixture({ dataDir: tmp(), onlySourceIds: ['importai'], dryRun: true, env: { GITHUB_ACTIONS: 'true' }, overrides: CLOUDFLARE_403 });
  const [importai] = r.sourceResults;
  assert.equal(importai.status, 'failed');
  assert.equal(importai.error, 'blocked from GitHub runner: 403 Cloudflare');
  assert.ok(importai.error.length <= 120);
});

test('validateMeta rejects a detail over 400 chars or spanning lines', async () => {
  const r = await runFixture({ dataDir: tmp(), dryRun: true });
  const meta = structuredClone(r.meta);
  const first = Object.values(meta.sources)[0];
  first.detail = 'x'.repeat(401);
  assert.throws(() => validateMeta(meta, registry.keys()), (e) => e.name === 'SchemaError' && /\.detail/.test(e.message));
  first.detail = 'x'.repeat(400);
  validateMeta(meta, registry.keys());
  first.detail = 'a\nb';
  assert.throws(() => validateMeta(meta, registry.keys()), /\.detail/);
  first.detail = '';
  assert.throws(() => validateMeta(meta, registry.keys()), /\.detail/);
});

test('full-registry dry run validates everything and writes nothing', async () => {
  const dataDir = tmp();
  const r = await runFixture({ dataDir, dryRun: true });
  assert.equal(r.diagnostic, false);
  assert.ok(!existsSync(path.join(dataDir, 'items.json')));
  validateDigest(r.digest);
});

test('corrupt previous state is tolerated with warnings', async () => {
  const dataDir = tmp();
  writeFileSync(path.join(dataDir, 'items.json'), '{ not json');
  writeFileSync(path.join(dataDir, 'meta.json'), JSON.stringify({ sitemapSkipped: { anthropic: 'nope' }, sitemapCache: [] }));
  const logger = quietLogger();
  const r = await runFixture({ dataDir, logger });
  assert.equal(r.diagnostic, false);
  assert.ok(logger.sink.some(([, m]) => /items\.json/.test(m)));
  assert.ok(logger.sink.some(([, m]) => /sitemap/.test(m)));
});
