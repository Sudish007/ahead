// The 5-minute brief: deterministic section fill, heuristic why-lines and the hard word budget.
import { codePointCompare, sourceInfo } from './registry.js';
import { compareRank } from './score.js';
import { cutAtWord } from './normalize.js';

export const SECTIONS = [
  { key: 'must-know', title: 'Must know', n: 4 },
  { key: 'research', title: 'Research', n: 3 },
  { key: 'releases', title: 'Releases & tools', n: 3 },
  { key: 'labs', title: 'From the labs', n: 2 },
  { key: 'analysis', title: 'Analysis worth reading', n: 2 },
  { key: 'deep-read', title: 'One deep read', n: 1 },
];
const AINEWS_RE = /^\[AINews\]/;
const TRIM_ORDER = ['analysis', 'labs', 'releases', 'research', 'deep-read', 'must-know'];
const DROP_ORDER = ['research', 'releases', 'labs', 'analysis'];
const ABBREVIATIONS = /(?:\b(?:e\.g|i\.e|vs|et al|Fig|No))\.$/;
const enUS = new Intl.NumberFormat('en-US');
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const countWords = (t) => String(t ?? '').split(/\s+/).filter(Boolean).length;

export function countDigestWords(digest) {
  let n = 0;
  for (const s of digest.sections) {
    n += countWords(s.title);
    for (const e of s.entries) n += countWords(`${e.title} ${e.summary} ${e.why} ${(e.sourceNames ?? []).join(' ')}`);
  }
  if (digest.overview && typeof digest.overview.text === 'string') n += countWords(digest.overview.text);
  return n;
}

export function compact(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}m`;
}

export function splitSentences(text) {
  const parts = String(text ?? '').trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/);
  const out = [];
  for (const p of parts) {
    if (out.length && ABBREVIATIONS.test(out[out.length - 1])) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out.filter(Boolean);
}

/** D4: weight desc, at asc, id code-point asc. */
export function orderSources(item, registry) {
  return [...item.sources].sort((a, b) => {
    const ia = sourceInfo(registry, a.id);
    const ib = sourceInfo(registry, b.id);
    return (ib.weight - ia.weight) || (Date.parse(a.at) - Date.parse(b.at)) || codePointCompare(a.id, b.id);
  });
}

const isLongForm = (item, registry) => item.sources.some((s) => sourceInfo(registry, s.id).longForm);
const validCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function heuristicWhy(item, now, registry) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const ordered = orderSources(item, registry);
  const primary = sourceInfo(registry, ordered[0].id);
  const primaryFamily = primary.family;
  const signals = item.signals ?? {};
  const extra = item.extra ?? {};
  const clauses = [];
  const usedFamilies = new Set();
  const familiesOf = (pred) => ordered.map((s) => sourceInfo(registry, s.id)).filter(pred).map((i) => i.family);

  // 1. at most one HN clause
  const hnMarker = extra.hnFrontCurrent === true;
  const rank = Number.isInteger(extra.hnRank) && extra.hnRank > 0 ? extra.hnRank : undefined;
  const points = validCount(signals.hnPoints) ? signals.hnPoints : undefined;
  const comments = validCount(signals.hnComments) ? signals.hnComments : undefined;
  let hnClause;
  if (hnMarker) {
    hnClause = rank !== undefined ? `#${rank} on HN front page` : 'on HN front page';
    if (points !== undefined) hnClause += `, ${compact(points)} points`;
    if (comments !== undefined) hnClause += `, ${compact(comments)} comments`;
  } else if (points !== undefined && comments !== undefined) {
    hnClause = `${compact(points)} points on HN, ${compact(comments)} comments`;
  } else if (points !== undefined) {
    hnClause = `${compact(points)} points on HN`;
  } else if (comments !== undefined) {
    hnClause = `${compact(comments)} comments on HN`;
  }
  if (hnClause) { clauses.push(hnClause); usedFamilies.add('hn'); familiesOf((i) => i.type === 'hn').forEach((f) => usedFamilies.add(f)); }

  // 2. other factual clauses
  if (validCount(signals.hfUpvotes)) {
    clauses.push(`${compact(signals.hfUpvotes)} upvotes on HF Papers`);
    familiesOf((i) => i.parser === 'hf-papers').forEach((f) => usedFamilies.add(f));
  }
  const alsoNames = [];
  const seenFamilies = new Set([primaryFamily]);
  for (const s of ordered) {
    const info = sourceInfo(registry, s.id);
    if (seenFamilies.has(info.family) || usedFamilies.has(info.family)) continue;
    seenFamilies.add(info.family);
    alsoNames.push(info.name);
  }
  if (alsoNames.length) clauses.push(`also on ${alsoNames.join(', ')}`);
  if (validCount(signals.ghStars)) {
    const pub = Date.parse(item.publishedAt);
    const stars = enUS.format(signals.ghStars);
    if (Number.isFinite(pub) && pub <= nowMs) {
      const d = Math.max(1, Math.ceil((nowMs - pub) / DAY));
      clauses.push(`${stars} stars in ${d === 1 ? '1 day' : `${d} days`}`);
    } else {
      clauses.push(`${stars} stars on GitHub`);
    }
  }
  if (typeof item.tag === 'string' && item.tag.trim()) clauses.push(`new release ${item.tag.trim()}`);
  if (validCount(signals.hfLikes)) clauses.push(`${compact(signals.hfLikes)} likes on Hugging Face`);
  if (validCount(signals.ytViews)) clauses.push(`${compact(signals.ytViews)} views`);

  // 3. category fallback
  if (clauses.length === 0) {
    const source = primary.name || primary.id;
    const sub = typeof extra.subreddit === 'string' && extra.subreddit.trim() ? extra.subreddit.trim() : undefined;
    let fb;
    switch (item.category) {
      case 'labs': fb = `${source} announcement`; break;
      case 'research': fb = typeof extra.primaryCategory === 'string' && extra.primaryCategory.trim() ? `new on arXiv (${extra.primaryCategory.trim()})` : 'new research paper'; break;
      case 'blogs': fb = Number.isSafeInteger(item.readMinutes) && item.readMinutes > 0 ? `${source}, ~${item.readMinutes} min read` : `${source} analysis`; break;
      case 'releases': fb = `${source} release`; break;
      case 'media': fb = `new episode from ${source}`; break;
      default:
        if (sub && extra.redditTopCurrent === true) fb = `top of r/${sub} today`;
        else if (sub) fb = `from r/${sub}`;
        else if (item.sources.some((s) => sourceInfo(registry, s.id).type === 'hn')) fb = 'on HN';
        else fb = 'new discussion';
    }
    return cutAtWord(fb, 160);
  }
  // 4. join rule
  if (clauses.length >= 2) {
    const joined = `${clauses[0]}; ${clauses[1]}`;
    if (joined.length <= 160) return joined;
  }
  return cutAtWord(clauses[0], 160);
}

function entrySummary(summary) {
  const sentences = splitSentences(summary);
  if (!sentences.length) return '';
  let out = sentences[0];
  if (out.length > 280) return cutAtWord(out, 280);
  if (sentences[1] && `${out} ${sentences[1]}`.length <= 280) out = `${out} ${sentences[1]}`;
  return out;
}

function makeEntry(item, now, registry) {
  const ordered = orderSources(item, registry);
  const entry = {
    id: item.id,
    title: cutAtWord(item.title, 140),
    url: item.url,
  };
  if (item.discussionUrl) entry.discussionUrl = item.discussionUrl;
  entry.sourceIds = ordered.map((s) => s.id);
  entry.sourceNames = ordered.map((s) => sourceInfo(registry, s.id).name || s.id);
  entry.summary = entrySummary(item.summary);
  entry.why = heuristicWhy(item, now, registry);
  entry.whySource = 'heuristic';
  entry.publishedAt = item.publishedAt;
  entry.category = item.category;
  entry.score = item.score;
  if (Number.isSafeInteger(item.readMinutes) && item.readMinutes > 0) entry.readMinutes = item.readMinutes;
  return entry;
}

function utcDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

export function buildBrief(items, previousDigests, now, { targetWords = 1100, registry }) {
  const nowMs = now.getTime();
  const today = utcDate(nowMs);
  const prevDays = new Set([utcDate(nowMs - DAY), utcDate(nowMs - 2 * DAY)]);
  const used = new Set();
  const recentDeepReads = new Set();
  const sortedPrev = [...(previousDigests ?? [])].filter((d) => d && typeof d.date === 'string').sort((a, b) => codePointCompare(b.date, a.date));
  for (const d of sortedPrev) {
    if (prevDays.has(d.date) && Array.isArray(d.itemIds)) d.itemIds.forEach((id) => used.add(id));
  }
  for (const d of sortedPrev.filter((d) => d.date < today).slice(0, 14)) {
    if (typeof d.deepReadId === 'string' && d.deepReadId) recentDeepReads.add(d.deepReadId);
  }

  const inWindow = (hours) => items.filter((it) => Date.parse(it.surfacedAt) >= nowMs - hours * HOUR && !used.has(it.id));
  let pool = inWindow(36);
  if (pool.length < 20) pool = inWindow(72);
  pool = [...pool].sort(compareRank);
  const picked = new Set();
  const take = (candidates, n) => {
    const out = [];
    for (const c of candidates) {
      if (out.length >= n) break;
      if (picked.has(c.id)) continue;
      picked.add(c.id);
      out.push(c);
    }
    return out;
  };
  const remaining = () => pool.filter((it) => !picked.has(it.id));
  const analysisLongForm = (x) => (Number.isSafeInteger(x.readMinutes) && x.readMinutes >= 5) || isLongForm(x, registry);
  const chosen = {};
  chosen['must-know'] = take(remaining(), 4);
  chosen.research = take(remaining().filter((it) => it.category === 'research'), 3);
  chosen.releases = take(remaining().filter((it) => it.category === 'releases'), 3);
  chosen.labs = take(remaining().filter((it) => it.category === 'labs'), 2);
  chosen.analysis = take(
    remaining().filter((it) => it.category === 'blogs' && !AINEWS_RE.test(it.title))
      .sort((a, b) => (Number(analysisLongForm(b)) - Number(analysisLongForm(a))) || compareRank(a, b)),
    2,
  );
  const deepPool = items
    .filter((it) => it.category === 'blogs' && !AINEWS_RE.test(it.title) && Date.parse(it.surfacedAt) >= nowMs - 7 * DAY
      && !used.has(it.id) && !picked.has(it.id) && !recentDeepReads.has(it.id))
    .sort(compareRank);
  const deep = deepPool.find((it) => (Number.isSafeInteger(it.readMinutes) && it.readMinutes >= 8) || isLongForm(it, registry)) ?? deepPool[0];
  chosen['deep-read'] = deep ? take([deep], 1) : [];

  const facts = new Map();
  const sections = SECTIONS.map(({ key, title }) => ({
    key,
    title,
    entries: chosen[key].map((it) => {
      facts.set(it.id, { signals: { ...(it.signals ?? {}) } });
      return makeEntry(it, now, registry);
    }),
  }));
  const digest = {
    date: today,
    generatedAt: now.toISOString(),
    wordCount: 0,
    readingMinutes: 1,
    overview: null,
    sections,
    itemIds: [],
    deepReadId: null,
    llm: { enabled: false, ok: false },
  };
  enforceBudget(digest, targetWords);
  finalizeDigest(digest);
  return { digest, facts };
}

function* trimTargets(digest, includeMustKnow) {
  for (const key of TRIM_ORDER) {
    if (key === 'must-know' && !includeMustKnow) continue;
    const section = digest.sections.find((s) => s.key === key);
    if (!section) continue;
    for (let i = section.entries.length - 1; i >= 0; i--) yield section.entries[i];
  }
}

function capWords(text, n) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (words.length <= n) return String(text ?? '');
  return `${words.slice(0, n).join(' ')}…`;
}

export function enforceBudget(digest, targetWords) {
  const over = () => countDigestWords(digest) > targetWords;
  if (!over()) return digest;
  // Stage 1: one sentence / 160 chars (pass 1 without must-know, pass 2 with it)
  for (const includeMustKnow of [false, true]) {
    for (const e of trimTargets(digest, includeMustKnow)) {
      if (!e.summary) continue;
      const first = splitSentences(e.summary)[0] ?? '';
      const trimmed = cutAtWord(first, 160);
      if (trimmed !== e.summary) { e.summary = trimmed; if (!over()) return digest; }
    }
  }
  // Stage 2: drop last entries, cycling, never below one
  let dropped = true;
  while (over() && dropped) {
    dropped = false;
    for (const key of DROP_ORDER) {
      const section = digest.sections.find((s) => s.key === key);
      if (section && section.entries.length > 1) {
        section.entries.pop();
        dropped = true;
        if (!over()) return digest;
      }
    }
  }
  // Stage 3: summaries to 120 chars
  for (const e of trimTargets(digest, true)) {
    if (e.summary && e.summary.length > 120) { e.summary = cutAtWord(e.summary, 120); if (!over()) return digest; }
  }
  // Stage 4: empty summaries one by one
  for (const e of trimTargets(digest, true)) {
    if (e.summary) { e.summary = ''; if (!over()) return digest; }
  }
  // Stage 5: cap every title and why at 12 words
  for (const e of trimTargets(digest, true)) {
    e.title = capWords(e.title, 12);
    e.why = capWords(e.why, 12);
  }
  if (!over()) return digest;
  // Stage 6: first three labels (D4 order) of <= 6 words each, plus "+N sources"
  for (const e of trimTargets(digest, true)) {
    const labels = e.sourceNames.slice(0, 3).map((l) => capWords(l, 6));
    if (e.sourceIds.length > 3) labels.push(`+${e.sourceIds.length - 3} sources`);
    e.sourceNames = labels;
  }
  if (over()) throw new Error(`internal: brief exceeds ${targetWords} words after all budget stages (${countDigestWords(digest)})`);
  return digest;
}

export function finalizeDigest(digest) {
  digest.itemIds = digest.sections.flatMap((s) => s.entries.map((e) => e.id));
  digest.deepReadId = digest.sections.find((s) => s.key === 'deep-read')?.entries[0]?.id ?? null;
  digest.wordCount = countDigestWords(digest);
  digest.readingMinutes = Math.max(1, Math.ceil(digest.wordCount / 220));
  return digest;
}
