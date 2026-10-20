#!/usr/bin/env node
// Diagnostic for sources that fail only from GitHub Actions: what do those hosts answer to THIS machine?
// Part A: the Cloudflare-403 hosts, once with the Ahead headers and once with browser headers.
// Part B: the six YouTube channels, 3x per header variant, plus the playlist_id form and the bare host.
// Plain globalThis.fetch with redirect: 'manual'; sequential with a 300 ms pause (~110 requests, 1-3 min).
// Only the header constants come from src/http.js (so the browser variant is exactly what the pipeline sends);
// writes nothing, always exits 0. Run on the runner with: gh workflow run refresh.yml -f probe=true
import { ACCEPT, ACCEPT_LANGUAGE, BROWSER_USER_AGENT, DEFAULT_USER_AGENT } from '../src/http.js';

// The pre-browser-headers client (the 03:42Z baseline that was blocked), kept as the control variant.
const AHEAD = {
  'user-agent': DEFAULT_USER_AGENT,
  accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
};
// What src/http.js sends to every host except IDENTIFIED_HOSTS.
const BROWSER = {
  'user-agent': BROWSER_USER_AGENT,
  accept: ACCEPT.feed,
  'accept-language': ACCEPT_LANGUAGE,
};
const TIMEOUT_MS = 15_000;
const PAUSE_MS = 300;
const BODY_CHARS = 120;

// [id, url, accept override]
const BLOCKED = [
  ['importai', 'https://importai.substack.com/feed'],
  ['zvi', 'https://thezvi.substack.com/feed'],
  ['chinai', 'https://chinai.substack.com/feed'],
  ['epoch-gradient-updates', 'https://epochai.substack.com/feed'],
  ['pod-dwarkesh', 'https://api.substack.com/feed/podcast/69345.rss'],
  ['thebatch', 'https://www.deeplearning.ai/sitemap.xml'],
  ['thebatch-page', 'https://www.deeplearning.ai/the-batch/', 'text/html'],
];
const CHANNELS = [
  ['yt-karpathy', 'UCXUPKJO5MZQN11PqgIvyuvQ'],
  ['yt-yannic', 'UCZHmQk67mSJgfCCTn7xBfew'],
  ['yt-aiexplained', 'UCNJ1Ymd5yFuUPtn21xtRbbw'],
  ['yt-gpumode', 'UCJgIbYl6C5no72a0NUAPcTA'],
  ['yt-stanford', 'UCBa5G_ESCn8Yd4vw5U-gIcg'],
  ['yt-3b1b', 'UCYO_jab_esuFRV4b17AJtAw'],
];
const STAR = { ...BROWSER, accept: '*/*' };
// [label, headers]
const YT_VARIANTS = [
  ['a ahead', AHEAD],
  ['b browser', BROWSER],
  ['c browser */*', STAR],
  ['d browser */* +consent cookie', { ...STAR, cookie: 'CONSENT=YES+cb; SOCS=CAI' }],
];
const channelUrl = (host, id) => `https://${host}/feeds/videos.xml?channel_id=${id}`;
const playlistUrl = (id) => `https://www.youtube.com/feeds/videos.xml?playlist_id=UU${id.slice(2)}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const header = (res, name) => res.headers.get(name) ?? '-';
const is2xx = (status) => typeof status === 'number' && status >= 200 && status < 300;

/** First 4 KB of the body, tags stripped, whitespace collapsed, cut to BODY_CHARS; '' on any error. */
async function snippet(res, maxBytes = 4096) {
  try {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      total += value.byteLength;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    const text = new TextDecoder('utf-8').decode(Buffer.concat(chunks).subarray(0, maxBytes));
    return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, BODY_CHARS);
  } catch {
    return '';
  }
}

/** One request after the pause; never throws. */
async function probe(url, headers) {
  await sleep(PAUSE_MS);
  try {
    const res = await fetch(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return {
      status: res.status,
      server: header(res, 'server'),
      cfRay: header(res, 'cf-ray'),
      cfMitigated: header(res, 'cf-mitigated'),
      contentType: header(res, 'content-type'),
      location: header(res, 'location'),
      body: await snippet(res),
    };
  } catch (err) {
    const reason = String(err?.cause?.message ?? err?.message ?? err).replace(/\s+/g, ' ').slice(0, BODY_CHARS);
    return { status: `ERR ${err?.name ?? 'Error'}`, server: '-', cfRay: '-', cfMitigated: '-', contentType: '-', location: '-', body: reason };
  }
}

async function partA() {
  console.log('== Part A: Cloudflare-403 hosts, one request per header set ==');
  console.log('id | variant | status | server | cf-ray | cf-mitigated | content-type | location | body[0..120]');
  for (const [id, url, accept] of BLOCKED) {
    for (const [variant, base] of [['ahead', AHEAD], ['browser', BROWSER]]) {
      const r = await probe(url, accept ? { ...base, accept } : base);
      console.log([id, variant, r.status, r.server, r.cfRay, r.cfMitigated, r.contentType, r.location, r.body].join(' | '));
    }
  }
}

async function partB() {
  console.log('');
  console.log('== Part B: YouTube feeds, 3 requests per variant (bare host once) ==');
  console.log('channel | variant | codes | ok n/3');
  const totals = new Map(); // variant -> { ok, n }
  let consentRedirects = 0;
  for (const [name, id] of CHANNELS) {
    const plan = [
      ...YT_VARIANTS.map(([label, headers]) => [label, channelUrl('www.youtube.com', id), headers, 3]),
      ['playlist UU (c headers)', playlistUrl(id), STAR, 3],
      ['bare host youtube.com (c headers)', channelUrl('youtube.com', id), STAR, 1],
    ];
    for (const [variant, url, headers, n] of plan) {
      const results = [];
      for (let i = 0; i < n; i++) results.push(await probe(url, headers));
      const okCount = results.filter((r) => is2xx(r.status)).length;
      const t = totals.get(variant) ?? { ok: 0, n: 0 };
      totals.set(variant, { ok: t.ok + okCount, n: t.n + n });
      consentRedirects += results.filter((r) => /consent\.youtube\.com/.test(r.location)).length;
      console.log(`${name} | ${variant} | ${results.map((r) => r.status).join(' ')} | ok ${okCount}/${n}`);
      const bad = results.find((r) => !is2xx(r.status));
      if (bad) console.log(`    first non-2xx: server=${bad.server}; content-type=${bad.contentType}; location=${bad.location}; body="${bad.body}"`);
    }
  }
  console.log('');
  console.log('== Summary: 200s across the six channels ==');
  for (const [variant, { ok, n }] of totals) console.log(`${variant}: ${ok}/${n}`);
  console.log(`responses with a location header pointing at consent.youtube.com: ${consentRedirects}`);
}

try {
  console.log(`probe-runner: node ${process.version}, GITHUB_ACTIONS=${process.env.GITHUB_ACTIONS ?? 'unset'}, ${new Date().toISOString()}`);
  await partA();
  await partB();
} catch (err) {
  console.log(`probe-runner aborted: ${err?.stack ?? err}`);
}
process.exitCode = 0;
