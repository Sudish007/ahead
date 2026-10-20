# Cloudflare Worker relay for the six Cloudflare-challenged sources (`ahead-relay` + pipeline relay path)

Reviewed: `git diff 99424e0..HEAD -- . ':!data'` (commits `35c1cf9` FEAT-001, `f5211ac` FEAT-002; 22 files, +3100/-36), the specification `relay-build-plan.md` (D1-D14, behaviour tables, items 1-14), `task-ahead-relay/context.json`, and the `findings` of FEAT-001.json and FEAT-002.json. `npm test` run by the reviewer: 249 tests, 249 pass, 0 fail, 49.4 s (199 pre-existing + 8 registry rows + 18 Worker + 3 allowlist + 16 pipeline relay + 5 http).

The change adds a token-gated Cloudflare Worker (`relay/`) that fetches exactly six allowlisted feed/sitemap URLs plus The Batch article pages, keeps a last-good copy per URL in KV (2 h freshness, cron refresh every 3 h, stale fallback, 502 JSON when nothing is cached), and teaches the pipeline to route `viaRelay` sources through it when `RELAY_URL` and `RELAY_TOKEN` are both set, with a one-attempt relay call, a direct fallback, three exact `note` strings and client-scoped token scrubbing in every error path. The allowlist is generated from `sources.config.mjs` and a test fails when the committed JSON drifts. D1-D14 are implemented as written; FEAT-001's declared deviations (prefix must already be normalized, `mkdirSync` in the generator, KV title, `bypassed` field name) are small and defensible.

**Watch for:** `resolveRelay` accepts a `RELAY_URL` ending in a bare `?` or `#` and builds unusable relay URLs without the promised `relay disabled:` warning (confirmed, non-blocking; the run degrades to direct fetches with six `relay: HTTP 404, fell back to direct` rows). The shared secret arrives as a request header, which Cloudflare's own request logging (`wrangler tail`, Workers Logs with `observability` on) records, so any saved tail capture holds the token (likely, non-blocking; only the account owner can read those). The README footprint sentence adds up to 112 where it says "under 100" (confirmed, doc nit).

**Verdict**: APPROVED

## High-level view

The Worker is not an open proxy. `fetch()` checks the token before anything else (constant-time compare of trimmed values; a Worker without the secret answers 401 to every request), then only `GET /feed/<id>` for ids that are own-properties of `allowlist.feeds` and `GET /page/<id>?u=` for ids in `allowlist.pages` whose `new URL(u).href` is `https:`, credential-free and starts with the id's prefix; everything else is 404 with no upstream request. The route resolver was probed with `%2e%2e`, `..%2F`, backslash-authority, `:443`, host-suffix, fragment and tab inputs and either normalizes inside the prefix on the same host or refuses. Upstream requests carry exactly `user-agent`, `accept-language`, `accept`; the token is never forwarded or echoed.

KV logic matches D4-D7: `v1:<url>` key, ArrayBuffer value, `{ contentType, fetchedAt }` metadata, 30-day TTL; a copy under 2 h is a `hit`; otherwise one upstream GET with a 10 s budget and one 2 s retry on 429 only; success means status 200 and no `cf-mitigated` header; bodies over 4,000,000 bytes are passed through as `bypass` and not stored; failure serves the copy as `stale` with `x-relay-stale: <fetchedAt>` or answers the 502 JSON with `upstreamStatus`, `cfMitigated`, `reason`. Every response has `cache-control: no-store`; 200s pass only the upstream `content-type`. The cron (`0 */3 * * *`, `relay/wrangler.toml:14`) walks `allowlist.feeds` in id order with a 2 s sleep between fetches and keeps the old copy on failure.

On the pipeline side the relay is a wrapper around today's `fetchText`: `run()` resolves `{ url, token }` once (both trimmed non-blank, `https:` without credentials/query/fragment), `runSource` wraps only when `deps.relay && source.viaRelay === true`, `source.url` goes to `/feed/<id>` and every other URL to `/page/<id>?u=`, the relay gets one attempt within 15 s (pages keep 8 s), `finalUrl` is reset to the requested URL so no `redirected to <relay url>` note can arise, and any thrown error logs one scrubbed warn line and runs the direct fetch with the caller's options. Parsers, age window, dedup and scoring are untouched; the full-registry fixture test shows every non-relay row byte-identical to the plain run.

Redaction is client-scoped in `createHttpClient`: the token is replaced with `REDACTED` in the URL, every `detail` header value and the body snippet before the 80/300-char cuts, and in `TimeoutError`/`BodyTooLarge` URLs; `headerDetail` skips `authorization` and `x-relay-token` regardless of `DETAIL_HEADERS`. The relay host is non-retryable. The token is only ever sent by `headersFor` to `relay.url`'s hostname, and headers are rebuilt per redirect hop, so a cross-host redirect drops it (tested). `refresh.yml` passes both secrets to the fetch step only; root `package.json` is unchanged; wrangler is pinned only in `relay/package.json`; the 64-hex grep over tracked and untracked files (including the FEAT findings) is empty.

<details>
<summary>Issues (4)</summary>

1. **`RELAY_URL` with a bare `?`/`#` slips through `resolveRelay`** (confirmed, non-blocking) — `src/relay.js:21` tests `parsed.search`/`parsed.hash`, which are `''` for `https://r.test/?` and `https://r.test/#`, so the value is accepted and `relayFeedUrl` yields `https://r.test/?/feed/importai` with no `relay disabled:` warning. Reject when the trimmed value contains `?` or `#` (or require `parsed.href === rawUrl` after slash-stripping) and add both strings to the malformed-URL test in `tests/relay.test.js`.
2. **Token visible in Cloudflare request logs and saved tail captures** (likely, non-blocking) — `wrangler tail --format json` and Workers Logs (`[observability] enabled = true`, `relay/wrangler.toml:9-10`) record `event.request.headers`, which include `x-relay-token`; FEAT-001 saved a tail capture to a file to parse it. Confirm with one captured event; if the header is present, delete that capture, add a sentence to the README hygiene paragraph (README.md:154) that Cloudflare's own logs show the header to the account owner and tail output must not be saved or shared, and rotate the token if a capture was shared.
3. **README footprint arithmetic** (confirmed, doc nit) — README.md:152 says "8 cron ticks x 6 fetches plus about 16 relay requests x 4 scheduled runs, i.e. under 100 Worker requests"; 48 + 64 = 112. The 48 cron fetches are subrequests inside 8 cron invocations, so the request count is ~72. Reword so the numbers add up.
4. **Relay-then-direct timing is reasoned, not tested** (confirmed gap, non-blocking) — the D9 comment at `src/http.js:290-293` (15 s relay timeout + 20 s direct timeout + 2 s backoff = 37 s, no second direct attempt because 8 s < 25 s remain) has no `fakeClock` test through `runSource`, and the Worker's 429 worst case (slow first 429 + 2 s + 10 s second attempt exceeds the pipeline's 15 s) is likewise untested. Optional: one pipeline test with `fakeClock` asserting `attempts === 1` on the direct error and `ms < 45_000`.

</details>

<details>
<summary>Details</summary>

### Auth gate and route resolver (`relay/src/index.js`)

`fetch()` (index.js:182-187) runs `tokenOk` first, then the GET check, then `resolveRoute`, then `serve`; a wrong or missing token on any path, method or id is a 401 with no upstream call. `tokenOk` (index.js:38-44) returns false when `env.RELAY_TOKEN` is not a non-empty string, trims both sides, and compares with `timingSafeEqual` (index.js:29-35), which XORs the lengths and every byte up to the longer length. The loop count depends on the longer input, which reveals at most the secret's length (64, documented), not its content.

`resolveRoute` (index.js:50-72) uses `Object.hasOwn` on both maps, so `/feed/constructor` and `/feed/__proto__` are 404. The page branch requires `https:`, no username/password and `target.href.startsWith(allowlist.pages[id])` (index.js:67). Because the prefix ends in `/` right after the host, `www.deeplearning.ai.evil.test` and `www.deeplearning.ai\@evil.test` fail the prefix test, `%2e%2e` and `../` normalize out of the prefix, `:443` and uppercase hosts normalize into it, and `..%2Fx` stays on the publisher's host (the server may decode it, which is a publisher concern, not a proxy escape). A fragment in `u` survives into the KV key (`fetch` strips it), so `#a` and `#b` would be two keys for one page; sitemap `loc`s carry no fragments, so this is theoretical.

The Worker's endpoint URL is public (README and `relay/README.md`), so anyone can spend the free tier's 100,000 requests/day on 401s; exhausting it returns the six sources to the direct path and today's `blocked from GitHub runner` rows. That is the accepted exposure of any public Worker without a custom domain or WAF rule (D14 puts both out of scope).

### KV read/store/stale path and the 429 retry

`serve` (index.js:147-157) treats a copy with an unparseable `fetchedAt` as stale (the NaN comparison is false, so it refetches rather than serving it forever) and never stores on `cf-mitigated` because `fetchUpstream` (index.js:109-134) reads the body only when `status === 200 && !cf-mitigated`; a 200 with `cf-mitigated` is reported as `upstreamStatus: 200, reason: 'status'`. Two small asymmetries: the metadata `contentType` is cut to 100 chars while the `miss` response carries the uncut header, and the request path stamps `fetchedAt` before the upstream fetch (up to ~22 s early in the 429-retry case) while the cron stamps after. Neither matters at a 2 h threshold.

`fetchUpstream` retries once after `sleep(2000)` on 429 only; a timeout, network error or any other status returns at once. Worst case for the pipeline: a first 429 that takes most of the 10 s budget plus 2 s plus a second 10 s attempt is 22 s, beyond the pipeline's 15 s relay timeout, so the pipeline would fall back to direct while the Worker finishes and stores the copy for the next run. The probe showed 429s answer in ~200 ms, so the realistic path is ~12 s. When `arrayBuffer()` itself throws after a 200, the returned failure has `status: null` while the log line keeps the real status; cosmetic.

```
pipeline ──x-relay-token──> Worker.fetch ── tokenOk ── GET? ── resolveRoute ── serve
                                                                    │
                                   KV getWithMetadata(v1:<url>) ────┤
                                   <2 h  → 200 hit                  │
                                   else  → fetchUpstream ───────────┤── 200 & !cf-mitigated → store (≤4 MB) → 200 miss|bypass
                                                                    └── failure → copy? 200 stale + x-relay-stale : 502 JSON
cron 0 */3 ──> scheduled ── waitUntil(refreshAll): feeds in id order, sleep 2 s between, store on success
```

### Allowlist generation

`tests/relay-allowlist.test.js` compares the committed `relay/src/allowlist.json` byte-for-byte (2-space JSON, LF, one trailing newline) with `buildAllowlist(CONFIG.sources)`, so a config change without regeneration fails `npm test`; running the generator during review left `git status --short relay/src/allowlist.json` empty. Schema rules (`src/schema.js:80-89`) refuse `viaRelay` outside rss/atom/sitemap and on templated URLs, require `relayPagePrefix` for relayed sitemaps, and additionally require the prefix to be already normalized (`u.href === v`, schema.js:52), which stops a prefix that would silently 404 every page fetch in the Worker; the eight planned invalid cases are in `tests/registry.test.js`.

### Pipeline routing, notes and the direct fallback

`runSource` (`src/pipeline.js:72-76`) keeps today's arrow as `direct` and wraps it only for `viaRelay` sources when `run()` resolved a relay (`pipeline.js:205`); the note is appended after `apiNote` (`pipeline.js:120`) and the `redirected to` check sees the requested URL because `createRelayFetch` returns `{ ...res, finalUrl: url }` (`src/relay.js:64`). `relayNote` renders exactly `via relay`, `via relay (stale <marker>)`, `via relay (stale)` when the header has no printable characters, or `relay: <class>, fell back to direct`; `staleMarker` keeps printable ASCII only, at most 40 chars.

"One direct attempt" deserves precision: after a relay failure the wrapper calls the unchanged direct `fetchText`, which keeps its own policy (one retry for 5xx/429/network when ≥ 25 s remain). The runner's Cloudflare 403 is non-retryable, so there is exactly one direct request there; a fast relay failure followed by a fast direct 503 can produce two direct requests, which is today's behaviour and what the README's "runs the direct fetch exactly as without the relay" promises. The tests assert `count(calls, FEED) === 1` only on the paths where that holds.

The `resolveRelay` gap: `src/relay.js:21` rejects `parsed.search`/`parsed.hash`, but WHATWG sets both to `''` for a bare delimiter, so `https://r.test/?` and `https://r.test/#` pass (probed: `{ url: 'https://r.test/?' }`, `relayFeedUrl` → `https://r.test/?/feed/importai`, no warning). That request reaches the Worker as path `/` with query `/feed/importai`, which is a 404, so every relay request fails and every `viaRelay` row reads `relay: HTTP 404, fell back to direct` with six warn lines. The failure is visible and safe, but it is the exact misconfiguration the `relay disabled:` warning exists for.

### Token redaction and header scoping (`src/http.js`)

`scrub` (http.js:165) is `split(token).join('REDACTED')`, applied in `once()` to the URL of every `HttpError`/`TimeoutError`/`BodyTooLarge`, to every `detail` header value via the third `headerDetail` parameter, and to the raw body snippet before tag-stripping and the 300-char cut, so a cut can never leave a token fragment. `SENSITIVE_HEADERS` (http.js:31) excludes `authorization` and `x-relay-token` from `detail` even if `DETAIL_HEADERS` grows. The token is hex, so URL-encoding is the identity and an encoded echo is still caught. Non-HTTP errors thrown by `fetchImpl` (undici `TypeError: fetch failed`) carry no headers in their message, and `errorClass`/`errorSummary` never include URLs, so the warn line, `error`, `detail`, `note`, `meta.json` and `items.json` stay token-free; the tests check `err.message`, `err.url`, `JSON.stringify(err)`, `err.stack`, `formatDetail`, the logger sink and the full meta for `RELAYSECRET`.

`headersFor` (http.js:202-205) adds the token and the Ahead UA only when `host === relayHost` (hostname only, so a relay on a non-default port still matches); headers are rebuilt per hop, and the 302-to-`evil.test` test shows the token absent on the second hop. The YouTube `redactKey` path and `tests/youtube.test.js` are untouched.

The remaining exposure is outside the repo: Cloudflare records request headers for every invocation in `wrangler tail` output and, with `[observability] enabled = true`, in Workers Logs (3-day retention on the free plan, dashboard access only). FEAT-001 captured a tail to a file to read the pretty-printed events, so that file likely contains the header value. No one but the account owner can read either, so this is hygiene, not a leak, but D10's "never in a log" did not account for it.

### Workflow, docs and tree hygiene

`.github/workflows/refresh.yml:48-49` adds `RELAY_URL`/`RELAY_TOKEN` to the fetch step's `env` only; the plan's one-liner prints `true false`. `tests/cli.test.js` blanks both for the spawned CLI. README.md:126-158 matches the code claim by claim (routes, `X-Relay-Token`, `x-relay-cache` values, `x-relay-stale`, 502 field names, 4,000,000-byte cap, `0 */3 * * *`, 15 s/8 s timeouts, the three notes, the `relay disabled:` warning, deploy/rotate/disable commands identical to `relay/README.md`); the Known-limits bullet (README.md:200) is rewritten and `no proxy, mirror or scraper` has 0 hits. Only the footprint sentence (README.md:152) has the arithmetic slip noted above. Root `package.json`/`package-lock.json` have no diff; `wrangler` appears only in `relay/package.json` (4.151.2 exact, lock resolved to the same version); `relay/node_modules` is covered by the unanchored `node_modules` ignore. `git grep -n -E '[0-9a-f]{64}'` over tracked files and `--untracked` (which includes the FEAT findings and this task directory) returns nothing; both commits list exactly the planned 13 and 10 files; `data/` and `.agents/` are not in the diff; nothing was pushed (`HEAD -> main` only).

### Test coverage

Covered: every row of the Worker behaviour table plus the FEAT-001 extras (trimmed tokens, prototype-key ids, HEAD, 304, 429-then-200, exact 2 h boundary, cap boundary, content-type cut/fallback, default export); allowlist sync and shape; the eight schema rows; `resolveRelay` gating and malformed URLs; URL builders; `staleMarker`; `relayNote`; `createRelayFetch` routing, timeout cap, finalUrl reset, page isolation, fallback options, both-fail propagation; pipeline gating matrix, relay 200 with header/UA assertions, stale note, seven-case failure matrix with one relay call and one direct call each, runner 403 after relay 502, non-relay source untouched, thebatch pages via `/page/thebatch?u=`, full-registry parity with `validateMeta`; http.js header scoping, cross-host drop, 401 echo scrubbed everywhere, redirect-loop scrub, Timeout/BodyTooLarge scrub, relay-host single attempt, `headers` exposure.

Not tested: `RELAY_URL` ending in `?`/`#`; the 45 s backstop arithmetic for relay-timeout-then-direct-timeout through `runSource` with `fakeClock`; a KV read that throws (the Worker would surface a 1101 and the pipeline falls back, but no test pins it); a page-level stale response through the real sitemap parser (unit-covered in `createRelayFetch` only).

</details>

<details>
<summary>File map</summary>

- `relay/src/index.js` — the Worker: token gate, route resolver, KV serve/store/stale/502, upstream fetch with 429 retry, cron refresh, factory + default export.
- `relay/src/allowlist.json` — generated allowlist (6 feeds, 1 page prefix, 4 header constants).
- `relay/build-allowlist.mjs` — generator (`buildAllowlist`) and CLI writer.
- `relay/wrangler.toml` — name, main, compat date, observability, cron, KV binding.
- `relay/package.json`, `relay/package-lock.json` — wrangler 4.151.2 pin, scripts.
- `relay/README.md` — operator notes: deploy, token generate/rotate, allowlist, tail, delete.
- `src/relay.js` — `resolveRelay`, URL builders, `staleMarker`, `createRelayFetch`, `relayNote`.
- `src/http.js` — relay host header branch, `SENSITIVE_HEADERS`, client-scoped `scrub`, non-retryable relay host, `headers` on results.
- `src/pipeline.js` — `direct`/relay wrapper swap in `runSource`, note append, `resolveRelay` in `run()`.
- `src/schema.js` — `viaRelay`/`relayPagePrefix` validation.
- `sources.config.mjs` — `viaRelay: true` on six sources, `relayPagePrefix` on thebatch.
- `scripts/probe-sources.mjs` — relay resolved from `process.env`.
- `.github/workflows/refresh.yml` — two secrets on the fetch step.
- `README.md` — intro, Sources notes, "Adding a source" fields, new Relay section, Local commands, Data files, Known limits.
- `tests/relay-worker.test.js`, `tests/relay-allowlist.test.js`, `tests/relay.test.js` — new suites.
- `tests/http.test.js`, `tests/registry.test.js` — added cases; `tests/cli.test.js`, `tests/helpers.js` — env blanks and relay page fixture routing.

Full diff: `git diff 99424e0..HEAD -- . ':!data'`
</details>
