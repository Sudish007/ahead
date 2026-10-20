# Relay probe results: can a Cloudflare Worker fetch the six Cloudflare-challenged sources?

Phase 1 of the relay option (user message 11: "A free relay (Cloudflare Worker or Deno Deploy cron) that fetches them ... still a datacenter IP, so it may be challenged too. Would need a quick test before committing to it."). The six sources fail from the GitHub runner with `blocked from GitHub runner: 403 Cloudflare` (`cf-mitigated=challenge`, "Just a moment...", see `runner-fix-results.md`). This probe asks whether a Worker's egress gets the same challenge. Nothing was built beyond a throwaway probe Worker, which has been deleted. gh-rel-unsloth was out of scope and untouched.

## Decision rule

A source **PASSES** only if all three scored calls returned HTTP 200 with a parseable feed/sitemap body (contains `<rss`, `<feed` or `<urlset`), under both request variants: the Worker's default `fetch` and the exact browser-like headers `src/http.js` sends. For **thebatch**, both the sitemap AND one real article page must pass; the article page passes when it returns HTTP 200 `text/html` whose `<title>` is the article's title (not Cloudflare's "Just a moment..." challenge page), since HTML never matches the feed test.

Scored calls: **calls 7, 8 and 9**, the three calls of the final probe build (`probeVersion: 4`: requests one at a time, 2 s apart). Six earlier calls with earlier builds are recorded in full below as additional evidence, including every non-200 seen; none of them was a Cloudflare challenge.

## Verdict

**relay viable for sources: importai, zvi, chinai, pod-dwarkesh, epoch-gradient-updates, thebatch**

All 42 scored requests (7 URLs x 2 header variants x 3 calls) returned HTTP 200, no `cf-mitigated` header, `server=cloudflare`, and the expected body (feed/sitemap XML, or the article's HTML). Across all nine calls (126 requests), the Worker was **never challenged**: 122 x 200, 4 x 429 from Substack's own rate limit (details below), 0 x 403, 0 x `cf-mitigated`, 0 challenge pages.

| source | type | URL | call 7 | call 8 | call 9 | result |
|---|---|---|---|---|---|---|
| importai | rss | https://importai.substack.com/feed | 200/200, parses | 200/200, parses | 200/200, parses | **PASS** |
| zvi | rss | https://thezvi.substack.com/feed | 200/200, parses | 200/200, parses | 200/200, parses | **PASS** (one 429 in call 6, see below) |
| chinai | rss | https://chinai.substack.com/feed | 200/200, parses | 200/200, parses | 200/200, parses | **PASS** |
| pod-dwarkesh | rss | https://api.substack.com/feed/podcast/69345.rss | 200/200, parses | 200/200, parses | 200/200, parses | **PASS** |
| epoch-gradient-updates | rss | https://epochai.substack.com/feed | 200/200, parses | 200/200, parses | 200/200, parses | **PASS** (429s in calls 1 and 5, see below) |
| thebatch (sitemap) | sitemap | https://www.deeplearning.ai/sitemap.xml | 200/200, parses | 200/200, parses | 200/200, parses | **PASS** |
| thebatch (article) | page | https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork | 200/200, article HTML | 200/200, article HTML | 200/200, article HTML | **PASS** |

Cells read `default/browser` status. "parses" = body contains `<rss`/`<urlset`; every feed body also carried the publication's `<title>` (Import AI, Don't Worry About the Vase, ChinAI Newsletter, Dwarkesh Podcast, Epoch AI). The article page's `<title>` was "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples" in all 18 article requests across the nine calls. deeplearning.ai (sitemap and article) was 200 on all 36 requests, every one `cf-cache-status: DYNAMIC` (served by the origin, not a cache), so that source's pass does not depend on caching.

The article URL was discovered by the Worker itself from the fetched sitemap on every call (`articleFrom: "sitemap (default fetch)"`): first `the-batch` `<loc>` with a `<lastmod>` that matches the source's `include` (`/^https:\/\/www\.deeplearning\.ai\/the-batch\/[^/]+\/?$/`) and not its `exclude` (`/\/the-batch\/(tag|issue-\d+)/`). `/the-batch/about` precedes it in the sitemap but has no `<lastmod>`, which `parseSitemap` also rejects. Its sitemap lastmod is `2026-10-16T08:15:44.000-07:00`.

### The non-200s: Substack 429 "Too Many Requests" (4 of 90 Substack requests, none scored)

Every non-200 in the nine calls was the same thing: **HTTP 429**, `content-type: text/plain; charset=utf-8`, 17-byte body `Too Many Requests`, `server=cloudflare`, **no `cf-mitigated` header, no `retry-after` header**. A Cloudflare challenge answers 403 `text/html` with `cf-mitigated: challenge` and "Just a moment..."; this is Substack's application rate limit instead.

| call | build | feed | variant | cf-ray | cf-cache-status | what the other variant of the same feed did |
|---|---|---|---|---|---|---|
| 1 | v1 (all 14 requests at once) | epoch-gradient-updates | browser | a4d68efbeced8ee3-BOM | (not recorded in v1) | default: 200, full feed, issued at the same instant |
| 5 | v2 (sequential, no gap) | epoch-gradient-updates | default | a4d6a991a926efdc-BOM | (not recorded in v2) | browser, ~0.3 s later: also 429 |
| 5 | v2 | epoch-gradient-updates | browser | a4d6a99319b9efdc-BOM | (not recorded in v2) | see above |
| 6 | v3 (2 s between requests) | zvi | default | a4d6b1eeee2d50c3-BOM | **BYPASS** | browser, 2 s later: 200, `cf-cache-status: HIT` |

What the pattern says:

- 429s hit only requests that were not served from Cloudflare's cache. Once `cf-cache-status` was recorded (calls 6-9, 40 Substack requests), the one 429 was a `BYPASS`, every `HIT` was 200, and the one `EXPIRED` (chinai, call 6) was also 200. Right after call 5's two epoch 429s, the same feed fetched from this machine (residential IP, Chrome UA) returned 200 with `cf-cache-status: MISS`, so the feed's cached copy had just expired and the Worker's origin-bound requests were the ones refused.
- The 429 is therefore most plausibly Substack's per-IP origin rate limit applied to the Worker's **shared** egress IPs (other tenants' Workers hit Substack from the same addresses). A Worker cannot change this; it can only avoid bursts and retry.
- Rate: 4/90 Substack requests overall (4.4%); 3 of the 4 came from builds that sent requests back-to-back (v1 burst, v2 no gap). With 2 s pacing (calls 6-9): 1/40. In the three scored calls: 0/30.
- Recovery: in call 6 the same feed returned 200 (`HIT`) 2 s after its 429; in call 5 a second request ~0.3 s after a 429 was also 429. `src/http.js` already treats 429 as retryable with one retry after 2 s (or `Retry-After`, capped at 30 s), so a relay built on the same policy would have recovered call 6 and probably not call 5 (gap too short). The v4 build added the same single retry to the probe; it never engaged because calls 7-9 had no 429 to retry.

### What a strict reading would say

If the rule were applied to every call ever made rather than the three scored calls of the final build: epoch-gradient-updates (calls 1, 5) and zvi (call 6) each had a 429 on at least one request variant, and importai, chinai, pod-dwarkesh and thebatch were 200 on all 18 of their requests. The 429s are rate limiting, not the challenge this probe set out to detect, and they were absent under the pacing a relay would use, so the verdict above counts all six as PASS and flags the two Substack feeds. The next step should decide whether that is acceptable, with these facts in hand.

## Caveats the next step should carry

- **Colo.** Every call ran in the BOM (Mumbai) colo (`workerColo: "BOM"`, all `cf-ray` suffixes `-BOM`) because the probe was invoked over HTTP from this machine. A Cron-Triggered relay runs wherever Cloudflare schedules it, so its egress colo may differ. The GitHub-runner failures were seen at LAX/SJC edges of the target zones; this probe shows the Worker-to-zone path is not challenged from BOM. Phase 2 should log `cf-ray`, `cf-cache-status` and status per fetch so a colo-dependent challenge or a 429 pattern would be visible in the first days.
- **Same answer with and without browser headers.** The default Worker `fetch` (no User-Agent) and the Chrome-155 UA + feed/html Accept + `en-US` Accept-Language variant behaved identically on every URL (the only differences were the 429s above, which fell on either variant). Phase 2 can keep `src/http.js` headers for consistency; they are not what makes it work.
- **Pace Substack.** Do not fan Substack requests out in parallel; one feed at a time with a gap, and keep the 429 retry. All 5 Substack feeds share the egress IP's budget.
- **Worker subrequests are labelled.** Cloudflare adds a `cf-worker` header to Worker subrequests, so Substack and deeplearning.ai could choose to block Workers later. Today they do not.
- **Sizes.** Bodies read (probe cap 1,000,000 bytes): importai 472,799; zvi >= 1,000,000 (cap hit; the pipeline's 8 MB cap applies); chinai 343,801; pod-dwarkesh 573,308; epoch-gradient-updates 646,194; sitemap 489,862 (3,406 `<loc>`s, flat `<urlset>`, no sitemap index); article 172,236 (172,184 in calls 8-9).
- **Timing.** Substack `HIT`s answered in 6-40 ms, origin-bound requests in 140-380 ms; deeplearning.ai (`DYNAMIC`) 15-300 ms. Each v4 call took ~30 s wall time, nearly all of it the 2 s pacing sleeps (28 s); Worker CPU time is unaffected by sleeping, which matters on the free plan.

## Method

- Probe Worker `ahead-relay-probe` (plain JS module Worker, no bundler, no npm deps; `wrangler.toml`: `main = "worker.js"`, `workers_dev = true`, `compatibility_date = "2026-10-01"`), deployed with `npx --yes wrangler@4.151.2 deploy` to `https://ahead-relay-probe.rishtapatra.workers.dev` (account 3b76db242a54ca8aae11deb8eef77ff9, OAuth login sudishdreams@gmail.com, free plan). Wrangler was not installed in the repo; npx used its cached 4.151.2.
- On GET it fetched each in-scope URL twice: default `fetch(url)` and `fetch(url, { headers })` with `src/http.js` values: `user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36`, `accept: application/rss+xml, application/atom+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.7` (feeds and sitemap, `ACCEPT.feed`) or `text/html` (article page, `ACCEPT.html`, as `parseSitemap` does), `accept-language: en-US,en;q=0.9`. Redirects followed. Per request it recorded status, `cf-mitigated`, `server`, `content-type`, `cf-ray` (v3+: also `cf-cache-status`, `retry-after`), final URL, bytes read, the first 200 tag-stripped characters of the body, the `<title>` when present (v2+), and the feed/sitemap parse test (`/<(rss|feed|urlset)[\s>]/i`). The article URL was picked from the sitemap body fetched in the same call, falling back to a hard-coded article if the sitemap failed (never needed).
- Builds: v1 `e82b1c08` all 14 requests in parallel (call 1); v2 `efb038b7` / `96c51016` (same code, redeployed) one request at a time, no gap (calls 2-5); v3 `f22c878c` 2 s between requests, records `cf-cache-status` (call 6); v4 `2183b439` v3 plus one retry after a 429 (calls 7-9).
- Calls (UTC, each one `Invoke-WebRequest` from this machine; the Worker answered first time on every call, no retries were needed against workers.dev): 1 08:12:36Z, 2 08:18:19Z, 3 08:22:47Z, 4 08:27:07Z, 5 08:30:45Z, 6 08:36:22Z, 7 08:42:47Z, 8 08:47:03Z, 9 08:51:57Z.
- The Worker was deleted after call 4 and redeployed for calls 5-9 because the raw JSON of calls 2-4 was lost to a relative-path mistake while assembling this report (the console summaries of those calls survive and are included below); the rerun then surfaced the 429 pattern, which is why the pacing and retry builds exist.
- Cleanup: `npx --yes wrangler@4.151.2 delete ahead-relay-probe --force` -> `Successfully deleted ahead-relay-probe` (08:53Z). Verified: `wrangler deployments list --name ahead-relay-probe` -> `This Worker does not exist on your account. [code: 10007]`; `https://ahead-relay-probe.rishtapatra.workers.dev/` -> HTTP 404. `relay/` removed from the working tree; `git status` shows no `relay/` entry.

## Raw results

### Calls 1-4: console summaries (one line per request, as printed while the call ran)

Format: `source variant status parses cf-mitigated server content-type cf-ray [bytes ms title]`. The full JSON of call 1 follows the summaries; the JSON of calls 2-4 was lost (see Method).

```text
# call 1  v1  ranAt=2026-10-20T08:12:36.994Z colo=BOM  version e82b1c08
importai                 default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d68efb3cb68ee3-BOM ms=37
importai                 browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d68efb3cb38ee3-BOM ms=30
zvi                      default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d68efb3cb18ee3-BOM ms=163
zvi                      browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d68efb3cb28ee3-BOM ms=175
chinai                   default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d68efb3cb58ee3-BOM ms=293
chinai                   browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d68efb3cb48ee3-BOM ms=293
pod-dwarkesh             default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d68efb6ccb8ee3-BOM ms=44
pod-dwarkesh             browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d68efb9cd58ee3-BOM ms=199
epoch-gradient-updates   default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d68efbbcde8ee3-BOM ms=53
epoch-gradient-updates   browser  status=429 parses=False cf-mitigated= server=cloudflare ct=text/plain; charset=utf-8 ray=a4d68efbeced8ee3-BOM ms=199
thebatch:sitemap         default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml ray=a4d68efcbd288ee3-BOM ms=175
thebatch:sitemap         browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml ray=a4d68efcfd328ee3-BOM ms=199
thebatch:article         default  status=200 parses=False cf-mitigated= server=cloudflare ct=text/html; charset=utf-8 ray=a4d68efe2d738ee3-BOM ms=307
thebatch:article         browser  status=200 parses=False cf-mitigated= server=cloudflare ct=text/html; charset=utf-8 ray=a4d68efe2d728ee3-BOM ms=296

# call 2  v2  ranAt=2026-10-20T08:18:19.544Z colo=BOM  version efb038b7
importai                 default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d697582fe4540b-BOM bytes=472799 ms=212 title=<![CDATA[Import AI]]>
importai                 browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d697599933540b-BOM bytes=472799 ms=13 title=<![CDATA[Import AI]]>
zvi                      default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d69759b948540b-BOM bytes=1000000 ms=19 title=<![CDATA[Don't Worry About the Vase]]>
zvi                      browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d69759e996540b-BOM bytes=1000000 ms=14 title=<![CDATA[Don't Worry About the Vase]]>
chinai                   default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d6975a09bc540b-BOM bytes=343801 ms=240 title=<![CDATA[ChinAI Newsletter]]>
chinai                   browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d6975b8b2c540b-BOM bytes=343801 ms=9 title=<![CDATA[ChinAI Newsletter]]>
pod-dwarkesh             default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d6975bab3c540b-BOM bytes=573308 ms=223 title=<![CDATA[Dwarkesh Podcast]]>
pod-dwarkesh             browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d6975d0c73540b-BOM bytes=573308 ms=230 title=<![CDATA[Dwarkesh Podcast]]>
epoch-gradient-updates   default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d6975e7dc2540b-BOM bytes=646194 ms=221 title=<![CDATA[Epoch AI]]>
epoch-gradient-updates   browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d697600efb540b-BOM bytes=646194 ms=19 title=<![CDATA[Epoch AI]]>
thebatch:sitemap         default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml ray=a4d697603f22540b-BOM bytes=489862 ms=26
thebatch:sitemap         browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml ray=a4d697606f4e540b-BOM bytes=489862 ms=24
thebatch:article         default  status=200 parses=False cf-mitigated= server=cloudflare ct=text/html; charset=utf-8 ray=a4d697609f7e540b-BOM bytes=172236 ms=30 title=Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples
thebatch:article         browser  status=200 parses=False cf-mitigated= server=cloudflare ct=text/html; charset=utf-8 ray=a4d69760cfb6540b-BOM bytes=172236 ms=37 title=Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples
articleFrom=sitemap (default fetch) url=https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork

# call 3  v2  ranAt=2026-10-20T08:22:47.195Z colo=BOM
importai                 default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d69de0ff6e8934-BOM bytes=472799 ms=368 title=<![CDATA[Import AI]]>
importai                 browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d69de359638934-BOM bytes=472799 ms=8 title=<![CDATA[Import AI]]>
zvi                      default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d69de3797b8934-BOM bytes=1000000 ms=155 title=<![CDATA[Don't Worry About the Vase]]>
zvi                      browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d69de47a778934-BOM bytes=1000000 ms=7 title=<![CDATA[Don't Worry About the Vase]]>
chinai                   default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d69de49aa28934-BOM bytes=343801 ms=360 title=<![CDATA[ChinAI Newsletter]]>
chinai                   browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d69de6dc578934-BOM bytes=343801 ms=6 title=<![CDATA[ChinAI Newsletter]]>
pod-dwarkesh             default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d69de6ec688934-BOM bytes=573308 ms=138 title=<![CDATA[Dwarkesh Podcast]]>
pod-dwarkesh             browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d69de7cd2b8934-BOM bytes=573308 ms=10 title=<![CDATA[Dwarkesh Podcast]]>
epoch-gradient-updates   default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d69de7ed4b8934-BOM bytes=646194 ms=221 title=<![CDATA[Epoch AI]]>
epoch-gradient-updates   browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d69de95e8a8934-BOM bytes=646194 ms=10 title=<![CDATA[Epoch AI]]>
thebatch:sitemap         default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml ray=a4d69de97eb28934-BOM bytes=489862 ms=27
thebatch:sitemap         browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml ray=a4d69de99ee78934-BOM bytes=489862 ms=26
thebatch:article         default  status=200 parses=False cf-mitigated= server=cloudflare ct=text/html; charset=utf-8 ray=a4d69de9cf118934-BOM bytes=172236 ms=25 title=Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples
thebatch:article         browser  status=200 parses=False cf-mitigated= server=cloudflare ct=text/html; charset=utf-8 ray=a4d69de9ff338934-BOM bytes=172236 ms=30 title=Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples
articleFrom=sitemap (default fetch) url=https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork

# call 4  v2  ranAt=2026-10-20T08:27:07.135Z colo=BOM
importai                 default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d6a4399d69540b-BOM bytes=472799 ms=16 title=<![CDATA[Import AI]]>
importai                 browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d6a439cd8b540b-BOM bytes=472799 ms=10 title=<![CDATA[Import AI]]>
zvi                      default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d6a439edb6540b-BOM bytes=1000000 ms=18 title=<![CDATA[Don't Worry About the Vase]]>
zvi                      browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d6a43a1ddf540b-BOM bytes=1000000 ms=9 title=<![CDATA[Don't Worry About the Vase]]>
chinai                   default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d6a43a3e02540b-BOM bytes=343801 ms=25 title=<![CDATA[ChinAI Newsletter]]>
chinai                   browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d6a43a6e29540b-BOM bytes=343801 ms=8 title=<![CDATA[ChinAI Newsletter]]>
pod-dwarkesh             default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d6a43a9e55540b-BOM bytes=573308 ms=19 title=<![CDATA[Dwarkesh Podcast]]>
pod-dwarkesh             browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d6a43adea2540b-BOM bytes=573308 ms=18 title=<![CDATA[Dwarkesh Podcast]]>
epoch-gradient-updates   default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d6a43b1ee0540b-BOM bytes=646194 ms=21 title=<![CDATA[Epoch AI]]>
epoch-gradient-updates   browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml; charset=utf-8 ray=a4d6a43b4f04540b-BOM bytes=646194 ms=10 title=<![CDATA[Epoch AI]]>
thebatch:sitemap         default  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml ray=a4d6a43b6f17540b-BOM bytes=489862 ms=233
thebatch:sitemap         browser  status=200 parses=True cf-mitigated= server=cloudflare ct=application/xml ray=a4d6a43cb846540b-BOM bytes=489862 ms=34
thebatch:article         default  status=200 parses=False cf-mitigated= server=cloudflare ct=text/html; charset=utf-8 ray=a4d6a43cf886540b-BOM bytes=172236 ms=24 title=Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples
thebatch:article         browser  status=200 parses=False cf-mitigated= server=cloudflare ct=text/html; charset=utf-8 ray=a4d6a43d18a2540b-BOM bytes=172236 ms=21 title=Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples
articleFrom=sitemap (default fetch) url=https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork
```

### Call 1 (probe v1, all requests in parallel, 08:12:36Z): full JSON

```json
{
  "ranAt": "2026-10-20T08:12:36.994Z",
  "workerColo": "BOM",
  "results": {
    "importai": {
      "url": "https://importai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d68efb3cb68ee3-BOM"
        },
        "finalUrl": "https://importai.substack.com/feed",
        "bodyBytesRead": 472799,
        "bodyStart": "https://importai.substack.com https://substackcdn.com/image/fetch/$s_!3yYS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2",
        "parsesAsFeedOrSitemap": true,
        "ms": 37
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d68efb3cb38ee3-BOM"
        },
        "finalUrl": "https://importai.substack.com/feed",
        "bodyBytesRead": 472799,
        "bodyStart": "https://importai.substack.com https://substackcdn.com/image/fetch/$s_!3yYS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2",
        "parsesAsFeedOrSitemap": true,
        "ms": 30
      }
    },
    "zvi": {
      "url": "https://thezvi.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d68efb3cb18ee3-BOM"
        },
        "finalUrl": "https://thezvi.substack.com/feed",
        "bodyBytesRead": 1000000,
        "bodyStart": "https://thezvi.substack.com https://substackcdn.com/image/fetch/$s_!fcDS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fthezvi.substack.com%2Fimg%2Fsubstack.png Don&apos;t Worry ",
        "parsesAsFeedOrSitemap": true,
        "ms": 163
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d68efb3cb28ee3-BOM"
        },
        "finalUrl": "https://thezvi.substack.com/feed",
        "bodyBytesRead": 1000000,
        "bodyStart": "https://thezvi.substack.com https://substackcdn.com/image/fetch/$s_!fcDS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fthezvi.substack.com%2Fimg%2Fsubstack.png Don&apos;t Worry ",
        "parsesAsFeedOrSitemap": true,
        "ms": 175
      }
    },
    "chinai": {
      "url": "https://chinai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d68efb3cb58ee3-BOM"
        },
        "finalUrl": "https://chinai.substack.com/feed",
        "bodyBytesRead": 343801,
        "bodyStart": "https://chinai.substack.com https://substackcdn.com/image/fetch/$s_!c4zh!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fbucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaw",
        "parsesAsFeedOrSitemap": true,
        "ms": 293
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d68efb3cb48ee3-BOM"
        },
        "finalUrl": "https://chinai.substack.com/feed",
        "bodyBytesRead": 343801,
        "bodyStart": "https://chinai.substack.com https://substackcdn.com/image/fetch/$s_!c4zh!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fbucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaw",
        "parsesAsFeedOrSitemap": true,
        "ms": 293
      }
    },
    "pod-dwarkesh": {
      "url": "https://api.substack.com/feed/podcast/69345.rss",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d68efb6ccb8ee3-BOM"
        },
        "finalUrl": "https://api.substack.com/feed/podcast/69345.rss",
        "bodyBytesRead": 573308,
        "bodyStart": "www.dwarkesh.com ]]> https://www.dwarkesh.com/podcast Substack Tue, 20 Oct 2026 07:23:53 GMT https://api.substack.com/feed/podcast/69345.rss Dwarkesh Patel Deeply researched interviews episodic Dwarke",
        "parsesAsFeedOrSitemap": true,
        "ms": 44
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d68efb9cd58ee3-BOM"
        },
        "finalUrl": "https://api.substack.com/feed/podcast/69345.rss",
        "bodyBytesRead": 573308,
        "bodyStart": "www.dwarkesh.com ]]> https://www.dwarkesh.com/podcast Substack Tue, 20 Oct 2026 08:12:37 GMT https://api.substack.com/feed/podcast/69345.rss Dwarkesh Patel Deeply researched interviews episodic Dwarke",
        "parsesAsFeedOrSitemap": true,
        "ms": 199
      }
    },
    "epoch-gradient-updates": {
      "url": "https://epochai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d68efbbcde8ee3-BOM"
        },
        "finalUrl": "https://epochai.substack.com/feed",
        "bodyBytesRead": 646194,
        "bodyStart": "https://epochai.substack.com https://substackcdn.com/image/fetch/$s_!ZsOK!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F",
        "parsesAsFeedOrSitemap": true,
        "ms": 53
      },
      "browser": {
        "status": 429,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/plain; charset=utf-8",
          "cf-ray": "a4d68efbeced8ee3-BOM"
        },
        "finalUrl": "https://epochai.substack.com/feed",
        "bodyBytesRead": 17,
        "bodyStart": "Too Many Requests",
        "parsesAsFeedOrSitemap": false,
        "ms": 199
      }
    },
    "thebatch:sitemap": {
      "url": "https://www.deeplearning.ai/sitemap.xml",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml",
          "cf-ray": "a4d68efcbd288ee3-BOM"
        },
        "finalUrl": "https://www.deeplearning.ai/sitemap.xml",
        "bodyBytesRead": 489862,
        "bodyStart": "https://www.deeplearning.ai/ https://www.deeplearning.ai/courses https://www.deeplearning.ai/about https://www.deeplearning.ai/contact https://www.deeplearning.ai/community https://www.deeplearning.ai",
        "parsesAsFeedOrSitemap": true,
        "ms": 175
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml",
          "cf-ray": "a4d68efcfd328ee3-BOM"
        },
        "finalUrl": "https://www.deeplearning.ai/sitemap.xml",
        "bodyBytesRead": 489862,
        "bodyStart": "https://www.deeplearning.ai/ https://www.deeplearning.ai/courses https://www.deeplearning.ai/about https://www.deeplearning.ai/contact https://www.deeplearning.ai/community https://www.deeplearning.ai",
        "parsesAsFeedOrSitemap": true,
        "ms": 199
      }
    },
    "thebatch:article": {
      "url": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/html; charset=utf-8",
          "cf-ray": "a4d68efe2d738ee3-BOM"
        },
        "finalUrl": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
        "bodyBytesRead": 172236,
        "bodyStart": "<script src=\"/_next/static/chunks/0.8zj-ak56mfq.js?dpl=dpl_HMeNiWM6WEe5as7",
        "parsesAsFeedOrSitemap": false,
        "ms": 307
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/html; charset=utf-8",
          "cf-ray": "a4d68efe2d728ee3-BOM"
        },
        "finalUrl": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
        "bodyBytesRead": 172236,
        "bodyStart": "<script src=\"/_next/static/chunks/0.8zj-ak56mfq.js?dpl=dpl_HMeNiWM6WEe5as7",
        "parsesAsFeedOrSitemap": false,
        "ms": 296
      },
      "articleFrom": "sitemap (default fetch)"
    }
  }
}
```

### Calls 5-9: full JSON as returned by the probe Worker, unedited

#### Call 5 (probe v2, sequential, no gap, 08:30:45Z)

```json
{
  "probeVersion": 2,
  "ranAt": "2026-10-20T08:30:45.354Z",
  "workerColo": "BOM",
  "results": {
    "importai": {
      "url": "https://importai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6a98d7f8befdc-BOM"
        },
        "finalUrl": "https://importai.substack.com/feed",
        "bodyBytesRead": 472799,
        "bodyStart": "https://importai.substack.com https://substackcdn.com/image/fetch/$s_!3yYS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2",
        "htmlTitle": "<![CDATA[Import AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 36
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6a98dffb0efdc-BOM"
        },
        "finalUrl": "https://importai.substack.com/feed",
        "bodyBytesRead": 472799,
        "bodyStart": "https://importai.substack.com https://substackcdn.com/image/fetch/$s_!3yYS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2",
        "htmlTitle": "<![CDATA[Import AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 26
      }
    },
    "zvi": {
      "url": "https://thezvi.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6a98e3fc0efdc-BOM"
        },
        "finalUrl": "https://thezvi.substack.com/feed",
        "bodyBytesRead": 1000000,
        "bodyStart": "https://thezvi.substack.com https://substackcdn.com/image/fetch/$s_!fcDS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fthezvi.substack.com%2Fimg%2Fsubstack.png Don&apos;t Worry ",
        "htmlTitle": "<![CDATA[Don't Worry About the Vase]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 35
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6a98ebfeeefdc-BOM"
        },
        "finalUrl": "https://thezvi.substack.com/feed",
        "bodyBytesRead": 1000000,
        "bodyStart": "https://thezvi.substack.com https://substackcdn.com/image/fetch/$s_!fcDS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fthezvi.substack.com%2Fimg%2Fsubstack.png Don&apos;t Worry ",
        "htmlTitle": "<![CDATA[Don't Worry About the Vase]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 33
      }
    },
    "chinai": {
      "url": "https://chinai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6a98ef811efdc-BOM"
        },
        "finalUrl": "https://chinai.substack.com/feed",
        "bodyBytesRead": 343801,
        "bodyStart": "https://chinai.substack.com https://substackcdn.com/image/fetch/$s_!c4zh!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fbucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaw",
        "htmlTitle": "<![CDATA[ChinAI Newsletter]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 48
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6a98f7843efdc-BOM"
        },
        "finalUrl": "https://chinai.substack.com/feed",
        "bodyBytesRead": 343801,
        "bodyStart": "https://chinai.substack.com https://substackcdn.com/image/fetch/$s_!c4zh!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fbucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaw",
        "htmlTitle": "<![CDATA[ChinAI Newsletter]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 24
      }
    },
    "pod-dwarkesh": {
      "url": "https://api.substack.com/feed/podcast/69345.rss",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6a98fa858efdc-BOM"
        },
        "finalUrl": "https://api.substack.com/feed/podcast/69345.rss",
        "bodyBytesRead": 573308,
        "bodyStart": "www.dwarkesh.com ]]> https://www.dwarkesh.com/podcast Substack Tue, 20 Oct 2026 08:26:18 GMT https://api.substack.com/feed/podcast/69345.rss Dwarkesh Patel Deeply researched interviews episodic Dwarke",
        "htmlTitle": "<![CDATA[Dwarkesh Podcast]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 261
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6a991590befdc-BOM"
        },
        "finalUrl": "https://api.substack.com/feed/podcast/69345.rss",
        "bodyBytesRead": 573308,
        "bodyStart": "www.dwarkesh.com ]]> https://www.dwarkesh.com/podcast Substack Tue, 20 Oct 2026 08:26:18 GMT https://api.substack.com/feed/podcast/69345.rss Dwarkesh Patel Deeply researched interviews episodic Dwarke",
        "htmlTitle": "<![CDATA[Dwarkesh Podcast]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 29
      }
    },
    "epoch-gradient-updates": {
      "url": "https://epochai.substack.com/feed",
      "default": {
        "status": 429,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/plain; charset=utf-8",
          "cf-ray": "a4d6a991a926efdc-BOM"
        },
        "finalUrl": "https://epochai.substack.com/feed",
        "bodyBytesRead": 17,
        "bodyStart": "Too Many Requests",
        "htmlTitle": null,
        "parsesAsFeedOrSitemap": false,
        "ms": 270
      },
      "browser": {
        "status": 429,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/plain; charset=utf-8",
          "cf-ray": "a4d6a99319b9efdc-BOM"
        },
        "finalUrl": "https://epochai.substack.com/feed",
        "bodyBytesRead": 17,
        "bodyStart": "Too Many Requests",
        "htmlTitle": null,
        "parsesAsFeedOrSitemap": false,
        "ms": 246
      }
    },
    "thebatch:sitemap": {
      "url": "https://www.deeplearning.ai/sitemap.xml",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml",
          "cf-ray": "a4d6a9947a43efdc-BOM"
        },
        "finalUrl": "https://www.deeplearning.ai/sitemap.xml",
        "bodyBytesRead": 489862,
        "bodyStart": "https://www.deeplearning.ai/ https://www.deeplearning.ai/courses https://www.deeplearning.ai/about https://www.deeplearning.ai/contact https://www.deeplearning.ai/community https://www.deeplearning.ai",
        "htmlTitle": null,
        "parsesAsFeedOrSitemap": true,
        "ms": 39
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml",
          "cf-ray": "a4d6a994ca66efdc-BOM"
        },
        "finalUrl": "https://www.deeplearning.ai/sitemap.xml",
        "bodyBytesRead": 489862,
        "bodyStart": "https://www.deeplearning.ai/ https://www.deeplearning.ai/courses https://www.deeplearning.ai/about https://www.deeplearning.ai/contact https://www.deeplearning.ai/community https://www.deeplearning.ai",
        "htmlTitle": null,
        "parsesAsFeedOrSitemap": true,
        "ms": 30
      }
    },
    "thebatch:article": {
      "url": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/html; charset=utf-8",
          "cf-ray": "a4d6a9951a85efdc-BOM"
        },
        "finalUrl": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
        "bodyBytesRead": 172236,
        "bodyStart": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getEle",
        "htmlTitle": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples",
        "parsesAsFeedOrSitemap": false,
        "ms": 39
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/html; charset=utf-8",
          "cf-ray": "a4d6a9955a96efdc-BOM"
        },
        "finalUrl": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
        "bodyBytesRead": 172236,
        "bodyStart": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getEle",
        "htmlTitle": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples",
        "parsesAsFeedOrSitemap": false,
        "ms": 33
      },
      "articleFrom": "sitemap (default fetch)"
    }
  }
}
```

#### Call 6 (probe v3, 2 s pacing, 08:36:22Z)

```json
{
  "probeVersion": 3,
  "gapMs": 2000,
  "ranAt": "2026-10-20T08:36:22.579Z",
  "workerColo": "BOM",
  "results": {
    "importai": {
      "url": "https://importai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6b1d5ae8850c3-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://importai.substack.com/feed",
        "bodyBytesRead": 472799,
        "bodyStart": "https://importai.substack.com https://substackcdn.com/image/fetch/$s_!3yYS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2",
        "htmlTitle": "<![CDATA[Import AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 30
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6b1e25a2750c3-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://importai.substack.com/feed",
        "bodyBytesRead": 472799,
        "bodyStart": "https://importai.substack.com https://substackcdn.com/image/fetch/$s_!3yYS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2",
        "htmlTitle": "<![CDATA[Import AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 14
      }
    },
    "zvi": {
      "url": "https://thezvi.substack.com/feed",
      "default": {
        "status": 429,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/plain; charset=utf-8",
          "cf-ray": "a4d6b1eeee2d50c3-BOM",
          "cf-cache-status": "BYPASS",
          "retry-after": null
        },
        "finalUrl": "https://thezvi.substack.com/feed",
        "bodyBytesRead": 17,
        "bodyStart": "Too Many Requests",
        "htmlTitle": null,
        "parsesAsFeedOrSitemap": false,
        "ms": 244
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6b1fcea2950c3-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://thezvi.substack.com/feed",
        "bodyBytesRead": 1000000,
        "bodyStart": "https://thezvi.substack.com https://substackcdn.com/image/fetch/$s_!fcDS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fthezvi.substack.com%2Fimg%2Fsubstack.png Don&apos;t Worry ",
        "htmlTitle": "<![CDATA[Don't Worry About the Vase]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 13
      }
    },
    "chinai": {
      "url": "https://chinai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6b2098d9950c3-BOM",
          "cf-cache-status": "EXPIRED",
          "retry-after": null
        },
        "finalUrl": "https://chinai.substack.com/feed",
        "bodyBytesRead": 343801,
        "bodyStart": "https://chinai.substack.com https://substackcdn.com/image/fetch/$s_!c4zh!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fbucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaw",
        "htmlTitle": "<![CDATA[ChinAI Newsletter]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 304
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6b217e9e050c3-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://chinai.substack.com/feed",
        "bodyBytesRead": 343801,
        "bodyStart": "https://chinai.substack.com https://substackcdn.com/image/fetch/$s_!c4zh!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fbucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaw",
        "htmlTitle": "<![CDATA[ChinAI Newsletter]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 13
      }
    },
    "pod-dwarkesh": {
      "url": "https://api.substack.com/feed/podcast/69345.rss",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6b2248d8c50c3-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://api.substack.com/feed/podcast/69345.rss",
        "bodyBytesRead": 573308,
        "bodyStart": "www.dwarkesh.com ]]> https://www.dwarkesh.com/podcast Substack Tue, 20 Oct 2026 08:26:18 GMT https://api.substack.com/feed/podcast/69345.rss Dwarkesh Patel Deeply researched interviews episodic Dwarke",
        "htmlTitle": "<![CDATA[Dwarkesh Podcast]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 24
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6b231290850c3-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://api.substack.com/feed/podcast/69345.rss",
        "bodyBytesRead": 573308,
        "bodyStart": "www.dwarkesh.com ]]> https://www.dwarkesh.com/podcast Substack Tue, 20 Oct 2026 08:12:37 GMT https://api.substack.com/feed/podcast/69345.rss Dwarkesh Patel Deeply researched interviews episodic Dwarke",
        "htmlTitle": "<![CDATA[Dwarkesh Podcast]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 12
      }
    },
    "epoch-gradient-updates": {
      "url": "https://epochai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6b23dbcbc50c3-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://epochai.substack.com/feed",
        "bodyBytesRead": 646194,
        "bodyStart": "https://epochai.substack.com https://substackcdn.com/image/fetch/$s_!ZsOK!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F",
        "htmlTitle": "<![CDATA[Epoch AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 243
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6b24bc93750c3-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://epochai.substack.com/feed",
        "bodyBytesRead": 646194,
        "bodyStart": "https://epochai.substack.com https://substackcdn.com/image/fetch/$s_!ZsOK!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F",
        "htmlTitle": "<![CDATA[Epoch AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 13
      }
    },
    "thebatch:sitemap": {
      "url": "https://www.deeplearning.ai/sitemap.xml",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml",
          "cf-ray": "a4d6b2585d1b50c3-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/sitemap.xml",
        "bodyBytesRead": 489862,
        "bodyStart": "https://www.deeplearning.ai/ https://www.deeplearning.ai/courses https://www.deeplearning.ai/about https://www.deeplearning.ai/contact https://www.deeplearning.ai/community https://www.deeplearning.ai",
        "htmlTitle": null,
        "parsesAsFeedOrSitemap": true,
        "ms": 65
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml",
          "cf-ray": "a4d6b26538f450c3-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/sitemap.xml",
        "bodyBytesRead": 489862,
        "bodyStart": "https://www.deeplearning.ai/ https://www.deeplearning.ai/courses https://www.deeplearning.ai/about https://www.deeplearning.ai/contact https://www.deeplearning.ai/community https://www.deeplearning.ai",
        "htmlTitle": null,
        "parsesAsFeedOrSitemap": true,
        "ms": 24
      }
    },
    "thebatch:article": {
      "url": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/html; charset=utf-8",
          "cf-ray": "a4d6b271ecca50c3-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
        "bodyBytesRead": 172236,
        "bodyStart": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getEle",
        "htmlTitle": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples",
        "parsesAsFeedOrSitemap": false,
        "ms": 23
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/html; charset=utf-8",
          "cf-ray": "a4d6b27e887750c3-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
        "bodyBytesRead": 172236,
        "bodyStart": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getEle",
        "htmlTitle": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples",
        "parsesAsFeedOrSitemap": false,
        "ms": 38
      },
      "articleFrom": "sitemap (default fetch)"
    }
  }
}
```

#### Call 7 (probe v4, 2 s pacing + 429 retry, 08:42:47Z) [scored]

```json
{
  "probeVersion": 4,
  "gapMs": 2000,
  "ranAt": "2026-10-20T08:42:47.703Z",
  "workerColo": "BOM",
  "results": {
    "importai": {
      "url": "https://importai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6bb3ca80734be-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://importai.substack.com/feed",
        "bodyBytesRead": 472799,
        "bodyStart": "https://importai.substack.com https://substackcdn.com/image/fetch/$s_!3yYS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2",
        "htmlTitle": "<![CDATA[Import AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 146
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6bb4a1b6934be-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://importai.substack.com/feed",
        "bodyBytesRead": 472799,
        "bodyStart": "https://importai.substack.com https://substackcdn.com/image/fetch/$s_!3yYS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2",
        "htmlTitle": "<![CDATA[Import AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 7
      }
    },
    "zvi": {
      "url": "https://thezvi.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6bb569e5134be-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://thezvi.substack.com/feed",
        "bodyBytesRead": 1000000,
        "bodyStart": "https://thezvi.substack.com https://substackcdn.com/image/fetch/$s_!fcDS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fthezvi.substack.com%2Fimg%2Fsubstack.png Don&apos;t Worry ",
        "htmlTitle": "<![CDATA[Don't Worry About the Vase]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 378
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6bb657aae34be-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://thezvi.substack.com/feed",
        "bodyBytesRead": 1000000,
        "bodyStart": "https://thezvi.substack.com https://substackcdn.com/image/fetch/$s_!fcDS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fthezvi.substack.com%2Fimg%2Fsubstack.png Don&apos;t Worry ",
        "htmlTitle": "<![CDATA[Don't Worry About the Vase]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 9
      }
    },
    "chinai": {
      "url": "https://chinai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6bb720d4734be-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://chinai.substack.com/feed",
        "bodyBytesRead": 343801,
        "bodyStart": "https://chinai.substack.com https://substackcdn.com/image/fetch/$s_!c4zh!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fbucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaw",
        "htmlTitle": "<![CDATA[ChinAI Newsletter]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 147
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6bb7f790d34be-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://chinai.substack.com/feed",
        "bodyBytesRead": 343801,
        "bodyStart": "https://chinai.substack.com https://substackcdn.com/image/fetch/$s_!c4zh!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fbucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaw",
        "htmlTitle": "<![CDATA[ChinAI Newsletter]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 8
      }
    },
    "pod-dwarkesh": {
      "url": "https://api.substack.com/feed/podcast/69345.rss",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6bb8c0ceb34be-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://api.substack.com/feed/podcast/69345.rss",
        "bodyBytesRead": 573308,
        "bodyStart": "www.dwarkesh.com ]]> https://www.dwarkesh.com/podcast Substack Tue, 20 Oct 2026 08:26:18 GMT https://api.substack.com/feed/podcast/69345.rss Dwarkesh Patel Deeply researched interviews episodic Dwarke",
        "htmlTitle": "<![CDATA[Dwarkesh Podcast]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 147
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6bb99693834be-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://api.substack.com/feed/podcast/69345.rss",
        "bodyBytesRead": 573308,
        "bodyStart": "www.dwarkesh.com ]]> https://www.dwarkesh.com/podcast Substack Tue, 20 Oct 2026 08:26:18 GMT https://api.substack.com/feed/podcast/69345.rss Dwarkesh Patel Deeply researched interviews episodic Dwarke",
        "htmlTitle": "<![CDATA[Dwarkesh Podcast]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 7
      }
    },
    "epoch-gradient-updates": {
      "url": "https://epochai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6bba5fceb34be-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://epochai.substack.com/feed",
        "bodyBytesRead": 646194,
        "bodyStart": "https://epochai.substack.com https://substackcdn.com/image/fetch/$s_!ZsOK!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F",
        "htmlTitle": "<![CDATA[Epoch AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 224
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6bbb3d95434be-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://epochai.substack.com/feed",
        "bodyBytesRead": 646194,
        "bodyStart": "https://epochai.substack.com https://substackcdn.com/image/fetch/$s_!ZsOK!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F",
        "htmlTitle": "<![CDATA[Epoch AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 7
      }
    },
    "thebatch:sitemap": {
      "url": "https://www.deeplearning.ai/sitemap.xml",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml",
          "cf-ray": "a4d6bbc06c7534be-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/sitemap.xml",
        "bodyBytesRead": 489862,
        "bodyStart": "https://www.deeplearning.ai/ https://www.deeplearning.ai/courses https://www.deeplearning.ai/about https://www.deeplearning.ai/contact https://www.deeplearning.ai/community https://www.deeplearning.ai",
        "htmlTitle": null,
        "parsesAsFeedOrSitemap": true,
        "ms": 22
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml",
          "cf-ray": "a4d6bbcd0f5834be-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/sitemap.xml",
        "bodyBytesRead": 489862,
        "bodyStart": "https://www.deeplearning.ai/ https://www.deeplearning.ai/courses https://www.deeplearning.ai/about https://www.deeplearning.ai/contact https://www.deeplearning.ai/community https://www.deeplearning.ai",
        "htmlTitle": null,
        "parsesAsFeedOrSitemap": true,
        "ms": 15
      }
    },
    "thebatch:article": {
      "url": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/html; charset=utf-8",
          "cf-ray": "a4d6bbd9aab234be-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
        "bodyBytesRead": 172236,
        "bodyStart": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getEle",
        "htmlTitle": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples",
        "parsesAsFeedOrSitemap": false,
        "ms": 280
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/html; charset=utf-8",
          "cf-ray": "a4d6bbe7ef3e34be-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
        "bodyBytesRead": 172236,
        "bodyStart": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getEle",
        "htmlTitle": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples",
        "parsesAsFeedOrSitemap": false,
        "ms": 36
      },
      "articleFrom": "sitemap (default fetch)"
    }
  }
}
```

#### Call 8 (probe v4, 08:47:03Z) [scored]

```json
{
  "probeVersion": 4,
  "gapMs": 2000,
  "ranAt": "2026-10-20T08:47:03.362Z",
  "workerColo": "BOM",
  "results": {
    "importai": {
      "url": "https://importai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c17a8b9a3faf-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://importai.substack.com/feed",
        "bodyBytesRead": 472799,
        "bodyStart": "https://importai.substack.com https://substackcdn.com/image/fetch/$s_!3yYS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2",
        "htmlTitle": "<![CDATA[Import AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 23
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c1872ef53faf-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://importai.substack.com/feed",
        "bodyBytesRead": 472799,
        "bodyStart": "https://importai.substack.com https://substackcdn.com/image/fetch/$s_!3yYS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2",
        "htmlTitle": "<![CDATA[Import AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 12
      }
    },
    "zvi": {
      "url": "https://thezvi.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c193cae03faf-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://thezvi.substack.com/feed",
        "bodyBytesRead": 1000000,
        "bodyStart": "https://thezvi.substack.com https://substackcdn.com/image/fetch/$s_!fcDS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fthezvi.substack.com%2Fimg%2Fsubstack.png Don&apos;t Worry ",
        "htmlTitle": "<![CDATA[Don't Worry About the Vase]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 24
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c1a06e5c3faf-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://thezvi.substack.com/feed",
        "bodyBytesRead": 1000000,
        "bodyStart": "https://thezvi.substack.com https://substackcdn.com/image/fetch/$s_!fcDS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fthezvi.substack.com%2Fimg%2Fsubstack.png Don&apos;t Worry ",
        "htmlTitle": "<![CDATA[Don't Worry About the Vase]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 11
      }
    },
    "chinai": {
      "url": "https://chinai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c1acf9e83faf-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://chinai.substack.com/feed",
        "bodyBytesRead": 343801,
        "bodyStart": "https://chinai.substack.com https://substackcdn.com/image/fetch/$s_!c4zh!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fbucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaw",
        "htmlTitle": "<![CDATA[ChinAI Newsletter]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 25
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c1b9ad5d3faf-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://chinai.substack.com/feed",
        "bodyBytesRead": 343801,
        "bodyStart": "https://chinai.substack.com https://substackcdn.com/image/fetch/$s_!c4zh!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fbucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaw",
        "htmlTitle": "<![CDATA[ChinAI Newsletter]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 14
      }
    },
    "pod-dwarkesh": {
      "url": "https://api.substack.com/feed/podcast/69345.rss",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c1c638e43faf-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://api.substack.com/feed/podcast/69345.rss",
        "bodyBytesRead": 573308,
        "bodyStart": "www.dwarkesh.com ]]> https://www.dwarkesh.com/podcast Substack Tue, 20 Oct 2026 08:26:18 GMT https://api.substack.com/feed/podcast/69345.rss Dwarkesh Patel Deeply researched interviews episodic Dwarke",
        "htmlTitle": "<![CDATA[Dwarkesh Podcast]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 221
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c1d41d333faf-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://api.substack.com/feed/podcast/69345.rss",
        "bodyBytesRead": 573308,
        "bodyStart": "www.dwarkesh.com ]]> https://www.dwarkesh.com/podcast Substack Tue, 20 Oct 2026 08:26:18 GMT https://api.substack.com/feed/podcast/69345.rss Dwarkesh Patel Deeply researched interviews episodic Dwarke",
        "htmlTitle": "<![CDATA[Dwarkesh Podcast]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 12
      }
    },
    "epoch-gradient-updates": {
      "url": "https://epochai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c1e0a9093faf-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://epochai.substack.com/feed",
        "bodyBytesRead": 646194,
        "bodyStart": "https://epochai.substack.com https://substackcdn.com/image/fetch/$s_!ZsOK!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F",
        "htmlTitle": "<![CDATA[Epoch AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 28
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c1ed5c633faf-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://epochai.substack.com/feed",
        "bodyBytesRead": 646194,
        "bodyStart": "https://epochai.substack.com https://substackcdn.com/image/fetch/$s_!ZsOK!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F",
        "htmlTitle": "<![CDATA[Epoch AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 11
      }
    },
    "thebatch:sitemap": {
      "url": "https://www.deeplearning.ai/sitemap.xml",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml",
          "cf-ray": "a4d6c1f9efb23faf-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/sitemap.xml",
        "bodyBytesRead": 489862,
        "bodyStart": "https://www.deeplearning.ai/ https://www.deeplearning.ai/courses https://www.deeplearning.ai/about https://www.deeplearning.ai/contact https://www.deeplearning.ai/community https://www.deeplearning.ai",
        "htmlTitle": null,
        "parsesAsFeedOrSitemap": true,
        "ms": 33
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml",
          "cf-ray": "a4d6c2069b0d3faf-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/sitemap.xml",
        "bodyBytesRead": 489862,
        "bodyStart": "https://www.deeplearning.ai/ https://www.deeplearning.ai/courses https://www.deeplearning.ai/about https://www.deeplearning.ai/contact https://www.deeplearning.ai/community https://www.deeplearning.ai",
        "htmlTitle": null,
        "parsesAsFeedOrSitemap": true,
        "ms": 76
      }
    },
    "thebatch:article": {
      "url": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/html; charset=utf-8",
          "cf-ray": "a4d6c2139ee83faf-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
        "bodyBytesRead": 172184,
        "bodyStart": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getEle",
        "htmlTitle": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples",
        "parsesAsFeedOrSitemap": false,
        "ms": 266
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/html; charset=utf-8",
          "cf-ray": "a4d6c221cab33faf-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
        "bodyBytesRead": 172184,
        "bodyStart": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getEle",
        "htmlTitle": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples",
        "parsesAsFeedOrSitemap": false,
        "ms": 34
      },
      "articleFrom": "sitemap (default fetch)"
    }
  }
}
```

#### Call 9 (probe v4, 08:51:57Z) [scored]

```json
{
  "probeVersion": 4,
  "gapMs": 2000,
  "ranAt": "2026-10-20T08:51:57.357Z",
  "workerColo": "BOM",
  "results": {
    "importai": {
      "url": "https://importai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c8a7faf1146a-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://importai.substack.com/feed",
        "bodyBytesRead": 472799,
        "bodyStart": "https://importai.substack.com https://substackcdn.com/image/fetch/$s_!3yYS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2",
        "htmlTitle": "<![CDATA[Import AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 15
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c8b4993f146a-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://importai.substack.com/feed",
        "bodyBytesRead": 472799,
        "bodyStart": "https://importai.substack.com https://substackcdn.com/image/fetch/$s_!3yYS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2",
        "htmlTitle": "<![CDATA[Import AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 9
      }
    },
    "zvi": {
      "url": "https://thezvi.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c8c12db2146a-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://thezvi.substack.com/feed",
        "bodyBytesRead": 1000000,
        "bodyStart": "https://thezvi.substack.com https://substackcdn.com/image/fetch/$s_!fcDS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fthezvi.substack.com%2Fimg%2Fsubstack.png Don&apos;t Worry ",
        "htmlTitle": "<![CDATA[Don't Worry About the Vase]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 141
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c8ce8b3a146a-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://thezvi.substack.com/feed",
        "bodyBytesRead": 1000000,
        "bodyStart": "https://thezvi.substack.com https://substackcdn.com/image/fetch/$s_!fcDS!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fthezvi.substack.com%2Fimg%2Fsubstack.png Don&apos;t Worry ",
        "htmlTitle": "<![CDATA[Don't Worry About the Vase]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 231
      }
    },
    "chinai": {
      "url": "https://chinai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c8dc7803146a-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://chinai.substack.com/feed",
        "bodyBytesRead": 343801,
        "bodyStart": "https://chinai.substack.com https://substackcdn.com/image/fetch/$s_!c4zh!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fbucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaw",
        "htmlTitle": "<![CDATA[ChinAI Newsletter]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 17
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c8e91c48146a-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://chinai.substack.com/feed",
        "bodyBytesRead": 343801,
        "bodyStart": "https://chinai.substack.com https://substackcdn.com/image/fetch/$s_!c4zh!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fbucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaw",
        "htmlTitle": "<![CDATA[ChinAI Newsletter]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 7
      }
    },
    "pod-dwarkesh": {
      "url": "https://api.substack.com/feed/podcast/69345.rss",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c8f5982f146a-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://api.substack.com/feed/podcast/69345.rss",
        "bodyBytesRead": 573308,
        "bodyStart": "www.dwarkesh.com ]]> https://www.dwarkesh.com/podcast Substack Tue, 20 Oct 2026 08:26:18 GMT https://api.substack.com/feed/podcast/69345.rss Dwarkesh Patel Deeply researched interviews episodic Dwarke",
        "htmlTitle": "<![CDATA[Dwarkesh Podcast]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 19
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c9023cb8146a-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://api.substack.com/feed/podcast/69345.rss",
        "bodyBytesRead": 573308,
        "bodyStart": "www.dwarkesh.com ]]> https://www.dwarkesh.com/podcast Substack Tue, 20 Oct 2026 08:26:18 GMT https://api.substack.com/feed/podcast/69345.rss Dwarkesh Patel Deeply researched interviews episodic Dwarke",
        "htmlTitle": "<![CDATA[Dwarkesh Podcast]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 8
      }
    },
    "epoch-gradient-updates": {
      "url": "https://epochai.substack.com/feed",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c90ec997146a-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://epochai.substack.com/feed",
        "bodyBytesRead": 646194,
        "bodyStart": "https://epochai.substack.com https://substackcdn.com/image/fetch/$s_!ZsOK!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F",
        "htmlTitle": "<![CDATA[Epoch AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 19
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml; charset=utf-8",
          "cf-ray": "a4d6c91b6e98146a-BOM",
          "cf-cache-status": "HIT",
          "retry-after": null
        },
        "finalUrl": "https://epochai.substack.com/feed",
        "bodyBytesRead": 646194,
        "bodyStart": "https://epochai.substack.com https://substackcdn.com/image/fetch/$s_!ZsOK!,w_256,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F",
        "htmlTitle": "<![CDATA[Epoch AI]]>",
        "parsesAsFeedOrSitemap": true,
        "ms": 10
      }
    },
    "thebatch:sitemap": {
      "url": "https://www.deeplearning.ai/sitemap.xml",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml",
          "cf-ray": "a4d6c927fba4146a-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/sitemap.xml",
        "bodyBytesRead": 489862,
        "bodyStart": "https://www.deeplearning.ai/ https://www.deeplearning.ai/courses https://www.deeplearning.ai/about https://www.deeplearning.ai/contact https://www.deeplearning.ai/community https://www.deeplearning.ai",
        "htmlTitle": null,
        "parsesAsFeedOrSitemap": true,
        "ms": 22
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "application/xml",
          "cf-ray": "a4d6c9349845146a-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/sitemap.xml",
        "bodyBytesRead": 489862,
        "bodyStart": "https://www.deeplearning.ai/ https://www.deeplearning.ai/courses https://www.deeplearning.ai/about https://www.deeplearning.ai/contact https://www.deeplearning.ai/community https://www.deeplearning.ai",
        "htmlTitle": null,
        "parsesAsFeedOrSitemap": true,
        "ms": 27
      }
    },
    "thebatch:article": {
      "url": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
      "default": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/html; charset=utf-8",
          "cf-ray": "a4d6c9414d30146a-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
        "bodyBytesRead": 172184,
        "bodyStart": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getEle",
        "htmlTitle": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples",
        "parsesAsFeedOrSitemap": false,
        "ms": 17
      },
      "browser": {
        "status": 200,
        "headers": {
          "cf-mitigated": null,
          "server": "cloudflare",
          "content-type": "text/html; charset=utf-8",
          "cf-ray": "a4d6c94de946146a-BOM",
          "cf-cache-status": "DYNAMIC",
          "retry-after": null
        },
        "finalUrl": "https://www.deeplearning.ai/the-batch/data-mixing-minus-the-guesswork",
        "bodyBytesRead": 172184,
        "bodyStart": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getEle",
        "htmlTitle": "Research from the Team Behind CausalMix Offers A Technique to Select Fine-Tuning Examples",
        "parsesAsFeedOrSitemap": false,
        "ms": 24
      },
      "articleFrom": "sitemap (default fetch)"
    }
  }
}
```
