# Response evidence, browser-like headers and a 3-attempt YouTube policy for sources that fail only from GitHub Actions

Twelve of the 64 sources failed only from the Actions runner: six Cloudflare-fronted feeds (five Substack, The Batch sitemap) answered 403 and the six YouTube channel feeds answered 404/500. The HTTP client now keeps bounded response evidence on every non-2xx in a new `detail` field (selected headers plus 300 chars of tag-stripped body, one line of at most 400 chars) that reaches `meta.json`, the Actions log and the CLI; every request except Reddit and the GitHub API carries a Chrome User-Agent, a browser-like feed `Accept` and `Accept-Language`; `www.youtube.com` gets three attempts with 2 s / 8 s backoff and `Accept: */*`; the arXiv API fallback is capped at 15 s so its retry fits the 45 s backstop; and still-blocked sources stay `failed` with a short specific `error`. The runner round-trips in FEAT-001..003 show the headers do not clear the Cloudflare JS challenge and YouTube recovers 0-1 of 6 channels per run, so the net result is diagnostics and honest error strings rather than recovered sources; the D3 conditional rules were applied exactly as the probe dictated (`*/*`, no cookie, no `playlist_id` switch).

Watch for: `runner-fix-results.md` and the README's "typically 1 of 6" are one run stale against the committed `data/meta.json` (4a44ef4, 05:14Z: 35/17/12 with all six `yt-*` failed) (confirmed, docs only); a non-2xx response whose body stalls now holds the attempt until the request timeout instead of failing immediately (confirmed mechanism, unlikely in practice); the backoff sleep still runs before the deadline check, so a retry that will be skipped wastes up to 8 s, or 30 s on a 429 with `retry-after` (confirmed, pre-existing order kept in the rewritten loop). Nothing blocks.

**Verdict**: APPROVED

## High-level view

`detail` is built in `src/http.js::once()` from the response only (five headers at 80 chars each, 4 KB of body cut to 300 chars after tag stripping), rendered by `formatDetail` as one control-character-free line, and bounded again by `validateMeta` at 400 chars. `error` stays separate and short because `app.js` renders it; `app.js` never renders `detail`, so the untrusted body text is only stored and logged. The cost of reading the body is that a stalled error response is now bounded by the request timeout rather than failing at once, and the Cloudflare page's stylesheet survives the tag strip, so the committed details are mostly CSS.

Header selection happens per redirect hop in `headersFor(current, accept)`, so the Bearer token is attached only while the hop's host is `api.github.com` and a cross-host redirect drops it (still pinned by `tests/http.test.js:152`). The runner probe showed the browser headers change nothing against Cloudflare (`cf-mitigated=challenge` under every variant) or YouTube (0/90), and the four post-change runs show they break nothing either (every other source kept its status).

Retries are a per-host plan (`[2000]`, `[2000, 8000]` for YouTube) with the deadline guard and the 429 cap applied before every attempt and `attempts` stamped on the thrown error. The guard still runs after the sleep, so a doomed retry costs its backoff before it is skipped. A failing YouTube source now costs ~10.3 s of a worker instead of ~2.3 s, about a minute of the 8-minute budget for all six.

Nothing was removed and no proxy, mirror, scraper or key was added; the README names the twelve sources with the exact `error` strings the committed `meta.json` carries. The results file and the README's recovery-rate phrase describe the 04:57Z run, while the follow-up push produced a 05:14Z run where all six YouTube channels failed.

<details>
<summary>Issues (7)</summary>

1. **Results file one run stale** - `runner-fix-results.md` ends at run 39372229633 (36/17/11, "yt-3b1b got through this run") but the committed `data/meta.json` is from run 39373776054 (4a44ef4, 05:14:50Z: 35/17/12, all six `yt-*` failed, `yt-3b1b` = `HTTP 500 (3 attempts)`). Add that run to the counts table and the still-blocked list, and change README `Known limits` "typically 1 of 6" to "0-1 of 6 in the measured runs". Non-blocking.
2. **Error-body read is bounded only by the request timeout** - `src/http.js:232` awaits `readSnippet(res)` on every status >= 400 with no cap of its own; a server that stalls the error body holds the attempt until the 20 s timeout (previously the body was cancelled immediately). Give the snippet read its own short budget (1-2 s) or accept the bounded worst case. Non-blocking.
3. **Backoff sleep before the deadline check** - `src/http.js:280-281` sleeps the backoff (2 s / 8 s, or up to 30 s for a 429 with `retry-after`) and only then checks whether >= 25 s remain; when the check fails the sleep was wasted. Check `deadlineAt - nowMs() - wait < RETRY_MIN_REMAINING_MS` before sleeping. Pre-existing order kept in the rewritten loop. Non-blocking.
4. **Cloudflare `detail` body is mostly CSS** - the tag strip at `src/http.js:232` keeps `<style>`/`<script>` contents, so the committed details read `Just a moment... *{box-sizing:border-box;...` and hit the 400-char cap mid-body (closing quote lost). Strip `<style>...</style>` and `<script>...</script>` blocks before removing tags. Non-blocking.
5. **Third-party error text is published** - `detail` is written to `data/meta.json`, which GitHub Pages serves publicly. Cloudflare's 1006/1020 "Access denied" pages print "Your IP: ...", so a blocked local `npm run fetch` that commits `data/` could publish the operator's home IP (runner IPs are public ranges and harmless). Possible; filter `Your IP` patterns or note it in the README's `detail` bullet. Non-blocking.
6. **arXiv failed path bypasses `errorSummary`** - `src/parsers/arxiv.js:98` sets `error: errorClass(fallbackError)`, so an arXiv double failure never shows `(n attempts)` or the Cloudflare string that every other source would. Plan-sanctioned (errorClass kept for the note); switch to `errorSummary` if consistency matters. Non-blocking.
7. **Untested paths** - the redirect-exhausted `detail` (`{ location, server }`), `detail` propagation in the arXiv failed path, `readSnippet` returning `''` when the stream aborts or errors, and a YouTube third attempt being skipped by the deadline guard have no unit test. Add cases to `tests/http.test.js` / `tests/arxiv.test.js`. Non-blocking.

</details>

<details>
<summary>Details</summary>

### Evidence capture on non-2xx and the `detail` bound

```
once(): status >= 400
  headers --> headerDetail (5 keys x <=80 chars) --------------------+
  body    --> readSnippet (<=4 KB) --> strip tags --> <=300 chars ---+--> HttpError.detail (object)
                                                                     |
runSource catch --> formatDetail --> one line <=400 chars --> result.detail --> meta.sources[id].detail
                                                         +--> logger.warn(`${id}: ${error} [${detail}]`)
```

The redirect-exhausted branch attaches `{ location, server }` only. `formatDetail` removes `[\x00-\x1f\x7f]`, so neither a newline nor an ANSI escape from a block page can reach the Actions log or `meta.json`; `validateMeta` (`src/schema.js:331`) rejects a `detail` over 400 chars or containing `\n`/`\r`. Request headers are never recorded (the test serialises the error and asserts no `user-agent`).

The body read has no budget of its own: `reader.read()` resolves only when the server sends bytes or ends the stream, so a 4xx whose body stalls keeps the attempt alive until the request's `AbortController` fires at `timeoutMs` (20 s default, less when the deadline is nearer); `readSnippet` then swallows the abort and the `HttpError` is still thrown with the right status (`src/http.js:92-109, 229-234`). The committed `ms` values for the six Cloudflare sources are 20-69 ms, so this is a bounded worst case rather than a live problem, but it is a change from the previous immediate cancel.

The tag strip keeps the contents of `<style>` and `<script>` elements. The Cloudflare interstitial puts a stylesheet right after the title, so the committed `detail` for all six blocked sources is `Just a moment... *{box-sizing:border-box;margin:0;padding:0}html{line-height:1.15;...` and the 400-char line ends mid-body without its closing quote (every Cloudflare detail in `data/meta.json` is exactly 400 chars). `server=cloudflare; cf-mitigated=challenge` sits at the front and is intact, so this is a readability nit; dropping `<style>...</style>` and `<script>...</script>` blocks before the tag strip would make the 300 body chars carry the page's visible text.

`detail` is third-party content persisted to a public file. `app.js` renders only `error` (`app.js:183`, `el()` text nodes) and never touches `detail`, so the exposure is the published text itself. Cloudflare's "Access denied" family (errors 1006/1020) prints the client IP in the page body, unlike the challenge page seen here. From Actions that would expose a shared runner IP, which is public anyway; from a local `npm run fetch` whose output is committed, it could expose a home IP (possible: it requires a host to block the home connection, which none of the 64 currently does).

### Header policy and the identified-host exceptions

`headersFor` is evaluated on `current` at every hop, so the UA switches if a redirect lands on an identified host and the Bearer token plus `application/vnd.github+json` are attached only while the hop's host is `api.github.com`; the pre-existing test `the GitHub token is sent only to api.github.com and never leaks` (`tests/http.test.js:152-176`) still asserts a cross-host redirect drops it. `www.reddit.com` and `api.github.com` keep the `Ahead/<version>` UA but do receive `Accept-Language`, as D2 specifies. `www.youtube.com` overrides `Accept` to `*/*` regardless of the caller's `accept` argument; all YouTube fetches are feed fetches, so nothing else is affected. Redirects are still followed by the manual loop (5 hops).

The runner measurement (FEAT-001 findings, run 39369807517) is the honest part: all seven Cloudflare URLs returned 403 with `cf-mitigated=challenge` under both the old and the browser header set, and YouTube returned 404/500 for 90 of 90 requests across four header variants, the `playlist_id=UU...` form and the bare host. A JS challenge cannot be passed by a plain HTTP client, so the browser headers were never going to clear it; they stayed because every non-blocked source kept its status across four runs (35-36 ok, 17-18 empty, 11-12 failed, versus 33/19/12 at baseline) and because the plan committed to them before the probe ran.

### YouTube backoff plan and the deadline guard

`retryable` keeps Reddit at never and `BodyTooLarge` at never, adds YouTube 404 to the retryable set, and the loop stamps `err.attempts` on whatever is finally thrown (1 when no retry ran). The fake-clock test pins attempts at 0 / 2000 / 10000 ms, `attempts === 3` after three 404s, and exactly one retry for other hosts.

The guard runs after the sleep, as it did before the rewrite. The consequence is sharper now that one backoff is 8 s: if attempt 2 on YouTube finishes at, say, 13 s, the client sleeps 8 s, finds 24 s remaining and gives up at 21 s, having spent 8 s on a retry it never made; on a 429 with `retry-after: 30` the wasted sleep is 30 s. Moving the check in front of the sleep (`deadlineAt - nowMs() - wait < RETRY_MIN_REMAINING_MS`) removes the waste without changing which attempts run. Bounded by the 45 s backstop either way.

On the runner the plan recovered one channel in each of the 04:46Z and 04:57Z runs (`yt-yannic` on attempt 2, then `yt-3b1b`) and none in the 05:14Z run. A failing channel costs 10.2-10.6 s (`ms` in `meta.json`) instead of ~2.3 s; six of them in the 6-worker pool is roughly a minute of a budget of eight.

### arXiv fallback timeout and the failure-class note

With a fast empty RSS the fallback path is 15 s + 2 s sleep + 15 s = 32 s, with 28 s left at the guard; the unit test pins two attempts by 32.5 s and one attempt under the default 20 s timeout. If the RSS itself times out (20 s, its own retry skipped at 22 s), the fallback still gets one 15 s attempt and gives up at 39 s, inside the backstop. The `empty` note now names the class (`api fallback failed (<class>)`) and the double-failure path attaches `formatDetail(fallbackError.detail)`.

The double-failure path keeps `error: errorClass(fallbackError)` rather than `errorSummary`, so an arXiv source would read `HTTP 503` where any other source would read `HTTP 503 (2 attempts)`. The plan explicitly kept `errorClass` for the arXiv note; extending that to the `error` field is a defensible reading, but it is the one place the D5 strings do not apply.

### Error strings for sources that stay blocked

`errorSummary` yields `blocked from GitHub runner: 403 Cloudflare` (42 chars) when `env.GITHUB_ACTIONS === 'true'` and the 403's `detail.server` matches `/cloudflare/i`, `blocked: 403 Cloudflare` off the runner, `HTTP <status> (<n> attempts)` for any retried `HttpError`, and `errorClass` otherwise, with the Cloudflare branch winning over the attempts branch. The committed `meta.json` carries exactly these strings on all twelve failed sources, the live Pages copy matches (`generatedAt 2026-10-20T05:14:50.991Z`, 35/17/12), and the Actions log shows the `<id>: <error> [<detail>]` warn lines. A timeout or network error after three YouTube attempts still reads `timeout`/`network` without the attempt count, which is what D5 specifies. `sources.config.mjs` is not in the diff, `package.json` gains only the `probe:runner` script, and no new dependency, proxy host, mirror URL or secret appears anywhere in the diff.

### Test coverage

`npm test` passes 183/183 (47.9 s) on the final tree, covering the Cloudflare 403 fixture (tag-free body <= 300, line <= 400, no request headers), the empty-body 404, `formatDetail` control-char removal and cut, the `errorSummary` matrix, the header matrix on an ordinary host, Reddit, the GitHub API and YouTube, the retry matrix with `attempts`, the 15 s-inside-45 s policy, the arXiv fallback `timeoutMs` and note, the on-runner and off-runner pipeline strings, and `validateMeta`'s `detail` bounds.

Not tested: the redirect-exhausted `detail` (`{ location, server }`); `detail` propagation on the arXiv double-failure path (`tests/arxiv.test.js` asserts status and note only); `readSnippet` returning `''` when the stream errors or the abort fires mid-read; a YouTube third attempt being skipped by the deadline guard after the 8 s backoff (the 25,000/24,999 ms cases cover only the generic single-retry path); the `probe:runner` script and the workflow input (diagnostic, YAML).

### Documentation against the committed data

README `Known limits` names exactly the twelve sources that fail in the committed `meta.json` (4a44ef4) with exactly its `error` strings, and the Sources table, `probe:runner`, `-f probe=true` and the `detail` field match the code. The drift is in the recovery rate: `runner-fix-results.md` calls run 39372229633 (04:57Z, 36/17/11, "yt-3b1b got through this run") the final run and the README says "typically 1 of 6", but the 7fad104 push triggered run 39373776054, whose data commit 4a44ef4 is what `main` and the live site now carry: 35/17/12, all six `yt-*` failed, `yt-3b1b` back to `HTTP 500 (3 attempts)`. Across the three post-policy runs the recovery rate is 1, 1, 0 of 6; the results file should gain that row and the README phrase should read "0-1 of 6 in the measured runs". Every data commit in the range is authored by `github-actions[bot]`, the four human commits touch no file under `data/`, and `src/` contains exactly the three `console.error` calls in `pipeline.js`'s default logger.

</details>

<details>
<summary>File map</summary>

- `src/http.js` - `BROWSER_USER_AGENT`, `IDENTIFIED_HOSTS`, `ACCEPT_LANGUAGE`, new `ACCEPT.feed`; `readSnippet`/`headerDetail`/`formatDetail`; `HttpError.detail`; per-host `retryPlan` with `err.attempts`; `errorSummary`.
- `src/pipeline.js` - `runSource` uses `errorSummary` + `formatDetail`, logs the detail; `run()` passes `onRunner` and copies `detail` to the source entry.
- `src/parsers/arxiv.js` - 15 s fallback timeout; `api fallback failed (<class>)` note; `detail` on the double-failure path.
- `src/schema.js` - `validateMeta` accepts optional `detail` (<= 400 chars, single line).
- `scripts/fetch.mjs` - prints `  <id>: <detail>` rows under the table.
- `scripts/probe-runner.mjs` (new) - header-variant matrix for the 7 blocked URLs and 6 YouTube channels; `scripts/probe-sources.mjs` passes `onRunner`.
- `.github/workflows/refresh.yml` - `workflow_dispatch` input `probe` and the conditional probe step; `package.json` - `probe:runner` script.
- `tests/http.test.js`, `tests/pipeline.test.js`, `tests/arxiv.test.js`, `tests/helpers.js` - detail/formatDetail, errorSummary, header and retry matrices, 15 s policy, arXiv opts/note, on/off-runner strings, `validateMeta` detail bounds, override `headers`, `startsWith('text/html')` page detection.
- `README.md` - header policy line, Sources notes, `probe:runner`, `-f probe=true`, `detail` field, rewritten Known limits bullet.

Full diff: `git diff f5efc03..HEAD -- . ':!data'` in `c:\Users\sudiskmr\Downloads\DomainClassification\ahead`.

</details>
