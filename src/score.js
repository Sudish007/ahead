// Score = source weight x recency decay + log-scaled engagement + cross-source bonus; total ranking order.
import { codePointCompare, sourceInfo } from './registry.js';

export const HALF_LIFE_HOURS = 36;
export const ENGAGEMENT = { hfUpvotes: 1.0, hnPoints: 0.6, hnComments: 0.4, ghStars: 0.5, redditScore: 0.5, hfLikes: 0.5, ytViews: 0.15 };
export const CROSS_BONUS = 4;
export const CROSS_CAP = 3;

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function distinctFamilies(item, registry) {
  return new Set((item.sources ?? []).map((s) => sourceInfo(registry, s.id).family)).size;
}

export function score(item, now, registry) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const ageHours = Math.max(0, (nowMs - Date.parse(item.surfacedAt)) / 3.6e6);
  const decay = 0.5 ** (ageHours / HALF_LIFE_HOURS);
  const W = Math.max(1, ...(item.sources ?? []).map((s) => sourceInfo(registry, s.id).weight ?? 1));
  let E = 0;
  for (const [key, coef] of Object.entries(ENGAGEMENT)) {
    const v = item.signals?.[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) E += coef * Math.log2(1 + v);
  }
  const X = CROSS_BONUS * Math.min(CROSS_CAP, Math.max(0, distinctFamilies(item, registry) - 1));
  return round2(W * decay + E + X);
}

export const compareRank = (a, b) =>
  (b.score - a.score)
  || (Date.parse(b.surfacedAt) - Date.parse(a.surfacedAt))
  || codePointCompare(a.title, b.title)
  || codePointCompare(a.id, b.id);
