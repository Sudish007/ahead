import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT, CONFIG } from './helpers.js';
import { validateItemsFile, validateDigest, validateDigestIndex, validateMeta, validateSitemapState } from '../src/schema.js';
import { countDigestWords } from '../src/brief.js';

const DATA = path.join(ROOT, 'data');
const files = ['items.json', 'meta.json', path.join('digests', 'index.json')].map((f) => path.join(DATA, f));
const present = files.every((f) => existsSync(f));
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

test('real data/ validates against the schemas', { skip: present ? false : 'data/ is empty (fresh clone): run npm run fetch first' }, () => {
  const items = readJson(files[0]);
  const meta = readJson(files[1]);
  const index = readJson(files[2]);
  validateItemsFile(items);
  assert.ok(statSync(files[0]).size <= 2_000_000);
  validateMeta(meta, CONFIG.sources.map((s) => s.id));
  for (const k of ['leaderboards', 'more', 'learn']) assert.ok(Array.isArray(meta.static[k]));
  const sitemapIds = CONFIG.sources.filter((s) => s.type === 'sitemap').map((s) => s.id);
  const warnings = [];
  const state = validateSitemapState(meta, sitemapIds, { warn: (m) => warnings.push(m) });
  assert.deepEqual(warnings, [], 'every sitemap marker/cache entry is valid');
  for (const map of [meta.sitemapSkipped, meta.sitemapCache]) {
    for (const [sid, m] of Object.entries(map)) {
      assert.ok(sitemapIds.includes(sid), sid);
      assert.ok(Object.keys(m).length <= 30);
    }
  }
  assert.deepEqual(state.sitemapCache, meta.sitemapCache);
  const digests = new Map();
  for (const day of index.days) {
    const file = path.join(DATA, 'digests', `${day.date}.json`);
    assert.ok(existsSync(file), file);
    const digest = readJson(file);
    validateDigest(digest);
    assert.ok(digest.wordCount <= 1100);
    assert.equal(digest.wordCount, countDigestWords(digest));
    assert.deepEqual(digest.itemIds, digest.sections.flatMap((s) => s.entries.map((e) => e.id)));
    assert.equal(digest.deepReadId, digest.sections.find((s) => s.key === 'deep-read')?.entries[0]?.id ?? null);
    assert.equal(day.entryCount, digest.itemIds.length);
    digests.set(day.date, digest);
  }
  validateDigestIndex(index, digests);
  assert.equal(meta.brief.date, index.days[0].date);
});
