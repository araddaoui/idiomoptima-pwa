# AGENTS.md

## Overview

IdiomOptima (internally "NativeWrite") is a grammar / punctuation / spelling correction
and "nativize prose" web app. Conceptually 2 layers:

- **Frontend** — React 19 + Vite 6 + Tailwind v4 + TipTap rich text editor SPA.
  Uses shadcn/ui tokens, lucide icons, motion, sonner. Served via Vercel.
- **Backend** — a single-file Cloudflare Worker (`nativewrite-api`, `index.js`, ~2200 lines)
  that verifies Clerk JWTs, enforces usage tiers, and calls LLM providers
  (Gemini → OpenRouter free-model rotation → DeepSeek → Cloudflare AI) with a large
  deterministic post-processing pipeline.

Auth: Clerk. Data: Supabase (`users`, `usage` tables). Payments: Stripe subscriptions.

The package name is still the legacy `react-example` and worker mame internally
"NativeWrite"; the user-facing brand is IdiomOptima.

## Commands

- `npm run dev` — Vite dev server on port 3000 (host 0.0.0.0).
  Set `DISABLE_HMR=true` to turn HMR off.
- `npm run build` — Vite production build (tsc types are checked here indirectly; the
  `cloudflare` vite plugin also builds the Worker).
- `npm run preview` — build + `wrangler dev`.
- `npm run lint` — `tsc --noEmit` (this is the typecheck command).
- `npm run deploy` — build + `wrangler deploy --config wrangler.toml`. IMPORTANT: this is
  the ONLY command that ships `index.js` to the transform worker the app actually calls
  (`https://nativewrite-api.nativewrite-api.workers.dev`). A bare `wrangler deploy` (no
  `--config`) resolves the Vite-emitted `dist/wrangler.json` (from `wrangler.jsonc`,
  name `react-example`) and instead publishes a STATIC SPA worker that never runs
  `index.js` — the app would silently keep hitting the last real transform deploy.
- `npm run clean` — `rm -rf dist`.

### Important routing notes

- The Worker handles the transform on **`POST /`**, NOT `/api/transform`.
  `/api/transform` only exists as the dev-proxy fallback in `vite.config.ts` that
  `geminiService.ts` overrides via `VITE_WORKER_URL`.
- Worker endpoints: `GET /health`, `POST /stripe-webhook`, `POST /create-checkout`,
  `POST /billing-portal`, `GET /user-tier`, and `POST /` (transform). Everything
  else → 404. `POST /create-checkout` and `POST /billing-portal` require a valid
  Clerk JWT and both `upsert_user`-guarantee a `users` row (checkout) / read
  `stripe_customer_id` (portal).
- SPA rewrites live in `vercel.json` (`/app*`, `/sign-in*`, `/sign-up*` → `index.html`;
  `www.idiomoptima.com` → 301 to bare domain).

## Project structure

- `src/App.tsx` — ClerkProvider + BrowserRouter. `/` landing, `/sign-in`, `/sign-up`,
  `/app` (protected → ToolPage).
- `src/pages/LandingPage.tsx` — marketing page (hero, features, pricing Free/Pro/Enterprise,
  FAQ accordion, TOS/privacy modal). Props: `onStartFree`, `onGoToApp`.
- `src/pages/ToolPage.tsx` — the main workspace. Presets + dialect/domain/tone controls,
  two-column editor → output panel. Output has 3 tabs (Full Prose / Track Changes / Notes).
  Per-sentence hover edit + "Use original" override system (`drafts`, `overrides`).
  Exports .docx (via `docx`) and PDF (via `jsPDF`). Loads reference databases from
  `/public` on mount: `idioms-clunky-native.json`, `ai-natural-database*.json`,
  `lexical-{academic,business,creative,general}.json`.
- `src/components/RichTextEditor.tsx` — TipTap wrapper (StarterKit, Superscript,
  Underline, Placeholder). Bidirectional sync via `isInternalChange` ref.
- `src/services/geminiService.ts` — `detectBestMode()` heuristic; `transformText()`
  POSTs to the Worker then applies client-side replacements (idiom / AI-ese / domain
  lexical databases) to `.revised` and `finalVersion`, tracking `databaseStats`.
- `src/lib/supabase.ts` — client for `users.subscription_tier`, `usage.request_count`,
  RPC `increment_usage`.
- `lib/utils.ts`, `src/index.css` — `cn()` helper; Tailwind v4 `@theme` + shadcn tokens +
  TipTap/output prose styling (Inter + Cormorant Garamond; `--background: #FAF8F5`).
- `index.js` — the entire Cloudflare Worker (see next section).
- `public/*.html` — static `faq`, `about`, `terms`, `privacy` pages.
- `scripts/build-idioms.cjs` — fetches idioms from GitHub
  `WithEnglishWeCan/generated-english-idioms`, writes `idioms-2000.json`.

## Worker (`index.js`) key behavior

- **Auth**: `Authorization: Bearer <clerk JWT>` → verified against
  `https://{CLERK_DOMAIN}/.well-known/jwks.json` (cached 1h). user id = `sub`.
- **Tiers & limits**: tier from `users.subscription_tier`; `free` = 4 requests/day
  (each capped at 800 words), `pro`/`enterprise` = 9999 and no word cap. Over the
  run limit → HTTP 429 with `limitReached: true`; over 800 words on free → HTTP 429
  with `wordLimitReached: true`. Usage
  increments only for authenticated users; **anonymous requests bypass limits entirely**.
- **Providers**: Pro = Gemini → OpenRouter → DeepSeek. Free = OpenRouter → Cloudflare AI
  → Gemini → DeepSeek; free texts ≥ 8000 chars skip OpenRouter/Cloudflare and go
  straight to Gemini/DeepSeek. OpenRouter rotates through a hardcoded free-model list
  on 429/timeout (45s each). Gemini uses `gemini-2.0-flash` with forced JSON,
  `thinkingBudget: 0`, 90s timeout.
- **Post-processing pipeline**: `extractFootnoteBlock` (pulls `[N]`/`Ibid.` out of body) →
  `normalizeTitleBreaks` (bolds headings) → `postProcessText` → `reinsertParagraphBreaks`
  → sentence-level passes (`protectQuotes`, `protectAcademicRegister`,
  `restoreStructuralMarkers`, `protectInvariantIdioms`, `restoreDroppedSentence`,
  `restoreCurlyApostrophes`, `restoreLeadingEllipsis`, `nativePolish`,
  `fixCommonMisspellingsSafe`, `capitalizeEnhanced`, `addQuestionMark`) →
  `rebuildFinalVersion` → scoring → `postProcessSuggestions`.
- **Scoring**: residual misspellings cap scores at 80; otherwise
  `revScore = min(98, 91 + realChangeCount*2)`; `origScore` docked proportionally.
- **Stripe**: `/create-checkout` creates a subscription session (price from
  `STRIPE_PRICE_ID`); `/stripe-webhook` verifies HMAC manually, sets tier pro on
  checkout completion, resets to free on subscription deleted.

## Environment variables

See `.env.example`. Frontend (Vite, `import.meta.env`):

- `VITE_CLERK_PUBLISHABLE_KEY`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_WORKER_URL` (optional; overrides the Worker URL used by `geminiService.ts`)

Worker secrets (set via `wrangler secret put`):

- `CLERK_DOMAIN`
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`
- `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`
- `AI` (Cloudflare Workers AI binding, per `wrangler.toml`)

Other files present: `.dev.vars`, `.env`, `.env.local` (local secrets), `.env.txt`.
Keep API keys out of commits.

## Known issues / cautions

- **Two wrangler configs coexist**: `wrangler.toml` (`nativewrite-api`, AI binding,
  compat 2026-08-19) and `wrangler.jsonc` (`react-example`, compat 2026-06-08,
  `nodejs_compat`). The build emits a `dist/wrangler.json`. Verify which one is the
  source of truth before changing Worker config.
- **Uncommitted changes** currently in the worktree: `src/pages/ToolPage.tsx` and
  `src/services/geminiService.ts` only if locally modified beyond the committed
  audit-hardening work (HEAD `61ac999`). Stray untracked files:
  `index.js.bak-20260828-131457`, `last-response.json`.
- **Public copy is now aligned with enforcement**: the worker limits authenticated free
  users to 4 requests/day (each capped at 800 words) (`users.subscription_tier`
  in Supabase), pro/enterprise 9999; anonymous requests bypass limits.
  `about.html`, `faq.html`, `privacy.html`, and the landing-page pricing reflect
  this. Any future change to the limit numbers must update
  `index.js` AND those four files.
- The repo root contains large data files (nativewrite `*.csv`, `lexical-*.json`,
  `metadata.json`) that are inputs to the frontend databases, not app source.
- `geminiService.ts` declares `process.env.WORKER_URL` reference inside comments/JSON in
  `vite.config.ts`; the Worker URL default in the service is the deployed
  `nativewrite-api` worker. Don't confuse `WORKER_URL` (vite proxy) with `VITE_WORKER_URL`.
- No AGENTS.md existed before this file; git history uses conventional commits
  (`fix: ...`, `Major overhaul: ...`).

## Determinism contract (two-pass rebuild, 2026-09-14)

The behavioral freeze (`freeze-2026-09-14`, commit `541bab2`) was EXPLICITLY
unfrozen by the user on 2026-09-14 to fix a user-reported inconsistency: the same
manuscript was sometimes edited heavily and sometimes barely at all. The binding
replacement is the **two-pass contract** below (approved along with its full
matrix by the user on 2026-09-14). Deploy is STILL only via `npm run deploy`
(`wrangler deploy --config wrangler.toml`); any future behavior change requires an
explicit okay from the user PLUS the full verification matrix (below) to pass.

Deterministic contract (must never drift):

- **Two-pass pipeline**: Pass 1 = Gemini grammar/spelling/S-V correction ONLY
  (never adds/removes commas, never rewrites for style, never swaps word choice).
  Pass 2 = deterministic regex lexical replacement from the client DB families
  (aiDb AI-ese → idioms → domain lexical), longest-first, word-boundary,
  quote-safe, collocation-guarded, applied to each sentence's `revised` only.
  There are NO code-side nativization rules in Pass 2 beyond the DB layer: the
  builtin word-swap map, the slot-template families, the prompt example list,
  and the template credit in scoring were all REMOVED. The grammar layer exists
  ONLY as a residual detector for scoring, never as an editor (the old Stage-A
  write path is gone).
- **Provider determinism**: Gemini is the ONLY provider for every tier
  (`MODEL_CANDIDATES = ["gemini-2.0-flash"]`),
  run at `temperature: 0`, `topP: 1`, `maxOutputTokens: 65536`, forced JSON, and
  NO `thinkingConfig`. OpenRouter/DeepSeek/Cloudflare-AI standby were REMOVED.
  There is no failure rotation: if Gemini is down the request fails loudly.
  Which model actually answered is audited (`timing.attempts`). No
  temperature/sampling variation is allowed to affect output.
- **Score = re-banded measured residual**, provider-independent: raw residual
  meter unchanged (spelling cap 80, duplicated-word cap 85, grammar 3/hit cap 15,
  stiffness density `min(40, round(stiff/proseCount*30))`, floor 40); then the
  BAND snaps it onto the display scale — `originalScore` = 98 only when the
  source is measured flawless (raw >= 98), otherwise at most 95; if nothing
  measurable changed (`anyChange` = no real sentence change AND no DB rule fired
  AND no spelling/stiffness/grammar clearing) the revision scores EXACTLY like
  its source; otherwise `revisedScore = min(98, originalScore + max(2,
  round(cleared*0.8)))` where `cleared = rawRev - rawOrig`. Residual misspellings
  still cap both at 80. The SAME input always produces the SAME scores regardless
  of provider. Reference profiles: military 77→95, uae 60→92, academic 60→92,
  grammar 79→84, business 98→98, general 91→98, literary 98→98, success-criteria
  80→96, kingston 60→92 (all committed fixtures, harness-asserted).
- **Coverage census** (diagnostic, never applied): `COVERAGE_WATCHLIST` in `index.js`
  (7 items: `the mere fact that`, `more likely to break than not`, `in whose neighbourhood`,
  `such a common denominator`, `is occasioned by`, `do not want to hear`,
  `looking forward to receive`) is scanned against the source and the result carries
  `coverage: { matched, uncovered }`. A "quiet" run is EXPLAINED by `uncovered`, not
  by whimsy. Reference census (offline): uae 7 (`more likely to break than not`,
  `in whose neighbourhood`), academic 7 (`the mere fact that`, `such a common denominator`),
  literary 0, business 1 (`looking forward to receive`), general 4 (none), military 7 (none),
  success-criteria 4 (none).
- **Title bolding** (incl. question-form titles like "Where does X come from?") is a
  restoration of an input heading ONLY: the line must be heading-shaped in the
  original, and `?`-form titles only when they are the sole sentence of their
  paragraph (a question inside body prose stays plain).
- **Drop/added-word Notes** flag only words NOT covered by a matched DB rule.
  Replacement words from a matched DB rule are whitelisted (`p.tgt`, NOT
  `p.dst`). Footnote/citation words are stripped before both checks.
- **Citation detection is `[N]`-gated**: a line is treated as a citation (skipped by
  Pass 2 and the stiff census) only when it STARTS with a `[N]` marker AND is,
  with the marker stripped, author-year shaped / an "Ibid." / a URL or DOI, or is
  already `isImmutableFootnote`. Body prose that merely CONTAINS book years
  ("extending from The Woman Warrior (1976) to China Men (1977)") MUST be
  nativized — this is why `have affinities with each other→share affinities`
  fires inside kingston's Book-Titles sentence.
- **Nativization rule-sets**: worker `DEFAULT_DATABASES.aiDb` = 28 entries;
  `public/ai-natural-database.json` = 3584 entries (the 16 documented additions,
  plus the freeze-safe data entry `robust framework→solid framework`). All 16
  documented additions above remain as DATA (their old code-side template
  families are removed; the aiDb rows are the only place they live now). DB
  growth is data-only and freeze-safe; rule SEMANTICS must not change.
- **Grammar/spelling lives in Pass 1 (live-only)**: the offline/rescue path
  cannot fix grammar by contract. The success-criteria fixture's grammar asserts
  (`challanges→challenges`, `underlaying→underlying`, `demonstration→demonstrate`)
  run against the LIVE worker only; offline, the harness asserts the DB-only
  fires (robust framework, `it is important to note that`, `it is worth noting`,
  `navigate these challenges`), UK-dialect preservation (`colonisation`,
  `travelled`, `labelled`, `characterisation`), footnote preservation, and the
  80→96 band. Grammar defects are detected deterministically via
  `applyGrammarLayer(...).fixes` (detector-only).
- **Known/accepted behavior (NOT bugs)**: model-performed synonym swaps not covered by
  any rule (e.g. `places`, `within`, `designated`, `taken`, `land`, `puts`) stay
  surfaced in the Notes by design. Anonymous requests bypass usage limits; free tier =
  4 requests/day, 800-word cap. Single-token DB entries are dropped by
  `buildNativizationMaps` unless on `SINGLE_WORD_ALLOW` (bare `navigate→handle`
  stays GATED on purpose — an un-gated swap would produce ungrammatical "handle
  to the page"; the multi-word `navigate these challenges→handle these challenges`
  fires normally).

Full verification matrix (required before ANY deploy):

1. `node --check index.js`
2. `npm run lint` (tsc --noEmit) and `npm run build`
3. `npm test` (`scripts/test-transform.mjs`, includes heading + added-word-note
   regressions and the DB-only Pass-2 suite)
4. `npm run consistency` (`scripts/consistency-check.mjs`): offline determinism ×3 per
   corpus fixture, coverage thresholds per field, Lolita-untouched invariant, re-banded
   reference pins (incl. military 77→95 and success-criteria 80→96), DB-only/dialect/
   footnote asserts, residual-detector honesty. Live provider audit is opt-in:
   `npm run consistency:live` (consumes quota; asserts live scores invariant, bytes
   identical when the same provider answers, and the Live-only grammar fixes land).
5. Local temp suites (not committed): master-test.cjs (83), auditfix-test.cjs (23),
   lang-test.mjs (14), audit-goal3.cjs (20), followup-verify.cjs (8). The old
   `e2e-user-text.cjs` probe is retired: its title regex required a literal `*` after
   stripping stars (could not pass) and note-12/13 only exist in the real transform
   path, not the `sentences: []` offline call; the military reference now lives as the
   `military.txt` harness fixture.
6. Corpus fixtures live in `scripts/corpus/` (`uae`, `academic`, `literary`,
   `business`, `general`, `military`, `grammar`, `success-criteria`, `kingston`);
   driven by the
   CORPUS table at the top of `scripts/consistency-check.mjs`.