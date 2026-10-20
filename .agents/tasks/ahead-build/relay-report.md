# Cloudflare Worker relay (`ahead-relay`) — ship and verify report

Date: 2026-10-20. Repo `Sudish007/ahead`, branch `main`.

## Verification result: VERIFIED on two real Actions runs with the secrets

All six `viaRelay` sources (importai, zvi, chinai, pod-dwarkesh, epoch-gradient-updates, thebatch) are `ok` or `empty` with `httpStatus 200` and `note: "via relay"` in the committed and the live `meta.json`. The pipeline reports **42 ok / 22 empty / 0 failed** (was 37 / 20 / 7). No token material appears in the repo, the committed data, the live data or the Actions logs.

## What changed

Commits pushed to `main` in one push (`6619f89..0f1ba36`, rebased on `origin/main`, no force-push). Local shas before the rebase were 99424e0 / 35c1cf9 / f5211ac / 8171775; the FEAT findings cite those.

| SHA | Message |
| --- | --- |
| `493e5701d48f3e957aeff59b6c5d0b60e585f04b` | docs: relay probe results (Cloudflare Worker egress vs the six challenged sources) |
| `2c6e87b2e5aa2c94c0798ae4c1dc545041486d72` | feat(relay): Cloudflare Worker relay for the six Cloudflare-challenged sources (allowlist, token auth, KV last-good copy, cron refresh) |
| `1ba2bb7bd6630c15b0fc0f6ddd7c0de2a9f3f183` | feat(pipeline): fetch viaRelay sources through the ahead-relay Worker with direct fallback, relay notes and token redaction |
| `0f1ba36bc8d8ce58ef5a248c45495a71a0b245f9` | docs: relay plan, FEAT artifacts and review |

Files in `2c6e87b` (13 files, +2411/−7): `sources.config.mjs` (`viaRelay` on the six sources, `relayPagePrefix` on thebatch), `src/schema.js` (validation of both fields), `tests/registry.test.js` (+8 invalid cases), `README.md`, `relay/package.json`, `relay/package-lock.json`, `relay/build-allowlist.mjs`, `relay/src/allowlist.json`, `relay/src/index.js` (the Worker), `relay/wrangler.toml`, `relay/README.md`, `tests/relay-worker.test.js` (18 tests), `tests/relay-allowlist.test.js` (3 tests).

Files in `1ba2bb7` (10 files, +689/−29): `src/relay.js` (new: `resolveRelay`, URL builders, `createRelayFetch` with direct fallback, `relayNote`), `src/http.js` (relay-host header rules, no retry on the relay host, token scrub in every error/detail, sensitive headers never in detail), `src/pipeline.js` (`runSource`/`run()` wiring), `scripts/probe-sources.mjs`, `.github/workflows/refresh.yml` (`RELAY_URL` + `RELAY_TOKEN` on the fetch step only), `README.md` (section `Relay for Cloudflare-blocked feeds`), `tests/relay.test.js` (16 tests), `tests/http.test.js` (+5), `tests/cli.test.js`, `tests/helpers.js`.

Files in `0f1ba36` (7 files, docs only): `.agents/tasks/ahead-build/{relay-build-plan.md, relay-review.md, relay-review.json}` and `task-ahead-relay/{task.json, context.json, features/FEAT-001.json, features/FEAT-002.json}`. `data/` was not touched locally.

Data commits made by the Actions bot after the push: `28539449b92d1e7bac47319029af0dbeda97b7dd` (refresh 10:47Z, push-triggered run) and `68220e5670388c0d6b6b9e29f1ca27ac1999612e` (refresh 10:49Z, the dispatch run used for verification).

## Test count

`npm test` on `main` before the push: **249 tests, 249 pass, 0 fail**, 54 s (was 199; +29 in FEAT-001, +21 in FEAT-002). Both Actions runs also ran the suite green (the fetch step only runs after it).

## Worker

- URL: `https://ahead-relay.rishtapatra.workers.dev` (Cloudflare account 3b76db242a54ca8aae11deb8eef77ff9, wrangler 4.151.2 pinned in `relay/package.json`).
- KV namespace: binding `RELAY_CACHE`, id `693b4290d7ef4bc7a1d6e9c560b6e585`.
- Cron: `0 */3 * * *` (refreshes the six feed copies 2 s apart).
- Deploy version at ship time: `9660149b-c140-469a-bb1f-bd413ccc6621` (2026-10-20T09:38:26Z). Not redeployed by this step.
- Behaviour: `GET /feed/<id>` and `GET /page/thebatch?u=<encoded url>` with `x-relay-token`; KV last-good copy, 2 h freshness, stale fallback (`x-relay-cache: hit|miss|bypass|stale`, `x-relay-stale`), 502 JSON on upstream failure with no copy, 4,000,000-byte store cap.

## Secrets

`gh secret list --repo Sudish007/ahead` → `RELAY_TOKEN` and `RELAY_URL` present (both set ~1 h before the push), plus the earlier `YOUTUBE_API_KEY`. `RELAY_TOKEN` is 64 hex characters; it is set in the Worker (`npx wrangler secret list` → `RELAY_TOKEN`), in GitHub, and in a local copy at `%LOCALAPPDATA%\ahead\relay-token.txt` outside the repo. The value is not reproduced anywhere in this report, the FEAT findings, commits or logs.

## Actions runs

| Run id | Trigger | Result | Notes |
| --- | --- | --- | --- |
| 39410315247 | push (`0f1ba36`) | success | Fetch step logged six `via relay` rows; committed `2853944` (data refresh 10:47Z); deployed Pages. |
| **39410515136** | workflow_dispatch | **success** | Dispatched after the push run finished, so no "main moved" collision. Six `via relay` rows; committed `68220e5` (data refresh 10:49Z); deployed Pages. **This is the run used for verification.** |

`gh run view <id> --log | Select-String 'via relay|relay failed|blocked from GitHub runner|relay disabled'` on both runs: the only `blocked from GitHub runner` hit is the unit-test title that checks that message; there are no `relay failed` and no `relay disabled` lines. Fetch-step rows from run 39410515136:

```
importai               | ok     | 20   | 1 | 342 | via relay
zvi                    | ok     | 20   | 6 | 410 | via relay
thebatch               | ok     | 3406 | 6 | 318 | via relay
epoch-gradient-updates | empty  | 20   | 0 | 257 | via relay
chinai                 | ok     | 20   | 1 | 174 | via relay
pod-dwarkesh           | empty  | 142  | 0 | 243 | via relay
```

## The six sources: BEFORE vs AFTER

BEFORE (`generatedAt` 2026-10-20T07:30:35Z, totals ok 37 / empty 20 / failed 7):

| Source | Status | httpStatus | Error |
| --- | --- | --- | --- |
| importai | failed | 403 | blocked from GitHub runner: 403 Cloudflare |
| zvi | failed | 403 | blocked from GitHub runner: 403 Cloudflare |
| chinai | failed | 403 | blocked from GitHub runner: 403 Cloudflare |
| pod-dwarkesh | failed | 403 | blocked from GitHub runner: 403 Cloudflare |
| epoch-gradient-updates | failed | 403 | blocked from GitHub runner: 403 Cloudflare |
| thebatch | failed | 403 | blocked from GitHub runner: 403 Cloudflare |

AFTER (`data/meta.json` at `68220e5`, `generatedAt` 2026-10-20T10:49:25.109Z, totals **ok 42 / empty 22 / failed 0**):

| Source | Status | httpStatus | fetched | kept | note | error |
| --- | --- | --- | --- | --- | --- | --- |
| importai | ok | 200 | 20 | 1 | via relay | — |
| zvi | ok | 200 | 20 | 6 | via relay | — |
| chinai | ok | 200 | 20 | 1 | via relay | — |
| pod-dwarkesh | empty | 200 | 142 | 0 | via relay | — |
| epoch-gradient-updates | empty | 200 | 20 | 0 | via relay | — |
| thebatch | ok | 200 | 3406 | 6 | via relay | — |

The two `empty` rows are not relay issues: neither feed has an item inside the 7-day window today (epochai.substack.com newest item 2026-10-09, the Dwarkesh podcast feed newest 2026-10-01); a direct fetch from a home connection gives the same `empty`. They will flip to `ok` when either publishes.

`gh-rel-unsloth`, which was `failed HTTP 502 (2 attempts)` in the baseline and out of scope here, happened to be `ok 200 10/3` in this run; GitHub's 502 was transient.

## Live meta.json check

`Invoke-RestMethod "https://sudish007.github.io/ahead/data/meta.json?t=<epoch>"` right after the dispatch run: `generatedAt` 2026-10-20T10:49:25.109Z, ok 42 / empty 22 / failed 0, and the same six rows (status, httpStatus, fetched, kept, `note=via relay`, empty error) as the committed file. No Pages lag.

## Token-absence checks

- `git grep -n -E '[0-9a-f]{64}' -- . ':!package-lock.json' ':!relay/package-lock.json'` on the working tree before the commit: empty.
- `git diff --cached | Select-String -Pattern '[0-9a-f]{64}'` before the docs commit: empty.
- `Select-String -Path data\meta.json,data\items.json -Pattern '[0-9a-f]{64}'` at `68220e5` (meta.json 24,831 bytes, items.json 756,606 bytes): empty.
- Live `items.json` (cache-busted): 0 matches for the same pattern.
- Actions logs: GitHub masks secrets; the relay lines quoted above carry no header values. Unit tests (`tests/relay.test.js`, `tests/http.test.js`) assert the literal `RELAYSECRET` never reaches HttpError message/url/detail, formatDetail, logger lines or meta/items.
- Hygiene note (review finding 2): `wrangler tail --format json` records the incoming `x-relay-token` header, so a tail capture does contain the token. The one capture made in this step (see footprint) was written to `%TEMP%`, parsed, and deleted; nothing was shared.

## Free-tier footprint observed

One six-source pipeline run observed with `npx wrangler tail ahead-relay --format json` (local `--dry-run` against the Worker, 2026-10-20 ~11:00Z): **12 Worker requests** = 6 `/feed/<id>` + 6 `/page/thebatch?u=` (one page per kept the-batch article; `PAGE_FETCH_LIMIT` caps this at 10, so the worst case per run is 16). Per day: 4 scheduled pipeline runs × ~12 = ~48 requests, plus 8 cron invocations making 48 upstream subrequests, so roughly 56 Worker invocations and ~100 upstream fetches a day against the 100,000 requests/day free limit. KV: ~6 writes per cron tick (≤48/day of the 1,000/day limit), ~12 reads per pipeline run. The largest stored value is thezvi (2,027,091 bytes, under the 4,000,000 cap, well under KV's 25 MiB).

## Re-run instructions (for future refreshes)

```
gh workflow run refresh.yml --repo Sudish007/ahead
gh run list --repo Sudish007/ahead --workflow refresh.yml --limit 1
gh run watch <id> --repo Sudish007/ahead --exit-status
gh run view <id> --repo Sudish007/ahead --log | Select-String 'via relay|relay failed|relay disabled'
```

Then fetch `https://sudish007.github.io/ahead/data/meta.json?t=<epoch>` and confirm the six `viaRelay` sources are `ok` or `empty` with `note` starting `via relay`. A `relay: <class>, fell back to direct` note means the Worker did not answer; check `npx wrangler tail ahead-relay` (cwd `relay/`, do not save the output) and `npx wrangler deployments list`. A push to `main` also triggers the workflow; if a dispatch run overlaps a push run, the later one's commit step exits with "main moved" by design. Re-dispatch once main settles.

Token rotation and Worker redeploy: see `README.md` section `Relay for Cloudflare-blocked feeds` and `relay/README.md`.

## Still failing / open

- Nothing in the registry failed in run 39410515136 (failedCount 0).
- `gh-rel-unsloth` remains out of scope; it passed this time but its earlier `HTTP 502` was a GitHub-side transient that may recur.
- Review findings in `relay-review.json` are all non-blocking and unaddressed in code: bare `?`/`#` in `RELAY_URL` not rejected by `resolveRelay`, README footprint arithmetic (the numbers above are the corrected ones), tail logs showing the token header to the account owner, and no fakeClock test for the relay-then-direct timing.
