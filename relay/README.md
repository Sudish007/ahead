# ahead-relay

A Cloudflare Worker (`src/index.js`, plain JS, `wrangler` is its only dev dependency) that fetches the six allowlisted sources whose publishers answer a Cloudflare JS challenge to GitHub-hosted runners: five Substack feeds and The Batch sitemap plus its article pages. It proxies only the URLs in `src/allowlist.json` (generated from the `viaRelay` sources in `../sources.config.mjs`), requires the shared-secret header `X-Relay-Token`, keeps a last-good copy of every URL in KV (2 h freshness, a cron refresh every 3 h, stale fallback) and answers a 502 JSON when upstream fails and no copy exists. Behaviour, response headers, pipeline integration, `meta.json` notes and limits are documented in the "Relay for Cloudflare-blocked feeds" section of the root `README.md`.

## Deploy (PowerShell, from this directory)

```powershell
$env:CI = 'true'; $env:WRANGLER_SEND_METRICS = 'false'
npm ci
npx wrangler kv namespace create RELAY_CACHE   # once; put the printed id into wrangler.toml [[kv_namespaces]]
npx wrangler deploy
```

## Token (generate, set, rotate)

The token value never goes on a command line or into the repo; it lives in `%LOCALAPPDATA%\ahead\relay-token.txt`, the Worker secret and the GitHub secret. Rotation is the same three lines again (the old token stops working at `secret put`).

```powershell
node -e "const fs=require('fs'),p=require('path'),f=process.argv[1];fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,require('crypto').randomBytes(32).toString('hex'));console.log('written',fs.statSync(f).size)" "$env:LOCALAPPDATA\ahead\relay-token.txt"
Get-Content -Raw "$env:LOCALAPPDATA\ahead\relay-token.txt" | npx wrangler secret put RELAY_TOKEN
Get-Content -Raw "$env:LOCALAPPDATA\ahead\relay-token.txt" | gh secret set RELAY_TOKEN --repo Sudish007/ahead
gh secret set RELAY_URL --repo Sudish007/ahead --body https://ahead-relay.rishtapatra.workers.dev
```

Piping appends a newline, so both the Worker and the pipeline `trim()` the token before comparing or sending it.

## Allowlist and observation

- `node relay/build-allowlist.mjs` (from the repo root) after changing `viaRelay`/`relayPagePrefix` in `sources.config.mjs`; `tests/relay-allowlist.test.js` fails while `src/allowlist.json` is stale.
- `npx wrangler tail ahead-relay` prints one JSON line per upstream attempt (`event: upstream` with status, cf-ray, cf-cache-status, cf-mitigated, bytes, ms, attempt) and one `event: cron` summary per tick.
- `npx wrangler delete ahead-relay` removes the Worker; the pipeline then falls back to direct fetches.
