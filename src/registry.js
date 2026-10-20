// Run-scoped source registry shared by dedup, scoring, the brief and the pipeline.

export const UNKNOWN_SOURCE = Object.freeze({
  weight: 1, longForm: false, registryIndex: Infinity, category: null, type: null, parser: null,
});

/** Build the registry Map from the validated `sources` array. */
export function buildRegistry(sources) {
  return new Map(sources.map((s, registryIndex) => [s.id, {
    ...s,
    family: s.family ?? s.id,
    registryIndex,
    category: s.category ?? null,
    type: s.type ?? null,
    parser: s.parser ?? null,
  }]));
}

/** Resolve a source id with the fallback for ids no longer in the registry. */
export function sourceInfo(registry, id) {
  const known = registry.get(id);
  if (known) return known;
  return { id, name: id, family: id, ...UNKNOWN_SOURCE };
}

/** Raw Unicode code-point comparison (never localeCompare). */
export function codePointCompare(a, b) {
  const left = Array.from(String(a));
  const right = Array.from(String(b));
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const delta = left[i].codePointAt(0) - right[i].codePointAt(0);
    if (delta) return delta;
  }
  return left.length - right.length;
}
