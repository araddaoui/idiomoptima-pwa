# FIX Note 13 + FREEZE — execution plan (approved: "Fix Note 13, then freeze")

Status: READY TO EXECUTE. Blocked only by tool permission rule (edit denied globally except `.opencode/plans/*.md`). Exit plan mode / allow edits to run.

## 1. The one parity fix
`index.js:2923` reads `p.dst` but phrase entries carry `tgt` (`buildNativizationMaps` pushes `{src, tgt, cat}` at `index.js:2511`), so DB-rule target words are never whitelisted → Note 13 falsely flags the 7 DB replacement words.

- `index.js:2923`:
  `while ((pm = rePh.exec(originalText)) !== null && phMatched < 10) { phMatched++; addKeys(allowed, p.tgt || p.dst); }`
- This is the ONLY `.dst` read in the worker (verified). After the fix, Note 13 for the user's text reports only `within, places` (genuinely un-covered model words). Note 12's `designated, taken, land, puts` stays (correct: none rule-covered).

## 2. Regression tests (in committed suite `scripts/test-transform.mjs`, section near the word-note tests)
- `api.addedContentWords("The politicians took the decision. [1]", "The politicians made the decision. [1]", {databases: api.DEFAULT_DATABASES, domain: "academic"})` → list must NOT contain `made`.
- A non-covered introduced word is still flagged, e.g. final "...places the use..." → list contains `places`.
- `api.droppedContentWords(...)` unchanged-behavior smoke: source `took the decision` not flagged as dropped (already covered by suite).

## 3. Verification matrix (must all pass before tagging)
1. `node --check index.js`
2. master-test.cjs (83) — temp dir
3. auditfix-test.cjs (23) — temp dir
4. lang-test.mjs (14) — temp dir
5. `npm test` (60 + new checks)
6. audit-goal3.cjs (20) — temp dir
7. followup-verify.cjs (8) — temp dir
8. e2e-user-text.cjs probe — expect `72 -> 99`, Note 13 added-list == `["within","places"]`, title bolded, no footnote terms
9. `npm run lint`
10. `npm run build`

## 4. Ship + freeze ceremony
1. `git add index.js scripts/test-transform.mjs`
2. Commit (conventional): `fix: whitelist matched DB-rule target words in added-word notes (tgt not dst)`
3. `npm run deploy` → verifies `nativewrite-api` (NOT `react-example`); record Version ID + URL `https://nativewrite-api.nativewrite-api.workers.dev`
4. `git push origin main`
5. `git tag freeze-2026-09-14` + `git push origin freeze-2026-09-14`
6. AGENTS.md: add `## FROZEN (freeze-2026-09-14)` section —
   - Pin tag + worker Version ID.
   - Frozen deterministic contract (behavior must never change without explicit unfreeze):
     - Score = honest measured improvement: `max(58, 100 - matchedStiffPhraseCount*4)`, spelling cap 80, duplicate cap 85, real-change credit +2/sentence capped 99/98, orig ≤ 98. Same input → same score every run regardless of provider.
     - Title bolding (incl. `?`-form) only when the line stands alone in its paragraph.
     - Drop/added Notes flag only words NOT covered by a matched builtin/DB rule; matched-rule target words are whitelisted.
     - Nativization backstop: worker aiDb 12 entries + public db 3567 entries; 7 new rules listed.
   - Gate rule: any future behavior change = explicit user unfreeze + full matrix above must pass; deploy only via `npm run deploy` (`wrangler deploy --config wrangler.toml`).

## 5. Known / accepted behavior (recorded, not bugs)
- Model-performed synonym swaps not in any DB rule (e.g. `places`, `within`, `designated`) are still surfaced by Notes — by design.
- Free users: 4 req/day, 800 words; anonymous bypasses limits (unchanged).

## Notes
- The suite additions keep `npm test` => 60 + 2 = 62 expected (exact count to confirm at run time).