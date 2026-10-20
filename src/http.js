// Run-scoped HTTP client: timeout/deadline, byte cap, bounded retries, per-host pacing, scoped GitHub token.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const DEFAULT_USER_AGENT = `Ahead/${pkg.version} (+https://github.com/Sudish007/ahead; personal AI dashboard)`;
/** Sent to every host except IDENTIFIED_HOSTS (Chrome stable 155, October 2026). */
export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
/** Hosts that ask clients to identify themselves (Reddit penalises browser-UA spoofing; GitHub wants a named client): they keep the Ahead UA. */
export const IDENTIFIED_HOSTS = new Set(['www.reddit.com', 'api.github.com']);

export const PACING = { 'export.arxiv.org': 3000, 'rss.arxiv.org': 1000, 'api.github.com': 1000 };
export const ACCEPT = {
  feed: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.7',
  json: 'application/json',
  html: 'text/html',
};
export const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
/** YouTube's feed endpoint: no feed Accept (the runner probe tied every variant at zero, so the plain `*\/*` default stands). */
const YOUTUBE_ACCEPT = '*/*';
const MAX_REDIRECTS = 5;
const RETRY_MIN_REMAINING_MS = 25_000;
/** Backoff before each retry; YouTube answers 404/500 transiently for valid channels, so it gets a third attempt. */
const RETRY_BACKOFF_MS = [2000];
const YOUTUBE_RETRY_BACKOFF_MS = [2000, 8000];
const SNIPPET_BYTES = 4096;
const DETAIL_BODY_CHARS = 300;
const DETAIL_LINE_CHARS = 400;
/** detail key -> response header it was read from (also the label formatDetail prints). */
const DETAIL_HEADERS = { server: 'server', cfRay: 'cf-ray', cfMitigated: 'cf-mitigated', contentType: 'content-type', location: 'location' };
/** Response headers that never reach `detail`, even if DETAIL_HEADERS is one day extended to read them. */
const SENSITIVE_HEADERS = new Set(['authorization', 'x-relay-token']);

/**
 * Rewrite `key=<value>` to `key=REDACTED` inside every googleapis.com URL found in `text`. The YouTube Data API key travels
 * only in the request URL, so this is applied to every string that can carry a URL into a message, log line or meta.json.
 */
export function redactKey(text) {
  return String(text).replace(/(googleapis\.com\/[^\s"'<>]*?[?&]key=)[^&\s"'<>]*/gi, '$1REDACTED');
}

function redactDetail(detail) {
  if (!detail || typeof detail !== 'object') return detail;
  const out = {};
  for (const [key, value] of Object.entries(detail)) out[key] = typeof value === 'string' ? redactKey(value) : value;
  return out;
}

export class HttpError extends Error {
  constructor(status, url, retryAfter, detail) {
    const safeUrl = redactKey(url);
    super(`HTTP ${status} for ${safeUrl}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = safeUrl;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
    if (detail !== undefined) this.detail = redactDetail(detail);
  }
}
export class BodyTooLarge extends Error {
  constructor(url, maxBytes) { super(`body exceeds ${maxBytes} bytes for ${redactKey(url)}`); this.name = 'BodyTooLarge'; }
}
export class TimeoutError extends Error {
  constructor(url) { super(`timeout for ${redactKey(url)}`); this.name = 'TimeoutError'; }
}
export class ParseError extends Error {
  constructor(kind) { super(`parse error: ${kind}`); this.name = 'ParseError'; this.kind = kind; }
}
export class WallClockError extends Error {
  constructor(message = 'wall clock') { super(message); this.name = 'WallClockError'; }
}

export function errorClass(err) {
  if (err instanceof HttpError) return `HTTP ${err.status}`;
  if (err instanceof TimeoutError) return 'timeout';
  if (err instanceof BodyTooLarge) return 'body too large';
  if (err instanceof ParseError) return `parse error: ${err.kind}`;
  if (err instanceof WallClockError) return err.message;
  if (err && err.name === 'AbortError') return 'timeout';
  return 'network';
}

/**
 * Short, specific per-source error string (<= 120 chars, one line) for meta.json and the UI health list.
 * Cloudflare 403 -> 'blocked[ from GitHub runner]: 403 Cloudflare'; retried HttpError -> 'HTTP <status> (<n> attempts)'; else errorClass.
 */
export function errorSummary(err, { onRunner = false } = {}) {
  if (err instanceof HttpError && err.status === 403 && /cloudflare/i.test(err.detail?.server ?? '')) {
    return onRunner ? 'blocked from GitHub runner: 403 Cloudflare' : 'blocked: 403 Cloudflare';
  }
  if (err instanceof HttpError && Number.isInteger(err.attempts) && err.attempts > 1) return `HTTP ${err.status} (${err.attempts} attempts)`;
  return errorClass(err);
}

export function defaultSleep(ms) {
  let timer;
  const p = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)); });
  p.cancel = () => clearTimeout(timer);
  return p;
}

function parseRetryAfter(value) {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** First `maxBytes` of a response body as UTF-8 text; '' on any error (never throws, never leaves the stream open). */
async function readSnippet(res, maxBytes = SNIPPET_BYTES) {
  try {
    if (!res.body || typeof res.body.getReader !== 'function') return '';
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      total += value.byteLength;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    return new TextDecoder('utf-8').decode(Buffer.concat(chunks).subarray(0, maxBytes));
  } catch {
    return '';
  }
}

/** Response evidence for a failed request: selected headers (each <= 80 chars after `scrub`); absent headers are omitted. */
function headerDetail(res, keys, scrub = String) {
  const detail = {};
  for (const key of keys) {
    const name = DETAIL_HEADERS[key];
    if (!name || SENSITIVE_HEADERS.has(name)) continue;
    const value = res.headers?.get?.(name);
    if (value !== undefined && value !== null && value !== '') detail[key] = scrub(String(value)).slice(0, 80);
  }
  return detail;
}

/** One-line `key=value; ...` rendering of an HttpError detail for logs, meta.json and the CLI; '' when there is nothing. */
export function formatDetail(detail) {
  if (!detail || typeof detail !== 'object') return '';
  const parts = [];
  for (const [key, raw] of Object.entries(detail)) {
    if (raw === undefined || raw === null) continue;
    // eslint-disable-next-line no-control-regex
    const value = redactKey(raw).replace(/[\x00-\x1f\x7f]/g, '');
    if (!value) continue;
    parts.push(key === 'body' ? `body="${value}"` : `${DETAIL_HEADERS[key] ?? key}=${value}`);
  }
  return parts.join('; ').slice(0, DETAIL_LINE_CHARS);
}

export function createHttpClient({
  fetchImpl = globalThis.fetch, githubToken = '', relay = null, sleep = defaultSleep, nowMs = Date.now, userAgent = DEFAULT_USER_AGENT,
} = {}) {
  const chains = new Map();
  const lastAt = new Map();
  // The relay Worker (src/relay.js) is the one host that receives the shared-secret header. The token travels only in that
  // header, so every string that can carry a response or URL into an error (and from there into logs or meta.json) is scrubbed.
  const relayHost = relay ? new URL(relay.url).hostname : null;
  const relayToken = relay ? relay.token : '';
  // Scrubbing runs before any slicing so a cut never leaves part of the token behind.
  const scrub = (text) => (relayToken ? String(text).split(relayToken).join('REDACTED') : text);

  async function paced(host, fn) {
    const gap = PACING[host];
    if (!gap) return fn();
    const prev = chains.get(host) ?? Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    chains.set(host, prev.then(() => gate));
    await prev;
    try {
      const last = lastAt.get(host);
      if (last !== undefined) {
        const wait = last + gap - nowMs();
        if (wait > 0) await sleep(wait);
      }
      lastAt.set(host, nowMs());
    } finally {
      release();
    }
    return fn();
  }

  function headersFor(url, accept) {
    const host = new URL(url).hostname;
    const headers = {
      'user-agent': IDENTIFIED_HOSTS.has(host) ? userAgent : BROWSER_USER_AGENT,
      accept: accept ?? ACCEPT.feed,
      'accept-language': ACCEPT_LANGUAGE,
    };
    if (host === 'www.youtube.com') headers.accept = YOUTUBE_ACCEPT;
    if (host === 'api.github.com' && githubToken) {
      headers.authorization = `Bearer ${githubToken}`;
      headers.accept = 'application/vnd.github+json';
    }
    // Our own Worker: identify as Ahead and present the shared secret. Headers are rebuilt per redirect hop, so a hop to
    // another host drops the token (the same mechanism that scopes the GitHub token to api.github.com).
    if (relayHost && host === relayHost) {
      headers['user-agent'] = userAgent;
      headers['x-relay-token'] = relayToken;
    }
    return headers;
  }

  async function readBody(res, url, maxBytes, controller) {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          try { await reader.cancel(); } catch { /* ignore */ }
          throw new BodyTooLarge(scrub(url), maxBytes);
        }
        chunks.push(value);
      }
      return new TextDecoder('utf-8').decode(Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))));
    }
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) throw new BodyTooLarge(scrub(url), maxBytes);
    return text;
  }

  async function once(url, { timeoutMs, maxBytes, accept, deadlineAt }) {
    const startedAt = nowMs();
    if (deadlineAt !== undefined && deadlineAt <= startedAt) throw new TimeoutError(scrub(url));
    let budget = timeoutMs;
    if (deadlineAt !== undefined) budget = Math.min(budget, deadlineAt - startedAt);
    const controller = new AbortController();
    let settled = false;
    let timedOut = false;
    const timer = sleep(budget);
    timer.then(() => { if (!settled) { timedOut = true; controller.abort(); } }, () => {});
    try {
      let current = url;
      let res;
      for (let hop = 0; ; hop++) {
        const headers = headersFor(current, accept);
        try {
          res = await fetchImpl(current, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
        } catch (err) {
          if (timedOut || controller.signal.aborted) throw new TimeoutError(scrub(url));
          throw err;
        }
        const status = res.status;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = res.headers?.get?.('location');
          if (!location || hop >= MAX_REDIRECTS) throw new HttpError(status, scrub(current), undefined, headerDetail(res, ['location', 'server'], scrub));
          try { if (res.body) await res.body.cancel?.(); } catch { /* ignore */ }
          current = new URL(location, current).href;
          continue;
        }
        if (status >= 400) {
          // Keep evidence of what the server said (block pages, challenge markers); the body is capped at 4 KB read / 300 chars kept.
          const detail = headerDetail(res, ['server', 'cfRay', 'cfMitigated', 'contentType', 'location'], scrub);
          const body = scrub(await readSnippet(res)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DETAIL_BODY_CHARS);
          if (body) detail.body = body;
          throw new HttpError(status, scrub(current), parseRetryAfter(res.headers?.get?.('retry-after')), detail);
        }
        let text;
        try {
          text = await readBody(res, current, maxBytes, controller);
        } catch (err) {
          if (err instanceof BodyTooLarge) throw err;
          if (timedOut || controller.signal.aborted) throw new TimeoutError(scrub(url));
          throw err;
        }
        // `headers` lets the relay wrapper read x-relay-stale; nothing else in the pipeline looks at it.
        return { status, text, finalUrl: res.url || current, contentType: res.headers?.get?.('content-type') ?? '', headers: res.headers };
      }
    } finally {
      settled = true;
      timer.cancel?.();
    }
  }

  function retryPlan(host) {
    return host === 'www.youtube.com' ? YOUTUBE_RETRY_BACKOFF_MS : RETRY_BACKOFF_MS;
  }

  function retryable(err, host) {
    // The relay Worker already retries upstream (one 429 retry) and serves its stale copy, so a failure from it is final here:
    // the direct fallback must still fit the 45 s backstop (15 s relay attempt + 20 s direct attempt, and no second direct
    // attempt since < 25 s remain at that point).
    if (relayHost && host === relayHost) return false;
    if (host === 'www.reddit.com') return false;
    // The YouTube Data API gets one attempt (8 s timeout): after it fails, the feed fallback's three fast-failing attempts
    // (~10.5 s) must still fit the 45 s source backstop with >= 25 s left at both retry checks. A retry here would cost that.
    if (host === 'www.googleapis.com') return false;
    if (err instanceof BodyTooLarge) return false;
    // YouTube's feed endpoint answers 404 transiently for valid channels; treat it like a 5xx.
    if (err instanceof HttpError && err.status === 404 && host === 'www.youtube.com') return true;
    if (err instanceof HttpError) return err.status >= 500 || err.status === 429;
    return true; // network errors and timeouts
  }

  /** One attempt plus the host's backoff plan; the error finally thrown carries `attempts` (1 when no retry ran). */
  async function fetchText(url, { timeoutMs = 20_000, maxBytes = 8_000_000, accept, deadlineAt } = {}) {
    const host = new URL(url).hostname;
    const opts = { timeoutMs, maxBytes, accept, deadlineAt };
    const plan = retryPlan(host);
    let attempts = 0;
    for (;;) {
      try {
        attempts++;
        return await paced(host, () => once(url, opts));
      } catch (err) {
        const backoff = plan[attempts - 1];
        if (backoff === undefined || !retryable(err, host)) { err.attempts = attempts; throw err; }
        let wait = backoff;
        if (err instanceof HttpError && err.status === 429 && err.retryAfter !== undefined) wait = Math.min(err.retryAfter, 30_000);
        await sleep(wait);
        if (deadlineAt !== undefined && deadlineAt - nowMs() < RETRY_MIN_REMAINING_MS) { err.attempts = attempts; throw err; }
      }
    }
  }

  return { fetchText };
}
