// Optional OpenAI-compatible editorial layer: 150-200 word overview + why-lines, validated against the sent facts.
import { countWords, enforceBudget } from './brief.js';
import { defaultSleep, redactKey } from './http.js';

export const SYSTEM_PROMPT = [
  'You are the editor of a one-page daily AI brief for an expert reader (researcher, founder, senior engineer).',
  'Using only the facts given in the user message, write:',
  '1. "overview": one paragraph of 160-190 words (never fewer than 150 or more than 200) of plain English, no hype, naming the 3-5 developments that matter most today and why.',
  '2. "why": an object mapping each entry id to one line of 12-20 words (never more than 25) saying why that entry matters to a researcher or founder.',
  'Never invent numbers, names, benchmarks, dates or quotes. Use a number only when it appears with the same digits and unit in the facts for that entry; otherwise write the line without numbers. Do not add entries.',
  'Reply with a single JSON object of the form { "overview": string, "why": { "<id>": string } } and nothing else: no markdown code fences, no prose before or after the JSON.',
].join('\n');

const NUMBER_RE = /#?[+-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+)(?:%|[kKmMbB]|x)?/g;
const LLM_TIMEOUT_MS = 60_000;
const MAX_ERROR_BODY = 16 * 1024;
/**
 * Output budget. The answer itself is ~1k tokens of JSON, but thinking models (Gemini 3.x Flash on the OpenAI-compatible
 * endpoint, OpenAI o-series) count their reasoning against the same cap, so a small budget truncates the visible JSON.
 */
export const MAX_TOKENS = 8192;
/** Longest `detail` excerpt recorded in meta.json (published) and the run log. */
export const DETAIL_CHARS = 300;
/**
 * Transient provider answers (Gemini's 503 "model is currently experiencing high demand", rate limits, gateway errors) and
 * network errors get a short backoff and another attempt; the first live Gemini run died on exactly one such 503.
 */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
export const RETRY_BACKOFF_MS = [10_000, 30_000];
const MAX_RETRY_AFTER_MS = 30_000;
/** Request-shape fixes for providers that answer HTTP 400 naming a parameter they do not accept; each applies at most once. */
const COMPAT_RETRIES = [
  { name: 'max_tokens', mentions: /max_tokens/i, apply: ({ max_tokens, ...rest }) => ({ ...rest, max_completion_tokens: max_tokens }) },
  { name: 'response_format', mentions: /response_format/i, apply: ({ response_format: _omit, ...rest }) => rest },
];

export function numberTokens(text) {
  return (String(text ?? '').match(NUMBER_RE) ?? []).map((t) => t.toLowerCase().replace(/,/g, '').replace(/^[#+]/, ''));
}

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

export function resolveLlmConfig(env = {}, { noLlm = false } = {}) {
  const key = nonEmpty(env.LLM_API_KEY) ? env.LLM_API_KEY.trim() : '';
  const model = nonEmpty(env.LLM_MODEL) ? env.LLM_MODEL.trim() : '';
  if (noLlm || !key) return { eligible: false, meta: { enabled: false, ok: false } };
  if (!model) return { eligible: false, meta: { enabled: false, ok: false, error: 'LLM_MODEL unset' } };
  const baseRaw = nonEmpty(env.LLM_BASE_URL) ? env.LLM_BASE_URL.trim() : 'https://api.openai.com/v1';
  let base;
  try { base = new URL(baseRaw); } catch { base = null; }
  const localhost = base && (base.hostname === 'localhost' || base.hostname === '127.0.0.1');
  const protocolOk = base && (base.protocol === 'https:' || (base.protocol === 'http:' && localhost));
  if (!base || !protocolOk || base.username || base.password || base.search || base.hash) {
    return { eligible: false, meta: { enabled: false, ok: false, model, error: 'invalid LLM_BASE_URL' } };
  }
  const endpoint = new URL(base.href);
  endpoint.pathname = `${base.pathname.replace(/\/+$/, '')}/chat/completions`;
  return { eligible: true, endpoint: endpoint.href, model, key, meta: { enabled: true, ok: false, model } };
}

function allowedSet(entry, section, signals) {
  const set = new Set();
  const add = (t) => numberTokens(t).forEach((n) => set.add(n));
  add(entry.id); add(section); add(entry.title); add(entry.summary);
  for (const n of entry.sourceNames ?? []) add(n);
  add(JSON.stringify(signals ?? {}));
  return set;
}

async function post(fetchImpl, endpoint, key, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    return await fetchImpl(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readSome(res) {
  try { return (await res.text()).slice(0, MAX_ERROR_BODY); } catch { return ''; }
}

/** `retry-after` in whole seconds -> ms (capped); undefined when absent or not a plain number. */
function retryAfterMs(res) {
  const header = res.headers?.get?.('retry-after');
  if (header === null || header === undefined || String(header).trim() === '') return undefined;
  const secs = Number(header);
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs * 1000, MAX_RETRY_AFTER_MS) : undefined;
}

/**
 * Bounded, secret-free excerpt of model output or an error body for meta.json and the log. The key is scrubbed before any
 * cut so a slice can never keep part of it; googleapis `key=` query values are redacted; control characters and runs of
 * whitespace collapse to one space. '' when nothing is left.
 */
export function excerpt(text, key = '') {
  let s = String(text ?? '');
  if (key) s = s.split(key).join('REDACTED');
  // eslint-disable-next-line no-control-regex
  s = redactKey(s).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, DETAIL_CHARS);
}

/** Index of the `}` closing the object that opens at `start`, honouring strings and escapes; -1 when it never closes. */
function balancedEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

const asObject = (s) => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/**
 * Model content -> plain object: trims, strips one surrounding markdown fence (```json ... ``` or ``` ... ```), parses
 * directly, and otherwise parses the first balanced top-level {...} in the text (prose before or after is ignored).
 * null when no object parses.
 */
export function parseJsonObject(content) {
  let text = String(content ?? '').trim();
  const fenced = text.match(/^```[\w-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/);
  if (fenced) text = fenced[1].trim();
  const direct = asObject(text);
  if (direct) return direct;
  for (let start = text.indexOf('{'); start >= 0;) {
    const end = balancedEnd(text, start);
    if (end < 0) { start = text.indexOf('{', start + 1); continue; }
    const v = asObject(text.slice(start, end + 1));
    if (v) return v;
    start = text.indexOf('{', end + 1);
  }
  return null;
}

/** `usage` of a chat-completions response as { prompt?, completion?, total? }; undefined when none of the counts is present. */
function usageOf(json) {
  const u = json?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const out = {};
  for (const [from, to] of [['prompt_tokens', 'prompt'], ['completion_tokens', 'completion'], ['total_tokens', 'total']]) {
    if (Number.isSafeInteger(u[from]) && u[from] >= 0) out[to] = u[from];
  }
  return Object.keys(out).length ? out : undefined;
}

/** One-line rendering of a failed result for the run log: `error[; finish_reason=..][; usage=..][; detail=".."]`. */
export function describeLlmFailure(result) {
  const parts = [result.error ?? 'failed'];
  if (result.finishReason) parts.push(`finish_reason=${result.finishReason}`);
  if (result.usage) parts.push(`usage=${JSON.stringify(result.usage)}`);
  if (result.detail) parts.push(`detail="${result.detail}"`);
  return parts.join('; ');
}

/** Mutates brief.digest with accepted values; returns the result state. `sleep` is injectable for tests. */
export async function editorialize(brief, config, fetchImpl = globalThis.fetch, { sleep = defaultSleep } = {}) {
  const { digest, facts } = brief;
  const { endpoint, key, model } = config;
  const fail = (error, info = {}) => {
    const out = { enabled: true, ok: false, model, error };
    if (nonEmpty(info.finishReason)) out.finishReason = info.finishReason.trim().slice(0, 40);
    if (info.usage) out.usage = info.usage;
    const detail = excerpt(info.detail, key);
    if (detail) out.detail = detail;
    return out;
  };
  const entries = [];
  const allowed = new Map();
  for (const section of digest.sections) {
    for (const e of section.entries) {
      if (entries.length >= 15) break;
      const signals = facts?.get?.(e.id)?.signals ?? {};
      entries.push({ id: e.id, section: section.key, title: e.title, summary: String(e.summary ?? '').slice(0, 300), sourceNames: e.sourceNames, signals });
      allowed.set(e.id, allowedSet({ ...e, summary: String(e.summary ?? '').slice(0, 300) }, section.key, signals));
    }
  }
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(entries) }];
  let body = { model, temperature: 0.3, max_tokens: MAX_TOKENS, response_format: { type: 'json_object' }, messages };
  let res;
  let raw;
  let retries = 0; // transient retries taken (compat retries are not counted: they fix the request, not the weather)
  const withAttempts = (error) => (retries > 0 ? `${error} (${retries + 1} attempts)` : error);
  const applied = new Set();
  for (;;) {
    try {
      res = await post(fetchImpl, endpoint, key, body);
    } catch (err) {
      // A timeout already cost 60 s and says the model is slow, not unavailable; it is not retried.
      if (err?.name === 'AbortError') return fail(withAttempts('timeout'));
      if (retries >= RETRY_BACKOFF_MS.length) return fail(withAttempts('network'));
      await sleep(RETRY_BACKOFF_MS[retries++]);
      continue;
    }
    if (res.status === 400) {
      const errText = await readSome(res);
      const fix = COMPAT_RETRIES.find((r) => !applied.has(r.name) && r.mentions.test(errText));
      if (!fix) return fail('HTTP 400', { detail: errText });
      applied.add(fix.name);
      body = fix.apply(body);
      continue;
    }
    if (TRANSIENT_STATUSES.has(res.status) && retries < RETRY_BACKOFF_MS.length) {
      const wait = retryAfterMs(res) ?? RETRY_BACKOFF_MS[retries];
      retries++;
      await readSome(res); // drain the connection before waiting
      await sleep(wait);
      continue;
    }
    break;
  }
  if (res.status < 200 || res.status >= 300) return fail(withAttempts(`HTTP ${res.status}`), { detail: await readSome(res) });
  try {
    raw = await res.text();
  } catch (err) {
    return fail(withAttempts(err?.name === 'AbortError' ? 'timeout' : 'network'));
  }
  let json;
  try { json = JSON.parse(raw); } catch { return fail('invalid JSON', { detail: raw }); }
  const usage = usageOf(json);
  const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
  if (!choice || typeof choice !== 'object') return fail('empty', { usage, detail: raw });
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined;
  const message = choice.message && typeof choice.message === 'object' ? choice.message : {};
  const content = typeof message.content === 'string' ? message.content : '';
  // A cut-off answer is never trusted, even if a prefix of it happens to parse (thinking spent the budget, or the JSON was cut).
  if (finishReason === 'length') return fail('truncated', { finishReason, usage, detail: content.trim() || message.reasoning_content || raw });
  if (!content.trim()) {
    if (nonEmpty(message.refusal)) return fail('refusal', { finishReason, usage, detail: message.refusal });
    if (nonEmpty(message.reasoning_content)) return fail('reasoning only', { finishReason, usage, detail: message.reasoning_content });
    return fail('empty', { finishReason, usage, detail: raw });
  }
  const parsed = parseJsonObject(content);
  if (!parsed) return fail('invalid JSON', { finishReason, usage, detail: content });
  let accepted = 0;
  const union = new Set();
  for (const set of allowed.values()) for (const n of set) union.add(n);
  if (typeof parsed.overview === 'string') {
    const text = parsed.overview.trim();
    const words = countWords(text);
    if (words >= 150 && words <= 200 && numberTokens(text).every((n) => union.has(n))) {
      digest.overview = { text, source: 'llm', model };
      accepted++;
    }
  }
  if (parsed.why && typeof parsed.why === 'object' && !Array.isArray(parsed.why)) {
    const byId = new Map();
    for (const s of digest.sections) for (const e of s.entries) byId.set(e.id, e);
    for (const [id, value] of Object.entries(parsed.why)) {
      const entry = byId.get(id);
      if (!entry || !allowed.has(id) || typeof value !== 'string') continue;
      const text = value.trim();
      if (!text || text.length > 200 || countWords(text) > 25) continue;
      if (!numberTokens(text).every((n) => allowed.get(id).has(n))) continue;
      entry.why = text;
      entry.whySource = 'llm';
      accepted++;
    }
  }
  if (accepted === 0) return fail('empty', { finishReason, usage, detail: content });
  enforceBudget(digest, 1100);
  const result = { enabled: true, ok: true, model };
  if (usage) result.usage = usage;
  return result;
}
