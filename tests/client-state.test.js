import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeReadMap, sanitizeSavedMap, sanitizeLearnMap, sanitizeLastVisit, sanitizeRange, sanitizeTheme, nextTheme, createStore, selectCatchUpDays, healthStatus, sourceChipHref, signalText, relativeAge } from '../app.js';

const NOW_MS = Date.parse('2026-10-19T12:00:00Z');
const isNullProto = (o) => Object.getPrototypeOf(o) === null && Object.keys(o).length === 0;

test('map sanitizers: null/array/scalar -> null-prototype empty record', () => {
  for (const bad of [null, [], 'x', 42, undefined, true]) {
    assert.ok(isNullProto(sanitizeReadMap(bad, NOW_MS)));
    assert.ok(isNullProto(sanitizeLearnMap(bad)));
    assert.ok(isNullProto(sanitizeSavedMap(bad)));
  }
});

test('read map keeps valid timestamps, drops malformed and prunes > 30 days', () => {
  const out = sanitizeReadMap({ a: NOW_MS - 1000, b: 'x', c: -1, d: 1.5, e: NOW_MS - 31 * 86_400_000, '': NOW_MS, [`${'x'.repeat(201)}`]: NOW_MS, f: NOW_MS - 29 * 86_400_000 }, NOW_MS);
  assert.deepEqual({ ...out }, { a: NOW_MS - 1000, f: NOW_MS - 29 * 86_400_000 });
  assert.equal(Object.getPrototypeOf(out), null);
  assert.deepEqual({ ...sanitizeLearnMap({ cs336: 5, bad: NaN, neg: -1 }) }, { cs336: 5 });
  assert.ok(isNullProto(sanitizeLearnMap(Object.create({ inherited: 1 }))), 'non-plain prototypes are rejected');
});

test('saved map validates every snapshot field and keeps valid siblings', () => {
  const good = { title: 'T', url: 'https://x.test/a', sourceNames: ['A'], publishedAt: '2026-10-18T00:00:00Z', category: 'news', savedAt: 5 };
  const out = sanitizeSavedMap({
    ok: good,
    badUrl: { ...good, url: 'javascript:1' },
    badCat: { ...good, category: 'misc' },
    badTitle: { ...good, title: '' },
    longTitle: { ...good, title: 'x'.repeat(201) },
    badNames: { ...good, sourceNames: ['', 'x'] },
    manyNames: { ...good, sourceNames: Array(17).fill('a') },
    badDate: { ...good, publishedAt: 'yesterday' },
    badSaved: { ...good, savedAt: -1 },
    notRecord: 'x',
    arr: [good],
  });
  assert.deepEqual(Object.keys(out), ['ok']);
  assert.deepEqual(out.ok, good);
  assert.notEqual(out.ok, good, 'copied');
});

test('scalar sanitizers', () => {
  assert.equal(sanitizeLastVisit(123), 123);
  assert.equal(sanitizeLastVisit(1.5), 0);
  assert.equal(sanitizeLastVisit(-3), 0);
  assert.equal(sanitizeLastVisit('5'), 0);
  assert.equal(sanitizeLastVisit(undefined), 0);
  assert.equal(sanitizeRange('24h'), '24h');
  assert.equal(sanitizeRange('3d'), '3d');
  assert.equal(sanitizeRange('7d'), '7d');
  assert.equal(sanitizeRange('1w'), '7d');
  assert.equal(sanitizeRange(null), '7d');
});

test('theme sanitizer and cycle', () => {
  assert.equal(sanitizeTheme('light'), 'light');
  assert.equal(sanitizeTheme('dark'), 'dark');
  for (const bad of ['system', undefined, null, 'blue', 1, {}, ['light']]) assert.equal(sanitizeTheme(bad), 'system');
  assert.equal(nextTheme('system'), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'system');
  assert.equal(nextTheme('nonsense'), 'system');
});

test('store: throwing getItem/setItem -> one warning and in-memory fallback that keeps working', () => {
  const warnings = [];
  const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); } };
  const store = createStore(throwing, (m) => warnings.push(m));
  assert.equal(store.get('ahead:range', sanitizeRange), '7d');
  store.set('ahead:range', '3d');
  assert.equal(store.get('ahead:range', sanitizeRange), '3d');
  store.set('ahead:read', { a: 1 });
  assert.deepEqual({ ...store.get('ahead:read', (v) => sanitizeReadMap(v, 10)) }, { a: 1 });
  assert.equal(warnings.length, 1);
  assert.equal(store.inMemory, true);
  const quota = { data: {}, getItem(k) { return k in this.data ? this.data[k] : null; }, setItem() { throw new Error('QuotaExceeded'); } };
  const w2 = [];
  const s2 = createStore(quota, (m) => w2.push(m));
  s2.set('ahead:learn', { x: 1 });
  s2.set('ahead:learn', { x: 2 });
  assert.deepEqual({ ...s2.get('ahead:learn', sanitizeLearnMap) }, { x: 2 });
  assert.equal(w2.length, 1);
  const corrupt = { data: { 'ahead:read': '{ nope' }, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = v; } };
  const w3 = [];
  const s3 = createStore(corrupt, (m) => w3.push(m));
  assert.ok(isNullProto(s3.get('ahead:read', (v) => sanitizeReadMap(v, NOW_MS))));
  assert.equal(w3.length, 1);
  assert.equal(s3.inMemory, false);
  s3.set('ahead:range', '24h');
  assert.equal(corrupt.data['ahead:range'], '"24h"');
});

test('selectCatchUpDays (D5)', () => {
  const days = [{ date: '2026-10-19' }, { date: '2026-10-18' }, { date: '2026-10-17' }, { date: '2026-10-16' }];
  assert.deepEqual(selectCatchUpDays(days, Date.parse('2026-10-17T18:00:00Z'), '2026-10-19').map((d) => d.date), ['2026-10-18']);
  assert.deepEqual(selectCatchUpDays(days, Date.parse('2026-10-19T01:00:00Z'), '2026-10-19'), []);
  assert.deepEqual(selectCatchUpDays(days, Date.parse('2026-10-18T23:59:59Z'), '2026-10-19'), []);
  assert.deepEqual(selectCatchUpDays(days, 0, '2026-10-19').map((d) => d.date), ['2026-10-18', '2026-10-17', '2026-10-16']);
  const many = Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(30 - i).padStart(2, '0')}` }));
  const picked = selectCatchUpDays([{ date: '2026-10-19' }, ...many], 0, '2026-10-19');
  assert.equal(picked.length, 14);
  assert.equal(picked[0].date, '2026-09-30');
  const shuffled = [days[2], days[0], days[3], days[1]];
  assert.deepEqual(selectCatchUpDays(shuffled, 0, '2026-10-19').map((d) => d.date), ['2026-10-18', '2026-10-17', '2026-10-16']);
});

test('healthStatus states and strings', () => {
  const fresh = (failedCount) => ({ failedCount, generatedAt: new Date(NOW_MS - 3.6e6).toISOString() });
  assert.deepEqual(healthStatus(fresh(0), NOW_MS), { state: 'green', text: 'All sources OK' });
  assert.deepEqual(healthStatus(fresh(3), NOW_MS), { state: 'amber', text: '3 sources failed' });
  assert.deepEqual(healthStatus(fresh(1), NOW_MS), { state: 'amber', text: '1 source failed' });
  assert.deepEqual(healthStatus(fresh(7), NOW_MS), { state: 'red', text: '7 sources failed' });
  const old = { failedCount: 0, generatedAt: new Date(NOW_MS - 13 * 3.6e6).toISOString() };
  assert.deepEqual(healthStatus(old, NOW_MS), { state: 'red', text: 'Data is 13 h old' });
  assert.deepEqual(healthStatus({ ...old, failedCount: 2 }, NOW_MS), { state: 'red', text: '2 sources failed' });
  assert.equal(healthStatus(null, NOW_MS).state, 'red');
});

test('sourceChipHref (D6) and formatting helpers', () => {
  assert.equal(sourceChipHref({ homepage: 'https://www.anthropic.com/news' }, 'https://www.anthropic.com/news/x'), 'https://www.anthropic.com/news');
  assert.equal(sourceChipHref({ name: 'OpenAI' }, 'https://openai.com/index/x?y=1'), 'https://openai.com');
  assert.equal(sourceChipHref(undefined, 'https://example.com/a/b'), 'https://example.com');
  assert.equal(sourceChipHref({ homepage: 'javascript:1' }, 'https://example.com/a'), 'https://example.com');
  assert.equal(sourceChipHref(undefined, 'nope'), null);
  assert.equal(signalText({ hnPoints: 435, hnComments: 215, ghStars: 1200 }), '▲435 · 215 comments · 1.2k★');
  assert.equal(signalText({}), '');
  assert.equal(relativeAge(new Date(NOW_MS - 5 * 60000).toISOString(), NOW_MS), '5 min ago');
  assert.equal(relativeAge(new Date(NOW_MS - 3 * 3.6e6).toISOString(), NOW_MS), '3 h ago');
  assert.equal(relativeAge(new Date(NOW_MS - 72 * 3.6e6).toISOString(), NOW_MS), '3 d ago');
});
