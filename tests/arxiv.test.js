import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW, read } from './helpers.js';
import { fetchArxivSource } from '../src/parsers/arxiv.js';
import { HttpError } from '../src/http.js';

const SOURCE = { id: 'arxiv-cs.LG', category: 'research', type: 'arxiv', url: 'https://rss.arxiv.org/rss/cs.LG', fallbackUrl: 'https://export.arxiv.org/api/query?x', weight: 3, family: 'arxiv', maxItems: 60 };
const REPLACED = ['1906.07073', '2306.02002', '2503.15889', '2307.07030', '2310.16659'];

function ctxWith(responses, calls = []) {
  return {
    now: NOW,
    logger: { warn: (m) => calls.push(['warn', m]) },
    fetchText: async (url) => {
      calls.push(['fetch', url]);
      const r = responses[url];
      if (r === undefined) throw new Error(`unexpected ${url}`);
      if (r instanceof Error) throw r;
      return { status: 200, text: r, finalUrl: url, contentType: 'application/xml' };
    },
  };
}

test('cs.LG RSS: 18 fetched, 13 kept, no replace announcements, fixture order', async () => {
  const calls = [];
  const r = await fetchArxivSource(SOURCE, ctxWith({ [SOURCE.url]: read('arxiv-rss-cs.LG.xml') }, calls));
  assert.equal(r.status, 'ok');
  assert.equal(r.fetched, 18);
  assert.equal(r.kept, 13);
  const ids = r.items.map((i) => i.arxivId);
  for (const id of REPLACED) assert.ok(!ids.includes(id), id);
  assert.equal(ids[0], '2610.22379');
  assert.ok(r.items[0].summaryText.startsWith('Calibrating expensive engineering simulators'));
  assert.deepEqual(r.items[0].authors, ['Ruo-Qian Wang']);
  assert.equal(r.items[0].extra.primaryCategory, 'cs.LG');
  assert.equal(r.items[0].publishedAt.toISOString(), '2026-10-19T04:00:00.000Z');
  assert.deepEqual(r.items[3].authors, ['Hariharan Srinivasan', 'Masoom Bhargava', 'Sayan Gupta']);
  assert.equal(calls.filter((c) => c[0] === 'fetch').length, 1, 'no fallback request');
  assert.equal(r.note, undefined);
});

test('maxItems 5 keeps the first five non-replace announcements in fixture order', async () => {
  const r = await fetchArxivSource({ ...SOURCE, maxItems: 5 }, ctxWith({ [SOURCE.url]: read('arxiv-rss-cs.LG.xml') }));
  assert.equal(r.fetched, 18);
  assert.equal(r.kept, 5);
  assert.deepEqual(r.items.map((i) => i.arxivId), ['2610.22379', '2610.22380', '2610.22381', '2610.22430', '2610.22433']);
});

test('valid empty RSS invokes the API fallback', async () => {
  const calls = [];
  const r = await fetchArxivSource(SOURCE, ctxWith({ [SOURCE.url]: read('arxiv-rss-cs.AI-empty.xml'), [SOURCE.fallbackUrl]: read('arxiv-api-cs.LG.xml') }, calls));
  assert.equal(r.status, 'ok');
  assert.equal(r.fetched, 10);
  assert.equal(r.kept, 10);
  assert.equal(r.note, 'api fallback');
  assert.equal(r.items[0].arxivId, '2610.23847');
  assert.ok(r.items.every((i) => !/v\d+$/.test(i.arxivId)));
  assert.ok(r.items.every((i) => i.extra.via === 'api'));
  assert.equal(r.items[0].extra.primaryCategory, 'cs.CL');
  assert.equal(r.items[0].authors.length, 5);
  assert.equal(calls.filter((c) => c[0] === 'fetch').length, 2);
});

test('primary HTTP failure + valid API -> ok with API counts', async () => {
  const r = await fetchArxivSource(SOURCE, ctxWith({ [SOURCE.url]: new HttpError(503, SOURCE.url), [SOURCE.fallbackUrl]: read('arxiv-api-cs.LG.xml') }));
  assert.equal(r.status, 'ok');
  assert.equal(r.fetched, 10);
  assert.equal(r.note, 'api fallback');
});

test('primary and fallback both fail -> failed 0/0 with the fallback error class', async () => {
  const calls = [];
  const r = await fetchArxivSource(SOURCE, ctxWith({ [SOURCE.url]: new HttpError(503, SOURCE.url), [SOURCE.fallbackUrl]: new HttpError(429, SOURCE.fallbackUrl) }, calls));
  assert.equal(r.status, 'failed');
  assert.equal(r.fetched, 0);
  assert.equal(r.kept, 0);
  assert.equal(r.error, 'HTTP 429');
  assert.ok(calls.some((c) => c[0] === 'warn' && /HTTP 503/.test(c[1]) && /HTTP 429/.test(c[1])));
});

test('valid empty RSS + fallback failure -> empty with note', async () => {
  const r = await fetchArxivSource(SOURCE, ctxWith({ [SOURCE.url]: read('arxiv-rss-cs.AI-empty.xml'), [SOURCE.fallbackUrl]: new TypeError('fetch failed') }));
  assert.equal(r.status, 'empty');
  assert.equal(r.fetched, 0);
  assert.equal(r.kept, 0);
  assert.equal(r.note, 'api fallback failed');
});

test('all-replace RSS -> empty with nonzero fetched and no fallback call', async () => {
  const xml = read('arxiv-rss-cs.LG.xml');
  const items = xml.split('<item>').slice(1).map((s) => `<item>${s.split('</item>')[0]}</item>`);
  const replaceOnly = items.filter((it) => /<arxiv:announce_type>replace/.test(it));
  assert.equal(replaceOnly.length, 5);
  const body = `${xml.split('<item>')[0]}${replaceOnly.join('\n')}</channel></rss>`;
  const calls = [];
  const r = await fetchArxivSource(SOURCE, ctxWith({ [SOURCE.url]: body }, calls));
  assert.equal(r.status, 'empty');
  assert.equal(r.fetched, 5);
  assert.equal(r.kept, 0);
  assert.equal(calls.filter((c) => c[0] === 'fetch').length, 1);
  assert.equal(r.note, undefined);
});

test('invalid primary XML falls back to the API', async () => {
  const r = await fetchArxivSource(SOURCE, ctxWith({ [SOURCE.url]: '<rss><channel><item></rss>', [SOURCE.fallbackUrl]: read('arxiv-api-cs.LG.xml') }));
  assert.equal(r.status, 'ok');
  assert.equal(r.note, 'api fallback');
});
