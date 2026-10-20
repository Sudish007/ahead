import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, NOW, runFixture } from './helpers.js';

const PRELOAD = pathToFileURL(path.join(ROOT, 'tests', 'preload-fixture-fetch.mjs')).href;
const FETCH = path.join(ROOT, 'scripts', 'fetch.mjs');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'ahead-cli-'));

function runCli(args, env = {}) {
  const callsFile = path.join(tmp(), 'calls.txt');
  const r = spawnSync(process.execPath, ['--import', PRELOAD, FETCH, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, AHEAD_TEST_CALLS: callsFile, LLM_API_KEY: '', LLM_MODEL: '', YOUTUBE_API_KEY: '', ...env },
  });
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : [];
  return { ...r, calls };
}

test('--source without --dry-run exits 1 before any fetch or write', () => {
  const dataDir = tmp();
  const r = runCli(['--source', 'hn-top', '--data-dir', dataDir, '--now', NOW.toISOString()]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--dry-run/);
  assert.equal(r.stdout, '');
  assert.equal(r.calls.length, 0);
  assert.equal(readdirSync(dataDir).length, 0);
});

test('--now must be an ISO timestamp; unknown flags exit 1', () => {
  assert.equal(runCli(['--now', 'yesterday']).status, 1);
  assert.equal(runCli(['--bogus']).status, 1);
});

test('--source hn-top,hf-papers --dry-run fetches only those ids, prints one table, writes nothing, calls no LLM', () => {
  const dataDir = tmp();
  const r = runCli(['--source', 'hn-top,hf-papers', '--dry-run', '--data-dir', dataDir, '--now', NOW.toISOString()], { LLM_API_KEY: 'sk-test', LLM_MODEL: 'gpt-test' });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^id\s+\| status \| fetched \| kept \| ms\s+\| note\/error$/);
  assert.match(lines[1], /^hf-papers\s+\| ok\s+\| 12\s+\| 12\s+\|/, 'registry order: hf-papers precedes hn-top');
  assert.match(lines[2], /^hn-top\s+\| ok\s+\| 42\s+\| 9\s+\|/);
  assert.equal(lines.length, 4);
  assert.match(lines[3], /^ok 2 · empty 0 · failed 0 · items \d+ · brief n\/a \(diagnostic\)$/);
  assert.equal(readdirSync(dataDir).length, 0, 'no writes');
  const hosts = new Set(r.calls.map((u) => new URL(u).hostname));
  assert.deepEqual([...hosts].sort(), ['hn.algolia.com', 'huggingface.co']);
  assert.ok(!r.calls.some((u) => /chat\/completions/.test(u)));
});

test('direct run() with onlySourceIds requires dryRun and returns the diagnostic contract', async () => {
  const dataDir = tmp();
  await assert.rejects(runFixture({ dataDir, onlySourceIds: ['hn-top'], dryRun: false }), /dryRun/);
  const r = await runFixture({ dataDir, onlySourceIds: ['hn-top'], dryRun: true });
  assert.deepEqual(Object.keys(r).sort(), ['diagnostic', 'items', 'sourceResults']);
  assert.equal(r.diagnostic, true);
});

test('a normal CLI run prints the full table and a summary with brief words', () => {
  const dataDir = tmp();
  const r = runCli(['--dry-run', '--data-dir', dataDir, '--now', NOW.toISOString()]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 64 + 2);
  assert.match(lines.at(-1), /^ok \d+ · empty \d+ · failed \d+ · items \d+ · brief \d+ words$/);
  assert.equal(readdirSync(dataDir).length, 0);
});
