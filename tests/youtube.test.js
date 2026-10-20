import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CONFIG, NOW, ROOT, read, runFixture, quietLogger, expandUrl } from './helpers.js';
import { API_MAX_RESULTS, API_TIMEOUT_MS, fetchYoutubeApi, parsePlaylistItems, uploadsPlaylistId, youtubeApiUrl } from '../src/parsers/youtube.js';
import { parseFeed } from '../src/parsers/feed.js';
import { ParseError } from '../src/http.js';

const KEY = 'TESTKEY';
const urlOf = (id) => expandUrl(CONFIG.sources.find((s) => s.id === id).url, NOW);
const API = youtubeApiUrl(uploadsPlaylistId(urlOf('yt-gpumode')), KEY);
const FEED = urlOf('yt-gpumode');
const API_OK = { [API]: { body: read('youtube-playlistitems.json'), contentType: 'application/json' } };
const QUOTA_403 = { status: 403, body: '{"error":{"code":403,"message":"quota","errors":[{"reason":"quotaExceeded"}]}}', contentType: 'application/json' };
const tmp = () => mkdtempSync(path.join(tmpdir(), 'ahead-yt-'));
const unit = { id: 'x', category: 'media', type: 'youtube', maxItems: 100, maxAgeDays: 3650 };
const ctx = { now: NOW, logger: { warn() {} } };

test('uploadsPlaylistId derives UU… from the channel_id of every youtube source and rejects anything else', () => {
  const yt = CONFIG.sources.filter((s) => s.type === 'youtube');
  assert.equal(yt.length, 6);
  for (const s of yt) {
    const channelId = new URL(s.url).searchParams.get('channel_id');
    assert.match(channelId, /^UC/);
    assert.equal(uploadsPlaylistId(s.url), `UU${channelId.slice(2)}`);
  }
  assert.equal(uploadsPlaylistId(urlOf('yt-gpumode')), 'UUJgIbYl6C5no72a0NUAPcTA');
  assert.equal(uploadsPlaylistId('https://www.youtube.com/feeds/videos.xml?playlist_id=PLx'), null);
  assert.equal(uploadsPlaylistId('https://www.youtube.com/feeds/videos.xml'), null);
  assert.equal(uploadsPlaylistId('not a url'), null);
  assert.equal(uploadsPlaylistId('https://www.youtube.com/feeds/videos.xml?channel_id=PLabc'), null);
  assert.equal(uploadsPlaylistId('https://www.youtube.com/feeds/videos.xml?channel_id=UC%20x'), null);
});

test('youtubeApiUrl: fixed parameter order, 15 results, URL-encoded key', () => {
  assert.equal(API_MAX_RESULTS, 15);
  assert.equal(API_TIMEOUT_MS, 8000);
  assert.equal(youtubeApiUrl('UUJgIbYl6C5no72a0NUAPcTA', KEY), `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=15&playlistId=UUJgIbYl6C5no72a0NUAPcTA&key=${KEY}`);
  assert.ok(youtubeApiUrl('UUx', 'a b+c').endsWith('&key=a%20b%2Bc'));
});

test('parsePlaylistItems maps the fixture to feed-shaped records (title, watch URL, date, description, channel, no signals)', () => {
  const r = parsePlaylistItems(read('youtube-playlistitems.json'), unit, ctx);
  assert.equal(r.status, 'ok');
  assert.equal(r.fetched, 6);
  assert.equal(r.kept, 6);
  const [first] = r.items;
  assert.equal(first.title, 'GSQ-RCO: Better Non-Uniform GGUF Quantization');
  assert.equal(first.url, 'https://www.youtube.com/watch?v=ECZPAzT6VgQ');
  assert.equal(first.publishedAt.toISOString(), '2026-10-17T07:05:21.000Z');
  assert.deepEqual(first.authors, ['GPU MODE']);
  assert.ok(first.summaryText.startsWith('Michael Helcig'));
  assert.ok(!/\n/.test(first.summaryText), 'description newlines collapsed by cleanText');
  assert.equal(first.bodyLength, first.summaryText.length);
  assert.equal(first.signals, undefined);
  for (const key of ['extra', 'enclosureType', 'thumbnail', 'category', 'tag']) assert.ok(!(key in first), key);
  assert.ok(r.items.every((i, k) => i.nativeIndex === k));
  assert.ok(!('summaryText' in r.items[4]) && !('bodyLength' in r.items[4]), 'empty description -> no summary, no bodyLength');
  assert.equal(r.items[5].publishedAt.toISOString(), '2026-09-18T18:42:32.000Z', 'falls back to snippet.publishedAt');
  // Parity with the feed parser on the same six videos
  const feed = parseFeed(read('youtube-gpumode.xml'), unit, ctx);
  const project = (items) => items.map((i) => [i.title, i.url, i.publishedAt.toISOString(), i.authors[0]]);
  assert.deepEqual(project(r.items), project(feed.items));
  assert.equal(first.summaryText, feed.items[0].summaryText);
  assert.equal(first.bodyLength, feed.items[0].bodyLength);
});

test('parsePlaylistItems: media descriptions are cut before Sponsors: while bodyLength measures the whole description, as in the feed path', () => {
  const doc = JSON.parse(read('youtube-playlistitems.json'));
  doc.items = [doc.items[0]];
  const synopsis = 'A talk about kernels.';
  doc.items[0].snippet.description = `${synopsis}\n\nSponsors: Acme GPUs https://acme.test`;
  const media = parsePlaylistItems(JSON.stringify(doc), unit, ctx);
  assert.equal(media.items[0].summaryText, synopsis);
  assert.equal(media.items[0].bodyLength, `${synopsis} Sponsors: Acme GPUs https://acme.test`.length);
  const blog = parsePlaylistItems(JSON.stringify(doc), { ...unit, category: 'blogs' }, ctx);
  assert.match(blog.items[0].summaryText, /Sponsors:/);
});

test('parsePlaylistItems rejects non-JSON and foreign shapes; drops records without a video id or title and placeholders', () => {
  assert.throws(() => parsePlaylistItems('{ not json', unit, ctx), (e) => e instanceof ParseError && e.message === 'parse error: invalid json');
  for (const body of ['{"kind":"youtube#videoListResponse","items":[]}', '[]', '{"kind":"youtube#playlistItemListResponse"}', 'null', '"str"']) {
    assert.throws(() => parsePlaylistItems(body, unit, ctx), (e) => e instanceof ParseError && e.message === 'parse error: unexpected shape', body);
  }
  const doc = JSON.parse(read('youtube-playlistitems.json'));
  const good = doc.items[0];
  const clone = () => structuredClone(good);
  const noVideoId = clone(); delete noVideoId.contentDetails.videoId; delete noVideoId.snippet.resourceId;
  const badVideoId = clone(); badVideoId.contentDetails.videoId = 'bad id!';
  const noTitle = clone(); noTitle.snippet.title = '';
  const privateVideo = clone(); privateVideo.snippet.title = 'Private video';
  const deletedVideo = clone(); deletedVideo.snippet.title = 'Deleted video';
  const noContentDetails = clone(); delete noContentDetails.contentDetails;
  doc.items = [good, noVideoId, badVideoId, noTitle, privateVideo, deletedVideo, null, 'junk', noContentDetails];
  const r = parsePlaylistItems(JSON.stringify(doc), unit, ctx);
  assert.equal(r.fetched, 9);
  assert.equal(r.kept, 2);
  assert.deepEqual(r.items.map((i) => i.nativeIndex), [0, 8]);
  assert.equal(r.items[1].url, 'https://www.youtube.com/watch?v=ECZPAzT6VgQ', 'video id and date fall back to snippet.resourceId / snippet.publishedAt');
  assert.equal(r.items[1].publishedAt.toISOString(), '2026-10-17T07:05:21.000Z');
  const empty = parsePlaylistItems('{"kind":"youtube#playlistItemListResponse","items":[]}', unit, ctx);
  assert.deepEqual(empty, { status: 'empty', items: [], fetched: 0, kept: 0 });
});

test('fetchYoutubeApi makes exactly one JSON request with the 8 s timeout and never reports a URL', async () => {
  const calls = [];
  const source = { ...CONFIG.sources.find((s) => s.id === 'yt-gpumode') };
  const fakeCtx = {
    ...ctx,
    youtubeApiKey: KEY,
    fetchText: async (url, opts) => { calls.push({ url, opts }); return { status: 200, text: read('youtube-playlistitems.json'), finalUrl: url, contentType: 'application/json' }; },
  };
  const r = await fetchYoutubeApi(source, fakeCtx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, API);
  assert.equal(calls[0].opts.accept, 'application/json');
  assert.equal(calls[0].opts.timeoutMs, 8000);
  assert.equal(r.status, 'ok');
  assert.equal(r.note, 'api');
  assert.equal(r.httpStatus, 200);
  assert.equal(r.fetched, 6);
  assert.equal(r.kept, 2, 'maxAgeDays 7 and maxItems 5 applied like the feed path');
  assert.equal(r.finalUrl, undefined);
  assert.equal(r.requestedUrl, undefined);
  assert.ok(!JSON.stringify(r).includes(KEY));
  const noChannel = { ...source, url: 'https://www.youtube.com/feeds/videos.xml?playlist_id=PLx' };
  calls.length = 0;
  await assert.rejects(fetchYoutubeApi(noChannel, fakeCtx), (e) => e instanceof ParseError && e.message === 'parse error: no channel_id in url');
  assert.equal(calls.length, 0, 'no request without a channel id');
});

test('src/parsers/youtube.js never calls console directly', () => {
  const src = readFileSync(path.join(ROOT, 'src', 'parsers', 'youtube.js'), 'utf8');
  assert.equal((src.match(/console\.(log|info|warn|error|debug)/g) ?? []).length, 0);
});

const stripMs = ({ ms, ...rest }) => { assert.ok(Number.isInteger(ms) && ms >= 0); return rest; };
const FEED_RESULT = { id: 'yt-gpumode', name: 'GPU MODE', category: 'media', status: 'ok', fetched: 6, kept: 2, skipped: 4, httpStatus: 200 };
const FEED_IDS = ['8c1f5c0e880b1cda', '14b0c554409863f1'];

test('pipeline without a key (absent, empty or blank) uses the feed path and never calls googleapis.com', async () => {
  for (const env of [undefined, { YOUTUBE_API_KEY: '' }, { YOUTUBE_API_KEY: '   ' }]) {
    const calls = [];
    const r = await runFixture({ dataDir: tmp(), onlySourceIds: ['yt-gpumode'], dryRun: true, calls, ...(env ? { env } : {}) });
    assert.deepEqual(stripMs(r.sourceResults[0]), FEED_RESULT, JSON.stringify(env));
    assert.ok(!('note' in r.sourceResults[0]));
    assert.ok(!calls.some((c) => /googleapis\.com/.test(c.url)), 'no API call');
    assert.ok(calls.some((c) => c.url === FEED));
    assert.deepEqual(r.items.map((i) => i.id), FEED_IDS);
    assert.deepEqual(r.items.map((i) => i.signals), [{ ytViews: 1730 }, { ytViews: 1336 }]);
  }
});

test('pipeline with a key: one API request, no feed request, same items as the feed path minus view counts, key nowhere in the output', async () => {
  const logger = quietLogger();
  const calls = [];
  const api = await runFixture({ dataDir: tmp(), onlySourceIds: ['yt-gpumode'], dryRun: true, logger, calls, env: { YOUTUBE_API_KEY: KEY }, overrides: API_OK });
  assert.deepEqual(stripMs(api.sourceResults[0]), { ...FEED_RESULT, note: 'api' });
  assert.ok(!('error' in api.sourceResults[0]) && !('detail' in api.sourceResults[0]));
  assert.equal(calls.filter((c) => c.url === API).length, 1);
  assert.ok(!calls.some((c) => c.url === FEED), 'the feed is not requested when the API answered');
  assert.equal(calls.find((c) => c.url === API).init.headers.accept, 'application/json');
  assert.deepEqual(api.items.map((i) => i.id), FEED_IDS, 'same ids, so saved/read state in localStorage keeps working');
  const feed = await runFixture({ dataDir: tmp(), onlySourceIds: ['yt-gpumode'], dryRun: true });
  const SAME = ['id', 'title', 'url', 'canonicalUrl', 'publishedAt', 'surfacedAt', 'summary', 'authors', 'readMinutes', 'category', 'sources'];
  api.items.forEach((item, k) => {
    for (const key of SAME) assert.deepEqual(item[key], feed.items[k][key], `${key} of item ${k}`);
    assert.deepEqual(item.signals, {});
    assert.deepEqual(feed.items[k].signals, { ytViews: [1730, 1336][k] });
    assert.deepEqual(item.sources, [{ id: 'yt-gpumode', at: item.publishedAt }]);
  });
  assert.ok(!JSON.stringify(api).includes(KEY));
  assert.ok(!logger.sink.some(([, m]) => m.includes(KEY)));
});

test('an API failure falls back to the feed with a note; the items are exactly the feed-path items', async () => {
  const feed = await runFixture({ dataDir: tmp(), onlySourceIds: ['yt-gpumode'], dryRun: true });
  const cases = [
    [QUOTA_403, 'api: HTTP 403, fell back to feed'],
    [{ status: 400 }, 'api: HTTP 400, fell back to feed'],
    [{ status: 404 }, 'api: HTTP 404, fell back to feed'],
    [{ status: 503 }, 'api: HTTP 503, fell back to feed'],
    [{ throw: new TypeError('fetch failed') }, 'api: network, fell back to feed'],
    [{ body: 'not json', contentType: 'application/json' }, 'api: parse error: invalid json, fell back to feed'],
    [{ body: '{"kind":"youtube#videoListResponse","items":[]}', contentType: 'application/json' }, 'api: parse error: unexpected shape, fell back to feed'],
  ];
  for (const [override, note] of cases) {
    const logger = quietLogger();
    const calls = [];
    const r = await runFixture({ dataDir: tmp(), onlySourceIds: ['yt-gpumode'], dryRun: true, logger, calls, env: { YOUTUBE_API_KEY: KEY }, overrides: { [API]: override } });
    assert.deepEqual(stripMs(r.sourceResults[0]), { ...FEED_RESULT, note }, note);
    assert.ok(!('error' in r.sourceResults[0]) && !('detail' in r.sourceResults[0]), note);
    assert.equal(calls.filter((c) => c.url === API).length, 1, `${note}: the API is never retried`);
    assert.equal(calls.filter((c) => c.url === FEED).length, 1, `${note}: the feed is fetched once`);
    assert.deepEqual(r.items, feed.items, `${note}: items identical to the feed path, including ytViews`);
    const warn = logger.sink.filter(([lvl, m]) => lvl === 'warn' && /youtube api failed/.test(m));
    assert.equal(warn.length, 1, note);
    const errorClass = note.slice('api: '.length, note.length - ', fell back to feed'.length);
    assert.ok(warn[0][1].startsWith(`yt-gpumode: youtube api failed (${errorClass}); falling back to feed`), warn[0][1]);
    assert.ok(!logger.sink.some(([, m]) => m.includes(KEY)), `${note}: key never logged`);
    assert.ok(!JSON.stringify(r).includes(KEY), `${note}: key never in the result`);
  }
  const logger = quietLogger();
  await runFixture({ dataDir: tmp(), onlySourceIds: ['yt-gpumode'], dryRun: true, logger, env: { YOUTUBE_API_KEY: KEY }, overrides: { [API]: QUOTA_403 } });
  const [, line] = logger.sink.find(([lvl, m]) => lvl === 'warn' && /youtube api failed/.test(m));
  assert.match(line, /^yt-gpumode: youtube api failed \(HTTP 403\); falling back to feed \[.*quotaExceeded/);
});

test('when both the API and the feed fail the source reports exactly today\'s feed error plus the note', async () => {
  const logger = quietLogger();
  const r = await runFixture({ dataDir: tmp(), onlySourceIds: ['yt-gpumode'], dryRun: true, logger, env: { YOUTUBE_API_KEY: KEY }, overrides: { [API]: QUOTA_403, [FEED]: { status: 403 } } });
  const [row] = r.sourceResults;
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'HTTP 403');
  assert.equal(row.httpStatus, 403);
  assert.equal(row.note, 'api: HTTP 403, fell back to feed');
  assert.equal(row.fetched, 0);
  assert.equal(row.kept, 0);
  assert.deepEqual(r.items, []);
  const plain = await runFixture({ dataDir: tmp(), onlySourceIds: ['yt-gpumode'], dryRun: true, overrides: { [FEED]: { status: 403 } } });
  const { note, ms, ...withApi } = row;
  const { ms: plainMs, ...withoutApi } = plain.sourceResults[0];
  assert.deepEqual(withApi, withoutApi, 'status, error, httpStatus and counts match the key-less run');
  void note; void ms; void plainMs;
  assert.ok(!JSON.stringify(r).includes(KEY));
  assert.ok(!logger.sink.some(([, m]) => m.includes(KEY)));
});

test('a full fixture run with a key keeps the pipeline contract (every youtube source notes api, the rest unchanged)', async () => {
  const yt = CONFIG.sources.filter((s) => s.type === 'youtube');
  const overrides = {};
  for (const s of yt) overrides[youtubeApiUrl(uploadsPlaylistId(s.url), KEY)] = API_OK[API];
  const r = await runFixture({ dataDir: tmp(), dryRun: true, env: { YOUTUBE_API_KEY: KEY }, overrides });
  for (const s of yt) {
    const row = r.sourceResults.find((x) => x.id === s.id);
    assert.equal(row.note, 'api', s.id);
    assert.equal(row.httpStatus, 200, s.id);
    assert.equal(row.fetched, 6, s.id);
  }
  assert.ok(!JSON.stringify(r.meta).includes(KEY));
  assert.ok(!JSON.stringify(r.items).includes(KEY));
});
