// Preload for CLI tests: replaces global fetch with the offline fixture fetch (records calls to AHEAD_TEST_CALLS).
import { appendFileSync } from 'node:fs';
import { fixtureFetch, NOW } from './helpers.js';

const inner = fixtureFetch({ now: NOW });
globalThis.fetch = async (url, init) => {
  if (process.env.AHEAD_TEST_CALLS) appendFileSync(process.env.AHEAD_TEST_CALLS, `${String(url)}\n`);
  return inner(url, init);
};
