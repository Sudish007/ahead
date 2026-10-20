// Run-scoped HTTP client: timeout/deadline, byte cap, one retry, per-host pacing, scoped GitHub token.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const DEFAULT_USER_AGENT = `Ahead/${pkg.version} (+https://github.com/Sudish007/ahead; personal AI dashboard)`;

export const PACING = { 'export.arxiv.org': 3000, 'rss.arxiv.org': 1000, 'api.github.com': 1000 };
export const ACCEPT = {
  feed: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
  json: 'application/json',
  html: 'text/html',
};
const MAX_REDIRECTS = 5;
const RETRY_MIN_REMAINING_MS = 25_000;

export class HttpError extends Error {
  constructor(status, url, retryAfter) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}
export class BodyTooLarge extends Error {
  constructor(url, maxBytes) { super(`body exceeds ${maxBytes} bytes for ${url}`); this.name = 'BodyTooLarge'; }
}
export class TimeoutError extends Error {
  constructor(url) { super(`timeout for ${url}`); this.name = 'TimeoutError'; }
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

export function createHttpClient({
  fetchImpl = globalThis.fetch, githubToken = '', sleep = defaultSleep, nowMs = Date.now, userAgent = DEFAULT_USER_AGENT,
} = {}) {
  const chains = new Map();
  const lastAt = new Map();

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
    const headers = { 'user-agent': userAgent, accept: accept ?? ACCEPT.feed };
    if (new URL(url).hostname === 'api.github.com' && githubToken) {
      headers.authorization = `Bearer ${githubToken}`;
      headers.accept = 'application/vnd.github+json';
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
          throw new BodyTooLarge(url, maxBytes);
        }
        chunks.push(value);
      }
      return new TextDecoder('utf-8').decode(Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))));
    }
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) throw new BodyTooLarge(url, maxBytes);
    return text;
  }

  async function once(url, { timeoutMs, maxBytes, accept, deadlineAt }) {
    const startedAt = nowMs();
    if (deadlineAt !== undefined && deadlineAt <= startedAt) throw new TimeoutError(url);
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
          if (timedOut || controller.signal.aborted) throw new TimeoutError(url);
          throw err;
        }
        const status = res.status;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = res.headers?.get?.('location');
          if (!location || hop >= MAX_REDIRECTS) throw new HttpError(status, current);
          try { if (res.body) await res.body.cancel?.(); } catch { /* ignore */ }
          current = new URL(location, current).href;
          continue;
        }
        if (status >= 400) {
          try { if (res.body) await res.body.cancel?.(); } catch { /* ignore */ }
          throw new HttpError(status, current, parseRetryAfter(res.headers?.get?.('retry-after')));
        }
        let text;
        try {
          text = await readBody(res, current, maxBytes, controller);
        } catch (err) {
          if (err instanceof BodyTooLarge) throw err;
          if (timedOut || controller.signal.aborted) throw new TimeoutError(url);
          throw err;
        }
        return { status, text, finalUrl: res.url || current, contentType: res.headers?.get?.('content-type') ?? '' };
      }
    } finally {
      settled = true;
      timer.cancel?.();
    }
  }

  function retryable(err, host) {
    if (host === 'www.reddit.com') return false;
    if (err instanceof BodyTooLarge) return false;
    // YouTube's feed endpoint answers 404 transiently for valid channels; treat it like a 5xx.
    if (err instanceof HttpError && err.status === 404 && host === 'www.youtube.com') return true;
    if (err instanceof HttpError) return err.status >= 500 || err.status === 429;
    return true; // network errors and timeouts
  }

  async function fetchText(url, { timeoutMs = 20_000, maxBytes = 8_000_000, accept, deadlineAt } = {}) {
    const host = new URL(url).hostname;
    const opts = { timeoutMs, maxBytes, accept, deadlineAt };
    try {
      return await paced(host, () => once(url, opts));
    } catch (err) {
      if (!retryable(err, host)) throw err;
      let wait = 2000;
      if (err instanceof HttpError && err.status === 429 && err.retryAfter !== undefined) wait = Math.min(err.retryAfter, 30_000);
      await sleep(wait);
      if (deadlineAt !== undefined && deadlineAt - nowMs() < RETRY_MIN_REMAINING_MS) throw err;
      return paced(host, () => once(url, opts));
    }
  }

  return { fetchText };
}
