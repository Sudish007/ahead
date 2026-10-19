# Setup notes: conventions borrowed from sibling `ai-batkahi`

Source: `c:\Users\sudiskmr\Downloads\DomainClassification\ai-batkahi`

## package.json
- `"private": true`, `"type": "module"`, `engines.node ">=22.2"`.
- Scripts: `build` (node src/build.js), `test` (`node src/build.js && node --test "tests/**/*.test.js"`),
  `serve` (node scripts/serve.mjs), plus `dryrun`, `audit`, `check-links` helpers in `scripts/*.mjs`.
- Exact-pinned versions (no `^`). devDependency `fast-xml-parser` `5.11.2`; deps `marked` `18.1.0`, fontsource fonts.
- Naming: build code in `src/*.js`, CLI utilities in `scripts/*.mjs`.

## .github/workflows
- Single workflow `pages.yml`: Deploy to GitHub Pages on push to `main` + `workflow_dispatch`.
- `actions/checkout@v7`, `actions/setup-node@v7` with `node-version: 24` and `cache: npm`,
  `npm ci` -> `npm test` -> `npm run build`, then `configure-pages@v6` / `upload-pages-artifact@v5`
  (path `dist`) / `deploy-pages@v5` in a separate `deploy` job with `github-pages` environment.
- Permissions: `contents: read`, `pages: write`, `id-token: write`; concurrency group `pages`.

## tests/
- Flat directory, `*.test.js` files run by `node --test` (node:test + node:assert).
- Shared `tests/helpers.js` exports `ROOT`, `DIST`, `walk()`, `read()` and content loaders;
  tests derive expected counts from source data rather than hard-coding.
- Tests mostly assert on the built `dist/` output (HTML, XML, links, CSS).

## .gitignore
- `node_modules`, `dist`, `.agents`.
  (Ahead keeps `.agents/` and `data/` tracked; only `node_modules` and `.DS_Store` ignored.)

## scripts/serve.mjs
- Tiny `node:http` static server, PORT env (default 4173), MIME map, gzip for text assets.
  Good template for Ahead's `serve` script.
