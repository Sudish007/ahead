import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay, FRESH_MS, MAX_STORE_BYTES, UPSTREAM_TIMEOUT_MS, RETRY_429_MS, STORE_TTL_S, CRON_GAP_MS } from '../relay/src/index.js';
import allowlist from '../relay/src/allowlist.json' with { type: 'json' };
import { BROWSER_USER_AGENT, ACCEPT, ACCEPT_LANGUAGE } from '../src/http.js';

const TOKEN = 'test-relay-token';
const T = Date.parse('2026-10-20T12:00:00Z');
const FEED = 'https://importai.substack.com/feed';
const KEY = `v1:${FEED}`;
const ARTICLE = 'https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork';
const HOUR = 3_600_000;

const bytes = (text) => new TextEncoder().encode(text).buffer;
const text = (buf) => new TextDecoder().decode(buf);
const iso = (ms) => new Date(ms).toISOString();

/** Map-backed KV with the two methods the Worker uses; `puts` records every write. */
function fakeKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  const puts = [];
  return {
    store,
    puts,
    async getWithMetadata(key) {
      const e = store.get(key);
      return e ? { value: e.value, metadata: e.metadata } : { value: null, metadata: null };
    },
    async put(key, value, { metadata, expirationTtl } = {}) {
      puts.push({ key, value, metadata, expirationTtl });
      store.set(key, { value, metadata, expirationTtl });
    },
  };
}

function fakeCtx() {
  const pending = [];
  return { waitUntil(p) { pending.push(p); }, flush: () => Promise.all(pending), pending };
}

const copy = (body, fetchedAtMs, contentType = 'application/xml; charset=utf-8') => ({ value: bytes(body), metadata: { contentType, fetchedAt: iso(fetchedAtMs) } });
const res = (status, body = '', headers = {}) => new Response(body, { status, headers: { 'content-type': 'application/xml; charset=utf-8', ...headers } });

/** Harness: relay with a recording fetchImpl (responses by URL, consumed in order; a function responder is called per call). */
function harness({ kv = fakeKv(), responses = {}, env = { RELAY_TOKEN: TOKEN } } = {}) {
  const calls = [];
  const sleeps = [];
  const logs = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init, headers: new Headers(init.headers) });
    const queue = responses[String(url)];
    if (!queue) throw new Error(`unexpected upstream ${url}`);
    const next = Array.isArray(queue) ? (queue.length > 1 ? queue.shift() : queue[0]) : queue;
    const out = typeof next === 'function' ? next() : next;
    if (out instanceof Error) throw out;
    return out;
  };
  const relay = createRelay({ fetchImpl, now: () => T, sleep: async (ms) => { sleeps.push(ms); }, log: (line) => logs.push(line) });
  const ctx = fakeCtx();
  const request = (path, init = {}) => new Request(`https://relay.test${path}`, { ...init, headers: { 'x-relay-token': TOKEN, ...(init.headers ?? {}) } });
  const get = (path, init) => relay.fetch(request(path, init), { RELAY_CACHE: kv, ...env }, ctx);
  return { relay, kv, ctx, calls, sleeps, logs, request, get };
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

test('constants match the plan', () => {
  assert.equal(FRESH_MS, 2 * HOUR);
  assert.equal(MAX_STORE_BYTES, 4_000_000);
  assert.equal(UPSTREAM_TIMEOUT_MS, 10_000);
  assert.equal(RETRY_429_MS, 2000);
  assert.equal(STORE_TTL_S, 30 * 86_400);
  assert.equal(CRON_GAP_MS, 2000);
});

test('missing, wrong or unset token -> 401 JSON on every route, no upstream request', async () => {
  const h = harness({ responses: { [FEED]: res(200, '<rss/>') } });
  for (const [path, headers] of [['/feed/importai', {}], ['/nope', {}], ['/feed/importai', { 'x-relay-token': 'wrong' }], ['/feed/importai', { 'x-relay-token': `${TOKEN}x` }]]) {
    const r = await h.relay.fetch(new Request(`https://relay.test${path}`, { headers }), { RELAY_CACHE: h.kv, RELAY_TOKEN: TOKEN }, h.ctx);
    assert.equal(r.status, 401, path);
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await r.json(), { error: 'unauthorized' });
  }
  for (const env of [{}, { RELAY_TOKEN: undefined }, { RELAY_TOKEN: '' }, { RELAY_TOKEN: '   ' }]) {
    const r = await h.relay.fetch(h.request('/feed/importai'), { RELAY_CACHE: h.kv, ...env }, h.ctx);
    assert.equal(r.status, 401, JSON.stringify(env));
  }
  assert.equal(h.calls.length, 0);
});

test('the token is compared trimmed on both sides (piped secrets carry a newline)', async () => {
  const h = harness({ responses: { [FEED]: res(200, '<rss/>') }, env: { RELAY_TOKEN: `${TOKEN}\r\n` } });
  const r = await h.relay.fetch(new Request('https://relay.test/feed/importai', { headers: { 'x-relay-token': ` ${TOKEN} ` } }), { RELAY_CACHE: h.kv, RELAY_TOKEN: `${TOKEN}\n` }, h.ctx);
  assert.equal(r.status, 200);
});

test('every unknown or disallowed route -> 404 JSON with no upstream request', async () => {
  const h = harness({ responses: {} });
  const u = (v) => `/page/thebatch?u=${encodeURIComponent(v)}`;
  const cases = [
    ['/', {}],
    ['/feed/', {}],
    ['/feed/unknown', {}],
    ['/feed/importai/', {}],
    ['/feed/constructor', {}],
    ['/feed/importai', { method: 'POST' }],
    ['/feed/importai', { method: 'HEAD' }],
    ['/page/importai?u=https%3A%2F%2Fwww.deeplearning.ai%2Fthe-batch%2Fx', {}],
    ['/page/thebatch', {}],
    ['/page/thebatch?u=', {}],
    ['/page/thebatch?u=not%20a%20url', {}],
    [u('https://evil.test/'), {}],
    [u('https://www.deeplearning.ai/tag/x'), {}],
    [u('https://www.deeplearning.ai/the-batch/../x'), {}],
    [u('http://www.deeplearning.ai/the-batch/x'), {}],
    [u('https://user:pw@www.deeplearning.ai/the-batch/x'), {}],
    [u('https://www.deeplearning.ai.evil.test/the-batch/x'), {}],
    ['/page/thebatch/x?u=https%3A%2F%2Fwww.deeplearning.ai%2Fthe-batch%2Fx', {}],
  ];
  for (const [path, init] of cases) {
    const r = await h.get(path, init);
    assert.equal(r.status, 404, `${init.method ?? 'GET'} ${path}`);
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await r.json(), { error: 'not found' });
  }
  assert.equal(h.calls.length, 0);
});

test('feed miss: upstream fetched with the pipeline headers, body and content-type passed through, copy stored; then hit', async () => {
  const body = '<?xml version="1.0"?><rss><channel><title>Import AI</title></channel></rss>';
  const h = harness({ responses: { [FEED]: res(200, body, { 'cf-ray': 'abc-BOM', 'content-encoding': 'br', 'content-length': '999' }) } });
  const r = await h.get('/feed/importai');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-relay-cache'), 'miss');
  assert.equal(r.headers.get('x-relay-stale'), null);
  assert.equal(r.headers.get('content-encoding'), null);
  assert.equal(r.headers.get('cf-ray'), null);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), new TextEncoder().encode(body));
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.url, FEED);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.redirect, 'follow');
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.equal(call.headers.get('accept'), ACCEPT.feed);
  assert.equal(call.headers.get('accept'), allowlist.headers['accept-feed']);
  assert.equal(call.headers.get('user-agent'), BROWSER_USER_AGENT);
  assert.equal(call.headers.get('accept-language'), ACCEPT_LANGUAGE);
  assert.equal(call.headers.get('x-relay-token'), null);
  assert.deepEqual([...call.headers.keys()].sort(), ['accept', 'accept-language', 'user-agent']);
  assert.equal(h.ctx.pending.length, 1);
  await h.ctx.flush();
  assert.deepEqual([...h.kv.store.keys()], [KEY]);
  const stored = h.kv.store.get(KEY);
  assert.equal(text(stored.value), body);
  assert.deepEqual(stored.metadata, { contentType: 'application/xml; charset=utf-8', fetchedAt: iso(T) });
  assert.equal(stored.expirationTtl, 30 * 86_400);
  assert.equal(h.logs.length, 1);
  const line = JSON.parse(h.logs[0]);
  assert.equal(line.event, 'upstream');
  assert.equal(line.path, 'request');
  assert.equal(line.url, FEED);
  assert.equal(line.status, 200);
  assert.equal(line.cfRay, 'abc-BOM');
  assert.equal(line.attempt, 1);
  assert.equal(line.bytes, new TextEncoder().encode(body).byteLength);
  assert.ok(!h.logs[0].includes(TOKEN));

  const again = await h.get('/feed/importai');
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('x-relay-cache'), 'hit');
  assert.equal(again.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.equal(again.headers.get('cache-control'), 'no-store');
  assert.equal(await again.text(), body);
  assert.equal(h.calls.length, 1);
  assert.equal(h.ctx.pending.length, 1);
});

test('a copy just inside the 2 h window is a hit; just outside it refetches', async () => {
  for (const [age, expect, calls] of [[FRESH_MS - 1, 'hit', 0], [FRESH_MS, 'miss', 1]]) {
    const h = harness({ kv: fakeKv({ [KEY]: copy('old', T - age) }), responses: { [FEED]: res(200, 'new') } });
    const r = await h.get('/feed/importai');
    assert.equal(r.headers.get('x-relay-cache'), expect, String(age));
    assert.equal(await r.text(), expect === 'hit' ? 'old' : 'new');
    assert.equal(h.calls.length, calls);
  }
});

test('stale copy + upstream 429 twice -> old body, x-relay-cache stale, x-relay-stale = fetchedAt, one 2 s retry, nothing stored', async () => {
  const h = harness({ kv: fakeKv({ [KEY]: copy('old body', T - 3 * HOUR) }), responses: { [FEED]: [res(429, 'slow down', { 'retry-after': '2' }), res(429, 'slow down')] } });
  const r = await h.get('/feed/importai');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-relay-cache'), 'stale');
  assert.equal(r.headers.get('x-relay-stale'), iso(T - 3 * HOUR));
  assert.equal(r.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(await r.text(), 'old body');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.sleeps, [2000]);
  assert.equal(h.ctx.pending.length, 0);
  assert.deepEqual(h.kv.puts, []);
  assert.deepEqual(h.logs.map((l) => JSON.parse(l).attempt), [1, 2]);
  assert.deepEqual(h.logs.map((l) => JSON.parse(l).status), [429, 429]);
});

test('stale copy + 429 then 200 -> miss with the new body after one retry', async () => {
  const h = harness({ kv: fakeKv({ [KEY]: copy('old body', T - 3 * HOUR) }), responses: { [FEED]: [res(429), res(200, 'fresh body')] } });
  const r = await h.get('/feed/importai');
  assert.equal(r.headers.get('x-relay-cache'), 'miss');
  assert.equal(await r.text(), 'fresh body');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.sleeps, [2000]);
  await h.ctx.flush();
  assert.equal(text(h.kv.store.get(KEY).value), 'fresh body');
});

test('stale copy + 503 / timeout / network / cf-mitigated 200 -> stale after exactly one upstream call, no retry', async () => {
  const cases = [
    ['503', res(503, 'down'), 503],
    ['timeout', abortError, null],
    ['network', () => new TypeError('fetch failed'), null],
    ['cf-mitigated 200', res(200, '<html>Just a moment...</html>', { 'cf-mitigated': 'challenge', 'content-type': 'text/html' }), 200],
    ['403', res(403, 'blocked', { 'cf-mitigated': 'challenge' }), 403],
    ['304 without body', res(304, null), 304],
  ];
  for (const [name, upstream, status] of cases) {
    const h = harness({ kv: fakeKv({ [KEY]: copy('old body', T - 3 * HOUR) }), responses: { [FEED]: upstream } });
    const r = await h.get('/feed/importai');
    assert.equal(r.status, 200, name);
    assert.equal(r.headers.get('x-relay-cache'), 'stale', name);
    assert.equal(r.headers.get('x-relay-stale'), iso(T - 3 * HOUR), name);
    assert.equal(await r.text(), 'old body', name);
    assert.equal(h.calls.length, 1, name);
    assert.deepEqual(h.sleeps, [], name);
    assert.deepEqual(h.kv.puts, [], name);
    assert.equal(h.logs.length, 1, name);
    assert.equal(JSON.parse(h.logs[0]).status, status, name);
  }
});

test('no copy + 403 with cf-mitigated -> 502 JSON exactly as the behaviour table', async () => {
  const h = harness({ responses: { [FEED]: res(403, '<html>Just a moment...</html>', { 'cf-mitigated': 'challenge', 'content-type': 'text/html', server: 'cloudflare' }) } });
  const r = await h.get('/feed/importai');
  assert.equal(r.status, 502);
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-relay-cache'), null);
  assert.equal(await r.text(), '{"error":"upstream failed","url":"https://importai.substack.com/feed","upstreamStatus":403,"cfMitigated":"challenge","reason":"status"}');
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.kv.puts, []);
  assert.equal(JSON.parse(h.logs[0]).cfMitigated, 'challenge');
});

test('no copy + 200 with cf-mitigated -> 502 with upstreamStatus 200 (a challenge page is never served)', async () => {
  const h = harness({ responses: { [FEED]: res(200, '<html>Just a moment...</html>', { 'cf-mitigated': 'challenge' }) } });
  const r = await h.get('/feed/importai');
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: 'upstream failed', url: FEED, upstreamStatus: 200, cfMitigated: 'challenge', reason: 'status' });
});

test('no copy + timeout -> 502 reason timeout; network error -> reason network; 429 twice -> reason status 429', async () => {
  const cases = [
    ['timeout', abortError, { upstreamStatus: null, cfMitigated: null, reason: 'timeout' }, 1, []],
    ['TimeoutError', () => Object.assign(new Error('timed out'), { name: 'TimeoutError' }), { upstreamStatus: null, cfMitigated: null, reason: 'timeout' }, 1, []],
    ['network', () => new TypeError('fetch failed'), { upstreamStatus: null, cfMitigated: null, reason: 'network' }, 1, []],
    ['429 x2', [res(429), res(429)], { upstreamStatus: 429, cfMitigated: null, reason: 'status' }, 2, [2000]],
    ['503', res(503), { upstreamStatus: 503, cfMitigated: null, reason: 'status' }, 1, []],
  ];
  for (const [name, upstream, expect, calls, sleeps] of cases) {
    const h = harness({ responses: { [FEED]: upstream } });
    const r = await h.get('/feed/importai');
    assert.equal(r.status, 502, name);
    assert.deepEqual(await r.json(), { error: 'upstream failed', url: FEED, ...expect }, name);
    assert.equal(h.calls.length, calls, name);
    assert.deepEqual(h.sleeps, sleeps, name);
    assert.deepEqual(h.kv.puts, [], name);
    const last = JSON.parse(h.logs.at(-1));
    if (expect.reason !== 'status') assert.equal(last.reason, expect.reason, name);
  }
});

test('body above MAX_STORE_BYTES -> 200 bypass, served in full, never stored; at the cap it is stored', async () => {
  for (const [size, expect] of [[MAX_STORE_BYTES + 1, 'bypass'], [MAX_STORE_BYTES, 'miss']]) {
    const big = new Uint8Array(size).fill(120);
    const h = harness({ responses: { [FEED]: new Response(big, { status: 200, headers: { 'content-type': 'application/xml' } }) } });
    const r = await h.get('/feed/importai');
    assert.equal(r.status, 200, String(size));
    assert.equal(r.headers.get('x-relay-cache'), expect, String(size));
    assert.equal(r.headers.get('content-type'), 'application/xml');
    assert.equal((await r.arrayBuffer()).byteLength, size);
    await h.ctx.flush();
    assert.equal(h.kv.puts.length, expect === 'miss' ? 1 : 0, String(size));
    assert.equal(h.kv.store.size, expect === 'miss' ? 1 : 0, String(size));
  }
});

test('page route: upstream fetched with accept text/html, key v1:<normalized href>, same cache rules', async () => {
  const html = '<!doctype html><html><head><title>Data Mixing Minus the Guesswork</title></head><body></body></html>';
  const h = harness({ responses: { [ARTICLE]: res(200, html, { 'content-type': 'text/html; charset=utf-8' }) } });
  const r = await h.get(`/page/thebatch?u=${encodeURIComponent(ARTICLE)}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(r.headers.get('x-relay-cache'), 'miss');
  assert.equal(await r.text(), html);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, ARTICLE);
  assert.equal(h.calls[0].headers.get('accept'), ACCEPT.html);
  assert.equal(h.calls[0].headers.get('accept'), allowlist.headers['accept-html']);
  assert.equal(h.calls[0].headers.get('user-agent'), BROWSER_USER_AGENT);
  assert.equal(h.calls[0].headers.get('accept-language'), ACCEPT_LANGUAGE);
  assert.equal(h.calls[0].headers.get('x-relay-token'), null);
  await h.ctx.flush();
  assert.deepEqual([...h.kv.store.keys()], [`v1:${ARTICLE}`]);
  assert.equal(h.kv.store.get(`v1:${ARTICLE}`).metadata.contentType, 'text/html; charset=utf-8');
  const again = await h.get(`/page/thebatch?u=${encodeURIComponent(ARTICLE)}`);
  assert.equal(again.headers.get('x-relay-cache'), 'hit');
  assert.equal(h.calls.length, 1);
});

test('page route normalizes u: an unencoded or oddly-cased URL inside the prefix maps to the same key', async () => {
  const html = '<html></html>';
  const h = harness({ responses: { 'https://www.deeplearning.ai/the-batch/a%20b': res(200, html, { 'content-type': 'text/html' }) } });
  const r = await h.get('/page/thebatch?u=https%3A%2F%2FWWW.deeplearning.ai%2Fthe-batch%2Fa%20b');
  assert.equal(r.status, 200);
  assert.equal(h.calls[0].url, 'https://www.deeplearning.ai/the-batch/a%20b');
});

test('the stored content-type is cut to 100 chars and a missing upstream content-type falls back to application/octet-stream', async () => {
  const long = `application/xml; ${'x'.repeat(200)}`;
  const h = harness({ responses: { [FEED]: res(200, 'body', { 'content-type': long }) } });
  const r = await h.get('/feed/importai');
  assert.equal(r.headers.get('content-type'), long);
  await h.ctx.flush();
  assert.equal(h.kv.store.get(KEY).metadata.contentType, long.slice(0, 100));
  assert.equal(h.kv.store.get(KEY).metadata.contentType.length, 100);

  const noType = new Response('body', { status: 200 });
  noType.headers.delete('content-type');
  const h2 = harness({ responses: { [FEED]: noType } });
  const r2 = await h2.get('/feed/importai');
  assert.equal(r2.headers.get('content-type'), 'application/octet-stream');
});

test('scheduled: every allowlist feed in id order, 2 s apart, fresh copies stored, failed and oversized keep the old copy, one summary line', async () => {
  const ids = Object.keys(allowlist.feeds);
  assert.deepEqual(ids, ['chinai', 'epoch-gradient-updates', 'importai', 'pod-dwarkesh', 'thebatch', 'zvi']);
  const urlOf = (id) => allowlist.feeds[id];
  const old = T - 3 * HOUR;
  const kv = fakeKv({
    [`v1:${urlOf('chinai')}`]: copy('old chinai', old),
    [`v1:${urlOf('epoch-gradient-updates')}`]: copy('old epoch', old),
    [`v1:${urlOf('importai')}`]: copy('old importai', old),
  });
  const h = harness({
    kv,
    responses: {
      [urlOf('chinai')]: res(200, 'new chinai'),
      [urlOf('epoch-gradient-updates')]: [res(429), res(200, 'new epoch')],
      [urlOf('importai')]: res(503, 'down'),
      [urlOf('pod-dwarkesh')]: res(200, 'new dwarkesh'),
      [urlOf('thebatch')]: new Response(new Uint8Array(MAX_STORE_BYTES + 1), { status: 200, headers: { 'content-type': 'application/xml' } }),
      [urlOf('zvi')]: res(200, 'new zvi'),
    },
  });
  const controller = { cron: '0 */3 * * *', scheduledTime: T };
  await h.relay.scheduled(controller, { RELAY_CACHE: kv, RELAY_TOKEN: TOKEN }, h.ctx);
  assert.equal(h.ctx.pending.length, 1);
  await h.ctx.flush();
  assert.deepEqual(h.calls.map((c) => c.url), [urlOf('chinai'), urlOf('epoch-gradient-updates'), urlOf('epoch-gradient-updates'), urlOf('importai'), urlOf('pod-dwarkesh'), urlOf('thebatch'), urlOf('zvi')]);
  for (const c of h.calls) {
    assert.equal(c.headers.get('accept'), ACCEPT.feed);
    assert.equal(c.headers.get('x-relay-token'), null);
  }
  assert.deepEqual(h.sleeps, [2000, 2000, 2000, 2000, 2000, 2000]);
  const at = (id) => kv.store.get(`v1:${urlOf(id)}`);
  assert.equal(text(at('chinai').value), 'new chinai');
  assert.equal(at('chinai').metadata.fetchedAt, iso(T));
  assert.equal(text(at('epoch-gradient-updates').value), 'new epoch');
  assert.equal(text(at('importai').value), 'old importai');
  assert.equal(at('importai').metadata.fetchedAt, iso(old));
  assert.equal(text(at('pod-dwarkesh').value), 'new dwarkesh');
  assert.equal(at('thebatch'), undefined);
  assert.equal(text(at('zvi').value), 'new zvi');
  assert.deepEqual(kv.puts.map((p) => p.key), [`v1:${urlOf('chinai')}`, `v1:${urlOf('epoch-gradient-updates')}`, `v1:${urlOf('pod-dwarkesh')}`, `v1:${urlOf('zvi')}`]);
  for (const p of kv.puts) assert.equal(p.expirationTtl, STORE_TTL_S);
  const upstreamLines = h.logs.map((l) => JSON.parse(l)).filter((l) => l.event === 'upstream');
  assert.equal(upstreamLines.length, 7);
  assert.ok(upstreamLines.every((l) => l.path === 'cron'));
  const summary = h.logs.map((l) => JSON.parse(l)).filter((l) => l.event === 'cron');
  assert.equal(summary.length, 1);
  assert.deepEqual(summary[0].refreshed, ['chinai', 'epoch-gradient-updates', 'pod-dwarkesh', 'zvi']);
  assert.deepEqual(summary[0].failed, ['importai']);
  assert.deepEqual(summary[0].bypassed, ['thebatch']);
  assert.ok(!h.logs.join('\n').includes(TOKEN));
});

test('the default export resolves globals at call time (no fetchImpl injected)', async () => {
  const mod = await import('../relay/src/index.js');
  const r = await mod.default.fetch(new Request('https://relay.test/feed/importai'), { RELAY_CACHE: fakeKv(), RELAY_TOKEN: TOKEN }, fakeCtx());
  assert.equal(r.status, 401);
  const nf = await mod.default.fetch(new Request('https://relay.test/nope', { headers: { 'x-relay-token': TOKEN } }), { RELAY_CACHE: fakeKv(), RELAY_TOKEN: TOKEN }, fakeCtx());
  assert.equal(nf.status, 404);
});
