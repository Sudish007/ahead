import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, HttpError, BodyTooLarge, TimeoutError, errorClass, errorSummary, formatDetail, redactKey, PACING, ACCEPT, BROWSER_USER_AGENT } from '../src/http.js';

/** Fake clock whose sleep() advances time and resolves timers in order. */
function fakeClock() {
  let now = 0;
  const timers = [];
  const nowMs = () => now;
  const sleep = (ms) => {
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    const timer = { at: now + ms, resolve, cancelled: false };
    timers.push(timer);
    p.cancel = () => { timer.cancelled = true; };
    return p;
  };
  const settle = () => new Promise((r) => setImmediate(r));
  const tick = async () => {
    let idle = 0;
    for (let i = 0; i < 10_000; i++) {
      await settle();
      const pending = timers.filter((t) => !t.cancelled && !t.fired).sort((a, b) => a.at - b.at);
      if (!pending.length) { if (++idle >= 3) return; continue; }
      idle = 0;
      const t = pending[0];
      now = Math.max(now, t.at);
      t.fired = true;
      t.resolve();
    }
  };
  return { nowMs, sleep, tick, set: (v) => { now = v; } };
}

const ok = (body = 'ok', headers = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/plain', ...headers } });

test('per-host pacing serializes export.arxiv.org at 3 s gaps and leaves other hosts alone', async () => {
  const clock = fakeClock();
  const times = [];
  const fetchImpl = async (url) => { times.push([new URL(url).hostname, clock.nowMs()]); return ok(); };
  const client = createHttpClient({ fetchImpl, sleep: clock.sleep, nowMs: clock.nowMs });
  const p = Promise.all([
    client.fetchText('https://export.arxiv.org/a'), client.fetchText('https://export.arxiv.org/b'), client.fetchText('https://export.arxiv.org/c'),
    client.fetchText('https://one.test/x'), client.fetchText('https://two.test/y'),
  ]);
  await clock.tick();
  await p;
  const arxiv = times.filter(([h]) => h === 'export.arxiv.org').map(([, t]) => t);
  assert.deepEqual(arxiv, [0, 3000, 6000]);
  assert.deepEqual(times.filter(([h]) => h !== 'export.arxiv.org').map(([, t]) => t), [0, 0]);
  assert.equal(PACING['api.github.com'], 1000);
});

test('retry matrix: once on 503, none on 403, none for reddit 429, three youtube attempts at 0/2/10 s, skipped near the deadline', async () => {
  const clock = fakeClock();
  const YT = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCx';
  const status = (code) => new Response('', { status: code });
  const mk = (responses) => {
    let i = 0;
    const calls = [];
    const fetchImpl = async (url) => { calls.push(clock.nowMs()); const r = responses[Math.min(i++, responses.length - 1)]; if (r instanceof Error) throw r; return r; };
    return { fetchImpl, calls };
  };
  const run = async (responses, url, opts) => {
    const { fetchImpl, calls } = mk(responses);
    const client = createHttpClient({ fetchImpl, sleep: clock.sleep, nowMs: clock.nowMs });
    const p = client.fetchText(url, opts).then((r) => ({ ok: r }), (e) => ({ err: e }));
    await clock.tick();
    return { res: await p, calls };
  };
  let r = await run([status(503), ok('fine')], 'https://a.test/');
  assert.equal(r.calls.length, 2); assert.equal(r.res.ok.text, 'fine');
  r = await run([status(503), status(503), status(503)], 'https://a.test/');
  assert.equal(r.calls.length, 2, 'other hosts keep exactly one retry'); assert.equal(errorClass(r.res.err), 'HTTP 503'); assert.equal(r.res.err.attempts, 2);
  r = await run([status(403)], 'https://a.test/');
  assert.equal(r.calls.length, 1); assert.ok(r.res.err instanceof HttpError); assert.equal(errorClass(r.res.err), 'HTTP 403'); assert.equal(r.res.err.attempts, 1);
  r = await run([status(429), ok()], 'https://www.reddit.com/r/x.rss');
  assert.equal(r.calls.length, 1); assert.equal(errorClass(r.res.err), 'HTTP 429'); assert.equal(r.res.err.attempts, 1);
  clock.set(0);
  r = await run([status(404), status(404), ok('yt')], YT);
  assert.deepEqual(r.calls, [0, 2000, 10_000], 'youtube gets 3 attempts with 2 s / 8 s backoff'); assert.equal(r.res.ok.text, 'yt');
  r = await run([status(404), status(404), status(404)], YT);
  assert.equal(r.calls.length, 3); assert.ok(r.res.err instanceof HttpError); assert.equal(r.res.err.attempts, 3); assert.equal(errorClass(r.res.err), 'HTTP 404');
  r = await run([status(500), ok('yt2')], YT);
  assert.equal(r.calls.length, 2, 'youtube 500 recovers on the second attempt'); assert.equal(r.res.ok.text, 'yt2');
  r = await run([status(404)], 'https://a.test/');
  assert.equal(r.calls.length, 1, '404 elsewhere is not retried'); assert.equal(errorClass(r.res.err), 'HTTP 404');
  r = await run([new TypeError('fetch failed'), ok('recovered')], 'https://a.test/');
  assert.equal(r.calls.length, 2); assert.equal(r.res.ok.text, 'recovered');
  clock.set(0);
  r = await run([new Response('', { status: 503 }), ok()], 'https://a.test/', { deadlineAt: 2000 + 25_000 });
  assert.equal(r.calls.length, 2, 'retry runs when exactly 25 s remain');
  clock.set(0);
  r = await run([new Response('', { status: 503 }), ok()], 'https://a.test/', { deadlineAt: 2000 + 24_999 });
  assert.equal(r.calls.length, 1, 'retry skipped when 24,999 ms remain');
  assert.equal(errorClass(r.res.err), 'HTTP 503');
});

test('two timed-out attempts are bounded by 42 s and the deadline caps the abort time', async () => {
  const clock = fakeClock();
  const fetchImpl = (url, { signal }) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  const client = createHttpClient({ fetchImpl, sleep: clock.sleep, nowMs: clock.nowMs });
  const p = client.fetchText('https://slow.test/').catch((e) => e);
  await clock.tick();
  const err = await p;
  assert.ok(err instanceof TimeoutError);
  assert.equal(errorClass(err), 'timeout');
  assert.equal(clock.nowMs(), 42_000);
  clock.set(0);
  const p2 = client.fetchText('https://slow.test/', { deadlineAt: 5000 }).catch((e) => e);
  await clock.tick();
  assert.ok((await p2) instanceof TimeoutError);
  assert.ok(clock.nowMs() <= 7000, `aborted at ${clock.nowMs()}`);
});

test('a 15 s timeout inside a 45 s deadline gets its retry; the default 20 s timeout does not', async () => {
  // Documents the arXiv API fallback policy (D4): 15 s + 2 s + 15 s = 32 s < 45 s, with >= 25 s left at the retry check.
  const clock = fakeClock();
  let calls = 0;
  const fetchImpl = (url, { signal }) => new Promise((_, reject) => { calls++; signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  const client = createHttpClient({ fetchImpl, sleep: clock.sleep, nowMs: clock.nowMs });
  const p = client.fetchText('https://slow.test/', { timeoutMs: 15_000, deadlineAt: 45_000 }).catch((e) => e);
  await clock.tick();
  const err = await p;
  assert.ok(err instanceof TimeoutError);
  assert.equal(calls, 2, 'two 15 s attempts fit the 45 s backstop');
  assert.equal(err.attempts, 2);
  assert.ok(clock.nowMs() <= 32_500, `finished at ${clock.nowMs()}`);
  clock.set(0);
  calls = 0;
  const p2 = client.fetchText('https://slow.test/', { deadlineAt: 45_000 }).catch((e) => e);
  await clock.tick();
  const err2 = await p2;
  assert.ok(err2 instanceof TimeoutError);
  assert.equal(calls, 1, 'with the default 20 s timeout only 23 s remain after the backoff, so the retry is skipped');
  assert.equal(err2.attempts, 1);
});

test('maxBytes aborts the body stream', async () => {
  const clock = fakeClock();
  const fetchImpl = async () => new Response(new ReadableStream({
    start(c) { for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(1000)); c.close(); },
  }), { status: 200 });
  const client = createHttpClient({ fetchImpl, sleep: clock.sleep, nowMs: clock.nowMs });
  const p = client.fetchText('https://big.test/', { maxBytes: 2500 }).catch((e) => e);
  await clock.tick();
  const err = await p;
  assert.ok(err instanceof BodyTooLarge);
  assert.equal(errorClass(err), 'body too large');
});

test('the GitHub token is sent only to api.github.com and never leaks', async () => {
  const clock = fakeClock();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init.headers.authorization, init.headers.accept]);
    if (url === 'https://api.github.com/redirect') return new Response('', { status: 302, headers: { location: 'https://evil.test/x' } });
    if (url === 'https://api.github.com/fail') return new Response('', { status: 401 });
    return ok();
  };
  const client = createHttpClient({ fetchImpl, githubToken: 'ghp_SECRET', sleep: clock.sleep, nowMs: clock.nowMs });
  const p = Promise.all([
    client.fetchText('https://api.github.com/search/repositories?q=x', { accept: 'application/json' }),
    client.fetchText('https://github.com/pytorch/pytorch/releases.atom'),
    client.fetchText('https://other.test/'),
    client.fetchText('https://api.github.com/redirect'),
    client.fetchText('https://api.github.com/fail').catch((e) => e),
  ]);
  await clock.tick();
  const [, , , , failErr] = await p;
  const byUrl = Object.fromEntries(seen.map(([u, a, acc]) => [u, { a, acc }]));
  assert.equal(byUrl['https://api.github.com/search/repositories?q=x'].a, 'Bearer ghp_SECRET');
  assert.equal(byUrl['https://api.github.com/search/repositories?q=x'].acc, 'application/vnd.github+json');
  assert.equal(byUrl['https://github.com/pytorch/pytorch/releases.atom'].a, undefined);
  assert.equal(byUrl['https://other.test/'].a, undefined);
  assert.equal(byUrl['https://evil.test/x'].a, undefined, 'cross-host redirect must not carry the token');
  assert.ok(!String(failErr.message).includes('SECRET'));
  assert.ok(!JSON.stringify(failErr).includes('SECRET'));
});

test('a client built without a token ignores process.env.GITHUB_TOKEN', async () => {
  const clock = fakeClock();
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_FROM_ENV';
  try {
    let auth = 'unset';
    const fetchImpl = async (url, init) => { auth = init.headers.authorization; return ok(); };
    const client = createHttpClient({ fetchImpl, sleep: clock.sleep, nowMs: clock.nowMs });
    const p = client.fetchText('https://api.github.com/x');
    await clock.tick();
    await p;
    assert.equal(auth, undefined);
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev;
  }
});

test('non-2xx responses keep bounded header/body evidence in err.detail; formatDetail renders one line <= 400 chars', async () => {
  const clock = fakeClock();
  const padding = '<p class="x">'.concat('lorem ipsum '.repeat(4), '</p>\n').repeat(40); // ~2.3 KB of markup
  const html = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>${padding}</body></html>`;
  const fetchImpl = async (url) => {
    if (url === 'https://blocked.test/feed') {
      return new Response(html, { status: 403, headers: { server: 'cloudflare', 'cf-ray': 'abc123-BOM', 'cf-mitigated': 'challenge', 'content-type': 'text/html' } });
    }
    return new Response('', { status: 404 });
  };
  const client = createHttpClient({ fetchImpl, sleep: clock.sleep, nowMs: clock.nowMs });
  const p = Promise.all([
    client.fetchText('https://blocked.test/feed').catch((e) => e),
    client.fetchText('https://gone.test/feed').catch((e) => e),
  ]);
  await clock.tick();
  const [blocked, gone] = await p;
  assert.ok(blocked instanceof HttpError);
  assert.equal(errorClass(blocked), 'HTTP 403');
  assert.equal(blocked.detail.server, 'cloudflare');
  assert.equal(blocked.detail.cfRay, 'abc123-BOM');
  assert.equal(blocked.detail.cfMitigated, 'challenge');
  assert.equal(blocked.detail.contentType, 'text/html');
  assert.ok(!('location' in blocked.detail));
  assert.ok(!blocked.detail.body.includes('<'), 'tags stripped');
  assert.ok(blocked.detail.body.length <= 300, `body ${blocked.detail.body.length} chars`);
  assert.match(blocked.detail.body, /^Just a moment\.\.\. lorem ipsum/);
  const line = formatDetail(blocked.detail);
  assert.ok(!/[\n\r]/.test(line));
  assert.ok(line.length <= 400, `line ${line.length} chars`);
  assert.match(line, /^server=cloudflare; cf-ray=abc123-BOM; cf-mitigated=challenge; content-type=text\/html; body="Just a moment/);
  assert.ok(!JSON.stringify(blocked).includes('user-agent'), 'request headers never recorded');
  // 404 with an empty body: no body key, formatDetail lists whatever headers exist (undici adds a content-type for string bodies)
  assert.ok(gone instanceof HttpError);
  assert.equal(errorClass(gone), 'HTTP 404');
  assert.ok(!('body' in gone.detail));
  assert.equal(formatDetail(gone.detail), gone.detail.contentType ? `content-type=${gone.detail.contentType}` : '');
  assert.equal(formatDetail(undefined), '');
  assert.equal(formatDetail({}), '');
  assert.equal(formatDetail({ server: 'a\nb\u0007c', body: 'x'.repeat(500) }).length, 400);
  assert.match(formatDetail({ server: 'a\nb\u0007c' }), /^server=abc$/);
});

test('errorSummary: Cloudflare 403 -> blocked[ from GitHub runner], retried HttpError -> attempts count, otherwise errorClass; all <= 120 chars', () => {
  const url = 'https://blocked.test/feed';
  const cf = new HttpError(403, url, undefined, { server: 'cloudflare' });
  const cases = [
    [errorSummary(cf), 'blocked: 403 Cloudflare'],
    [errorSummary(cf, { onRunner: true }), 'blocked from GitHub runner: 403 Cloudflare'],
    [errorSummary(new HttpError(403, url)), 'HTTP 403'],
    [errorSummary(Object.assign(new HttpError(404, url), { attempts: 3 })), 'HTTP 404 (3 attempts)'],
    [errorSummary(Object.assign(new HttpError(500, url), { attempts: 3 }), { onRunner: true }), 'HTTP 500 (3 attempts)'],
    [errorSummary(Object.assign(new HttpError(503, url), { attempts: 1 })), 'HTTP 503'],
    [errorSummary(new TimeoutError(url)), 'timeout'],
    [errorSummary(new TypeError('fetch failed')), 'network'],
  ];
  for (const [actual, expected] of cases) {
    assert.equal(actual, expected);
    assert.ok(actual.length <= 120 && !/[\n\r]/.test(actual), `"${actual}" fits meta.sources[id].error`);
  }
  // Cloudflare detection wins over the attempt count; the server match is case-insensitive
  const cfRetried = Object.assign(new HttpError(403, url, undefined, { server: 'Cloudflare' }), { attempts: 2 });
  assert.equal(errorSummary(cfRetried, { onRunner: true }), 'blocked from GitHub runner: 403 Cloudflare');
  // errorClass itself is unchanged (the arXiv note and other tests pin it)
  assert.equal(errorClass(cf), 'HTTP 403');
});

test('browser headers by default, the Ahead UA on identified hosts, */* for YouTube; finalUrl and content type are reported', async () => {
  const clock = fakeClock();
  const seen = {};
  const fetchImpl = async (url, init) => { seen[url] = init.headers; return new Response('<rss/>', { status: 200, headers: { 'content-type': 'text/plain' } }); };
  const client = createHttpClient({ fetchImpl, sleep: clock.sleep, nowMs: clock.nowMs });
  const p = Promise.all([
    client.fetchText('https://mistral.ai/news/rss'),
    client.fetchText('https://www.reddit.com/r/x.rss'),
    client.fetchText('https://api.github.com/x'),
    client.fetchText('https://www.youtube.com/feeds/videos.xml?channel_id=UCx'),
  ]);
  await clock.tick();
  const [res] = await p;
  const feed = seen['https://mistral.ai/news/rss'];
  assert.equal(feed['user-agent'], BROWSER_USER_AGENT);
  assert.match(feed['user-agent'], /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) .*Chrome\/155\.0\.0\.0 Safari\/537\.36$/);
  assert.equal(feed.accept, ACCEPT.feed);
  assert.equal(feed.accept, 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.7');
  assert.equal(feed['accept-language'], 'en-US,en;q=0.9');
  const AHEAD_UA = /^Ahead\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/Sudish007\/ahead; personal AI dashboard\)$/;
  for (const url of ['https://www.reddit.com/r/x.rss', 'https://api.github.com/x']) {
    assert.match(seen[url]['user-agent'], AHEAD_UA, `${url} identifies itself`);
    assert.equal(seen[url].accept, ACCEPT.feed, url);
    assert.equal(seen[url]['accept-language'], 'en-US,en;q=0.9', url);
  }
  const yt = seen['https://www.youtube.com/feeds/videos.xml?channel_id=UCx'];
  assert.equal(yt['user-agent'], BROWSER_USER_AGENT);
  assert.equal(yt.accept, '*/*', 'probe-chosen YouTube accept (all variants tied at zero)');
  assert.equal(yt.cookie, undefined, 'no consent cookie: the runner probe saw no consent.youtube.com redirect');
  assert.equal(yt['accept-language'], 'en-US,en;q=0.9');
  assert.equal(res.contentType, 'text/plain');
  assert.equal(res.finalUrl, 'https://mistral.ai/news/rss');
  assert.equal(res.status, 200);
});

const KEY = 'AIzaSECRET';
const API_URL = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=15&playlistId=UUJgIbYl6C5no72a0NUAPcTA&key=${KEY}`;
const API_URL_REDACTED = API_URL.replace(KEY, 'REDACTED');

test('redactKey rewrites key=<value> inside googleapis.com URLs only', () => {
  assert.equal(redactKey(API_URL), API_URL_REDACTED);
  assert.ok(API_URL_REDACTED.endsWith('&key=REDACTED'));
  assert.equal(redactKey(`https://www.googleapis.com/x?key=${KEY}&part=snippet`), 'https://www.googleapis.com/x?key=REDACTED&part=snippet');
  assert.equal(redactKey(`one ${API_URL} two https://www.googleapis.com/y?key=${KEY} three`), `one ${API_URL_REDACTED} two https://www.googleapis.com/y?key=REDACTED three`);
  assert.equal(redactKey('https://example.test/feed?key=abc'), 'https://example.test/feed?key=abc', 'other hosts are left alone');
  assert.equal(redactKey('HTTP 403 for https://a.test/feed'), 'HTTP 403 for https://a.test/feed');
  assert.equal(redactKey('plain text without a url'), 'plain text without a url');
});

test('HttpError, TimeoutError and BodyTooLarge never carry the API key in message, url, detail or JSON', () => {
  const err = new HttpError(403, API_URL, undefined, { location: `https://www.googleapis.com/r?key=${KEY}`, body: `see https://www.googleapis.com/y?key=${KEY}`, server: 'ESF' });
  assert.equal(err.message, `HTTP 403 for ${API_URL_REDACTED}`);
  assert.equal(err.url, API_URL_REDACTED);
  assert.equal(err.detail.location, 'https://www.googleapis.com/r?key=REDACTED');
  assert.equal(err.detail.body, 'see https://www.googleapis.com/y?key=REDACTED');
  assert.equal(err.detail.server, 'ESF');
  assert.ok(!JSON.stringify(err).includes(KEY));
  assert.ok(!err.stack.includes(KEY));
  const line = formatDetail(err.detail);
  assert.ok(!line.includes(KEY));
  assert.match(line, /location=https:\/\/www\.googleapis\.com\/r\?key=REDACTED/);
  assert.ok(!formatDetail({ location: `https://www.googleapis.com/r?key=${KEY}` }).includes(KEY), 'formatDetail redacts a raw detail object too');
  const timeout = new TimeoutError(API_URL);
  assert.ok(timeout.message.includes('key=REDACTED') && !timeout.message.includes(KEY));
  const big = new BodyTooLarge(API_URL, 10);
  assert.ok(big.message.includes('key=REDACTED') && !big.message.includes(KEY));
  assert.equal(errorClass(err), 'HTTP 403');
  assert.equal(errorSummary(err), 'HTTP 403');
  assert.equal(errorClass(timeout), 'timeout');
  assert.equal(errorClass(big), 'body too large');
  // Plain URLs are untouched
  const plain = new HttpError(404, 'https://a.test/feed');
  assert.equal(plain.message, 'HTTP 404 for https://a.test/feed');
  assert.equal(plain.url, 'https://a.test/feed');
});

test('a 403 from the Data API through the client keeps the quota evidence and drops the key', async () => {
  const clock = fakeClock();
  const body = '{"error":{"code":403,"message":"quota","errors":[{"reason":"quotaExceeded"}]}}';
  const fetchImpl = async (url) => {
    assert.equal(url, API_URL, 'the request itself carries the key');
    return new Response(body, { status: 403, headers: { 'content-type': 'application/json' } });
  };
  const client = createHttpClient({ fetchImpl, sleep: clock.sleep, nowMs: clock.nowMs });
  const p = client.fetchText(API_URL, { accept: ACCEPT.json, timeoutMs: 8000 }).catch((e) => e);
  await clock.tick();
  const err = await p;
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 403);
  assert.equal(err.attempts, 1);
  assert.match(err.detail.body, /quotaExceeded/);
  assert.ok(!err.message.includes(KEY));
  assert.ok(!err.url.includes(KEY));
  assert.ok(!formatDetail(err.detail).includes(KEY));
  assert.ok(!JSON.stringify(err).includes(KEY));
  assert.ok(err.url.endsWith('key=REDACTED'));
});

const RELAY = { url: 'https://r.test', token: 'RELAYSECRET' };
const AHEAD_UA_RE = /^Ahead\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/Sudish007\/ahead; personal AI dashboard\)$/;

test('the relay token and the Ahead UA go to the relay host only, are dropped on a cross-host redirect and never sent without a relay', async () => {
  const clock = fakeClock();
  const seen = {};
  const fetchImpl = async (url, init) => {
    seen[url] = init.headers;
    if (url === 'https://r.test/go') return new Response('', { status: 302, headers: { location: 'https://evil.test/x' } });
    return ok('<rss/>', { 'content-type': 'application/xml' });
  };
  const client = createHttpClient({ fetchImpl, relay: RELAY, sleep: clock.sleep, nowMs: clock.nowMs });
  const p = Promise.all([
    client.fetchText('https://r.test/feed/x'),
    client.fetchText('https://r.test/page/thebatch?u=https%3A%2F%2Fwww.deeplearning.ai%2Fthe-batch%2Fa', { accept: ACCEPT.html }),
    client.fetchText('https://other.test/'),
    client.fetchText('https://r.test/go'),
  ]);
  await clock.tick();
  const [feed, page, , redirected] = await p;
  assert.equal(seen['https://r.test/feed/x']['x-relay-token'], 'RELAYSECRET');
  assert.match(seen['https://r.test/feed/x']['user-agent'], AHEAD_UA_RE);
  assert.equal(seen['https://r.test/feed/x'].accept, ACCEPT.feed);
  assert.equal(seen['https://r.test/feed/x']['accept-language'], 'en-US,en;q=0.9');
  assert.equal(seen['https://r.test/page/thebatch?u=https%3A%2F%2Fwww.deeplearning.ai%2Fthe-batch%2Fa']['x-relay-token'], 'RELAYSECRET');
  assert.equal(seen['https://r.test/page/thebatch?u=https%3A%2F%2Fwww.deeplearning.ai%2Fthe-batch%2Fa'].accept, 'text/html');
  assert.equal(seen['https://other.test/']['x-relay-token'], undefined);
  assert.equal(seen['https://other.test/']['user-agent'], BROWSER_USER_AGENT);
  assert.equal(seen['https://evil.test/x']['x-relay-token'], undefined, 'cross-host redirect must not carry the token');
  assert.equal(seen['https://evil.test/x']['user-agent'], BROWSER_USER_AGENT);
  assert.equal(redirected.finalUrl, 'https://evil.test/x');
  assert.equal(feed.text, '<rss/>');
  assert.equal(page.status, 200);
  // Without a relay the header never exists, even for the same host
  const plainSeen = {};
  const plain = createHttpClient({ fetchImpl: async (url, init) => { plainSeen[url] = init.headers; return ok(); }, sleep: clock.sleep, nowMs: clock.nowMs });
  const p2 = plain.fetchText('https://r.test/feed/x');
  await clock.tick();
  await p2;
  assert.equal(plainSeen['https://r.test/feed/x']['x-relay-token'], undefined);
  assert.equal(plainSeen['https://r.test/feed/x']['user-agent'], BROWSER_USER_AGENT);
});

test('a relay 401 that echoes the token keeps its evidence with the token scrubbed everywhere and never records sensitive headers', async () => {
  const clock = fakeClock();
  const fetchImpl = async () => new Response('{"error":"unauthorized","echo":"RELAYSECRET"}', {
    status: 401, headers: { server: 'cloudflare', 'x-relay-token': 'RELAYSECRET', authorization: 'Bearer RELAYSECRET', 'content-type': 'application/json' },
  });
  const client = createHttpClient({ fetchImpl, relay: RELAY, sleep: clock.sleep, nowMs: clock.nowMs });
  const p = client.fetchText('https://r.test/feed/x').catch((e) => e);
  await clock.tick();
  const err = await p;
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 401);
  assert.equal(err.attempts, 1);
  assert.equal(err.url, 'https://r.test/feed/x');
  assert.equal(err.detail.server, 'cloudflare');
  assert.equal(err.detail.contentType, 'application/json');
  assert.ok(!('authorization' in err.detail) && !('xRelayToken' in err.detail));
  assert.ok(!Object.values(err.detail).some((v) => /relay-token|authorization/i.test(String(v))));
  assert.equal(err.detail.body, '{"error":"unauthorized","echo":"REDACTED"}');
  for (const text of [err.message, err.url, JSON.stringify(err), err.stack, formatDetail(err.detail)]) assert.ok(!text.includes('RELAYSECRET'), text);
  assert.equal(formatDetail(err.detail), 'server=cloudflare; content-type=application/json; body="{"error":"unauthorized","echo":"REDACTED"}"');
  assert.equal(errorClass(err), 'HTTP 401');
  assert.equal(errorSummary(err), 'HTTP 401');
  assert.equal(errorSummary(err, { onRunner: true }), 'HTTP 401', 'a relay 401 is not a Cloudflare block of the source');
  // A redirect loop error from the relay host scrubs its URL and location too
  const loop = createHttpClient({ fetchImpl: async (url) => new Response('', { status: 302, headers: { location: `${url}?t=RELAYSECRET` } }), relay: RELAY, sleep: clock.sleep, nowMs: clock.nowMs });
  const p2 = loop.fetchText('https://r.test/feed/x').catch((e) => e);
  await clock.tick();
  const loopErr = await p2;
  assert.ok(loopErr instanceof HttpError);
  assert.equal(loopErr.status, 302);
  assert.ok(!JSON.stringify(loopErr).includes('RELAYSECRET'));
  assert.match(loopErr.detail.location, /t=REDACTED/);
});

test('TimeoutError and BodyTooLarge for a relay URL carry REDACTED instead of the token', async () => {
  const clock = fakeClock();
  const url = 'https://r.test/feed/x?t=RELAYSECRET';
  const hang = (u, { signal }) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  const slow = createHttpClient({ fetchImpl: hang, relay: RELAY, sleep: clock.sleep, nowMs: clock.nowMs });
  const p = slow.fetchText(url, { timeoutMs: 15_000 }).catch((e) => e);
  await clock.tick();
  const timeout = await p;
  assert.ok(timeout instanceof TimeoutError);
  assert.equal(timeout.message, 'timeout for https://r.test/feed/x?t=REDACTED');
  assert.equal(timeout.attempts, 1, 'no second attempt against the relay host');
  assert.equal(clock.nowMs(), 15_000);
  const stream = async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(1000)); c.close(); } }), { status: 200 });
  const big = createHttpClient({ fetchImpl: stream, relay: RELAY, sleep: clock.sleep, nowMs: clock.nowMs });
  const p2 = big.fetchText(url, { maxBytes: 2500 }).catch((e) => e);
  await clock.tick();
  const tooLarge = await p2;
  assert.ok(tooLarge instanceof BodyTooLarge);
  assert.equal(tooLarge.message, 'body exceeds 2500 bytes for https://r.test/feed/x?t=REDACTED');
  for (const e of [timeout, tooLarge]) assert.ok(!JSON.stringify(e).includes('RELAYSECRET') && !e.stack.includes('RELAYSECRET'));
  // The deadline guard path too
  clock.set(10_000);
  const late = await slow.fetchText(url, { deadlineAt: 5000 }).catch((e) => e);
  assert.ok(late instanceof TimeoutError);
  assert.equal(late.message, 'timeout for https://r.test/feed/x?t=REDACTED');
});

test('the relay host gets exactly one attempt (503, 429, network) while other hosts keep their retry', async () => {
  const clock = fakeClock();
  const run = async (responses, url) => {
    let i = 0;
    const calls = [];
    const fetchImpl = async () => { calls.push(clock.nowMs()); const r = responses[Math.min(i++, responses.length - 1)]; if (r instanceof Error) throw r; return r; };
    const client = createHttpClient({ fetchImpl, relay: RELAY, sleep: clock.sleep, nowMs: clock.nowMs });
    const p = client.fetchText(url).then((r) => ({ ok: r }), (e) => ({ err: e }));
    await clock.tick();
    return { res: await p, calls };
  };
  let r = await run([new Response('', { status: 503 }), ok()], 'https://r.test/feed/x');
  assert.equal(r.calls.length, 1); assert.equal(errorClass(r.res.err), 'HTTP 503'); assert.equal(r.res.err.attempts, 1);
  r = await run([new TypeError('fetch failed'), ok()], 'https://r.test/feed/x');
  assert.equal(r.calls.length, 1); assert.equal(errorClass(r.res.err), 'network'); assert.equal(r.res.err.attempts, 1);
  r = await run([new Response('', { status: 429, headers: { 'retry-after': '1' } }), ok()], 'https://r.test/feed/x');
  assert.equal(r.calls.length, 1); assert.equal(errorClass(r.res.err), 'HTTP 429'); assert.equal(r.res.err.attempts, 1);
  r = await run([new Response('', { status: 502 }), ok()], 'https://r.test/page/thebatch?u=x');
  assert.equal(r.calls.length, 1); assert.equal(errorClass(r.res.err), 'HTTP 502');
  r = await run([new Response('', { status: 503 }), ok('fine')], 'https://a.test/');
  assert.equal(r.calls.length, 2, 'other hosts keep their retry with a relay configured'); assert.equal(r.res.ok.text, 'fine');
  r = await run([ok('relayed')], 'https://r.test/feed/x');
  assert.equal(r.calls.length, 1); assert.equal(r.res.ok.text, 'relayed');
});

test('every successful result exposes the response headers next to contentType', async () => {
  const clock = fakeClock();
  const fetchImpl = async () => ok('<rss/>', { 'content-type': 'application/xml; charset=utf-8', 'x-relay-cache': 'stale', 'x-relay-stale': '2026-10-20T06:00:00.000Z' });
  for (const relay of [RELAY, null]) {
    const client = createHttpClient({ fetchImpl, relay, sleep: clock.sleep, nowMs: clock.nowMs });
    const p = client.fetchText('https://r.test/feed/x');
    await clock.tick();
    const res = await p;
    assert.equal(typeof res.headers.get, 'function');
    assert.equal(res.headers.get('content-type'), res.contentType);
    assert.equal(res.contentType, 'application/xml; charset=utf-8');
    assert.equal(res.headers.get('x-relay-stale'), '2026-10-20T06:00:00.000Z');
    assert.equal(res.headers.get('x-relay-cache'), 'stale');
    assert.deepEqual(Object.keys(res).sort(), ['contentType', 'finalUrl', 'headers', 'status', 'text']);
  }
});

test('www.googleapis.com gets exactly one attempt: no retry on 503 or a network error', async () => {
  const clock = fakeClock();
  const url = 'https://www.googleapis.com/youtube/v3/playlistItems?x';
  const run = async (responses) => {
    let i = 0;
    const calls = [];
    const fetchImpl = async () => { calls.push(clock.nowMs()); const r = responses[Math.min(i++, responses.length - 1)]; if (r instanceof Error) throw r; return r; };
    const client = createHttpClient({ fetchImpl, sleep: clock.sleep, nowMs: clock.nowMs });
    const p = client.fetchText(url).then((r) => ({ ok: r }), (e) => ({ err: e }));
    await clock.tick();
    return { res: await p, calls };
  };
  let r = await run([new Response('', { status: 503 }), ok()]);
  assert.equal(r.calls.length, 1);
  assert.equal(errorClass(r.res.err), 'HTTP 503');
  assert.equal(r.res.err.attempts, 1);
  r = await run([new TypeError('fetch failed'), ok()]);
  assert.equal(r.calls.length, 1);
  assert.equal(errorClass(r.res.err), 'network');
  r = await run([ok('fine')]);
  assert.equal(r.calls.length, 1);
  assert.equal(r.res.ok.text, 'fine');
});
