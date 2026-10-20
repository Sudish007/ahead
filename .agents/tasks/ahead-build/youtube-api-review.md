# Optional YouTube Data API path for the six channel sources

When `YOUTUBE_API_KEY` is set, each `type: 'youtube'` source is fetched with one `playlistItems.list` call against the channel's uploads playlist (the feed URL's `channel_id` with `UC` swapped for `UU`), mapped to the record shape `parseFeed` already emits, and pushed through the unchanged `toItem` / dedup / score path. Any failure of that call (HTTP error, timeout, network, bad JSON, missing channel id) is caught inside `runSource`, logged without the URL, and the existing feed path runs exactly as before with `api: <class>, fell back to feed` appended to the source note. The key travels only in the request URL; `http.js` gained `redactKey()` and applies it in every constructor and formatter that can carry a URL into a message, a log line or `meta.json`, and the API fetcher never exposes `finalUrl`. The change is confined to one new parser module, three touched modules, one workflow line, tests and docs; the registry, ranking, brief and UI are untouched.

**Watch for:** the feed fallback's third attempt survives an 8 s API timeout only when the first two feed attempts fail within 2 s combined (documented D3 margin, non-blocking, confirmed). Redaction is scoped to `googleapis.com` hosts, so a hypothetical off-domain redirect carrying the query string would escape it (possible, non-blocking; Google does not redirect this endpoint). No key leak path was found.

**Verdict**: APPROVED

## High-level view

The branch lives in `runSource`'s `work` closure, after the arXiv special case: with a non-blank key and a `youtube` source it awaits `fetchYoutubeApi` and returns its result; on any throw it records `apiNote` and falls through to the generic `fetchText(source.url)` + `parseFeed` lines that were already there. Because the note is attached after the outer try/catch, it reaches both the success row (`note: 'api: HTTP 403, fell back to feed'`, status and counts from the feed) and the failed row (today's exact `error`/`httpStatus`/`detail` plus the note). An unset, empty or whitespace key skips the branch entirely; the only other touched line on that path is a `redactKey()` wrap on the redirect note, a no-op for non-Google URLs.

`src/parsers/youtube.js` derives the playlist id from `new URL(source.url).searchParams.get('channel_id')` validated against `/^UC[A-Za-z0-9_-]+$/`, so there is no second id list and a misconfigured URL degrades to the feed path via `ParseError('no channel_id in url')` without any request. The mapper produces the feed's record fields (`title`, `watch?v=` URL, `publishedAt`, `summaryText` with the media `Sponsors:` cut, `bodyLength`, `authors`), no `signals`, and runs `applySelection` with the source's `maxAgeDays`/`maxItems`. The two in-window fixture items come out with the same ids, summaries, `readMinutes` and `sources` as the feed path; `signals` is the only difference.

Redaction is a single regex in `http.js` that rewrites `key=<value>` inside any `googleapis.com/...` URL, applied in the `HttpError` constructor (message, `url`, every string in `detail`), in `TimeoutError` and `BodyTooLarge`, in `formatDetail` before the control-character strip, and on the redirect note. `errorClass`/`errorSummary` never carried URLs, `run()` copies only a fixed set of fields into `meta.sources[id]` (`finalUrl` is not among them), `probe-runner.mjs` is unchanged and keyless, and the workflow exposes the secret to the fetch step only.

Two non-blocking observations. D3's budget math assumes the feed attempts fail fast: after an 8 s API timeout the third feed attempt runs only if the first two together take under 2 s, where today the allowance is 10 s. And redaction keys on the host while `once()` follows redirects to any host before building `HttpError` from `current`; the gap only opens if Google 3xx'd an API call off-domain with the query string intact, which it does not do.

Verification evidence (commit message and the plan's Verification section): `npm test` 183 → 199 pass / 0 fail, a keyless dry run showing today's `HTTP 404 (3 attempts)` rows with no note, a keyless full live run written outside the repo with zero `key=` hits, and `git grep AIza` returning only the test placeholder. I reproduced the fixture shape check and the `AIza`/`key=`/CRLF greps locally; no suite spot-check was needed.

<details>
<summary>Issues (3)</summary>

1. **Feed retry margin after an API timeout** (confirmed, non-blocking) — after an 8 s API timeout the third feed attempt runs only if the first two feed attempts fail within 2 s combined (10 s today). Documented D3 trade-off; no change now. Lower `API_TIMEOUT_MS` if runner rows ever show `api: timeout` together with `HTTP 404 (2 attempts)`.
2. **Host-scoped redaction vs off-domain redirect** (possible, non-blocking) — `once()` follows up to five redirects to any host and `redactKey` only matches `googleapis.com`, so a 3xx off-domain that preserved the query string would put the key into `HttpError.url`/`message`. No known trigger. Optional hardening: redact or refuse off-host redirect targets when the original host is `googleapis.com`.
3. **Pipeline-level timeout case not pinned** (confirmed, non-blocking) — the fallback matrix covers HTTP, network and parse failures but not `TimeoutError`. Add a `throw: new TimeoutError(API)` override so `api: timeout, fell back to feed` is asserted end to end.

</details>

<details>
<summary>Details</summary>

### API branch and fallback inside runSource

```
runSource(source, deps)
  youtubeApiKey = deps.youtubeApiKey.trim()   ('' when unset / blank)
  work:
    arxiv?            -> fetchArxivSource
    youtube && key?   -> try fetchYoutubeApi -----> { items, httpStatus, note:'api' }
                         catch: apiNote = 'api: <errorClass>, fell back to feed'
                                logger.warn(id: youtube api failed (<class>); falling back to feed [<redacted detail>])
    (fall through)    -> fetchText(source.url) + pickParser(source)   <- unchanged feed path
  race(work, 45 s backstop)
  catch -> today's { status:'failed', error, httpStatus?, detail? }   <- unchanged
  result.note = result.note ? `${note}; ${apiNote}` : apiNote           <- after the catch, so present on failed rows too
```

The arrangement keeps the "never worse than today" property structurally rather than by case analysis: the API branch can only `return` a result or fall through, and nothing it does mutates `result`, `httpStatus` or the error path. `errorClass(err)` feeds the note, so the note can only read `HTTP <n>`, `timeout`, `network`, `body too large`, `parse error: <fixed kind>` or `wall clock`, none of which contain a URL. The warn line appends `formatDetail(err.detail)`, redacted at construction and again in `formatDetail`. The CLI test adds `YOUTUBE_API_KEY: ''` to the spawn env so a developer's shell key cannot reach the offline tests, where `fixtureFetch` would otherwise throw an `unmapped URL <url>` error containing it.

### Mapping parity and the `bodyLength` reading of D4

The plan's D4 shorthand said `bodyLength = summaryText.length`, but `summaryFields` in the feed path measures `bodyLength` on the whole cleaned description and cuts only `summaryText` at `Sponsors:`. The coder followed `summaryFields` (the plan's own "mirrors `summaryFields`" clause), documented the reading in the Verification note, and pinned it with a test where a description with a sponsor block yields the synopsis as `summaryText` and the full length as `bodyLength`. This is the right reading: it keeps `readMinutes` identical between the two paths for the same video, which the pipeline-level parity test asserts.

`publishedAt` prefers `contentDetails.videoPublishedAt` (the video's own publish time) over `snippet.publishedAt` (when it was added to the uploads playlist), which matters for scheduled premieres. Both `playlistId` and `videoId` are regex-validated before being interpolated into URLs and the key goes through `encodeURIComponent`, so none of them can smuggle extra query parameters into the request or the `watch?v=` URL.

### Where a URL can surface, and why the key cannot

Every constructor in `http.js` that embeds a URL now redacts it: `HttpError` (both the 4xx branch and the redirect-exhausted branch pass `current`), `TimeoutError` (passes the original `url`) and `BodyTooLarge` (passes `current`). `redactDetail` copies the detail object with every string value redacted, so `detail.location` and `detail.body` are covered even if Google echoed a URL, and `formatDetail` redacts before stripping control characters, the order that cannot splice a match. Non-timeout fetch errors are rethrown raw, but undici's `TypeError: fetch failed` carries no URL in `message` or `cause`, and the pipeline never logs `err.message` for per-source failures anyway, only `errorSummary`/`errorClass` and `formatDetail`.

`fetchYoutubeApi` deliberately leaves `finalUrl` and `requestedUrl` unset (`res.finalUrl` would carry the key), and independently `run()` whitelists the fields it copies into `meta.sources[id]` (`status`, `fetched`, `kept`, `skipped`, `ms`, `httpStatus`, `note`, `error`, `detail`), so `finalUrl` could not reach `meta.json` even if it were set. `scripts/fetch.mjs` prints `error ?? note` and `detail`, both key-free; `probe-sources.mjs` prints `finalUrl`, which the API path never sets and which in the fallback case is the feed's URL. `probe-runner.mjs` is byte-identical to the base and builds feed URLs from hard-coded channel ids with no env access.

The committed fixture contains no `key=`, the `AIza` grep over `src tests scripts README.md .github` returns only the `'AIzaSECRET'` placeholder in `tests/http.test.js`, and `data/` has zero `key=` hits. The http test asserts the key is absent from `message`, `url`, `detail.location`, `detail.body`, `JSON.stringify(err)`, `err.stack` and `formatDetail(err.detail)`, and every keyed pipeline test asserts it is absent from `JSON.stringify(result)` and from every logger line.

### Redaction scope stops at `googleapis.com` (possible, non-blocking)

`redactKey` matches `(googleapis\.com\/[^\s"'<>]*?[?&]key=)[^&\s"'<>]*`, scoped to the host on purpose (D5) so a feed whose own URL happens to carry `key=` is not rewritten. `once()` follows up to five redirects to whatever `location` says and then builds `HttpError(status, current, …)` from the final URL. If `www.googleapis.com` ever answered a 3xx pointing at another host and preserved the query string, that `current` would contain the key and the regex would not match it. Google's REST endpoints do not redirect, so this is a structural gap without a known trigger. The belt-and-braces option is to redact `location` targets (or refuse off-host redirects) when the original request host was `googleapis.com`; what would need to be checked before spending effort is whether any 3xx has ever been observed on `/youtube/v3/playlistItems`, which the runner round-trip in plan items 9-10 would reveal as an `HTTP 3xx` note.

### The 45 s budget after an 8 s API timeout (confirmed, non-blocking)

`fetchText` skips a retry when fewer than 25 s remain before the source deadline. With the API path in front, the check before the third feed attempt happens at `8 + t1 + 2 + t2 + 8` seconds, so the third attempt runs only while `t1 + t2 <= 2 s`; without the key the same bound is `t1 + t2 <= 10 s`. D3 computed this with "fast-failing" feed attempts and accepted the margin, and the realistic API failures (400 bad key, 403 quota or disabled API) return in well under a second, leaving the feed budget effectively untouched. The margin only bites when the API hangs for the full 8 s and the feed endpoint is also slow to fail, in which case the row would read `HTTP 404 (2 attempts)` with `api: timeout, fell back to feed`. No change is needed now; the runner's `meta.json` will show whether that combination ever occurs, and `API_TIMEOUT_MS` is the single knob if it does.

### Test coverage

`tests/youtube.test.js` (12 tests) covers the derivation for all six registry sources plus five rejection shapes, the exact request string and key encoding, item-by-item mapping of the fixture with a projection equality against `parseFeed` on the sibling XML fixture, the sponsor-cut split, the reject and drop cases, `fetchYoutubeApi`'s single call with `finalUrl`/`requestedUrl` unset, and at pipeline level the key-absent/empty/blank runs, the keyed success run (no feed call, same ids, `signals {}` vs `ytViews`), a seven-case fallback matrix (403 quota body, 400, 404, 503, network, non-JSON, wrong `kind`) asserting one API call, one feed call, items deep-equal to the keyless run and the exact warn line, the API-403-plus-feed-403 case reducing to today's failed row plus the note, and a full-registry keyed run. `tests/http.test.js` (4 tests) covers `redactKey` on five string shapes, the three error classes and `formatDetail`, a 403 through the real client keeping `quotaExceeded` in `detail.body` without the key, and the no-retry rule on 503 and network errors.

Not tested: the API path reaching `TimeoutError` through the pipeline (`api: timeout, fell back to feed`). The matrix covers HTTP, network and parse classes and the http test covers `TimeoutError` message redaction, but the combination is not pinned; a `throw: new TimeoutError(API)` override in the matrix would close it. Also, the parity test runs against a fixture synthesized from the feed XML, so it proves the mapper handles the documented API shape, not that the live API's `snippet.title`/`description` match the feed's text for real channels; only the runner round-trip in plan items 9-10 can show that, and the plan already schedules it.

### Verification evidence

The commit message and the plan's Verification section record: `npm test` 183 pass before, 199 pass / 0 fail after (12 + 4 new), 47 s; `node scripts/fetch.mjs --source yt-gpumode,yt-karpathy --dry-run` without a key giving `failed | HTTP 404 (3 attempts)` with no note; a full keyless live run to `%TEMP%\ahead-live-data` with `ok 39 · empty 19 · failed 6`, zero `api` notes and zero `key=` hits in the written files; `git grep AIza` returning only the placeholder; the fixture shape check printing the six expected video ids with the two edge deviations. I reproduced the fixture check, the `AIza` grep, the `key=` grep over `data/` and a CR-byte count on the fixture (0) locally; all matched. Items 9-10 (push, `gh run watch`, runner `meta.json`, results note) are runner-only and deliberately left for the final step.

</details>

<details>
<summary>File map</summary>

- `src/parsers/youtube.js` (new) — `uploadsPlaylistId`, `youtubeApiUrl`, `parsePlaylistItems`, `fetchYoutubeApi`; constants `API_TIMEOUT_MS`, `API_MAX_RESULTS`.
- `src/pipeline.js` — API branch in `runSource`'s `work`, `apiNote` appended after the catch, redirect note redacted, `youtubeApiKey` read from `env` and threaded into deps.
- `src/http.js` — `redactKey`, `redactDetail`; redaction in `HttpError`/`TimeoutError`/`BodyTooLarge`/`formatDetail`; `www.googleapis.com` never retried.
- `src/parsers/feed.js` — `stripSponsors` extracted and exported; `summaryFields` uses it (behaviour unchanged).
- `scripts/probe-sources.mjs` — passes `process.env.YOUTUBE_API_KEY ?? ''` to `runSource`.
- `.github/workflows/refresh.yml` — `YOUTUBE_API_KEY: ${{ secrets.YOUTUBE_API_KEY }}` on the fetch step only.
- `README.md` — intro sentence, YouTube row, new "YouTube Data API key (optional)" section, `meta.json` note values, Known limits split into Cloudflare and YouTube bullets.
- `tests/youtube.test.js` (new) — 12 unit and pipeline tests.
- `tests/http.test.js` — 4 redaction / no-retry tests.
- `tests/cli.test.js` — `YOUTUBE_API_KEY: ''` in the spawn env.
- `tests/fixtures/youtube-playlistitems.json` (new) — synthesized playlistItems response, six items, LF only.
- `tests/fixtures/README.md` — fixture row.

Full diff: `git diff origin/main HEAD` in `c:\Users\sudiskmr\Downloads\DomainClassification\ahead` (commit `b9965cb`).

</details>
