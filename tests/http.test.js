import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, HttpError, BodyTooLarge, TimeoutError, errorClass, formatDetail, PACING } from '../src/http.js';

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

test('retry matrix: once on 503, none on 403, none for reddit 429, once for youtube 404, skipped near the deadline', async () => {
  const clock = fakeClock();
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
  let r = await run([new Response('', { status: 503 }), ok('fine')], 'https://a.test/');
  assert.equal(r.calls.length, 2); assert.equal(r.res.ok.text, 'fine');
  r = await run([new Response('', { status: 403 })], 'https://a.test/');
  assert.equal(r.calls.length, 1); assert.ok(r.res.err instanceof HttpError); assert.equal(errorClass(r.res.err), 'HTTP 403');
  r = await run([new Response('', { status: 429 }), ok()], 'https://www.reddit.com/r/x.rss');
  assert.equal(r.calls.length, 1); assert.equal(errorClass(r.res.err), 'HTTP 429');
  r = await run([new Response('', { status: 404 }), ok('yt')], 'https://www.youtube.com/feeds/videos.xml?channel_id=UCx');
  assert.equal(r.calls.length, 2, 'youtube 404 is retried once'); assert.equal(r.res.ok.text, 'yt');
  r = await run([new Response('', { status: 404 })], 'https://a.test/');
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

test('user-agent and accept headers, finalUrl and content type are reported', async () => {
  const clock = fakeClock();
  let headers;
  const fetchImpl = async (url, init) => { headers = init.headers; return new Response('<rss/>', { status: 200, headers: { 'content-type': 'text/plain' } }); };
  const client = createHttpClient({ fetchImpl, sleep: clock.sleep, nowMs: clock.nowMs });
  const p = client.fetchText('https://mistral.ai/news/rss');
  await clock.tick();
  const res = await p;
  assert.match(headers['user-agent'], /^Ahead\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/Sudish007\/ahead; personal AI dashboard\)$/);
  assert.match(headers.accept, /application\/rss\+xml/);
  assert.equal(res.contentType, 'text/plain');
  assert.equal(res.finalUrl, 'https://mistral.ai/news/rss');
  assert.equal(res.status, 200);
});
