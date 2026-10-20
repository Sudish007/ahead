import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW, read } from './helpers.js';
import { parseFeed, sniffFormat } from '../src/parsers/feed.js';
import { cleanText } from '../src/normalize.js';
import { ParseError } from '../src/http.js';

const ctx = { now: NOW, logger: { warn() {} } };
const src = (over = {}) => ({ id: 'x', category: 'blogs', type: 'rss', maxItems: 100, maxAgeDays: 3650, ...over });

const expectations = [
  ['openai-news.xml', 15, 'How Itaú is building generative AI for its entire customer base', '2026-10-16T19:00:00.000Z', 'https://openai.com/index/itau-generative-ai'],
  ['deepmind-blog.xml', 10, 'Accelerating the search for antimicrobial peptides with Google Antigravity', '2026-10-15T16:08:03.000Z', 'https://deepmind.google/blog/accelerating-antimicrobial-discovery/'],
  ['hf-blog.xml', 10, 'Scaling Indic Pretraining: 2.8 Trillion Tokens and an Open Data Generation Pipeline', '2026-10-16T01:44:47.000Z', 'https://huggingface.co/blog/nvidia/scaling-indic-pretraining'],
  ['mistral-news-rss.xml', 90, 'Introducing Timestral', '2026-10-15T12:00:00.000Z', 'https://mistral.ai/news/timestral/'],
  ['transformer-circuits-feed.xml', 56, 'Characterizing interference weights in a tiny language model', '2026-08-21T00:00:00.000Z', 'https://transformer-circuits.pub/2026/interference_effectiveness_helpfulness/index.html'],
  ['epoch-atom.xml', 10, 'Open-weight models trail closed models in cyber capabilities by 6–7 months', '2026-10-16T00:00:00.000Z', 'https://epoch.ai/data-insights/open-closed-cyber-eci-gap'],
  ['allenai-rss.xml', 8, 'HiRO-ACEv2: Simulating extreme weather at 3 km resolution for a fraction of the cost', '2026-10-14T08:00:00.000Z', 'https://allenai.org/blog/hiro-acev2'],
  ['substack-interconnects.xml', 5, 'Meta shakes up the frontiers, open and closed', '2026-10-17T14:06:54.000Z', 'https://www.interconnects.ai/p/meta-shakes-up-the-frontiers-open'],
  ['simonwillison-atom.xml', 8, 'llm-tools-datasette 0.1.1', '2026-10-18T23:43:09.000Z', 'https://simonwillison.net/2026/Oct/18/llm-tools-datasette/'],
  ['alignmentforum.xml', 2, 'The Alignment Problem: Computer Science Meets Analytic Philosophy', '2026-10-18T12:18:41.000Z', 'https://www.alignmentforum.org/posts/Emp7awtxsYn8MusNq/the-alignment-problem-computer-science-meets-analytic'],
  ['google-research.xml', 8, 'Grounding AI agents in biological reality: Building blocks for autonomous wet labs', '2026-10-16T18:11:34.000Z', 'https://research.google/blog/grounding-ai-agents-in-biological-reality-building-blocks-for-autonomous-wet-labs/'],
  ['nvidia-dev-blog-atom.xml', 8, 'Code, Test, and Deploy on One Machine with NVIDIA RTX Spark', '2026-10-16T17:00:00.000Z', 'https://developer.nvidia.com/blog/code-test-and-deploy-on-one-machine-with-nvidia-rtx-spark/'],
  ['meta-newsroom-ai.xml', 3, 'Introducing Muse Wonder and Muse Wonder Full: Frontier Models for Agents', '2026-10-12T17:08:05.000Z', 'https://about.fb.com/news/2026/10/introducing-muse-wonder-models/'],
  ['karpathy-bearblog-atom.xml', 3, 'Sequoia Ascent 2026 summary', '2026-04-30T16:00:00.000Z', 'https://karpathy.bearblog.dev/sequoia-ascent-2026/'],
  ['smol-ainews.xml', 2, 'not much happened today', '2026-09-09T05:44:39.000Z', 'https://news.smol.ai/issues/26-09-09-not-much/'],
  ['podcast-cognitive-revolution.xml', 5, "AI:AM: Where's the Steering Wheel? My Agent Set the Password, Hidden Valence, Proofs Find Linux Bugs", '2026-10-17T13:47:03.000Z', 'https://www.cognitiverevolution.ai/ai-am-where-s-the-steering-wheel-my-agent-set-the-password-hidden-valence-proofs-find-linux-bugs/'],
  ['podcast-mlst-anchor.xml', 5, 'What Most People Get Wrong About Evolution | Akarsh Kumar', '2026-10-10T05:48:01.000Z', 'https://podcasters.spotify.com/pod/show/machinelearningstreettalk/episodes/What-Most-People-Get-Wrong-About-Evolution--Akarsh-Kumar-e3q8ds7'],
  ['youtube-gpumode.xml', 6, 'GSQ-RCO: Better Non-Uniform GGUF Quantization', '2026-10-17T07:05:21.000Z', 'https://www.youtube.com/watch?v=ECZPAzT6VgQ'],
];

for (const [file, count, title, date, link] of expectations) {
  test(`feed fixture ${file}`, () => {
    const media = file.includes('podcast') || file.includes('youtube');
    const r = parseFeed(read(file), src({ category: media ? 'media' : 'blogs', type: file.includes('youtube') ? 'youtube' : 'rss' }), ctx);
    assert.equal(r.fetched, count);
    assert.equal(r.kept, count);
    assert.equal(r.items[0].title, title);
    assert.equal(r.items[0].publishedAt.toISOString(), date);
    assert.equal(r.items[0].url, link);
    assert.ok(r.items.every((i, k) => i.nativeIndex === k));
  });
}

test('format is sniffed from the body, never the header (Mistral text/plain)', () => {
  assert.equal(sniffFormat(read('mistral-news-rss.xml')), 'rss');
  assert.equal(sniffFormat(read('epoch-atom.xml')), 'atom');
  assert.equal(sniffFormat('<html><body>nope</body></html>'), null);
  assert.throws(() => parseFeed('<html><body>nope</body></html>', src(), ctx), (e) => e instanceof ParseError && e.message === 'parse error: not a feed');
  assert.throws(() => parseFeed('<rss><channel><item></rss>', src(), ctx), (e) => e instanceof ParseError && e.message === 'parse error: invalid xml');
});

test('HF blog items have no summaries; Mistral items may lack descriptions', () => {
  const r = parseFeed(read('hf-blog.xml'), src(), ctx);
  assert.ok(r.items.every((i) => i.summaryText === undefined));
  const m = parseFeed(read('mistral-news-rss.xml'), src(), ctx);
  assert.equal(m.items[1].title, 'Introducing Mistral Large 4');
  assert.equal(m.items[1].summaryText, undefined);
  assert.equal(m.items[0].summaryText, 'State-of-the-art probabilistic forecasting in four sizes (5M–209M params), CPU-efficient, zero-shot ready.');
});

test('Interconnects: exactly two audio enclosures re-route to media; the rest stay blogs', () => {
  const r = parseFeed(read('substack-interconnects.xml'), src({ id: 'interconnects' }), ctx);
  assert.equal(r.items.length, 5);
  const audio = r.items.filter((i) => typeof i.enclosureType === 'string' && i.enclosureType.startsWith('audio/'));
  assert.equal(audio.length, 2);
  assert.ok(audio.every((i) => i.category === 'media'));
  assert.equal(r.items.filter((i) => i.category === undefined).length, 3);
  assert.deepEqual(r.items[0].authors, ['Nathan Lambert']);
  assert.equal(r.items[0].summaryText, 'US open weights are back!');
  assert.ok(r.items[0].bodyLength > 1000, 'content:encoded body measured');
});

test('YouTube: ytViews signal and published (not updated) date', () => {
  const r = parseFeed(read('youtube-gpumode.xml'), src({ category: 'media', type: 'youtube' }), ctx);
  assert.equal(r.items[0].signals.ytViews, 1730);
  assert.equal(r.items[0].publishedAt.toISOString(), '2026-10-17T07:05:21.000Z');
  assert.ok(r.items[0].summaryText.startsWith('Michael Helcig'));
});

test('Epoch CDATA html title and multiple authors; Ai2 -08:00 offset', () => {
  const e = parseFeed(read('epoch-atom.xml'), src({ type: 'atom' }), ctx);
  assert.equal(e.items[0].title, 'Open-weight models trail closed models in cyber capabilities by 6–7 months');
  assert.deepEqual(e.items[0].authors, ['Jaeho Lee', 'Alexander Barry']);
  const a = parseFeed(read('allenai-rss.xml'), src(), ctx);
  assert.equal(a.items[0].publishedAt.toISOString(), '2026-10-14T08:00:00.000Z');
  assert.ok(a.items[0].summaryText.startsWith('HiRO-ACEv2 captures'));
  assert.ok(!/<img/.test(a.items[0].summaryText));
});

test('smol: content:encoded-only items get a summary and a cleaned bodyLength', () => {
  const xml = read('smol-ainews.xml');
  const r = parseFeed(xml, src(), ctx);
  assert.ok(r.items[0].summaryText.length > 0);
  const rawBody = /<content:encoded>([\s\S]*?)<\/content:encoded>/.exec(xml)[1];
  const decoded = rawBody.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  assert.equal(r.items[0].bodyLength, cleanText(decoded).length);
  assert.ok(r.items[0].bodyLength < rawBody.length);
});

test('Cognitive Revolution: synopsis kept, cut before Sponsors:, bodyLength from the full body', () => {
  const r = parseFeed(read('podcast-cognitive-revolution.xml'), src({ category: 'media' }), ctx);
  const i = r.items[0];
  assert.ok(i.summaryText.startsWith('Nathan Labenz and Prakash Narayanan'));
  assert.ok(!/Sponsors:/.test(i.summaryText));
  assert.ok(!/Parallel provides|OutSystems is/.test(i.summaryText));
  assert.ok(i.bodyLength > i.summaryText.length + 500, 'bodyLength measures the whole cleaned body');
  assert.ok(i.enclosureType.startsWith('audio/'));
});

test('maxAgeDays and maxItems apply in native order after parser drops', () => {
  const r = parseFeed(read('openai-news.xml'), { id: 'openai', category: 'labs', type: 'rss', maxItems: 3 }, ctx);
  assert.equal(r.fetched, 15);
  assert.equal(r.kept, 3);
  assert.deepEqual(r.items.map((i) => i.nativeIndex), [0, 1, 2]);
  const old = parseFeed(read('transformer-circuits-feed.xml'), { id: 'tc', category: 'labs', type: 'atom' }, ctx);
  assert.equal(old.status, 'empty');
  assert.equal(old.fetched, 56);
  assert.equal(old.kept, 0);
});
