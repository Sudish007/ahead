import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW } from './helpers.js';
import { canonicalizeUrl, cleanText, extractArxivId, parseDate, toItem, truncate, itemId } from '../src/normalize.js';

test('canonicalizeUrl table', () => {
  const cases = [
    ['https://www.example.com/a/?utm_source=x&utm_medium=y&ref=z&fbclid=1', 'https://example.com/a'],
    ['http://Example.com/index.html', 'https://example.com/'],
    ['https://example.com/docs/index.html', 'https://example.com/docs'],
    ['https://example.com:443/x//y///z/', 'https://example.com/x/y/z'],
    ['https://huyenchip.com//2025/01/post/', 'https://huyenchip.com/2025/01/post'],
    ['https://example.com/a?b=2&a=1&s=share', 'https://example.com/a?a=1&b=2'],
    ['https://example.com/p%C3%A9/%2Fx?q=%20a', 'https://example.com/p%C3%A9/%2Fx?q=%20a'],
    ['https://www.youtube.com/watch?v=abc123&feature=share&t=10s', 'https://youtube.com/watch?v=abc123'],
    ['https://youtu.be/abc123?si=xyz', 'https://youtube.com/watch?v=abc123'],
    ['https://news.ycombinator.com/item?id=123&p=2', 'https://news.ycombinator.com/item?id=123'],
    ['https://arxiv.org/pdf/2610.22379v2.pdf', 'https://arxiv.org/abs/2610.22379'],
    ['http://export.arxiv.org/abs/2610.22379v1', 'https://arxiv.org/abs/2610.22379'],
    ['https://github.com/Foo/Bar.git?tab=readme', 'https://github.com/foo/bar?tab=readme'],
    ['https://github.com/Foo/Bar/issues/1', 'https://github.com/Foo/Bar/issues/1'],
    ['https://example.com/a#section', 'https://example.com/a'],
    ['https://example.com/', 'https://example.com/'],
  ];
  for (const [input, expected] of cases) assert.equal(canonicalizeUrl(input), expected, input);
  assert.equal(canonicalizeUrl('javascript:alert(1)'), null);
  assert.equal(canonicalizeUrl('not a url'), null);
  assert.equal(canonicalizeUrl('ftp://example.com/x'), null);
  assert.equal(canonicalizeUrl(42), null);
});

test('extractArxivId', () => {
  assert.equal(extractArxivId('https://arxiv.org/abs/2610.22379'), '2610.22379');
  assert.equal(extractArxivId('https://arxiv.org/pdf/2610.22379v3.pdf'), '2610.22379');
  assert.equal(extractArxivId('https://arxiv.org/html/2610.22379v1'), '2610.22379');
  assert.equal(extractArxivId('https://huggingface.co/papers/2610.22379'), '2610.22379');
  assert.equal(extractArxivId('https://www.alphaxiv.org/abs/2610.22379'), '2610.22379');
  assert.equal(extractArxivId('https://www.alphaxiv.org/overview/2610.22379v2'), '2610.22379');
  assert.equal(extractArxivId('https://arxiv.org/abs/cs/0112017'), 'cs/0112017');
  assert.equal(extractArxivId('arXiv:2610.22379v1 Announce Type: new'), '2610.22379');
  assert.equal(extractArxivId('https://example.com/2610.22379'), null);
  assert.equal(extractArxivId(null), null);
});

test('cleanText handles CDATA, entities, nested tags and scripts', () => {
  assert.equal(cleanText('<![CDATA[<p>Hello &amp; <b>world</b></p>]]>'), 'Hello & world');
  assert.equal(cleanText('a&nbsp;b &#8217;c&#x27;d &amp;amp; e'), 'a b ’c\'d & e');
  assert.equal(cleanText('<div><script>bad()</script><style>.x{}</style>ok</div>  <p>two</p>'), 'ok two');
  assert.equal(cleanText('&lt;p&gt;escaped&lt;/p&gt; html'), 'escaped html');
  assert.equal(cleanText(undefined), '');
});

test('parseDate accepts RFC 822 and ISO, rejects garbage and pre-2000, clamps the future', () => {
  assert.equal(parseDate('Mon, 19 Oct 2026 00:00:00 -0400', NOW).toISOString(), '2026-10-19T04:00:00.000Z');
  assert.equal(parseDate('Fri, 16 Oct 2026 01:44:47 GMT', NOW).toISOString(), '2026-10-16T01:44:47.000Z');
  assert.equal(parseDate('Thu, 15 Oct 2026 12:00:00 -0000', NOW).toISOString(), '2026-10-15T12:00:00.000Z');
  assert.equal(parseDate('2026-10-14T00:00:00-08:00', NOW).toISOString(), '2026-10-14T08:00:00.000Z');
  assert.equal(parseDate('garbage', NOW), undefined);
  assert.equal(parseDate('1999-12-31T00:00:00Z', NOW), undefined);
  assert.equal(parseDate('', NOW), undefined);
  assert.equal(parseDate('2027-01-01T00:00:00Z', NOW).getTime(), NOW.getTime());
});

test('truncate prefers sentence ends, then spaces, and appends an ellipsis', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('One sentence. Another longer sentence here.', 30), 'One sentence.…');
  assert.equal(truncate('no sentence end but many words to cut somewhere', 20), 'no sentence end but…');
  assert.ok(truncate('x'.repeat(50), 10).length <= 10);
});

test('toItem derives at per kind and applies maxAgeDays', () => {
  const feedSource = { id: 'openai', category: 'labs', type: 'rss' };
  const fresh = toItem({ title: 'T', url: 'https://openai.com/x', publishedAt: new Date('2026-10-18T00:00:00Z') }, feedSource, NOW);
  assert.equal(fresh.sources[0].at, '2026-10-18T00:00:00.000Z');
  assert.equal(fresh.surfacedAt, '2026-10-18T00:00:00.000Z');
  assert.equal(fresh.id, itemId('https://openai.com/x'));
  assert.equal(fresh.sources[0].url, undefined);
  const old = toItem({ title: 'T', url: 'https://openai.com/old', publishedAt: new Date('2026-10-11T11:00:00Z') }, feedSource, NOW);
  assert.equal(old, null);
  const undated = toItem({ title: 'T', url: 'https://openai.com/undated' }, feedSource, NOW);
  assert.equal(undated.publishedAt, NOW.toISOString());
  assert.equal(undated.surfacedAt, NOW.toISOString());
  const model = toItem({ title: 'o/m', url: 'https://huggingface.co/o/m', publishedAt: new Date('2025-01-01T00:00:00Z'), surfacedAt: NOW }, { id: 'hf-trending', category: 'releases', type: 'json' }, NOW);
  assert.equal(model.surfacedAt, NOW.toISOString());
  assert.equal(model.publishedAt, '2025-01-01T00:00:00.000Z');
  const paper = toItem({ title: 'P', url: 'https://huggingface.co/papers/2610.22379', arxivId: '2610.22379', surfacedAt: new Date('2026-10-19T00:00:00Z'), publishedAt: new Date('2026-10-15T00:00:00Z') }, { id: 'hf-papers', category: 'research', type: 'json', parser: 'hf-papers' }, NOW);
  assert.equal(paper.id, 'arxiv:2610.22379');
  assert.equal(paper.url, 'https://arxiv.org/abs/2610.22379');
  assert.equal(paper.sources[0].url, 'https://huggingface.co/papers/2610.22379');
  assert.equal(paper.sources[0].at, '2026-10-19T00:00:00.000Z');
  const hn = toItem({ title: 'H', url: 'https://example.com/a', discussionUrl: 'https://news.ycombinator.com/item?id=1', publishedAt: NOW, signals: { hnComments: 2, hnPoints: 3 } }, { id: 'hn-top', category: 'news', type: 'hn' }, NOW);
  assert.deepEqual(Object.keys(hn.signals), ['hnPoints', 'hnComments']);
  assert.equal(hn.sources[0].url, 'https://news.ycombinator.com/item?id=1');
  assert.equal(toItem({ title: '', url: 'https://x.test/' }, feedSource, NOW), null);
  assert.equal(toItem({ title: 'x', url: 'javascript:1' }, feedSource, NOW), null);
  const audio = toItem({ title: 'E', url: 'https://x.test/e', publishedAt: NOW, enclosureType: 'audio/mpeg', bodyLength: 2500 }, { id: 'interconnects', category: 'blogs', type: 'rss' }, NOW);
  assert.equal(audio.category, 'media');
  assert.equal(audio.readMinutes, 3);
});
