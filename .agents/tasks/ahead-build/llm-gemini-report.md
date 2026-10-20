# LLM editorial layer on Gemini: fix report

Date: 2026-10-20. Repo `Sudish007/ahead`, branch `main`. Live config (GitHub Actions secrets, never read locally): `LLM_BASE_URL = https://generativelanguage.googleapis.com/v1beta/openai`, `LLM_MODEL = gemini-3.6-flash`.

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

Resilience: transient answers (429, 500, 502, 503, 504, network error) retried after 10 s / 30 s / 60 s (`retry-after` honoured, capped at 30 s), at most four attempts; a timeout is retried once at most; a 429 naming a per-day quota is final; per-attempt timeout raised from 60 s to 120 s and it now covers the body read too. Compatibility 400s are not counted as attempts.

Diagnostics in `meta.llm` (published, so bounded and secret-free): `error` (with ` (N attempts)` when retries ran), `finishReason` (<= 40 chars), `usage { prompt, completion, total }`, `detail` (first 300 chars of the model content or error body, whitespace collapsed), `ms`, `compat` (fixes applied). `excerpt()` scrubs the key (split/join before any cut, so a slice can never keep a fragment) and runs `redactKey` from `src/http.js` on googleapis `key=` values. `validateMeta` enforces `detail` single-line <= 300, `finishReason` <= 40, `usage`/`ms` non-negative integers, `compat` a non-empty array of <= 3 strings. `digest.llm` stays `{ enabled, ok }`. The pipeline warning line is `describeLlmFailure(result)`.

Safety rules preserved: per-entry number grounding against that entry's facts (rejected entries keep the heuristic line), overview grounded against the union and dropped when it fails 150-200 words or the number check, per-entry granularity (good entries accepted even when others are rejected), `enforceBudget(digest, 1100)` after acceptance, a failed call leaves the heuristic brief byte-identical. UI already renders `overview` with the "AI-written" tag (`app.js` `renderDigest`); no frontend change.

### Commits on `main`

| SHA | Change |
|---|---|
| `11cca3f` | JSON mode, 8k token budget, fence/prose-tolerant parsing, truncated/refusal/reasoning-only states, bounded key-scrubbed `detail`, `finishReason`, `usage`; schema + docs |
| `3417b5f` | retry transient 429/5xx/network errors with backoff (10 s / 30 s) |
| `54d1588` | third backoff step (60 s) for sustained 503s |
| `7bc20f4` | `reasoning_effort: "low"` with its own compat retry |
| `2b120d6` | 120 s per-attempt timeout covering the body, one timeout retry, `ms`/`compat` diagnostics |
| (this commit) | per-day-quota 429 is final; this report |

### Tests

`npm test`: 256 tests (was 249), 256 pass on the Actions runner (the `npm test` step of every run above was green). Locally on this Windows checkout 255 pass and `tests/relay-allowlist.test.js` fails on a pre-existing `core.autocrlf=true` artifact (the test asserts LF in `relay/src/allowlist.json`; the file is LF in the index and on CI); unrelated to this work.

New or extended `llm.test.js` cases: fenced JSON (```` ```json ````, bare fence, CRLF) parses; JSON with leading prose and stray braces parses by extraction; `{"a":1,} then {"b":2}` skips the invalid object; `finish_reason: "length"` -> `truncated` with `finishReason`, `usage`, `detail`, even when a prefix parses or content is absent; `content: null` + `reasoning_content` -> `reasoning only`; `refusal` -> `refusal`; request body has `response_format json_object`, `max_tokens >= 4000` (8192), `reasoning_effort low`; a 400 naming `response_format` / `reasoning_effort` / `max_tokens` triggers one retry each without that field, messages unchanged; `detail` capped at 300 chars with the fake key (`sk-SECRET`) and a googleapis `key=` value redacted, including when the cut falls inside the key; transient retry plan (waits, `retry-after` seconds and cap, non-numeric header ignored, exhausted -> `HTTP 503 (4 attempts)`, compat 400 not counted, timeout retried once, per-day 429 final); `validateMeta` bounds for the new fields; numbers-validation tests unchanged and green.

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
| FINAL_RUN_PLACEHOLDER | | | |

In every run the brief stayed heuristic (`overview: null`, 15/15 `whySource: "heuristic"`, 553 words) and `digest.llm = { enabled: true, ok: false }`.

Leak check on the published files after each run: `meta.json` and `digests/2026-10-20.json` contain no `AIza` and no `Bearer` substring. The only new published text is the Gemini error body shown above.

## Diagnosis

The original defect (truncation + brittle parsing + no diagnostics) is fixed and covered by tests; the new diagnostics are what made the live failures readable. What the live runs show now is a provider-side capacity problem for this model id: from 11:32Z to at least 12:28Z `gemini-3.6-flash` answered `503 UNAVAILABLE "high demand"` on 12 of 13 attempts spaced 10-60 s apart, and the one request it accepted took longer than 60 s. This matches public reports for the same model on the Developer API: a paid Tier 1 project seeing a sustained [~37% 503 rate on gemini-3.6-flash over 30 days](https://discuss.ai.google.dev/t/persistent-37-unavailable-503-on-generatecontent-with-gemini-3-6-flash-paid-tier-1-zero-429s-counttokens-unaffected/179971/1) (503s arriving after 2-79 s of queueing, so they are not admission refusals), and a free-tier report that [3.7/3.8 Flash return 503 on every call while 3.6 Flash answers intermittently and the Flash-Lite models answer normally](https://discuss.ai.google.dev/t/handling-429-503-errors-from-the-gemini-api/124640/79). Google's guidance for 429/503 is backoff and retry, which the pipeline now does within a run; across runs the 6-hourly cron is the retry. Content rephrased from those threads for licensing compliance.

Two facts from those reports matter for operating this: on the free tier each failed call still counts against the model's requests-per-day quota (reported as 20 RPD for `gemini-3.6-flash`), so a run now costs 1-4 of those; and the lite models are the ones reported as reliable. Nothing in the request shape causes the 503 (the first live run got a 200 from the same endpoint with the smaller body, and 503s continued identically across the request changes).

## Recommendation (product decision, not taken here)

Switch `LLM_MODEL` to a model with spare capacity on the Developer API, e.g. `gh secret set LLM_MODEL --repo Sudish007/ahead --body <model>`; nothing else changes. Candidates named in Google's own docs and forum: a current Flash-Lite (`gemini-3.5-flash-lite` is the one reported as answering normally on the free tier) or the current default Flash in the docs (`gemini-3.8-flash`, reported 503-heavy on the free tier in September). The pipeline is model-agnostic; the next scheduled run (every 6 h) or a `gh workflow run refresh.yml` picks the new value up. If staying on `gemini-3.6-flash`, expect intermittent `HTTP 503 (4 attempts)` in `meta.llm` and heuristic briefs on those runs; successful runs will show `ok: true` with `usage` and `ms`.
