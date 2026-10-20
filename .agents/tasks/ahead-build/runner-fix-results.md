# Runner-fix results: sources that fail only from GitHub Actions

Plan: `runner-fix-plan.md`. Features: `task-runner-fix/features/FEAT-00{1,2,3}.json`. All counts come from the bot-committed `data/meta.json` (64 sources) after each Actions run; the live copy at https://sudish007.github.io/ahead/data/meta.json was checked to carry the same `generatedAt` and strings after the final run.

## Counts

| run | generatedAt | ok | empty | failed | items | commit / notes |
|---|---|---|---|---|---|---|
| baseline | 2026-10-20T03:42:54Z | 33 | 19 | 12 | — | before any change; 6× HTTP 403 (Cloudflare), 6× HTTP 404/500 (YouTube), arxiv-cs.AI empty (API fallback timed out) |
| FEAT-001 probe dispatch | 2026-10-20T04:30Z | 35 | 17 | 12 | — | run 39369807517 (`-f probe=true`); `detail` on every failed source; header-variant matrix all 0/18 for YouTube |
| FEAT-002 push | 2026-10-20T04:46:16Z | 35 | 18 | 11 | 825 | run 39371243408, code 5c86db7, data 79efa54; yt-yannic returned 200 (empty, 0 kept) |
| FEAT-003 push (final) | 2026-10-20T04:57:36Z | 36 | 17 | 11 | 829 | run 39372229633, code d3fdfb8, data 07ee16f; yt-3b1b ok 15/1, yt-yannic back to 500 |

## Per-source: the 12 baseline failures + arxiv-cs.AI

`status | httpStatus | error | note | detail (truncated)`; ms is runSource wall time in the final run.

| source | baseline (03:42Z) | FEAT-002 run (04:46Z) | final run (04:57Z) |
|---|---|---|---|
| arxiv-cs.AI | empty, 200, note `valid empty RSS and api fallback failed (timeout)` | ok, 200, 789/60 via RSS, 2145 ms | ok, 200, 789/60 via RSS, 2149 ms, no note |
| importai | failed, 403, `HTTP 403` | failed, 403, `HTTP 403`, detail `server=cloudflare; cf-ray=…-LAX; cf-mitigated=challenge; …` | failed, 403, `blocked from GitHub runner: 403 Cloudflare`, 102 ms, detail `server=cloudflare; cf-ray=a4d5715ba9edce48-SJC; cf-mitigated=challenge; content-type=text/html; charset=UTF-8; body="Just a moment..."` |
| zvi | failed, 403, `HTTP 403` | failed, 403, `HTTP 403`, Cloudflare challenge | failed, 403, `blocked from GitHub runner: 403 Cloudflare`, 82 ms, `server=cloudflare; cf-ray=a4d5715be9f2dc9b-SJC; cf-mitigated=challenge` |
| chinai | failed, 403, `HTTP 403` | failed, 403, `HTTP 403`, Cloudflare challenge | failed, 403, `blocked from GitHub runner: 403 Cloudflare`, 57 ms, `server=cloudflare; cf-ray=a4d5715e1df36af7-SJC; cf-mitigated=challenge` |
| epoch-gradient-updates | failed, 403, `HTTP 403` | failed, 403, `HTTP 403`, Cloudflare challenge | failed, 403, `blocked from GitHub runner: 403 Cloudflare`, 62 ms, `server=cloudflare; cf-ray=a4d5715dd98f33fc-SJC; cf-mitigated=challenge` |
| pod-dwarkesh | failed, 403, `HTTP 403` | failed, 403, `HTTP 403`, Cloudflare challenge | failed, 403, `blocked from GitHub runner: 403 Cloudflare`, 73 ms, `server=cloudflare; cf-ray=a4d5716dbef8b917-SJC; cf-mitigated=challenge` |
| thebatch | failed, 403, `HTTP 403` | failed, 403, `HTTP 403`, Cloudflare challenge | failed, 403, `blocked from GitHub runner: 403 Cloudflare`, 66 ms, `server=cloudflare; cf-ray=a4d5715c9ed41563-SJC; cf-mitigated=challenge` |
| yt-karpathy | failed, 404, `HTTP 404` | failed, 404, `HTTP 404`, 3 attempts, 10386 ms | failed, 404, `HTTP 404 (3 attempts)`, 10360 ms, `server=YouTube RSS Feeds server; content-type=text/html; charset=UTF-8; body="Error 404 (Not Found)!!1 …"` |
| yt-yannic | failed, 404, `HTTP 404` | **empty**, 200, 15/0, 2190 ms (attempt 2 succeeded) | failed, 500, `HTTP 500 (3 attempts)`, 10496 ms, `server=YouTube RSS Feeds server; … body="Error 500 (Server Error)!!1 …"` |
| yt-aiexplained | failed, 404, `HTTP 404` | failed, 404, `HTTP 404`, 3 attempts, 10408 ms | failed, 404, `HTTP 404 (3 attempts)`, 10275 ms, as yt-karpathy |
| yt-gpumode | failed, 404, `HTTP 404` | failed, 404, `HTTP 404`, 3 attempts, 10193 ms | failed, 404, `HTTP 404 (3 attempts)`, 10263 ms, as yt-karpathy |
| yt-stanford | failed, 404/500, `HTTP 500` | failed, 500, `HTTP 500`, 3 attempts, 10244 ms | failed, 404, `HTTP 404 (3 attempts)`, 10260 ms, as yt-karpathy |
| yt-3b1b | failed, 404, `HTTP 404` | failed, 404, `HTTP 404`, 3 attempts, 10199 ms | **ok**, 200, 15/1, 5 ms |

Controls (identified hosts, must stay unchanged): reddit ok 200 50/50 (669 ms final); gh-trending-llm ok 30/10; gh-trending-ml empty; gh-trending-agents ok; gh-rel-pytorch empty (CI tags); gh-rel-vllm ok. Unchanged across all runs.

Every `error` string in the final meta.json is <= 42 chars and single-line (`validateMeta` cap 120). Runner egress colo varied per run (IAD, LAX, SJC in the cf-ray), so the Cloudflare block is keyed to the GitHub runner IP ranges, not one colo.

## Final still-blocked list (what the README "Known limits" documents)

- Cloudflare JS challenge, 403 on every run, error `blocked from GitHub runner: 403 Cloudflare`: importai, zvi, thebatch, epoch-gradient-updates, chinai, pod-dwarkesh.
- YouTube feed endpoint, 404/500 for most requests from the runner, error `HTTP 404 (3 attempts)` / `HTTP 500 (3 attempts)` when all three attempts fail: yt-karpathy, yt-yannic, yt-aiexplained, yt-gpumode, yt-stanford (yt-3b1b got through this run; yt-yannic got through the previous one). Expect ~1 of 6 channels per run, varying.

## Decisions taken (D3 conditional rules, from the FEAT-001 runner probe, run 39369807517)

- (i) YouTube Accept: variants (b) browser+feed Accept, (c) browser+`*/*`, (d) c+cookie all 0/18 on the runner -> tie -> `Accept: */*`, no cookie.
- (ii) Cookie `CONSENT=YES+cb; SOCS=CAI`: not added; no YouTube response carried a `location` pointing at consent.youtube.com.
- (iii) `playlist_id=UU…` URL form: not adopted; 0/18 on the runner, never succeeded where `channel_id` got zero. `sources.config.mjs` untouched.
- D5: still-blocked sources stay in the registry and stay `failed`; `errorSummary(err, { onRunner })` gives the short specific string; `errorClass` unchanged (arXiv note, tests). No proxy, mirror, scraper or key anywhere.

## What could only be confirmed on the runner

- Whether browser-like headers clear the Cloudflare 403s: no (cf-mitigated=challenge under Chrome UA + browser Accept + Accept-Language on all six, three colos).
- Whether the runner ever gets a 200 from YouTube's feed endpoint: rarely (0/90 in the FEAT-001 probe; 1/6 channels in each of the FEAT-002 and FEAT-003 runs, a different channel each time); the 3-attempt policy is what recovers those.
- The exact `detail` strings (block page, `cf-ray`, `server=YouTube RSS Feeds server`) in meta.json and the Actions log.
- The arxiv-cs.AI fallback path at 20 s timing out inside the 45 s backstop (seen at 03:42Z); the 04:46Z and 04:57Z runs fetched 789 items via RSS, so the 15 s fallback timeout was exercised only by unit tests. The 00:00 UTC scheduled run is the one that hits the empty-RSS window.
- That the `onRunner` strings (`blocked from GitHub runner: …`) actually appear in meta.json and on the live Pages copy (GITHUB_ACTIONS=true is set only there).
- The `workflow_dispatch` `probe` input and the probe matrix in the job log.

## Actions run ids

- 39365652341, 39366270740 (03:50Z): pre-change evidence runs (baseline failures, arxiv fallback timeout).
- 39369807517 (04:29Z, workflow_dispatch `-f probe=true`): FEAT-001 probe matrix + `detail` fields.
- 39371243408 (04:45Z, push 5c86db7): FEAT-002 headers/retries/arXiv timeout.
- 39372229633 (04:56Z, push d3fdfb8): FEAT-003 errorSummary + docs; final counts 36 ok / 17 empty / 11 failed, data commit 07ee16f, live copy generatedAt 2026-10-20T04:57:36.006Z.
