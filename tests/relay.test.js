import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CONFIG, NOW, read, runFixture, quietLogger, expandUrl } from './helpers.js';
import { RELAY_TIMEOUT_MS, createRelayFetch, relayFeedUrl, relayNote, relayPageUrl, resolveRelay, staleMarker } from '../src/relay.js';
import { HttpError } from '../src/http.js';
import { validateMeta } from '../src/schema.js';
import { buildRegistry } from '../src/registry.js';

const RELAY = 'https://r.test';
const TOKEN = 'RELAYSECRET';
const ENV = { RELAY_URL: RELAY, RELAY_TOKEN: TOKEN };
const urlOf = (id) => expandUrl(CONFIG.sources.find((s) => s.id === id).url, NOW);
const FEED = urlOf('importai');
const RFEED = `${RELAY}/feed/importai`;
const BODY = read('substack-interconnects.xml');
const SUBSTACK = { body: BODY, contentType: 'application/xml' };
const SITEMAP = { body: read('deeplearning-sitemap.xml'), contentType: 'application/xml' };
const CLOUDFLARE_403 = { status: 403, body: '<html><body>Just a moment...</body></html>', contentType: 'text/html', headers: { server: 'cloudflare', 'cf-ray': 'abc-BOM' } };
const RELAY_IDS = ['importai', 'zvi', 'thebatch', 'epoch-gradient-updates', 'chinai', 'pod-dwarkesh'];
const tmp = () => mkdtempSync(path.join(tmpdir(), 'ahead-relay-'));
const stripMs = ({ ms, ...rest }) => { assert.ok(Number.isInteger(ms) && ms >= 0); return rest; };
const relayHeader = (calls, url) => calls.find((c) => c.url === url)?.init.headers['x-relay-token'];
const count = (calls, url) => calls.filter((c) => c.url === url).length;
const noToken = (r, logger, label) => {
  assert.ok(!JSON.stringify(r).includes(TOKEN), `${label}: token never in the result`);
  if (logger) assert.ok(!logger.sink.some(([, m]) => m.includes(TOKEN)), `${label}: token never logged`);
};

test('resolveRelay: both variables trimmed and non-blank -> { url without trailing slashes, token }', () => {
  const logger = quietLogger();
  assert.deepEqual(resolveRelay({ RELAY_URL: 'https://r.test/', RELAY_TOKEN: ' tok ' }, logger), { url: 'https://r.test', token: 'tok' });
  assert.deepEqual(resolveRelay({ RELAY_URL: 'https://r.test/sub//', RELAY_TOKEN: 'tok' }, logger), { url: 'https://r.test/sub', token: 'tok' });
  assert.deepEqual(resolveRelay({ RELAY_URL: ' https://ahead-relay.rishtapatra.workers.dev\n', RELAY_TOKEN: 'tok\n' }, logger), { url: 'https://ahead-relay.rishtapatra.workers.dev', token: 'tok' });
  assert.equal(RELAY_TIMEOUT_MS, 15_000);
  assert.deepEqual(logger.sink, []);
});

test('resolveRelay: either variable absent, empty or blank -> null without a warning (an unset secret renders as "")', () => {
  for (const env of [{}, undefined, { RELAY_URL: 'https://r.test' }, { RELAY_TOKEN: 'tok' }, { RELAY_URL: '  ', RELAY_TOKEN: 'tok' }, { RELAY_URL: 'https://r.test', RELAY_TOKEN: '\n' }, { RELAY_URL: 'https://r.test', RELAY_TOKEN: '' }, { RELAY_URL: 7, RELAY_TOKEN: 'tok' }]) {
    const logger = quietLogger();
    assert.equal(resolveRelay(env, logger), null, JSON.stringify(env));
    assert.deepEqual(logger.sink, [], JSON.stringify(env));
  }
});

test('resolveRelay: a malformed RELAY_URL disables the relay with exactly one warning', () => {
  for (const url of ['http://r.test', 'https://u:p@r.test', 'https://r.test/?x=1', 'https://r.test/#f', 'not a url', 'r.test', 'ftp://r.test']) {
    const logger = quietLogger();
    assert.equal(resolveRelay({ RELAY_URL: url, RELAY_TOKEN: 'tok' }, logger), null, url);
    const warns = logger.sink.filter(([lvl]) => lvl === 'warn');
    assert.equal(warns.length, 1, url);
    assert.equal(logger.sink.length, 1, url);
    assert.match(warns[0][1], /^relay disabled: RELAY_URL must be an https URL without credentials, query or fragment$/);
    assert.ok(!warns[0][1].includes('tok'), 'the token is never part of the warning');
  }
});

test('relayFeedUrl and relayPageUrl build the Worker routes with encoded id and page URL', () => {
  const relay = { url: RELAY, token: TOKEN };
  assert.equal(relayFeedUrl(relay, 'importai'), 'https://r.test/feed/importai');
  assert.equal(relayFeedUrl(relay, 'epoch-gradient-updates'), 'https://r.test/feed/epoch-gradient-updates');
  assert.equal(relayFeedUrl(relay, 'a/b c'), 'https://r.test/feed/a%2Fb%20c');
  assert.equal(relayPageUrl(relay, 'thebatch', 'https://www.deeplearning.ai/the-batch/a-b?x=1&y=2'), 'https://r.test/page/thebatch?u=https%3A%2F%2Fwww.deeplearning.ai%2Fthe-batch%2Fa-b%3Fx%3D1%26y%3D2');
  const page = relayPageUrl({ url: 'https://r.test/sub', token: TOKEN }, 'thebatch', 'https://www.deeplearning.ai/the-batch/x');
  assert.equal(page, 'https://r.test/sub/page/thebatch?u=https%3A%2F%2Fwww.deeplearning.ai%2Fthe-batch%2Fx');
  assert.equal(new URL(page).searchParams.get('u'), 'https://www.deeplearning.ai/the-batch/x', 'the Worker decodes u back to the article URL');
  assert.ok(!relayFeedUrl(relay, 'importai').includes(TOKEN) && !page.includes(TOKEN), 'the token travels in a header, never in the URL');
});

test('staleMarker: x-relay-stale trimmed, printable ASCII only, at most 40 chars; "" when nothing printable remains; undefined without the header', () => {
  assert.equal(staleMarker(new Headers({ 'x-relay-stale': ' 2026-10-20T06:00:00.000Z ' })), '2026-10-20T06:00:00.000Z');
  assert.equal(staleMarker(new Headers({ 'x-relay-stale': 'x'.repeat(60) })), 'x'.repeat(40));
  assert.equal(staleMarker(new Headers({ 'x-relay-stale': '\u0001\u0002\u007f' })), '');
  assert.equal(staleMarker(new Headers({ 'x-relay-stale': 'a\u0007b\tc' })), 'abc');
  assert.equal(staleMarker(new Headers({ 'x-relay-cache': 'hit' })), undefined);
  assert.equal(staleMarker(new Headers()), undefined);
  assert.equal(staleMarker(undefined), undefined);
  assert.equal(staleMarker({}), undefined);
});

test('relayNote renders the three note strings from the primary request state', () => {
  assert.equal(relayNote({ primary: null }), undefined);
  assert.equal(relayNote(undefined), undefined);
  assert.equal(relayNote({ primary: { via: 'relay' } }), 'via relay');
  assert.equal(relayNote({ primary: { via: 'relay', stale: '2026-10-20T06:00:00.000Z' } }), 'via relay (stale 2026-10-20T06:00:00.000Z)');
  assert.equal(relayNote({ primary: { via: 'relay', stale: '' } }), 'via relay (stale)');
  assert.equal(relayNote({ primary: { via: 'direct', failure: 'HTTP 502' } }), 'relay: HTTP 502, fell back to direct');
  assert.equal(relayNote({ primary: { via: 'direct', failure: 'timeout' } }), 'relay: timeout, fell back to direct');
  for (const note of ['via relay', 'via relay (stale 2026-10-20T06:00:00.000Z)', 'relay: HTTP 502, fell back to direct']) assert.ok(note.length <= 120 && !/[\n\r]/.test(note), note);
});

test('createRelayFetch routes the feed and the pages, caps the relay timeout at 15 s (pages keep 8 s) and reports the requested URL as finalUrl', async () => {
  const relay = { url: RELAY, token: TOKEN };
  const source = { id: 'thebatch', url: 'https://www.deeplearning.ai/sitemap.xml' };
  const calls = [];
  const direct = async (url, opts) => { calls.push({ url, opts }); return { status: 200, text: 'body', finalUrl: url, contentType: 'application/xml', headers: new Headers({ 'x-relay-cache': 'hit' }) }; };
  const state = { primary: null };
  const logger = quietLogger();
  const fetchText = createRelayFetch({ source, relay, direct, logger, state });
  const feed = await fetchText(source.url);
  assert.deepEqual(calls, [{ url: 'https://r.test/feed/thebatch', opts: { timeoutMs: 15_000 } }]);
  assert.equal(feed.finalUrl, source.url, 'no `redirected to <relay url>` note can arise');
  assert.equal(feed.text, 'body');
  assert.equal(feed.status, 200);
  assert.deepEqual(state.primary, { via: 'relay' });
  calls.length = 0;
  const page = await fetchText('https://www.deeplearning.ai/the-batch/x', { timeoutMs: 8000, maxBytes: 1_500_000, accept: 'text/html', deadlineAt: 99 });
  assert.deepEqual(calls, [{ url: 'https://r.test/page/thebatch?u=https%3A%2F%2Fwww.deeplearning.ai%2Fthe-batch%2Fx', opts: { timeoutMs: 8000, maxBytes: 1_500_000, accept: 'text/html', deadlineAt: 99 } }]);
  assert.equal(page.finalUrl, 'https://www.deeplearning.ai/the-batch/x');
  assert.deepEqual(state.primary, { via: 'relay' }, 'a page request never touches the primary state');
  calls.length = 0;
  await fetchText(source.url, { timeoutMs: 20_000 });
  assert.equal(calls[0].opts.timeoutMs, 15_000, 'a longer caller timeout is capped at RELAY_TIMEOUT_MS');
  assert.deepEqual(logger.sink, []);
  // Stale copy: the header value lands in the state
  const staleDirect = async (url) => ({ status: 200, text: 'old', finalUrl: url, contentType: 'application/xml', headers: new Headers({ 'x-relay-cache': 'stale', 'x-relay-stale': '2026-10-20T06:00:00.000Z' }) });
  const staleState = { primary: null };
  await createRelayFetch({ source, relay, direct: staleDirect, logger, state: staleState })(source.url);
  assert.deepEqual(staleState.primary, { via: 'relay', stale: '2026-10-20T06:00:00.000Z' });
  assert.equal(relayNote(staleState), 'via relay (stale 2026-10-20T06:00:00.000Z)');
});

test('createRelayFetch falls back to the direct fetch on any relay error, logs one warn line per failure and lets page failures leave the note alone', async () => {
  const relay = { url: RELAY, token: TOKEN };
  const source = { id: 'thebatch', url: 'https://www.deeplearning.ai/sitemap.xml' };
  const calls = [];
  const direct = async (url, opts) => {
    calls.push(url);
    if (url.startsWith(RELAY)) throw new HttpError(502, url, undefined, { contentType: 'application/json', body: '{"error":"upstream failed","upstreamStatus":403,"cfMitigated":"challenge"}' });
    return { status: 200, text: `direct ${url}`, finalUrl: url, contentType: 'application/xml', headers: new Headers(), opts };
  };
  const state = { primary: null };
  const logger = quietLogger();
  const fetchText = createRelayFetch({ source, relay, direct, logger, state });
  const feed = await fetchText(source.url, { timeoutMs: 20_000 });
  assert.deepEqual(calls, ['https://r.test/feed/thebatch', source.url]);
  assert.equal(feed.text, `direct ${source.url}`);
  assert.deepEqual(feed.opts, { timeoutMs: 20_000 }, 'the direct fallback runs with the caller\'s own options');
  assert.deepEqual(state.primary, { via: 'direct', failure: 'HTTP 502' });
  assert.equal(relayNote(state), 'relay: HTTP 502, fell back to direct');
  assert.deepEqual(logger.sink, [['warn', 'thebatch: relay failed (HTTP 502) for feed; falling back to direct [content-type=application/json; body="{"error":"upstream failed","upstreamStatus":403,"cfMitigated":"challenge"}"]']]);
  calls.length = 0;
  const page = await fetchText('https://www.deeplearning.ai/the-batch/x', { timeoutMs: 8000 });
  assert.deepEqual(calls, ['https://r.test/page/thebatch?u=https%3A%2F%2Fwww.deeplearning.ai%2Fthe-batch%2Fx', 'https://www.deeplearning.ai/the-batch/x']);
  assert.equal(page.text, 'direct https://www.deeplearning.ai/the-batch/x');
  assert.deepEqual(state.primary, { via: 'direct', failure: 'HTTP 502' }, 'unchanged by the page');
  assert.equal(logger.sink.length, 2);
  assert.equal(logger.sink[1][1].slice(0, 'thebatch: relay failed (HTTP 502) for page; falling back to direct'.length), 'thebatch: relay failed (HTTP 502) for page; falling back to direct');
  // Other error classes
  for (const [thrown, failure] of [[Object.assign(new Error('aborted'), { name: 'AbortError' }), 'timeout'], [new TypeError('fetch failed'), 'network'], [new HttpError(401, `${RELAY}/feed/thebatch`), 'HTTP 401']]) {
    const s = { primary: null };
    const l = quietLogger();
    const d = async (url) => { if (url.startsWith(RELAY)) throw thrown; return { status: 200, text: 'ok', finalUrl: url, contentType: '', headers: new Headers() }; };
    await createRelayFetch({ source, relay, direct: d, logger: l, state: s })(source.url);
    assert.deepEqual(s.primary, { via: 'direct', failure }, failure);
    assert.deepEqual(l.sink, [['warn', `thebatch: relay failed (${failure}) for feed; falling back to direct`]], failure);
  }
  // A direct failure after the relay failed surfaces as the direct error (runSource turns it into the row's error)
  const both = async (url) => { throw url.startsWith(RELAY) ? new HttpError(502, url) : new HttpError(403, url, undefined, { server: 'cloudflare' }); };
  const s = { primary: null };
  await assert.rejects(createRelayFetch({ source, relay, direct: both, logger: quietLogger(), state: s })(source.url), (e) => e instanceof HttpError && e.status === 403);
  assert.deepEqual(s.primary, { via: 'direct', failure: 'HTTP 502' });
});

// Pipeline: the direct row for importai when the Substack fixture answers its feed URL
const D = { id: 'importai', name: 'Import AI', category: 'blogs', status: 'ok', fetched: 5, kept: 1, skipped: 4, httpStatus: 200 };

test('pipeline without both variables (absent, blank or only one set) fetches directly and never contacts the relay', async () => {
  const plain = await runFixture({ dataDir: tmp(), onlySourceIds: ['importai'], dryRun: true, overrides: { [FEED]: SUBSTACK } });
  assert.deepEqual(stripMs(plain.sourceResults[0]), D);
  assert.equal(plain.items.length, 1);
  for (const env of [undefined, { RELAY_URL: RELAY }, { RELAY_TOKEN: TOKEN }, { RELAY_URL: ' ', RELAY_TOKEN: TOKEN }, { RELAY_URL: RELAY, RELAY_TOKEN: '' }]) {
    const calls = [];
    const logger = quietLogger();
    const r = await runFixture({ dataDir: tmp(), onlySourceIds: ['importai'], dryRun: true, calls, logger, overrides: { [FEED]: SUBSTACK }, ...(env ? { env } : {}) });
    const label = JSON.stringify(env);
    assert.deepEqual(stripMs(r.sourceResults[0]), D, label);
    assert.ok(!('note' in r.sourceResults[0]), label);
    assert.equal(count(calls, FEED), 1, label);
    assert.ok(!calls.some((c) => c.url.startsWith(RELAY)), `${label}: no relay request`);
    assert.ok(calls.every((c) => c.init.headers['x-relay-token'] === undefined), `${label}: no relay header`);
    assert.deepEqual(r.items, plain.items, label);
    assert.deepEqual(logger.sink, [], `${label}: nothing logged`);
  }
});

test('pipeline with both variables: one relay request with the token and the Ahead UA, no direct request, the same items, note "via relay"', async () => {
  const plain = await runFixture({ dataDir: tmp(), onlySourceIds: ['importai'], dryRun: true, overrides: { [FEED]: SUBSTACK } });
  const calls = [];
  const logger = quietLogger();
  const r = await runFixture({ dataDir: tmp(), onlySourceIds: ['importai'], dryRun: true, calls, logger, env: ENV, overrides: { [RFEED]: SUBSTACK } });
  const [row] = r.sourceResults;
  assert.deepEqual(stripMs(row), { ...D, note: 'via relay' });
  assert.ok(!('error' in row) && !('detail' in row));
  assert.ok(!/redirected to/.test(row.note));
  assert.equal(count(calls, RFEED), 1);
  assert.equal(count(calls, FEED), 0, 'the feed is not requested directly when the relay answered');
  assert.equal(calls.length, 1);
  const init = calls[0].init;
  assert.equal(init.headers['x-relay-token'], TOKEN);
  assert.match(init.headers['user-agent'], /^Ahead\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/Sudish007\/ahead; personal AI dashboard\)$/);
  assert.equal(init.redirect, 'manual');
  assert.deepEqual(r.items, plain.items, 'items identical to the direct run (same ids, so saved/read state survives)');
  assert.equal(r.items[0].sources[0].id, 'importai');
  noToken(r, logger, 'relay 200');
  assert.deepEqual(logger.sink, []);
});

test('a stale copy from the relay is noted with the Worker\'s fetchedAt', async () => {
  const r = await runFixture({ dataDir: tmp(), onlySourceIds: ['importai'], dryRun: true, env: ENV, overrides: { [RFEED]: { ...SUBSTACK, headers: { 'x-relay-cache': 'stale', 'x-relay-stale': '2026-10-20T06:00:00.000Z' } } } });
  assert.deepEqual(stripMs(r.sourceResults[0]), { ...D, note: 'via relay (stale 2026-10-20T06:00:00.000Z)' });
  const r2 = await runFixture({ dataDir: tmp(), onlySourceIds: ['importai'], dryRun: true, env: ENV, overrides: { [RFEED]: { ...SUBSTACK, headers: { 'x-relay-cache': 'hit' } } } });
  assert.equal(r2.sourceResults[0].note, 'via relay', 'hit/miss/bypass carry no stale marker');
});

test('a relay failure falls back to one direct fetch with a note; the relay is never retried; items match the direct run', async () => {
  const plain = await runFixture({ dataDir: tmp(), onlySourceIds: ['importai'], dryRun: true, overrides: { [FEED]: SUBSTACK } });
  const cases = [
    [{ status: 401 }, 'relay: HTTP 401, fell back to direct'],
    [{ status: 404 }, 'relay: HTTP 404, fell back to direct'],
    [{ status: 502, body: '{"error":"upstream failed","upstreamStatus":403,"cfMitigated":"challenge"}', contentType: 'application/json' }, 'relay: HTTP 502, fell back to direct'],
    [{ status: 429 }, 'relay: HTTP 429, fell back to direct'],
    [{ status: 503 }, 'relay: HTTP 503, fell back to direct'],
    [{ throw: Object.assign(new Error('aborted'), { name: 'AbortError' }) }, 'relay: timeout, fell back to direct'],
    [{ throw: new TypeError('fetch failed') }, 'relay: network, fell back to direct'],
  ];
  for (const [override, note] of cases) {
    const logger = quietLogger();
    const calls = [];
    const r = await runFixture({ dataDir: tmp(), onlySourceIds: ['importai'], dryRun: true, logger, calls, env: ENV, overrides: { [RFEED]: override, [FEED]: SUBSTACK } });
    assert.deepEqual(stripMs(r.sourceResults[0]), { ...D, note }, note);
    assert.ok(!('error' in r.sourceResults[0]) && !('detail' in r.sourceResults[0]), note);
    assert.equal(count(calls, RFEED), 1, `${note}: the relay host gets exactly one attempt`);
    assert.equal(count(calls, FEED), 1, `${note}: the feed is fetched directly once`);
    assert.equal(calls.length, 2, note);
    assert.equal(relayHeader(calls, FEED), undefined, `${note}: the direct request carries no relay header`);
    assert.deepEqual(r.items, plain.items, `${note}: items identical to the direct run`);
    const warn = logger.sink.filter(([lvl, m]) => lvl === 'warn' && /relay failed/.test(m));
    assert.equal(warn.length, 1, note);
    const failure = note.slice('relay: '.length, note.length - ', fell back to direct'.length);
    assert.ok(warn[0][1].startsWith(`importai: relay failed (${failure}) for feed; falling back to direct`), warn[0][1]);
    noToken(r, logger, note);
  }
  const logger = quietLogger();
  await runFixture({ dataDir: tmp(), onlySourceIds: ['importai'], dryRun: true, logger, env: ENV, overrides: { [RFEED]: cases[2][0], [FEED]: SUBSTACK } });
  const [, line] = logger.sink.find(([lvl, m]) => lvl === 'warn' && /relay failed/.test(m));
  assert.match(line, /^importai: relay failed \(HTTP 502\) for feed; falling back to direct \[.*cfMitigated/);
});

test('when the relay fails and the direct fetch is challenged on the runner, the row is today\'s failure plus the relay note', async () => {
  const logger = quietLogger();
  const calls = [];
  const r = await runFixture({ dataDir: tmp(), onlySourceIds: ['importai'], dryRun: true, logger, calls, env: { ...ENV, GITHUB_ACTIONS: 'true' }, overrides: { [RFEED]: { status: 502 }, [FEED]: CLOUDFLARE_403 } });
  const [row] = r.sourceResults;
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'blocked from GitHub runner: 403 Cloudflare');
  assert.equal(row.httpStatus, 403);
  assert.equal(row.note, 'relay: HTTP 502, fell back to direct');
  assert.match(row.detail, /^server=cloudflare/);
  assert.equal(row.detail, 'server=cloudflare; cf-ray=abc-BOM; content-type=text/html; body="Just a moment..."');
  assert.equal(row.fetched, 0);
  assert.equal(row.kept, 0);
  assert.deepEqual(r.items, []);
  assert.equal(count(calls, RFEED), 1);
  assert.equal(count(calls, FEED), 1);
  const plain = await runFixture({ dataDir: tmp(), onlySourceIds: ['importai'], dryRun: true, env: { GITHUB_ACTIONS: 'true' }, overrides: { [FEED]: CLOUDFLARE_403 } });
  const { note, ms, ...withRelay } = row;
  const { ms: plainMs, ...withoutRelay } = plain.sourceResults[0];
  assert.deepEqual(withRelay, withoutRelay, 'status, error, httpStatus, detail and counts match the relay-less run');
  void note; void ms; void plainMs;
  assert.ok(logger.sink.some(([lvl, m]) => lvl === 'warn' && m === `importai: blocked from GitHub runner: 403 Cloudflare [${row.detail}]`));
  noToken(r, logger, 'both failed');
});

test('a source without viaRelay is untouched by the relay variables: direct request, no header, identical row', async () => {
  const OPENAI = urlOf('openai');
  assert.equal(CONFIG.sources.find((s) => s.id === 'openai').viaRelay, undefined);
  const plain = await runFixture({ dataDir: tmp(), onlySourceIds: ['openai'], dryRun: true });
  const calls = [];
  const logger = quietLogger();
  const r = await runFixture({ dataDir: tmp(), onlySourceIds: ['openai'], dryRun: true, calls, logger, env: ENV });
  assert.deepEqual(calls.map((c) => c.url), [OPENAI]);
  assert.ok(calls.every((c) => c.init.headers['x-relay-token'] === undefined));
  assert.ok(!/^Ahead\//.test(calls[0].init.headers['user-agent']), 'browser UA as before');
  assert.deepEqual(stripMs(r.sourceResults[0]), stripMs(plain.sourceResults[0]));
  assert.ok(!('note' in r.sourceResults[0]));
  assert.deepEqual(r.items, plain.items);
  assert.deepEqual(logger.sink, []);
  noToken(r, logger, 'openai');
});

test('thebatch via relay: the sitemap through /feed/thebatch and every article page through /page/thebatch?u=, identical items', async () => {
  const plain = await runFixture({ dataDir: tmp(), onlySourceIds: ['thebatch'], dryRun: true });
  assert.equal(plain.sourceResults[0].status, 'ok');
  assert.ok(plain.items.length >= 2);
  assert.ok(plain.items.every((i) => i.extra.titleFrom === 'page'), 'the direct run reads every page');
  const calls = [];
  const logger = quietLogger();
  const RSITEMAP = `${RELAY}/feed/thebatch`;
  const r = await runFixture({ dataDir: tmp(), onlySourceIds: ['thebatch'], dryRun: true, calls, logger, env: ENV, overrides: { [RSITEMAP]: SITEMAP } });
  const [row] = r.sourceResults;
  assert.equal(row.status, 'ok');
  assert.equal(row.note, 'via relay');
  assert.equal(row.httpStatus, 200);
  assert.equal(count(calls, RSITEMAP), 1);
  assert.equal(relayHeader(calls, RSITEMAP), TOKEN);
  const pages = calls.filter((c) => c.url !== RSITEMAP);
  assert.ok(pages.length >= 2, `${pages.length} page requests`);
  for (const c of pages) {
    assert.ok(c.url.startsWith(`${RELAY}/page/thebatch?u=https%3A%2F%2Fwww.deeplearning.ai%2Fthe-batch%2F`), c.url);
    assert.equal(c.init.headers['x-relay-token'], TOKEN, c.url);
    assert.equal(c.init.headers.accept, 'text/html', c.url);
    assert.match(c.init.headers['user-agent'], /^Ahead\//, c.url);
  }
  assert.ok(!calls.some((c) => new URL(c.url).hostname === 'www.deeplearning.ai'), 'no direct request to the publisher');
  assert.deepEqual(r.items, plain.items, 'same titles, ids, dates and summaries as the direct run');
  assert.deepEqual(r.items.map((i) => i.extra.titleFrom), plain.items.map(() => 'page'));
  assert.deepEqual(logger.sink, []);
  noToken(r, logger, 'thebatch');
});

test('a full-registry dry run with the relay: six "via relay" rows, every other row unchanged, valid meta, token nowhere', async () => {
  assert.deepEqual(CONFIG.sources.filter((s) => s.viaRelay === true).map((s) => s.id), RELAY_IDS);
  const plain = await runFixture({ dataDir: tmp(), dryRun: true });
  const overrides = {};
  for (const id of RELAY_IDS) overrides[`${RELAY}/feed/${id}`] = id === 'thebatch' ? SITEMAP : SUBSTACK;
  const calls = [];
  const logger = quietLogger();
  const r = await runFixture({ dataDir: tmp(), dryRun: true, calls, logger, env: ENV, overrides });
  assert.equal(r.diagnostic, false);
  for (const id of RELAY_IDS) {
    const row = r.sourceResults.find((x) => x.id === id);
    assert.equal(row.note, 'via relay', id);
    assert.equal(row.httpStatus, 200, id);
    assert.ok(['ok', 'empty'].includes(row.status), `${id}: ${row.status}`);
    assert.equal(r.meta.sources[id].note, 'via relay', id);
    assert.equal(count(calls, `${RELAY}/feed/${id}`), 1, id);
    assert.equal(count(calls, urlOf(id)), 0, `${id}: never fetched directly`);
  }
  for (const row of r.sourceResults) {
    if (RELAY_IDS.includes(row.id)) continue;
    assert.deepEqual(stripMs(row), stripMs(plain.sourceResults.find((x) => x.id === row.id)), row.id);
  }
  for (const c of calls) {
    const viaRelay = c.url.startsWith(RELAY);
    assert.equal(c.init.headers['x-relay-token'], viaRelay ? TOKEN : undefined, c.url);
  }
  assert.equal(r.meta.failedCount, plain.meta.failedCount);
  validateMeta(r.meta, buildRegistry(CONFIG.sources).keys());
  assert.ok(!JSON.stringify(r.meta).includes(TOKEN));
  assert.ok(!JSON.stringify(r.items).includes(TOKEN));
  assert.ok(!JSON.stringify(r.digest).includes(TOKEN));
  assert.ok(!logger.sink.some(([, m]) => m.includes(TOKEN)));
  assert.ok(!logger.sink.some(([, m]) => /relay/.test(m)), 'nothing to warn about when every relay request succeeds');
});
