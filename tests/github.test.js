import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW, read } from './helpers.js';
import { parseFeed } from '../src/parsers/feed.js';

const ctx = { now: NOW, logger: { warn() {} } };

test('pytorch releases feed is all CI tags -> empty', () => {
  const r = parseFeed(read('gh-releases-pytorch.xml'), { id: 'gh-rel-pytorch', category: 'releases', type: 'github', url: 'https://github.com/pytorch/pytorch/releases.atom', repo: 'pytorch/pytorch' }, ctx);
  assert.equal(r.status, 'empty');
  assert.equal(r.fetched, 10);
  assert.equal(r.kept, 0);
});

test('vllm releases: three entries with tags and repo-prefixed titles', () => {
  const r = parseFeed(read('gh-releases-vllm.xml'), { id: 'gh-rel-vllm', category: 'releases', type: 'github', url: 'https://github.com/vllm-project/vllm/releases.atom', repo: 'vllm-project/vllm' }, ctx);
  assert.equal(r.kept, 3);
  assert.deepEqual(r.items.map((i) => i.tag), ['v0.32.1rc0', 'v0.32.0', 'v0.32.0rc3']);
  assert.equal(r.items[0].title, 'vllm-project/vllm v0.32.1rc0');
  assert.equal(r.items[0].url, 'https://github.com/vllm-project/vllm/releases/tag/v0.32.1rc0');
  assert.ok(r.items[1].summaryText.length > 0);
  assert.ok(r.items[1].bodyLength >= r.items[1].summaryText.length);
});

test('llama.cpp: bNNNN build tags kept, maxItems 3 respected in native order', () => {
  const r = parseFeed(read('gh-releases-llamacpp.xml'), { id: 'gh-rel-llamacpp', category: 'releases', type: 'github', url: 'https://github.com/ggml-org/llama.cpp/releases.atom', repo: 'ggml-org/llama.cpp', maxItems: 3 }, ctx);
  assert.equal(r.fetched, 4);
  assert.equal(r.kept, 3);
  assert.ok(r.items.every((i) => /^b\d{4,}$/.test(i.tag)));
  assert.ok(r.items[0].title.startsWith('ggml-org/llama.cpp: b'));
  assert.deepEqual(r.items.map((i) => i.nativeIndex), [0, 1, 2]);
});
