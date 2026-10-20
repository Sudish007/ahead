#!/usr/bin/env node
// Fetch + parse every registry source and print one row each. Never writes.
import { createHttpClient } from '../src/http.js';
import { defaultLogger, expandUrl, runSource } from '../src/pipeline.js';
import { resolveRelay } from '../src/relay.js';
import { validateConfig } from '../src/schema.js';
import { sources, linkouts, learn } from '../sources.config.mjs';

validateConfig({ sources, linkouts, learn });
const now = new Date();
const quiet = { ...defaultLogger, warn: () => {}, info: () => {} };
const relay = resolveRelay(process.env, quiet);
const http = createHttpClient({ fetchImpl: globalThis.fetch, githubToken: process.env.GITHUB_TOKEN ?? '', relay });
const onRunner = process.env.GITHUB_ACTIONS === 'true';
const w = Math.max(...sources.map((s) => s.id.length));
console.log(`${'id'.padEnd(w)} | status | items | ms    | note | finalUrl`);
let next = 0;
const rows = new Array(sources.length);
const worker = async () => {
  while (next < sources.length) {
    const k = next++;
    const source = { ...sources[k], url: expandUrl(sources[k].url, now) };
    const r = await runSource(source, { http, now, logger: quiet, onRunner, youtubeApiKey: process.env.YOUTUBE_API_KEY ?? '', relay });
    rows[k] = `${source.id.padEnd(w)} | ${String(r.status).padEnd(6)} | ${String(r.kept ?? 0).padEnd(5)} | ${String(r.ms).padEnd(5)} | ${r.error ?? r.note ?? ''} | ${r.finalUrl ?? ''}`;
  }
};
await Promise.all(Array.from({ length: 6 }, worker));
for (const row of rows) console.log(row);
