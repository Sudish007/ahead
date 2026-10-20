# YouTube Data API v3 — ship and verify report

Date: 2026-10-20. Repo `Sudish007/ahead`, branch `main`.

## Verification result: VERIFIED on a real Actions run with the secret

All six `yt-*` sources are `ok` or `empty` in the live `meta.json`, every one of them took the `api` path, and no key material appears in the committed data.

## What changed

Commits pushed to `main` (rebased on `origin/main`, no force-push):

| SHA | Message |
| --- | --- |
| `b9965cb4c2295c497cea9dd0badd01d8b32b6368` | feat(youtube): optional Data API path for the channel sources with feed fallback and key redaction |
| `052312ff411314ecb0ee1632db8aa2886689833d` | docs: youtube-api plan and review |

Files touched by `b9965cb` (source/test/doc/workflow): `src/parsers/youtube.js` (new API path + feed fallback), `src/http.js` (`redactKey()` applied to HttpError / TimeoutError / BodyTooLarge / formatDetail / redirect note), the fetch pipeline's `runSource` (API-first with `api: <class>, fell back to feed` note), `.github/workflows/refresh.yml` (`YOUTUBE_API_KEY: ${{ secrets.YOUTUBE_API_KEY }}` on the fetch step only), `README.md` ("YouTube Data API key (optional)" section), `tests/youtube.test.js` (new, 12 tests), `tests/http.test.js` (+4 redaction tests).

Files touched by `052312f`: `.agents/tasks/ahead-build/{review.json, review.md, youtube-api-plan.md, youtube-api-review.json, youtube-api-review.md}` (tracked by repo convention; `data/` was not touched locally).

Data commits made by the Actions bot after the push: `5ff71e8` (refresh 07:05Z, push-triggered run) and `a1da05d` (refresh 07:30Z, the dispatch run used for verification).

## Test count

`npm test` on `main` after the changes: **199 tests, 199 pass, 0 fail** (was 183 before; +12 in `tests/youtube.test.js`, +4 in `tests/http.test.js`). Duration ~50 s.

## Secret check

`gh secret list --repo Sudish007/ahead` → `YOUTUBE_API_KEY` **present** (updated ~52 minutes before the check). No polling was needed.

## Actions runs

| Run id | Trigger | Result | Notes |
| --- | --- | --- | --- |
| 39384212155 | push (`052312f`) | success | Auto-triggered by the push; committed `5ff71e8` (data refresh 07:05Z). |
| 39384242643 | workflow_dispatch | failure | Ran concurrently with the push run. Fetch step succeeded; the "Commit data back to main" guard exited 1 because main had moved (`052312f..5ff71e8`). This is the workflow's intended protection, not a code failure. |
| **39386858981** | workflow_dispatch | **success** | Re-dispatched after main settled. Committed `a1da05d` (data refresh 07:30Z) and deployed Pages. **This is the run used for verification.** |

## yt-* sources: BEFORE vs AFTER

BEFORE (`generatedAt` 2026-10-20T05:35:46Z, totals ok 35 / empty 18 / failed 11):

| Source | Status | Error |
| --- | --- | --- |
| yt-karpathy | failed | HTTP 404 (3 attempts) |
| yt-yannic | empty | — |
| yt-aiexplained | failed | HTTP 404 (3 attempts) |
| yt-gpumode | failed | HTTP 404 (3 attempts) |
| yt-stanford | failed | HTTP 404 (3 attempts) |
| yt-3b1b | failed | HTTP 404 (3 attempts) |

AFTER (live `https://sudish007.github.io/ahead/data/meta.json?t=<epoch>`, `generatedAt` 2026-10-20T07:30:35.490Z, totals ok 37 / empty 20 / failed 7):

| Source | Status | Note | Items in items.json |
| --- | --- | --- | --- |
| yt-karpathy | empty | api | 0 (no uploads inside maxAgeDays) |
| yt-yannic | empty | api | 0 |
| yt-aiexplained | empty | api | 0 |
| yt-gpumode | ok | api | 2 |
| yt-stanford | ok | api | 5 |
| yt-3b1b | ok | api | 1 |

Zero `yt-*` sources failed. The 7 remaining failures are unrelated and pre-existing: 6 are `blocked from GitHub runner: 403 Cloudflare` (importai, zvi, thebatch, epoch-gradient-updates, chinai, pod-dwarkesh) and 1 is `gh-rel-unsloth: HTTP 502 (2 attempts)`.

Source of truth used: the **live** Pages `meta.json` (cache-busted). It matched the committed `data/meta.json` at `a1da05d` after `git pull` (same `generatedAt` 07:30:35.490Z), so there was no Pages lag.

## Key-redaction check

- Unit tests: `tests/http.test.js` covers `redactKey()` rewriting `key=<value>` → `key=REDACTED` in googleapis URLs across HttpError message/url/detail, TimeoutError, BodyTooLarge, formatDetail and the redirect note; `tests/youtube.test.js` asserts `fetchYoutubeApi` never reports a URL and that the key appears nowhere in pipeline output. All pass.
- Committed data at `a1da05d` (`data/meta.json` + `data/items.json`): 0 matches for `key=<value>`, 0 matches for `AIza[0-9A-Za-z_-]{20,}`, 0 occurrences of `googleapis`.
- Live Pages data (`meta.json` 27,074 bytes, `items.json` 743,915 bytes): same scan, 0 / 0 / 0.

## Re-run instructions (for future refreshes)

```
gh workflow run refresh.yml --repo Sudish007/ahead
gh run list --repo Sudish007/ahead --workflow refresh.yml --limit 1
gh run watch <id> --repo Sudish007/ahead --exit-status
```

Then fetch `https://sudish007.github.io/ahead/data/meta.json?t=<epoch>` and confirm `sources.yt-*.status` is `ok` or `empty` for all six. Note: a push to `main` also triggers the workflow; if a dispatch run overlaps a push run, the later one's commit step exits with "main moved" by design. Re-dispatch once main settles.
