# LLM editorial layer on Gemini: fix report

Date: 2026-10-20. Repo `Sudish007/ahead`, branch `main`. Live config (GitHub Actions secrets, the key never read locally): `LLM_BASE_URL = https://generativelanguage.googleapis.com/v1beta/openai`; `LLM_MODEL` was `gemini-3.6-flash` at the start and is `gemini-3.5-flash-lite` at the end (see "Decision taken").

**Outcome in one line:** the parsing/request defect is fixed and tested; live `meta.llm` went from `{"ok":false,"error":"invalid JSON"}` to `{"ok":true,"overview":"accepted","why":{"accepted":15,"rejected":0}}` with a 159-word overview and 15/15 model-written why-lines, after the model was switched to `gemini-3.5-flash-lite` because `gemini-3.6-flash` on the free tier answered 503 for an hour and then exhausted its 20 requests/day.

## Starting point

First live run with the key (run 39412855023, `generatedAt 2026-10-20T11:09:34Z`):

```json
{"enabled":true,"ok":false,"model":"gemini-3.6-flash","error":"invalid JSON"}
```

The brief fell back to the heuristic version correctly: `overview: null`, 15/15 entries `whySource: "heuristic"`, 553 words.

## Root cause

`src/llm.js` sent `max_tokens: 1500` and parsed `choices[0].message.content` by slicing from the first `{` to the last `}`. On Gemini's OpenAI-compatible endpoint `max_tokens` is a hard cap on thinking **plus** visible output (Google forum answer for gemini-3.6-flash: ["max_tokens is a hard cap on combined thinking + visible output"](https://discuss.ai.google.dev/t/gemini-3-6-flash-openai-compatible-token-limits-response-fields-and-auth-keys/183372/2); the model's default `reasoning_effort` is medium). Gemini 3.x Flash spends a sizeable share of a 1,500-token budget on reasoning, so the visible JSON was cut off (`finish_reason: "length"`) and the truncated text did not parse. The old code reported only `invalid JSON`, with no finish reason, usage or excerpt, which is why the first run was undiagnosable from `meta.json`.

Secondary weaknesses fixed at the same time: no JSON mode was requested, markdown fences would have broken the parser, a reply with `content: null` plus `reasoning_content`/`refusal` was reported as `empty`, and a single provider hiccup (503, slow answer) ended the editorial layer for the run.

## What changed

All in `src/llm.js` unless noted; tests in `tests/llm.test.js`; schema in `src/schema.js`; log line in `src/pipeline.js`; docs in `README.md`, `.agents/tasks/ahead-build/plan.md` §9 and `design.md` §7.

Request:
- `response_format: { type: "json_object" }`, dropped on an HTTP 400 that names it.
- `max_tokens: 8192` (was 1,500); the `max_tokens -> max_completion_tokens` retry is kept.
- `reasoning_effort: "low"`, dropped on an HTTP 400 that names it (OpenAI's non-reasoning models reject it).
- System prompt asks for a single JSON object, no fences, no prose; overview 160-190 words (hard limits 150/200 unchanged); why-lines 12-20 words (hard limit 25 unchanged); numbers only when they appear with the same digits and unit in that entry's facts.
- `temperature: 0.3` unchanged. One logical request per run unchanged.

Parsing (`parseJsonObject`): trim, strip one surrounding ```` ```json ```` / ```` ``` ```` fence, `JSON.parse`; failing that, the first balanced top-level `{...}` (string-aware brace matching, a balanced-but-invalid object is skipped); only then `invalid JSON`. `finish_reason: "length"` -> `truncated` even when a prefix parses. Missing/blank content -> `refusal` (when `message.refusal`), `reasoning only` (when only `message.reasoning_content`), else `empty`.

Resilience: transient answers (429, 500, 502, 503, 504, network error) retried after 10 s and then 30 s (`retry-after` header or Gemini's "Please retry in Ns" phrase honoured, capped at 30 s). Hard ceiling `MAX_REQUESTS = 3` POSTs per run, counting compatibility 400 retries and transient retries alike; a timeout and a 429 are each retried once at most; a 429 naming a per-day quota is final; per-attempt timeout raised from 60 s to 120 s and it now covers the body read too. Compatibility 400s do not count towards the ` (N attempts)` suffix but do count towards the ceiling.

Diagnostics in `meta.llm` (published, so bounded and secret-free): `error` (with ` (N attempts)` when retries ran), `finishReason` (<= 40 chars), `usage { prompt, completion, total }`, `detail` (first 300 chars of the model content or error body, whitespace collapsed), `ms`, `compat` (fixes applied), and when the reply parsed `overview` (`accepted` | `missing` | `rejected: N words` | `rejected: number X`) and `why { accepted, rejected }`; a rejected overview is kept as `detail`. `excerpt()` scrubs the key (split/join before any cut, so a slice can never keep a fragment) and runs `redactKey` from `src/http.js` on googleapis `key=` values. `validateMeta` enforces `detail` single-line <= 300, `finishReason` <= 40, `overview` <= 80 single-line, `why` exactly `{ accepted, rejected }` non-negative integers, `usage`/`ms` non-negative integers, `compat` a non-empty array of <= 3 strings. `digest.llm` stays `{ enabled, ok }`. The pipeline logs `describeLlmFailure(result)` as a warning on failure and as a `partial` warning when `ok` but the overview was not accepted or a why-line was rejected.

Grounding tweak: a number the facts spell with a leading `-` (`Lightricks/LTX-2.5` tokenizes as `-2.5`, `Qwen3.8-27B` as `-27b`) also grounds its unsigned form, so prose like "LTX 2.5" passes; a sign the facts lack is still rejected.

Safety rules preserved: per-entry number grounding against that entry's facts (rejected entries keep the heuristic line), overview grounded against the union and dropped when it fails 150-200 words or the number check, per-entry granularity (good entries accepted even when others are rejected), `enforceBudget(digest, 1100)` after acceptance, a failed call leaves the heuristic brief byte-identical. UI already renders `overview` with the "AI-written" tag (`app.js` `renderDigest`); no frontend change.

### Commits on `main`

| SHA | Change |
|---|---|
| `11cca3f` | JSON mode, 8k token budget, fence/prose-tolerant parsing, truncated/refusal/reasoning-only states, bounded key-scrubbed `detail`, `finishReason`, `usage`; schema + docs |
| `3417b5f` | retry transient 429/5xx/network errors with backoff (10 s / 30 s) |
| `54d1588` | third backoff step (60 s) for sustained 503s |
| `7bc20f4` | `reasoning_effort: "low"` with its own compat retry |
| `2b120d6` | 120 s per-attempt timeout covering the body, one timeout retry, `ms`/`compat` diagnostics |
| `9980d8f` | a 429 naming a per-day quota is final; docs for the timeout; first version of this report |
| `57e6ebe` (`[skip ci]`) | a 429 is retried once at most; Gemini's "retry in Ns" hint honoured |
| `00832f7` (`[skip ci]`) | report: quota finding, status, recommendations (the decision point) |
| `58c54e7` (`[skip ci]`) | `MAX_REQUESTS = 3`: hard ceiling on requests per run counting compat and transient retries; backoff plan 10 s / 30 s; README on free-tier quotas, billed projects and the revert command |
| `8b50f77` | `meta.llm.overview` / `meta.llm.why` acceptance diagnostics, rejected overview kept as `detail`, prompt states the discard rule and asks for ids verbatim, hyphenated ids (`LTX-2.5`) ground their unsigned number |
| (final, `[skip ci]`) | this report completed |

Secret change (not a commit): `LLM_MODEL` set to `gemini-3.5-flash-lite` at 12:51Z via `gh secret set LLM_MODEL --repo Sudish007/ahead --body gemini-3.5-flash-lite` (decision (a) from the parent session; a model id, not secret material).

### Tests

`npm test`: 258 tests (was 249), 258 pass on the Actions runner (the `npm test` step of every run below was green). Locally on this Windows checkout 257 pass and `tests/relay-allowlist.test.js` fails on a pre-existing `core.autocrlf=true` artifact (the test asserts LF in `relay/src/allowlist.json`; the file is LF in the index and on CI); unrelated to this work.

New or extended `llm.test.js` cases: fenced JSON (```` ```json ````, bare fence, CRLF) parses; JSON with leading prose and stray braces parses by extraction; `{"a":1,} then {"b":2}` skips the invalid object; `finish_reason: "length"` -> `truncated` with `finishReason`, `usage`, `detail`, even when a prefix parses or content is absent; `content: null` + `reasoning_content` -> `reasoning only`; `refusal` -> `refusal`; request body has `response_format json_object`, `max_tokens >= 4000` (8192), `reasoning_effort low`; a 400 naming `response_format` / `reasoning_effort` / `max_tokens` triggers one retry each without that field, messages unchanged; `detail` capped at 300 chars with the fake key (`sk-SECRET`) and a googleapis `key=` value redacted, including when the cut falls inside the key; transient retry plan (waits, `retry-after` seconds and cap, non-numeric header ignored, Gemini's "retry in 4.5s" phrase, exhausted -> `HTTP 503 (3 attempts)`, compat 400 not counted as an attempt, timeout retried once, 429 retried once, per-day 429 final); a ten-sequence sweep proving no mix of compat 400s, 429s, 5xx, timeouts and network errors ever makes a fourth request; overview status strings (`accepted`, `missing`, `rejected: 149 words`, `rejected: number 90%`) with the rejected text as bounded `detail`; why `{ accepted, rejected }` counts; hyphenated-id grounding (`LTX-2.5` -> `2.5` accepted, `2.5` -> `-2.5` rejected); `validateMeta` bounds for every new field; numbers-validation tests unchanged and green.

### Request ceiling (checked before the dispatch, as asked)

`pipeline.js` calls `editorialize` once per run and only when a key and model are set (never in `--dry-run`/`--source` mode); it passes the raw `fetch`, not the retrying HTTP client used for sources. Inside `editorialize`, `requests` counts every POST and nothing is sent once it reaches `MAX_REQUESTS = 3`, whether the previous answer was a compatibility 400, a 429/5xx, a timeout or a network error. A 429 is retried once at most (`MAX_RATE_LIMIT_RETRIES = 1`) and not at all when the body names a per-day quota; a timeout once at most. So a run costs at most 3 requests, a day of four scheduled runs at most 12, and an exhausted-quota day costs 2 per run: the 20/day Flash quota cannot be exhausted by the schedule alone if the user switches back.

## Live verification

Every push to `main` outside `data/` triggers `refresh.yml`, so each commit above was a live attempt. All runs were green (tests, fetch, commit, deploy); the LLM layer's own outcome is in `meta.llm`:

| Run | Commit | `generatedAt` | `meta.llm` (live) |
|---|---|---|---|
| 39412855023 | before | 11:09:34Z | `{"enabled":true,"ok":false,"model":"gemini-3.6-flash","error":"invalid JSON"}` |
| 39415556927 | `11cca3f` | 11:32:27Z | `error: "HTTP 503"`, `detail: [{ "error": { "code": 503, "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", "status": "UNAVAILABLE" } } ]` |
| 39416821925 | `3417b5f` | 11:42:59Z | `error: "HTTP 503 (3 attempts)"`, same detail |
| 39417740486 | `54d1588` | 11:50:38Z | `error: "HTTP 503 (4 attempts)"`, same detail (run `durationMs` 158,325) |
| 39420946893 | `7bc20f4` | 12:16:52Z | `error: "timeout"` (the model accepted the request but did not answer within 60 s) |
| 39422148102 | `2b120d6` | 12:26:29Z | `error: "HTTP 503 (4 attempts)"`, same detail, `ms: 157582` |
| 39423321018 | `9980d8f` | 12:35:29Z | `error: "HTTP 429 (4 attempts)"`, `ms: 113917`, `detail: [{ "error": { "code": 429, "message": "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded fo` (cut at 300 chars) |
| 39425526237 (dispatch) | `58c54e7`, model `gemini-3.5-flash-lite` | 12:52:12Z | `{"enabled":true,"ok":true,"model":"gemini-3.5-flash-lite","usage":{"prompt":1557,"completion":739,"total":2296},"ms":2587}`; digest: `overview: null`, 15/15 `whySource: "llm"`, 626 words |
| 39427891665 (push) | `8b50f77` | 13:09:31Z | `{"enabled":true,"ok":true,"model":"gemini-3.5-flash-lite","overview":"accepted","why":{"accepted":15,"rejected":0},"usage":{"prompt":1581,"completion":814,"total":2395},"ms":11059}`; digest: overview 159 words, 15/15 `whySource: "llm"`, 825 words, 4 min |

Through run 39423321018 the brief stayed heuristic (`overview: null`, 15/15 `whySource: "heuristic"`, 553 words) and `digest.llm = { enabled: true, ok: false }`. The 1,100-word cap and the schema held in every run (the Actions `npm test` step and `validateDigest`/`validateMeta` in the pipeline).

**Before / after.** Live `meta.llm` at the start:

```json
{"enabled":true,"ok":false,"model":"gemini-3.6-flash","error":"invalid JSON"}
```

Live `meta.llm` at the end (run 39427891665):

```json
{"enabled":true,"ok":true,"model":"gemini-3.5-flash-lite","overview":"accepted","why":{"accepted":15,"rejected":0},"usage":{"prompt":1581,"completion":814,"total":2395},"ms":11059}
```

Live digest `data/digests/2026-10-20.json` at the end: `overview.text` is a 159-word paragraph (`source: "llm"`, `model: "gemini-3.5-flash-lite"`), rendered on the site with the "AI-written" tag; 15 entries, **15 `whySource: "llm"`, 0 `heuristic`**; `wordCount` 825 (cap 1,100), `readingMinutes` 4; `digest.llm = { enabled: true, ok: true }`. `usage.total - prompt - completion = 0`, so Flash-Lite at `reasoning_effort: "low"` spent nothing on thinking; the call took 11 s.

Why the first Flash-Lite run (39425526237) had `ok: true` but no overview: the model's overview failed one of the two acceptance checks (word range or number grounding) and the result object at that commit did not say which. Commit `8b50f77` added `overview`/`why` to the result, keeps a rejected overview as `detail`, and tightened the prompt (the discard rule is now stated; model names and ids are to be copied verbatim, since `Lightricks/LTX-2.5` tokenizes as `-2.5` and a prose `LTX 2.5` would have failed grounding before the unsigned-form rule). The next run accepted the overview.

Leak check on the published files after every run, including the last two: `meta.json` and `digests/2026-10-20.json` contain no `AIza` and no `Bearer` substring. The only provider text ever published was the Gemini 503/429 error bodies shown above.

## Diagnosis

The original defect (truncation + brittle parsing + no diagnostics) is fixed and covered by tests; the new diagnostics are what made the live failures readable. What the live runs show now is a provider-side capacity problem for this model id: from 11:32Z to at least 12:28Z `gemini-3.6-flash` answered `503 UNAVAILABLE "high demand"` on 12 of 13 attempts spaced 10-60 s apart, and the one request it accepted took longer than 60 s. This matches public reports for the same model on the Developer API: a paid Tier 1 project seeing a sustained [~37% 503 rate on gemini-3.6-flash over 30 days](https://discuss.ai.google.dev/t/persistent-37-unavailable-503-on-generatecontent-with-gemini-3-6-flash-paid-tier-1-zero-429s-counttokens-unaffected/179971/1) (503s arriving after 2-79 s of queueing, so they are not admission refusals), and a free-tier report that [3.7/3.8 Flash return 503 on every call while 3.6 Flash answers intermittently and the Flash-Lite models answer normally](https://discuss.ai.google.dev/t/handling-429-503-errors-from-the-gemini-api/124640/79). Google's guidance for 429/503 is backoff and retry, which the pipeline now does within a run; across runs the 6-hourly cron is the retry. Content rephrased from those threads for licensing compliance.

Run 39423321018 confirmed the second half of those reports: the key is on the **free tier**, and `gemini-3.6-flash` there has a 20 requests-per-day quota that the 503-answered attempts also consumed. The day's requests (1 before the fix, then 1 + 3 + 4 + 1 + 4 from the retrying runs, plus whatever the key was used for before 11:09Z) exhausted it, so that run got `429 "You exceeded your current quota"` on all four attempts. The 429 body on the OpenAI-compatible endpoint names the metric (`generate_content_free_tier_requests, limit: 20`) but not the word "day", which is why the per-day rule from `9980d8f` did not catch it; `57e6ebe` therefore caps every 429 at one retry regardless of wording, and `58c54e7` caps every run at 3 requests. That quota resets at midnight Pacific (07:00 UTC); it no longer matters for the live site since the model switch, but it is why a switch back to a 3.x Flash model should be paired with billing.

Nothing in the request shape causes the 503 or the 429: the first live run got a 200 from the same endpoint with the smaller body, the 503s continued identically across the request changes, and the 429 is a quota count. The same code with `LLM_MODEL=gemini-3.5-flash-lite` answered in 2.6 s and 11 s with no retries.

## Decision taken and the model choice

The parent session chose option (a): switch `LLM_MODEL` to `gemini-3.5-flash-lite`. Reasons: on the Gemini Developer API free tier, Flash-Lite allows roughly 500 requests per day against about 20 for the 3.x Flash models, both counting failed attempts; the job is 15 one-line rewrites plus a short grounded overview, which does not need the larger model; and the Flash-Lite models were the ones reported as answering normally while 3.x Flash returned 503s. `gemini-3.6-flash` remains a fine choice on a billed (Tier 1+) AI Studio project, where the 20/day limit does not apply, though the paid-tier 503 report above suggests capacity can still be tight.

Revert (model id only, nothing else changes; the next scheduled run or a `gh workflow run refresh.yml --repo Sudish007/ahead` picks it up):

```sh
gh secret set LLM_MODEL --repo Sudish007/ahead --body gemini-3.6-flash
```

Back to Flash-Lite: `gh secret set LLM_MODEL --repo Sudish007/ahead --body gemini-3.5-flash-lite`. Both are documented in the README's LLM section.

## Status against the acceptance criteria

All met live as of run 39427891665 (2026-10-20T13:09:31Z): `meta.llm.ok` true, `meta.llm.model` `gemini-3.5-flash-lite`, no `error`; digest `overview` a 159-word string (`source: "llm"`); 15 of 15 entries `whySource: "llm"`, 0 heuristic; `wordCount` 825 under the 1,100 cap; `meta.json` and the digest free of `AIza` and `Bearer`; every Actions run green; 258 tests passing on CI; a run can never make more than 3 provider requests, and a 429 is retried at most once. The heuristic fallback is intact and was exercised live on every failing run of the day.

## Operating notes

- To check a run: `https://sudish007.github.io/ahead/data/meta.json` -> `llm` (`ok`, `overview`, `why`, `usage`, `ms`; on failure `error`, `finishReason`, `detail`), and `data/digests/<date>.json` -> `overview.text`, `whySource` per entry.
- `overview: "rejected: N words"` with the text in `detail` means the model missed the 90-260 band (the prompt asks for about 170); `rejected: number X` means it used a number absent from the facts (both leave the heuristic brief's `overview: null`, which the UI simply omits).
- `HTTP 429` with `limit: 20` in `detail` means a 3.x Flash model's free daily quota is spent; it resets at midnight Pacific (07:00 UTC).
