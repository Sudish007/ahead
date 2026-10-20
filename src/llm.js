// Optional OpenAI-compatible editorial layer: 150-200 word overview + why-lines, validated against the sent facts.
import { countWords, enforceBudget } from './brief.js';

export const SYSTEM_PROMPT = [
  'You are the editor of a one-page daily AI brief for an expert reader (researcher, founder, senior engineer).',
  'Using only the facts given in the user message, write:',
  '1. "overview": 150-200 words of plain English, no hype, naming the 3-5 developments that matter most today and why.',
  '2. "why": an object mapping each entry id to one line of at most 25 words saying why that entry matters to a researcher or founder.',
  'Never invent numbers, names, benchmarks or quotes that are not in the facts. Do not add entries.',
  'Output only JSON of the form { "overview": string, "why": { "<id>": string } } with no markdown fences or commentary.',
].join('\n');

const NUMBER_RE = /#?[+-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+)(?:%|[kKmMbB]|x)?/g;
const LLM_TIMEOUT_MS = 60_000;
const MAX_ERROR_BODY = 16 * 1024;

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

/** Mutates brief.digest with accepted values; returns the result state. */
export async function editorialize(brief, config, fetchImpl = globalThis.fetch) {
  const { digest, facts } = brief;
  const { endpoint, key, model } = config;
  const fail = (error) => ({ enabled: true, ok: false, model, error });
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
  const body = { model, temperature: 0.3, max_tokens: 1500, messages };
  let res;
  try {
    res = await post(fetchImpl, endpoint, key, body);
    if (res.status === 400) {
      const errText = await readSome(res);
      if (/max_tokens/i.test(errText)) {
        const { max_tokens: _omit, ...rest } = body;
        res = await post(fetchImpl, endpoint, key, { ...rest, max_completion_tokens: 1500 });
      } else {
        return fail('HTTP 400');
      }
    }
  } catch (err) {
    return fail(err?.name === 'AbortError' ? 'timeout' : 'network');
  }
  if (!res || res.status < 200 || res.status >= 300) return fail(`HTTP ${res?.status ?? 0}`);
  let parsed;
  try {
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return fail('empty');
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start < 0 || end <= start) return fail('invalid JSON');
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return fail('invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object') return fail('invalid JSON');
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
  if (accepted === 0) return fail('empty');
  enforceBudget(digest, 1100);
  return { enabled: true, ok: true, model };
}
