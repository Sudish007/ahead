import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW, read } from './helpers.js';
import { parseReddit, isRedditHost } from '../src/parsers/reddit.js';

const SRC = { id: 'reddit', category: 'news', type: 'reddit', url: 'https://www.reddit.com/r/LocalLLaMA+MachineLearning/top/.rss?t=day&limit=50', maxItems: 50 };

test('reddit multireddit: 12 items, external link extraction, permalinks, markers', () => {
  const r = parseReddit(read('reddit-multi-rss.xml'), SRC, { now: NOW, logger: { warn() {} } });
  assert.equal(r.fetched, 12);
  assert.equal(r.kept, 12);
  const external = r.items.filter((i) => i.url !== i.discussionUrl);
  assert.equal(external.length, 4);
  const hosts = external.map((i) => new URL(i.url).hostname).sort();
  assert.deepEqual(hosts, ['huggingface.co', 'huggingface.co', 'huggingface.co', 'warlock.ai']);
  const hosted = r.items.filter((i) => i.url === i.discussionUrl);
  assert.equal(hosted.length, 8);
  assert.ok(hosted.every((i) => /^https:\/\/www\.reddit\.com\/r\/(LocalLLaMA|MachineLearning)\/comments\//.test(i.url)));
  assert.ok(r.items.every((i) => i.extra.redditTopCurrent === true));
  assert.ok(r.items.every((i) => ['LocalLLaMA', 'MachineLearning'].includes(i.extra.subreddit)));
  assert.equal(r.items[3].extra.subreddit, 'MachineLearning');
  assert.ok(r.items.every((i) => !/submitted by|\[link\]|\[comments\]/.test(i.summaryText ?? '')));
  assert.ok(r.items[0].summaryText.startsWith('Google just released Harness2'));
  assert.equal(r.items[0].publishedAt.toISOString(), '2026-10-18T22:33:51.000Z');
  assert.ok(r.items.every((i) => i.signals === undefined));
});

test('isRedditHost covers reddit.com and redd.it subdomains', () => {
  assert.equal(isRedditHost('https://www.reddit.com/gallery/x'), true);
  assert.equal(isRedditHost('https://i.redd.it/x.png'), true);
  assert.equal(isRedditHost('https://preview.redd.it/x'), true);
  assert.equal(isRedditHost('https://reddit.com/r/x'), true);
  assert.equal(isRedditHost('https://huggingface.co/x'), false);
  assert.equal(isRedditHost('https://notreddit.com/x'), false);
});
