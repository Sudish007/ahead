// Shared per-source selection: parser drops happened already; apply maxAgeDays then maxItems in native order.

export function applySelection(records, source, ctx, fetched, note) {
  const maxAgeDays = source.maxAgeDays ?? 7;
  const maxItems = source.maxItems ?? 40;
  const cutoff = ctx.now.getTime() - maxAgeDays * 86_400_000;
  const aged = records.filter((r) => {
    const d = r.surfacedAt ?? r.publishedAt;
    return !(d instanceof Date) || d.getTime() >= cutoff;
  });
  const items = aged.slice(0, maxItems);
  const out = { status: items.length ? 'ok' : 'empty', items, fetched, kept: items.length };
  if (note) out.note = note;
  return out;
}

export const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

export function finiteNonNegative(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function nonNegativeInteger(v) {
  const n = finiteNonNegative(v);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}
