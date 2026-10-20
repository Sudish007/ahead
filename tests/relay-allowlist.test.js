import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG, ROOT } from './helpers.js';
import { buildAllowlist, ALLOWLIST_NOTE } from '../relay/build-allowlist.mjs';
import { codePointCompare } from '../src/registry.js';
import { ACCEPT, ACCEPT_LANGUAGE, BROWSER_USER_AGENT } from '../src/http.js';

const FILE = path.join(ROOT, 'relay', 'src', 'allowlist.json');

test('relay/src/allowlist.json is exactly what build-allowlist.mjs generates from the config (run `node relay/build-allowlist.mjs` when this fails)', () => {
  const raw = readFileSync(FILE, 'utf8');
  assert.deepEqual(JSON.parse(raw), buildAllowlist(CONFIG.sources));
  assert.equal(raw, `${JSON.stringify(buildAllowlist(CONFIG.sources), null, 2)}\n`, 'formatting: 2-space JSON, LF, one trailing newline');
  assert.ok(!raw.includes('\r'));
});

test('the allowlist holds exactly the viaRelay sources, their page prefixes and the http.js headers', () => {
  const a = buildAllowlist(CONFIG.sources);
  const relayed = CONFIG.sources.filter((s) => s.viaRelay === true);
  assert.deepEqual(Object.keys(a), ['note', 'feeds', 'pages', 'headers']);
  assert.equal(a.note, ALLOWLIST_NOTE);
  assert.deepEqual(Object.keys(a.feeds), ['chinai', 'epoch-gradient-updates', 'importai', 'pod-dwarkesh', 'thebatch', 'zvi']);
  assert.equal(Object.keys(a.feeds).length, relayed.length);
  for (const s of relayed) assert.equal(a.feeds[s.id], s.url, s.id);
  assert.deepEqual(a.pages, { thebatch: 'https://www.deeplearning.ai/the-batch/' });
  for (const s of relayed.filter((x) => x.type === 'sitemap')) assert.equal(a.pages[s.id], s.relayPagePrefix, s.id);
  for (const id of Object.keys(a.pages)) assert.ok(id in a.feeds, `${id} has a page prefix but no feed`);
  const sorted = [...Object.keys(a.feeds)].sort(codePointCompare);
  assert.deepEqual(Object.keys(a.feeds), sorted);
  assert.deepEqual(a.headers, {
    'user-agent': BROWSER_USER_AGENT,
    'accept-language': ACCEPT_LANGUAGE,
    'accept-feed': ACCEPT.feed,
    'accept-html': ACCEPT.html,
  });
  for (const s of CONFIG.sources.filter((x) => x.viaRelay !== true)) assert.ok(!(s.id in a.feeds) && !(s.id in a.pages), s.id);
});

test('buildAllowlist sorts ids by code point, keeps only viaRelay === true and only string page prefixes', () => {
  const a = buildAllowlist([
    { id: 'b', type: 'rss', url: 'https://b.test/feed', viaRelay: true },
    { id: 'Z', type: 'sitemap', url: 'https://z.test/sitemap.xml', viaRelay: true, relayPagePrefix: 'https://z.test/p/' },
    { id: 'a', type: 'rss', url: 'https://a.test/feed', viaRelay: 'true' },
    { id: 'c', type: 'rss', url: 'https://c.test/feed' },
  ]);
  assert.deepEqual(a.feeds, { Z: 'https://z.test/sitemap.xml', b: 'https://b.test/feed' });
  assert.deepEqual(Object.keys(a.feeds), ['Z', 'b']);
  assert.deepEqual(a.pages, { Z: 'https://z.test/p/' });
  assert.deepEqual(buildAllowlist([]).feeds, {});
  assert.deepEqual(buildAllowlist([]).pages, {});
});
