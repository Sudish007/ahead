#!/usr/bin/env node
// CLI entry: parse flags, run the pipeline, print the per-source table. Sole stdout owner.
import { run } from '../src/pipeline.js';
import { sources, linkouts, learn } from '../sources.config.mjs';

function parseArgs(argv) {
  const opts = { dryRun: false, noLlm: false, dataDir: 'data' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-llm') opts.noLlm = true;
    else if (a === '--source') { opts.onlySourceIds = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a.startsWith('--source=')) { opts.onlySourceIds = a.slice(9).split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a === '--data-dir') opts.dataDir = argv[++i];
    else if (a.startsWith('--data-dir=')) opts.dataDir = a.slice(11);
    else if (a === '--now') opts.now = argv[++i];
    else if (a.startsWith('--now=')) opts.now = a.slice(6);
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

function pad(s, n) { return String(s).padEnd(n); }

function printTable(result) {
  const rows = result.sourceResults;
  const w = Math.max(6, ...rows.map((r) => r.id.length));
  console.log(`${pad('id', w)} | status | fetched | kept | ms    | note/error`);
  for (const r of rows) {
    const tail = r.error ?? r.note ?? '';
    console.log(`${pad(r.id, w)} | ${pad(r.status, 6)} | ${pad(r.fetched, 7)} | ${pad(r.kept, 4)} | ${pad(r.ms, 5)} | ${tail}`);
  }
  const ok = rows.filter((r) => r.status === 'ok').length;
  const empty = rows.filter((r) => r.status === 'empty').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const brief = result.diagnostic ? 'n/a (diagnostic)' : `${result.digest.wordCount} words`;
  console.log(`ok ${ok} · empty ${empty} · failed ${failed} · items ${result.items.length} · brief ${brief}`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  if (opts.onlySourceIds && !opts.dryRun) {
    console.error('--source selects a diagnostic subset and requires --dry-run (a partial run never writes data or calls the LLM)');
    return 1;
  }
  let now = new Date();
  if (opts.now !== undefined) {
    now = new Date(opts.now);
    if (!Number.isFinite(now.getTime())) { console.error(`--now must be an ISO timestamp, got "${opts.now}"`); return 1; }
  }
  try {
    const result = await run({ sources, linkouts, learn, now, dataDir: opts.dataDir, onlySourceIds: opts.onlySourceIds, dryRun: opts.dryRun, noLlm: opts.noLlm });
    printTable(result);
    return 0;
  } catch (err) {
    console.error(err?.stack ?? String(err));
    return 1;
  }
}

process.exitCode = await main();
