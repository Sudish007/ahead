// ahead-relay: Cloudflare Worker that fetches the six allowlisted, Cloudflare-challenged feeds for the Ahead pipeline.
// GitHub-hosted runners get a 403 JS challenge from these publishers; a Worker's egress does not (probe of 2026-10-20).
// Web APIs only: the same file runs under wrangler and in the Node unit tests (tests/relay-worker.test.js).
import allowlist from './allowlist.json' with { type: 'json' };

/** A KV copy younger than this is served without an upstream request (the cron refreshes every 3 h). */
export const FRESH_MS = 2 * 60 * 60 * 1000;
/** Bodies above this are passed through and never stored: thezvi.substack.com/feed measured 2,027,091 bytes on 2026-10-20. */
export const MAX_STORE_BYTES = 4_000_000;
/** Upstream fetch budget; the pipeline gives a relay request 15 s, so one 429 retry still fits. */
export const UPSTREAM_TIMEOUT_MS = 10_000;
/** Substack answered 429 to bursty probe builds and cleared 2 s later: one retry, on 429 only. */
export const RETRY_429_MS = 2000;
/** A URL that leaves the registry disappears from KV after this. */
export const STORE_TTL_S = 30 * 86_400;
/** All five Substack feeds share the egress IP's budget: the cron fetches one feed at a time with this gap. */
export const CRON_GAP_MS = 2000;

const KEY_PREFIX = 'v1:';
const TOKEN_HEADER = 'x-relay-token';
const CONTENT_TYPE_CHARS = 100;
const FALLBACK_CONTENT_TYPE = 'application/octet-stream';
const FEED_PATH = /^\/feed\/([^/]+)$/;
const PAGE_PATH = /^\/page\/([^/]+)$/;

const encoder = new TextEncoder();

/** Constant-time comparison of two strings (no early return on the first differing byte). */
function timingSafeEqual(a, b) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** True when the request's token equals the secret. Both are trimmed: `Get-Content -Raw ... |` appends a newline to the secret. */
export function tokenOk(request, env) {
  const secret = env?.RELAY_TOKEN;
  if (typeof secret !== 'string' || secret.trim() === '') return false;
  const given = request.headers.get(TOKEN_HEADER);
  if (typeof given !== 'string') return false;
  return timingSafeEqual(given.trim(), secret.trim());
}

/**
 * `GET /feed/<id>` -> the allowlisted feed URL; `GET /page/<id>?u=<url>` -> the normalized `u` when it starts with the id's
 * page prefix (https only, no credentials). Everything else is null (404): this is not an open proxy.
 */
export function resolveRoute(url) {
  const u = url instanceof URL ? url : new URL(url);
  const feed = FEED_PATH.exec(u.pathname);
  if (feed) {
    const id = feed[1];
    return Object.hasOwn(allowlist.feeds, id) ? { kind: 'feed', id, url: allowlist.feeds[id] } : null;
  }
  const page = PAGE_PATH.exec(u.pathname);
  if (page) {
    const id = page[1];
    if (!Object.hasOwn(allowlist.pages, id)) return null;
    const raw = u.searchParams.get('u');
    if (raw === null) return null;
    let target;
    try { target = new URL(raw); } catch { return null; }
    if (target.protocol !== 'https:' || target.username || target.password) return null;
    // `href` is normalized (`/the-batch/../x` becomes `/x`), so the prefix test sees what fetch() would request.
    if (!target.href.startsWith(allowlist.pages[id])) return null;
    return { kind: 'html', id, url: target.href };
  }
  return null;
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/** 200 with the upstream content-type and nothing else from upstream (Workers decode bodies, so no content-encoding/length). */
function serveBody(copy, cache, staleAt) {
  const headers = new Headers({
    'content-type': copy.contentType || FALLBACK_CONTENT_TYPE,
    'cache-control': 'no-store',
    'x-relay-cache': cache,
  });
  if (staleAt !== undefined) headers.set('x-relay-stale', staleAt);
  return new Response(copy.body, { status: 200, headers });
}

/** Exactly the pipeline's headers for this kind of URL; the relay token is never forwarded. */
function upstreamHeaders(kind) {
  return {
    'user-agent': allowlist.headers['user-agent'],
    'accept-language': allowlist.headers['accept-language'],
    accept: kind === 'html' ? allowlist.headers['accept-html'] : allowlist.headers['accept-feed'],
  };
}

const isTimeout = (err) => err?.name === 'AbortError' || err?.name === 'TimeoutError';

/**
 * Factory with injectable fetch/clock/sleep/log for the Node tests. The default export is `createRelay()` with every
 * dependency resolved at call time (globalThis.fetch, Date.now, setTimeout, console.log).
 */
export function createRelay({ fetchImpl, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = (line) => console.log(line) } = {}) {
  /**
   * One GET with the allowlist headers, 10 s budget, redirects followed; one retry after 2 s on 429 only. Failure is any
   * status other than 200 or any `cf-mitigated` header (a challenge page can be a 200). One JSON log line per attempt
   * (status, cf-ray, cf-cache-status) so a colo-dependent challenge or a 429 pattern shows up in `wrangler tail`.
   */
  async function fetchUpstream(url, kind, path) {
    const fetcher = fetchImpl ?? globalThis.fetch;
    let failure = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const startedAt = now();
      let res = null;
      let body = null;
      try {
        res = await fetcher(url, { method: 'GET', headers: upstreamHeaders(kind), redirect: 'follow', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
        if (res.status === 200 && !res.headers.get('cf-mitigated')) body = await res.arrayBuffer();
        else { try { await res.body?.cancel(); } catch { /* ignore */ } }
      } catch (err) {
        const reason = isTimeout(err) ? 'timeout' : 'network';
        log(JSON.stringify({ event: 'upstream', path, url, status: res?.status ?? null, cfRay: res?.headers.get('cf-ray') ?? null, cfCacheStatus: null, cfMitigated: null, bytes: 0, ms: now() - startedAt, attempt, reason }));
        return { ok: false, status: null, cfMitigated: null, contentType: null, body: null, reason };
      }
      const cfMitigated = res.headers.get('cf-mitigated');
      log(JSON.stringify({ event: 'upstream', path, url, status: res.status, cfRay: res.headers.get('cf-ray'), cfCacheStatus: res.headers.get('cf-cache-status'), cfMitigated, bytes: body ? body.byteLength : 0, ms: now() - startedAt, attempt }));
      if (body) return { ok: true, status: 200, cfMitigated: null, contentType: res.headers.get('content-type') ?? FALLBACK_CONTENT_TYPE, body, reason: null };
      failure = { ok: false, status: res.status, cfMitigated, contentType: null, body: null, reason: 'status' };
      if (res.status !== 429 || attempt > 1) return failure;
      await sleep(RETRY_429_MS);
    }
    return failure;
  }

  function store(kv, key, up, fetchedAtMs) {
    const metadata = { contentType: up.contentType.slice(0, CONTENT_TYPE_CHARS), fetchedAt: new Date(fetchedAtMs).toISOString() };
    return kv.put(key, up.body, { metadata, expirationTtl: STORE_TTL_S });
  }

  async function readCopy(kv, key) {
    const { value, metadata } = await kv.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!value || !metadata) return null;
    return { body: value, contentType: metadata.contentType, fetchedAt: metadata.fetchedAt };
  }

  /** KV read -> fresh copy (hit) | upstream (miss, or bypass above the cap) | stale copy | 502 JSON. */
  async function serve(route, env, ctx) {
    const kv = env.RELAY_CACHE;
    const key = KEY_PREFIX + route.url;
    const copy = await readCopy(kv, key);
    const nowMs = now();
    if (copy && nowMs - Date.parse(copy.fetchedAt) < FRESH_MS) return serveBody(copy, 'hit');
    const up = await fetchUpstream(route.url, route.kind, 'request');
    if (up.ok) {
      if (up.body.byteLength > MAX_STORE_BYTES) return serveBody(up, 'bypass');
      ctx.waitUntil(store(kv, key, up, nowMs));
      return serveBody(up, 'miss');
    }
    if (copy) return serveBody(copy, 'stale', copy.fetchedAt);
    return json(502, { error: 'upstream failed', url: route.url, upstreamStatus: up.status, cfMitigated: up.cfMitigated, reason: up.reason });
  }

  /** Cron: every feed URL in id order, 2 s apart; a failed or oversized fetch keeps the old copy. One summary line. */
  async function refreshAll(env) {
    const startedAt = now();
    const ids = Object.keys(allowlist.feeds).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const summary = { event: 'cron', refreshed: [], failed: [], bypassed: [], ms: 0 };
    for (let i = 0; i < ids.length; i++) {
      if (i > 0) await sleep(CRON_GAP_MS);
      const url = allowlist.feeds[ids[i]];
      const up = await fetchUpstream(url, 'feed', 'cron');
      if (!up.ok) { summary.failed.push(ids[i]); continue; }
      if (up.body.byteLength > MAX_STORE_BYTES) { summary.bypassed.push(ids[i]); continue; }
      await store(env.RELAY_CACHE, KEY_PREFIX + url, up, now());
      summary.refreshed.push(ids[i]);
    }
    summary.ms = now() - startedAt;
    log(JSON.stringify(summary));
  }

  return {
    async fetch(request, env, ctx) {
      if (!tokenOk(request, env)) return json(401, { error: 'unauthorized' });
      if (request.method !== 'GET') return json(404, { error: 'not found' });
      const route = resolveRoute(new URL(request.url));
      if (!route) return json(404, { error: 'not found' });
      return serve(route, env, ctx);
    },
    async scheduled(controller, env, ctx) {
      ctx.waitUntil(refreshAll(env));
    },
  };
}

export default createRelay();
