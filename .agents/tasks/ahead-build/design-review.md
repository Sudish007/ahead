# Design review: Ahead corrected design

Reviewed `design.md` iteration 6, the authoritative `source-probe.md`, the supplied previous `design-review.json`, the fixture inventory, relevant fixture bodies, the existing `ahead/package.json` and `.gitattributes`, and the referenced `ai-batkahi/scripts/serve.mjs` template. I did not re-probe any live source.

## Findings

1. **MEDIUM — The LLM numeric-validation input is unavailable under the declared digest and function contracts.**

   **Where:** sections 5.1, 5.9, 6.3-6.4, 7, 11, and `llm.test.js` in section 13.

   **Problem:** Section 7 says the editorial user message contains each entry's `signals`, and it builds the allowed-number sets from `JSON.stringify(signals)`. However, the digest-entry shape in 5.9 has no `signals` field, section 6.3 does not define an internal draft-only field, and `editorialize(brief, config, fetchImpl)` receives neither the retained `Item[]` nor an item lookup. A coder must therefore choose among silently omitting signals, adding an undeclared output field, or inventing a draft-field stripping step. Without a specified choice, the corrected overview/why numeric check cannot reliably admit numbers that are supported only by engagement signals.

   **Concrete fix:** Keep `signals` out of the serialized digest and pass an explicit fact lookup:

   ```js
   const editorialFacts = new Map(items.map(item => [item.id, {
     signals: { ...item.signals },
   }]));

   editorialize(brief, config, { fetchImpl, editorialFacts });
   ```

   `editorialize` must obtain each payload entry's `signals` from `editorialFacts.get(entry.id)?.signals ?? {}`; the remaining sent fields come from the digest entry. State that the lookup is never attached to the digest. Add a test where the only support for `1,200` is `signals.hnPoints = 1200`, assert the request contains that signal, the text is accepted, and the finalized/output digest has no undeclared `signals` field.

2. **MEDIUM — The declared Hugging Face model-id regex accepts the unsafe `..` case that the test plan says must be rejected.**

   **Where:** the `hf-models` parser in section 5.3, the “bounded safe repository-id regex” rule in section 11, and `json.test.js` in section 13.

   **Problem:** `^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)?$` accepts values such as `owner/..` and `model..name`. Section 13 explicitly requires an id containing `..` to be malformed. `new URL('https://huggingface.co/owner/..')` also normalizes the dot segment to a different path, so this is not only a test-description typo. The parser specification and its acceptance test cannot both be implemented.

   **Concrete fix:** Make the extra rejection explicit rather than relying on the regex alone:

   ```js
   function isHfModelId(id) {
     if (typeof id !== 'string' || id.length > 200 || id.includes('..')) return false;
     const parts = id.split('/');
     return parts.length <= 2 && parts.every(part =>
       /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)
     );
   }
   ```

   Use this same helper in parser validation and tests, and pin `owner/..`, `model..name`, a second slash, leading punctuation, and a normal `owner/model.name` case.

3. **MEDIUM — HF optional-field mappings and the GitHub-stars why clause still require implementation guesses.**

   **Where:** the `hf-papers` and `hf-models` bullets in section 5.3, the Item/signal schema in 5.4, scoring in 5.7, why-line construction in 6.3, input validation in 11, and JSON/brief tests in section 13.

   **Problem:** The HF Papers rule says to add `signals.hfUpvotes`, `extra.githubStars`, “and other optional numeric values,” without naming those values or their output keys. The HF Models rule similarly says likes/downloads go into `signals.hfLikes` “and `extra`” without defining the exact extra keys. The why rule then requests a GitHub-stars clause but does not say whether `{stars}` comes from `signals.ghStars`, `extra.githubStars`, or their maximum. These choices change scoring, serialized data, and visible brief text. The authoritative HF fixture contains `githubStars`, `githubRepo`, `numComments`, and other optional fields, so the ambiguity is exercised by real input.

   **Concrete fix:** Lock one mapping. For example:

   ```js
   // HF Papers
   paper.upvotes     -> signals.hfUpvotes
   paper.githubStars -> extra.githubStars       // why-line only; does not enter score
   paper.githubRepo  -> extra.githubRepo         // only after HTTP(S) URL validation
   // Explicitly omit numComments, projectPage, ai_summary and all unlisted fields.

   // HF Models
   likes         -> signals.hfLikes
   downloads     -> extra.downloads
   trendingScore -> extra.trendingScore
   ```

   Define the stars operand as the maximum valid value among `item.signals.ghStars` and `item.extra?.githubStars`, consuming both keys for clause deduplication. Alternatively map both sources to `signals.ghStars`, but choose one policy and make the scoring consequence explicit. Replace “other optional numeric values” with the exhaustive list and test every mapped and deliberately omitted fixture field.

4. **MEDIUM — The brief has no total rule for its primary source, source-name order, or primary family.**

   **Where:** section 6.3 (`{source}` fallbacks, `sourceNames`, and `also on {other family names}`), the word-budget source-label pass in 6.4, and `brief.test.js` in section 13.

   **Problem:** `sourceNames` puts sources “contributing the research/labs category first,” but does not order research against labs or settle ties. `{source}` is not tied to a particular source entry, and “non-primary family” never defines which family is primary. A multi-source paper with arXiv, HF Papers, and HN can consequently produce different fallback text, `also on` text, and first-three labels under equally reasonable implementations. This also weakens the byte-determinism claim.

   **Concrete fix:** Define one ordered list and derive every concept from it. For example:

   ```js
   const SOURCE_CLASS = { research: 2, labs: 1 };
   orderedSources = [...item.sources].sort((a, b) =>
     ((SOURCE_CLASS[sourceInfo(b.id).category] ?? 0) -
      (SOURCE_CLASS[sourceInfo(a.id).category] ?? 0)) ||
     (sourceInfo(a.id).registryIndex - sourceInfo(b.id).registryIndex) ||
     codePointCompare(a.id, b.id)
   );
   sourceIds = orderedSources.map(x => x.id);
   sourceNames = orderedSources.map(x => sourceInfo(x.id).name);
   primarySource = orderedSources[0];
   primaryFamily = sourceInfo(primarySource.id).family;
   ```

   Specify that `{source}` names `primarySource`; `also on` traverses this same order, excludes `primaryFamily` and any family already consumed by an earlier HN clause, and emits the first source name for each remaining family. Add a mixed research/labs/HN/unknown-source test.

5. **MEDIUM — “Catch up since last visit” does not specify whether same-day refreshes qualify.**

   **Where:** Archive behavior in section 8.3, `ahead:lastVisit` in 8.4, and the four-refreshes-per-day behavior in sections 1 and 9.

   **Problem:** Catch-up “loads every digest dated after `lastVisit`,” but a digest has both a calendar `date` and a precise `generatedAt`, while `lastVisit` is an epoch timestamp. Comparing calendar dates omits a digest regenerated later on the same UTC day, even though the current design rewrites today's digest every six hours. Comparing `generatedAt` includes it. Both interpretations fit the current wording and produce materially different awareness behavior.

   **Concrete fix:** Select by generation time, including the current UTC date when it was refreshed after the visit:

   ```js
   const catchUpDays = index.days
     .filter(day => Date.parse(day.generatedAt) > lastVisit)
     .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt))
     .slice(0, 14);
   ```

   Treat an invalid `generatedAt` as a malformed index entry. Add browser/unit cases for a same-day refresh before and after `lastVisit`, a prior-day digest, and `lastVisit === 0`.

6. **NIT — `homepage` is promised as frontend metadata but is never serialized.**

   **Where:** section 4.1's `homepage` comment, the `meta.sources`/`meta.static` shapes in 5.9, and frontend rendering in section 8.

   **Problem:** The registry says an optional homepage is “shown on hover / in the source list,” but the browser cannot import `sources.config.mjs`, `Item.sources` does not contain a homepage, and neither frontend-facing meta shape includes it. The six configured homepage values are therefore unreachable in the UI contract.

   **Concrete fix:** Either remove the display promise, or add optional validated `homepage` to `meta.sources[id]` and state exactly where it appears. A concrete choice is to render the source name in the health details as an external link when `homepage` exists and use it as the source chip's `title`; add a schema and rendering test.

7. **NIT — The local static-server contract is not fully defined by the referenced template.**

   **Where:** repository layout section 3, input validation section 11, local development section 15, and `ai-batkahi/scripts/serve.mjs`.

   **Problem:** The referenced template exists, but it serves `dist/` below a configured base path and sends a checked-in `404.html`. Ahead is supposed to serve the repository root, has no `site.config.js`, `dist/`, or `404.html`, and needs `/data/**`. The design does not state the required request-method, malformed-URI, or root-containment behavior, so copying the template does not produce the declared server and an ad hoc adaptation can reintroduce path traversal or crash on bad percent encoding.

   **Concrete fix:** State that Ahead's server binds `127.0.0.1`, serves only `GET`/`HEAD` from the repository root, returns 405 otherwise, catches `decodeURIComponent` errors as 400, resolves the path and rejects anything outside the root, maps directories to `index.html`, and emits an inline/plain 404 without assuming a file. Retain the template's MIME/gzip behavior and add traversal (`..`, encoded `..`, encoded separator), malformed-percent, HEAD, and missing-file tests.

## Verified Assumptions

- **The called-out first-deployment permission finding is resolved consistently.** The `refresh` job has both `contents: write` and `pages: write`; `actions/configure-pages@v6` has `enablement: true`; the separate deploy job has `pages: write` and `id-token: write`. Sections 9, 10, 13, 15, 16, 18, and 19 require no pre-push Pages setup.
- **The filtering/capping/count finding is resolved.** Sections 4.1, 5.1, 5.3, 5.9, 10, 12, 13, and 19 consistently apply parser-specific drops, then age filtering, then `maxItems` in native order. `fetched` is the decoded candidate count before those steps; `kept` is the valid post-cap count before cross-source dedup.
- **The one-registry finding is resolved.** `run()` constructs one map containing `registryIndex` and explicit nullable `category`/`type`/`parser`, and passes that map to `mergeItems`, `score`, and `buildBrief`. The unknown-source object is complete, and section 5.8 now gives executable aggregate authority tuples and comparison direction.
- **The link-out finding is resolved.** `linkouts.more` assigns alphaXiv to Research, Meta AI blog to Labs, and AI News to Blogs. Validation, `meta.static`, section 8.3's literal `Also:` strip, manual checks, and README requirements agree.
- **Previous JSON findings 2-5, 7, and 8 are resolved.** Sitemap invalidation is source-scoped and preserves historical HN attribution; `sourceStartedAtMs` is in parser context and the 40-second page budget includes the sitemap download; the workflow no longer rebases; Reddit present-tense wording requires a current-run marker; stateful sitemap regexes are rejected; and media summaries cut the Cognitive Revolution fixture at `Sponsors:` while retaining full-body length.
- **Previous JSON finding 6 is resolved at the rule level but not fully wired.** Overview bounds are now exactly 150-200 words and digit-form number tokens are checked against a union of sent entry facts. Finding 1 identifies the missing data path for the declared `signals` facts.
- The authoritative probe supports the 64-source baseline and source choices: 64 primary URLs, the four arXiv fallbacks, and HN rank source all returned HTTP 200 in pass 2; HN Algolia order differs from Firebase rank; Reddit requires one unauthenticated request per minute; Anthropic and The Batch need sitemap handling; and smol.ai is stale while current issues arrive through Latent Space.
- The committed HN pair confirms story `50150434` at rank 4 and `50145337` at rank 10. The Cognitive Revolution fixture contains the standalone `Sponsors:` boundary. The fixture inventory records 18 arXiv RSS entries with 13 non-replacement survivors, two audio enclosures among five Interconnects entries, and the deeplearning.ai sitemap edge cases.
- The existing package is ESM on Node `>=22` and currently has `fast-xml-parser` 5.11.2 in `devDependencies`, so the specified move to runtime `dependencies` is grounded. `.gitattributes` contains `tests/fixtures/** -text` as claimed.
- The referenced `ai-batkahi` server template exists and provides localhost binding, MIME handling, gzip, and path normalization. Finding 7 concerns the undefined Ahead-specific adaptation, not the template's existence.

## Unverified/Wrong Assumptions

- **UNSPECIFIED:** how `editorialize` obtains the engagement signals that section 7 says it sends and validates (finding 1).
- **WRONG:** the stated HF model-id regex rejects `..` (finding 2).
- **UNSPECIFIED:** the exhaustive HF optional-field mapping and the operand for the GitHub-stars clause (finding 3).
- **UNSPECIFIED:** the brief's primary source/family and exact source-label order (finding 4).
- **UNSPECIFIED:** whether catch-up compares `date` or `generatedAt`, especially for a later same-day refresh (finding 5).
- **WRONG:** configured `homepage` values are currently available to the frontend contract (finding 6).
- **UNSPECIFIED:** the safe root-serving adaptation of the neighboring static-server template (finding 7).
- **UNVERIFIED BY EXECUTION:** automatic first-run Pages creation. The design now contains the exact permission and `enablement` path required by the earlier review, but this review did not execute GitHub Actions.
- **UNVERIFIED BY THE PROBE:** successful authenticated LLM calls and current model ids. The probe intentionally established endpoint reachability with invalid credentials only, and the design correctly requires deployment-time verification.
- **NOT RE-PROBED:** current source reachability, response sizes, and rate limits. `source-probe.md` was treated as authoritative as instructed.
