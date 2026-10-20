// run(): validate config -> fetch all sources -> normalize/dedup -> merge with the previous run -> score ->
// retention/caps -> brief (+ optional LLM) -> meta -> validate -> atomic writes.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ACCEPT, createHttpClient, errorClass, errorSummary, formatDetail, redactKey, WallClockError } from './http.js';
import { buildRegistry, codePointCompare, sourceInfo } from './registry.js';
import { ConfigError, validateConfig, validateDigest, validateDigestIndex, validateItem, validateItemsFile, validateMeta, validateSitemapState } from './schema.js';
import { toItem } from './normalize.js';
import { parseFeed } from './parsers/feed.js';
import { fetchArxivSource } from './parsers/arxiv.js';
import { fetchYoutubeApi } from './parsers/youtube.js';
import { parseGithubSearch, parseHfModels, parseHfPapers, parseHn } from './parsers/json.js';
import { parseReddit } from './parsers/reddit.js';
import { parseSitemap } from './parsers/sitemap.js';
import { applyInvalidations, mergeItems, mergePrevious, stripEphemeral } from './dedup.js';
import { compareRank, score } from './score.js';
import { buildBrief, finalizeDigest } from './brief.js';
import { editorialize, resolveLlmConfig } from './llm.js';

export const SOURCE_BACKSTOP_MS = 45_000;
export const RUN_BUDGET_MS = 8 * 60_000;
export const WORKERS = 6;
export const MAX_ITEMS = 3000;
export const MAX_ITEMS_BYTES = 2_000_000;
const DAY = 86_400_000;
const DIGEST_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

export const defaultLogger = {
  warn: (...a) => console.error(...a),
  info: (...a) => console.error(...a),
  error: (...a) => console.error(...a),
  debug: () => {},
};

export function expandUrl(url, now) {
  const unix24hAgo = Math.floor(now.getTime() / 1000) - 86_400;
  const date7dAgo = new Date(now.getTime() - 7 * DAY).toISOString().slice(0, 10);
  return url.replace(/\{\{unix24hAgo\}\}/g, String(unix24hAgo)).replace(/\{\{date7dAgo\}\}/g, date7dAgo);
}

export function acceptFor(source) {
  if (source.type === 'json' || source.type === 'hn') return ACCEPT.json;
  if (source.type === 'github' && hostOf(source.url) === 'api.github.com') return ACCEPT.json;
  return ACCEPT.feed;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function pickParser(source) {
  switch (source.type) {
    case 'rss': case 'atom': case 'youtube': return parseFeed;
    case 'github': return hostOf(source.url) === 'api.github.com' ? parseGithubSearch : parseFeed;
    case 'json': return source.parser === 'hf-models' ? parseHfModels : parseHfPapers;
    case 'hn': return parseHn;
    case 'reddit': return parseReddit;
    case 'sitemap': return parseSitemap;
    default: throw new ConfigError(`unsupported source type ${source.type}`);
  }
}

/** Generic per-source runner with the 45 s backstop. `source.url` must already be template-expanded. */
export async function runSource(source, deps) {
  const { http, now, nowMs = Date.now, logger = defaultLogger, onRunner = false } = deps;
  // An empty or whitespace YOUTUBE_API_KEY (an unset repository secret renders as '') behaves exactly like an absent one.
  const youtubeApiKey = typeof deps.youtubeApiKey === 'string' ? deps.youtubeApiKey.trim() : '';
  const sourceStartedAtMs = nowMs();
  const deadlineAt = sourceStartedAtMs + SOURCE_BACKSTOP_MS;
  const accept = acceptFor(source);
  const fetchText = (url, opts = {}) => http.fetchText(url, { maxBytes: source.maxBytes ?? 8_000_000, accept, deadlineAt, ...opts });
  const ctx = {
    now, nowMs, fetchText, logger, youtubeApiKey,
    previousItemsByCanonicalUrl: deps.previousItemsByCanonicalUrl ?? new Map(),
    previousSitemapSkipped: deps.previousSitemapSkipped ?? {},
    previousSitemapCache: deps.previousSitemapCache ?? {},
    sourceStartedAtMs, deadlineAt,
  };
  let timer;
  const backstop = new Promise((_, reject) => { timer = setTimeout(() => reject(new WallClockError('wall clock')), SOURCE_BACKSTOP_MS); });
  let apiNote;
  const work = (async () => {
    if (source.type === 'arxiv') return fetchArxivSource(source, ctx);
    if (source.type === 'youtube' && youtubeApiKey) {
      try {
        return await fetchYoutubeApi(source, ctx);
      } catch (err) {
        // A failing API must never make a source worse than today: note it and run the feed path exactly as before.
        apiNote = `api: ${errorClass(err)}, fell back to feed`;
        const detail = formatDetail(err?.detail);
        logger.warn(`${source.id}: youtube api failed (${errorClass(err)}); falling back to feed${detail ? ` [${detail}]` : ''}`);
      }
    }
    const res = await fetchText(source.url);
    const result = await pickParser(source)(res.text, source, ctx);
    result.httpStatus = res.status;
    result.finalUrl = res.finalUrl;
    return result;
  })();
  work.catch(() => {});
  let result;
  try {
    result = await Promise.race([work, backstop]);
  } catch (err) {
    result = { status: 'failed', items: [], fetched: 0, kept: 0, error: errorSummary(err, { onRunner }) };
    if (Number.isInteger(err?.status)) result.httpStatus = err.status;
    const detail = formatDetail(err?.detail);
    if (detail) result.detail = detail;
    logger.warn(`${source.id}: ${result.error}${result.detail ? ` [${result.detail}]` : ''}`);
  } finally {
    clearTimeout(timer);
  }
  result.ms = Math.max(0, nowMs() - sourceStartedAtMs);
  if (apiNote) result.note = result.note ? `${result.note}; ${apiNote}` : apiNote;
  const requested = result.requestedUrl ?? source.url;
  delete result.requestedUrl;
  const sameUrl = (a, b) => { try { return new URL(a).href === new URL(b).href; } catch { return a === b; } };
  if (result.finalUrl && !sameUrl(result.finalUrl, requested)) {
    const note = `redirected to ${redactKey(result.finalUrl)}`;
    result.note = result.note ? `${result.note}; ${note}` : note;
  }
  return result;
}

async function readJson(file, logger, what) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') logger.warn(`${what} unreadable (${err.message}); starting without it`);
    return null;
  }
}

async function loadPrevious(dataDir, registry, logger, { withDigests }) {
  const itemsFile = await readJson(path.join(dataDir, 'items.json'), logger, 'previous items.json');
  const previousItems = [];
  if (itemsFile) {
    if (!Array.isArray(itemsFile.items)) logger.warn('previous items.json has no items array; starting empty');
    else for (const it of itemsFile.items) {
      try { validateItem(it); previousItems.push(it); } catch (err) { logger.warn(`dropping invalid stored item: ${err.message}`); }
    }
  }
  const metaFile = await readJson(path.join(dataDir, 'meta.json'), logger, 'previous meta.json');
  const sitemapIds = [...registry.values()].filter((s) => s.type === 'sitemap').map((s) => s.id);
  const state = validateSitemapState(metaFile ?? {}, sitemapIds, logger);
  const digests = [];
  if (withDigests) {
    let names = [];
    try { names = await readdir(path.join(dataDir, 'digests')); } catch { names = []; }
    for (const name of names) {
      const m = DIGEST_FILE_RE.exec(name);
      if (!m) continue;
      const d = await readJson(path.join(dataDir, 'digests', name), logger, `digest ${name}`);
      if (!d || d.date !== m[1] || !Array.isArray(d.sections) || !Array.isArray(d.itemIds)) { if (d) logger.warn(`digest ${name} has an unexpected shape; skipped`); continue; }
      digests.push(d);
    }
  }
  return { previousItems, previousState: state, digests };
}

function sizeTrim(items, generatedAt) {
  let list = items;
  let trimmed = 0;
  const bytes = () => Buffer.byteLength(JSON.stringify({ generatedAt, count: list.length, items: list }));
  while (list.length && bytes() > MAX_ITEMS_BYTES) {
    const n = Math.ceil(list.length * 0.05);
    list = list.slice(0, list.length - n);
    trimmed += n;
  }
  return { items: list, trimmed };
}

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  try {
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw new Error(`cannot write ${file}: ${err.message}`);
  }
}

export async function run({
  sources, linkouts, learn, now = new Date(), dataDir = 'data', fetchImpl = globalThis.fetch, env = process.env,
  logger = defaultLogger, nowMs = Date.now, onlySourceIds, dryRun = false, noLlm = false,
} = {}) {
  const runStart = nowMs();
  validateConfig({ sources, linkouts, learn });
  const registry = buildRegistry(sources);
  if (onlySourceIds !== undefined) {
    if (!Array.isArray(onlySourceIds) || onlySourceIds.length === 0) throw new ConfigError('onlySourceIds must be a non-empty array of source ids');
    if (new Set(onlySourceIds).size !== onlySourceIds.length) throw new ConfigError('onlySourceIds must not repeat ids');
    for (const id of onlySourceIds) if (!registry.has(id)) throw new ConfigError(`onlySourceIds names unknown source "${id}"`);
    if (dryRun !== true) throw new ConfigError('a source-filtered run is diagnostic only: pass dryRun: true (--dry-run)');
  }
  const diagnostic = onlySourceIds !== undefined;
  const http = createHttpClient({ fetchImpl, githubToken: typeof env?.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN : '', nowMs });
  const onRunner = env?.GITHUB_ACTIONS === 'true';
  const youtubeApiKey = typeof env?.YOUTUBE_API_KEY === 'string' ? env.YOUTUBE_API_KEY : '';

  const { previousItems, previousState, digests: previousDigests } = await loadPrevious(dataDir, registry, logger, { withDigests: !diagnostic });
  const previousItemsByCanonicalUrl = new Map(previousItems.map((it) => [it.canonicalUrl, it]));

  const selected = sources.map((s, i) => i).filter((i) => !diagnostic || onlySourceIds.includes(sources[i].id));
  const raw = new Array(selected.length);
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const k = next++;
      const source = { ...sources[selected[k]], url: expandUrl(sources[selected[k]].url, now) };
      if (nowMs() - runStart > RUN_BUDGET_MS) {
        logger.warn(`${source.id}: run budget exceeded`);
        raw[k] = { status: 'failed', items: [], fetched: 0, kept: 0, error: 'run budget exceeded', ms: 0 };
        continue;
      }
      raw[k] = await runSource(source, {
        http, now, nowMs, logger, onRunner, youtubeApiKey, previousItemsByCanonicalUrl,
        previousSitemapSkipped: previousState.sitemapSkipped[source.id] ?? {},
        previousSitemapCache: previousState.sitemapCache[source.id] ?? {},
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, selected.length) }, worker));

  // Normalize + accounting
  const candidates = [];
  const sourceResults = [];
  const invalidations = [];
  const sitemapMaps = { sitemapSkipped: {}, sitemapCache: {} };
  selected.forEach((registryIndex, k) => {
    const source = sources[registryIndex];
    const r = raw[k];
    let kept = r.kept;
    for (const item of r.items ?? []) {
      const normalized = toItem(item, source, now);
      if (!normalized) { kept--; continue; }
      candidates.push({ ...normalized, registryIndex, nativeIndex: item.nativeIndex });
    }
    kept = Math.max(0, kept);
    const status = r.status === 'ok' && kept === 0 ? 'empty' : r.status;
    const entry = { id: source.id, name: source.name, category: source.category, status, fetched: r.fetched ?? 0, kept, skipped: Math.max(0, (r.fetched ?? 0) - kept), ms: r.ms ?? 0 };
    if (Number.isInteger(r.httpStatus)) entry.httpStatus = r.httpStatus;
    if (r.note) entry.note = r.note;
    if (r.error) entry.error = r.error;
    if (typeof r.detail === 'string' && r.detail) entry.detail = r.detail;
    sourceResults.push(entry);
    if (source.type === 'sitemap') {
      if (r.status === 'failed') {
        sitemapMaps.sitemapSkipped[source.id] = previousState.sitemapSkipped[source.id] ?? {};
        sitemapMaps.sitemapCache[source.id] = previousState.sitemapCache[source.id] ?? {};
      } else {
        sitemapMaps.sitemapSkipped[source.id] = r.sitemapSkipped ?? {};
        sitemapMaps.sitemapCache[source.id] = r.sitemapCache ?? {};
        if (Array.isArray(r.invalidations)) invalidations.push(...r.invalidations);
      }
    }
  });
  const fresh = mergeItems(candidates, registry);

  if (diagnostic) {
    for (const it of fresh) it.score = score(it, now, registry);
    fresh.sort(compareRank);
    return { diagnostic: true, items: fresh, sourceResults };
  }

  // Merge with the previous run
  const stripped = previousItems.map(stripEphemeral);
  const adjusted = applyInvalidations(stripped, invalidations, registry, logger);
  let items = mergePrevious(adjusted, fresh, registry, logger);
  for (const it of items) it.score = score(it, now, registry);
  items.sort(compareRank);
  const nowTs = now.getTime();
  items = items.filter((it) => {
    const surfaced = Date.parse(it.surfacedAt);
    if (surfaced < nowTs - 7 * DAY) return false;
    const arxivOnly = it.sources.every((s) => sourceInfo(registry, s.id).family === 'arxiv') && Object.keys(it.signals ?? {}).length === 0;
    return !(arxivOnly && surfaced < nowTs - 3 * DAY);
  });
  items = items.slice(0, MAX_ITEMS);
  const generatedAt = now.toISOString();
  const trimmedResult = sizeTrim(items, generatedAt);
  items = trimmedResult.items;
  if (trimmedResult.trimmed) logger.warn(`items.json over ${MAX_ITEMS_BYTES} bytes; trimmed ${trimmedResult.trimmed} lowest-ranked items`);
  const previousIds = new Set(previousItems.map((it) => it.id));
  const newItemCount = items.filter((it) => !previousIds.has(it.id)).length;

  // Brief
  const today = generatedAt.slice(0, 10);
  const llmConfig = resolveLlmConfig(env ?? {}, { noLlm });
  const targetWords = llmConfig.eligible ? 880 : 1100;
  const briefInputs = previousDigests.filter((d) => d.date !== today && Date.parse(d.date) >= nowTs - 15 * DAY);
  const brief = buildBrief(items, briefInputs, now, { targetWords, registry });
  let llmResult = llmConfig.meta;
  if (llmConfig.eligible) {
    llmResult = await editorialize(brief, llmConfig, fetchImpl);
    if (!llmResult.ok) logger.warn(`LLM editorial layer failed: ${llmResult.error}`);
  }
  const digest = finalizeDigest(brief.digest);
  digest.llm = { enabled: llmResult.enabled, ok: llmResult.ok };

  // Index (rebuilt from the directory listing + today's digest)
  const dayEntry = (d) => ({ date: d.date, generatedAt: d.generatedAt, wordCount: d.wordCount, readingMinutes: d.readingMinutes, entryCount: d.itemIds.length });
  const others = previousDigests.filter((d) => d.date !== today);
  const digestIndex = { days: [dayEntry(digest), ...others.map(dayEntry)].sort((a, b) => codePointCompare(b.date, a.date)) };
  const digestsByDate = new Map([[digest.date, digest], ...others.map((d) => [d.date, d])]);

  // Meta
  const metaSources = {};
  for (const r of sourceResults) {
    const { id, ...rest } = r;
    const homepage = registry.get(id)?.homepage;
    metaSources[id] = homepage ? { ...rest, homepage } : rest;
  }
  const meta = {
    generatedAt,
    durationMs: Math.max(0, nowMs() - runStart),
    itemCount: items.length,
    newItemCount,
    trimmedForSize: trimmedResult.trimmed,
    sources: metaSources,
    okCount: sourceResults.filter((r) => r.status === 'ok').length,
    emptyCount: sourceResults.filter((r) => r.status === 'empty').length,
    failedCount: sourceResults.filter((r) => r.status === 'failed').length,
    sitemapSkipped: sitemapMaps.sitemapSkipped,
    sitemapCache: sitemapMaps.sitemapCache,
    llm: llmResult,
    brief: { date: digest.date, wordCount: digest.wordCount, readingMinutes: digest.readingMinutes },
    static: structuredClone({ ...linkouts, learn }),
  };

  const itemsFile = { generatedAt, count: items.length, items };
  validateItemsFile(itemsFile, { now });
  validateDigest(digest);
  validateDigestIndex(digestIndex, digestsByDate);
  validateMeta(meta, registry.keys());

  if (!dryRun) {
    await mkdir(path.join(dataDir, 'digests'), { recursive: true });
    await writeAtomic(path.join(dataDir, 'items.json'), JSON.stringify(itemsFile));
    await writeAtomic(path.join(dataDir, 'digests', `${digest.date}.json`), JSON.stringify(digest, null, 1));
    await writeAtomic(path.join(dataDir, 'digests', 'index.json'), JSON.stringify(digestIndex, null, 1));
    await writeAtomic(path.join(dataDir, 'meta.json'), JSON.stringify(meta, null, 1));
  }
  return { diagnostic: false, items, digest, digestIndex, meta, sourceResults };
}
