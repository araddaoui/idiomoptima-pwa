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
  on 429/timeout (45s each). Gemini uses `gemini-2.5-flash` with forced JSON,
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

## Determinism contract (tag `determinism-2026-09-14`)

The behavioral freeze (`freeze-2026-09-14`, commit `541bab2`) was EXPLICITLY
unfrozen by the user on 2026-09-14 to fix a user-reported inconsistency: the same
manuscript was sometimes edited heavily and sometimes barely at all. The replacement
profile — temperature 0 on all LLM providers plus an auditable coverage census —
is now the binding contract below. Deploy is STILL only via `npm run deploy`
(`wrangler deploy --config wrangler.toml`); any future behavior change requires an
explicit okay from the user PLUS the full verification matrix (below) to pass.

Deterministic contract (must never drift):

- **Provider determinism**: ALL providers run at `temperature: 0` (Gemini
  `thinkingBudget: 0`, `topP: 1`). Provider order stays fixed per tier, failure-driven
  rotation intact; which provider actually answered is audited (`timing.attempts`) and
  surfaced by the consistency harness. No temperature/sampling variation is allowed to
  affect output.
- **Score = honest measured improvement**, provider-independent: base
  `max(58, 100 - matchedStiffPhraseCount * 4)`; residual-misspellings cap at 80;
  duplicated-word cap at 85; real-change credit `+2`/really-changed sentence capped
  at 99 (98 without changes), original capped at 98. The SAME input must always
  produce the SAME `originalScore`/`revisedScore` regardless of which LLM provider
  answered. Reference profile for the "military power literature" sample: 72 → 99
  (committed fixture `scripts/corpus/military.txt`, harness-asserted).
- **Coverage census** (diagnostic, never applied): `COVERAGE_WATCHLIST` in `index.js`
  (7 items: `the mere fact that`, `more likely to break than not`, `in whose neighbourhood`,
  `such a common denominator`, `is occasioned by`, `do not want to hear`,
  `looking forward to receive`) is scanned against the source and the result carries
  `coverage: { matched, uncovered }`. A "quiet" run is EXPLAINED by `uncovered`, not
  by whimsy. Reference census (offline): uae 7 (`more likely to break than not`,
  `in whose neighbourhood`), academic 7 (`the mere fact that`, `such a common denominator`),
  literary 0, business 1 (`looking forward to receive`), general 4 (none), military 7 (none).
- **Title bolding** (incl. question-form titles like "Where does X come from?") is a
  restoration of an input heading ONLY: the line must be heading-shaped in the
  original, and `?`-form titles only when they are the sole sentence of their
  paragraph (a question inside body prose stays plain).
- **Drop/added-word Notes** flag only words NOT covered by a matched builtin or DB
  rule. Replacement words from a matched DB rule are whitelisted (`p.tgt`, NOT
  `p.dst`). Footnote/citation words are stripped before both checks.
- **Nativization rule-sets**: worker `DEFAULT_DATABASES.aiDb` = 28 entries;
  `public/ai-natural-database.json` = 3583 entries. The 16 additions (in addition to
  the earlier documented 7): `it will be useful to map out→it helps to map out`,
  `intent upon spreading→determined to spread`, `was the key culprit in→was the main driver of`,
  `equally pressing sources of concern→equally pressing worries`,
  `casting doubt on the very legitimacy→calling into question the very legitimacy`,
  `is seen as an extension of→is regarded as an extension of`,
  `has the asset of allowing me to→allows me to`, `remaining within the continuity of→continuing`,
  `lends itself basically to the mere fact that→rests essentially on the fact that`,
  `within the parameters of→within the bounds of`, `have affinities with each other→share affinities`,
  `underpinning representation of→underlying representation of`,
  `as the world evolves at a rapid pace→as the world changes fast`,
  `is a testament to→attests to`, `a tapestry of→a mix of`, `regarding for the→regarding the`.
  DB growth is data-only and freeze-safe; rule SEMANTICS must not change.
- **Known/accepted behavior (NOT bugs)**: model-performed synonym swaps not covered by
  any rule (e.g. `places`, `within`, `designated`, `taken`, `land`, `puts`) stay
  surfaced in the Notes by design. Anonymous requests bypass usage limits; free tier =
  4 requests/day, 800-word cap. Single-token DB entries (e.g. `user-friendly`) are
  dropped by `buildNativizationMaps` (not on `SINGLE_WORD_ALLOW`).

Full verification matrix (required before ANY deploy):

1. `node --check index.js`
2. `npm run lint` (tsc --noEmit) and `npm run build`
3. `npm test` (`scripts/test-transform.mjs`, includes heading + added-word-note regressions)
4. `npm run consistency` (`scripts/consistency-check.mjs`): offline determinism ×3 per
   corpus fixture, coverage thresholds per field, Lolita-untouched invariant, military
   72→99 reference. Live provider audit is opt-in: `npm run consistency:live` (consumes
   quota; asserts live scores invariant and bytes identical when the same provider answers).
5. Local temp suites (not committed): master-test.cjs (83), auditfix-test.cjs (23),
   lang-test.mjs (14), audit-goal3.cjs (20), followup-verify.cjs (8). The old
   `e2e-user-text.cjs` probe is retired: its title regex required a literal `*` after
   stripping stars (could not pass) and note-12/13 only exist in the real transform
   path, not the `sentences: []` offline call; the military reference now lives as the
   `military.txt` harness fixture.
6. Corpus fixtures live in `scripts/corpus/` (`uae`, `academic`, `literary`,
   `business`, `general`, `military`); driven by the CORPUS table at the top of
   `scripts/consistency-check.mjs`.