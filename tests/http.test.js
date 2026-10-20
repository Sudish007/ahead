import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, HttpError, BodyTooLarge, TimeoutError, errorClass, formatDetail, PACING, ACCEPT, BROWSER_USER_AGENT } from '../src/http.js';

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
