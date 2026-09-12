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
- `npm run deploy` — build + `wrangler deploy`.
- `npm run clean` — `rm -rf dist`.

### Important routing notes

- The Worker handles the transform on **`POST /`**, NOT `/api/transform`.
  `/api/transform` only exists as the dev-proxy fallback in `vite.config.ts` that
  `geminiService.ts` overrides via `VITE_WORKER_URL`.
- Worker endpoints: `GET /health`, `POST /stripe-webhook`, `POST /create-checkout`,
  `GET /user-tier`, and `POST /` (transform). Everything else → 404.
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
- **Tiers & limits**: tier from `users.subscription_tier`; `free` = 50 requests/day,
  `pro`/`enterprise` = 9999. Over limit → HTTP 429 with `limitReached: true`. Usage
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
- **Uncommitted changes** currently in the worktree: `index.js`, `src/pages/ToolPage.tsx`,
  `src/services/geminiService.ts`, and the public `ai-natural-database*.json` +
  `lexical-*.json` files. Stray untracked files: `index.js.bak-20260828-131457`,
  `last-response.json`.
- **`public/about.html` still claims "4 transformations per day, up to 800 words"** but the
  worker enforces 50 requests/day for free users — stale copy.
- The repo root contains large data files (nativewrite `*.csv`, `lexical-*.json`,
  `metadata.json`) that are inputs to the frontend databases, not app source.
- `geminiService.ts` declares `process.env.WORKER_URL` reference inside comments/JSON in
  `vite.config.ts`; the Worker URL default in the service is the deployed
  `nativewrite-api` worker. Don't confuse `WORKER_URL` (vite proxy) with `VITE_WORKER_URL`.
- No AGENTS.md existed before this file; git history uses conventional commits
  (`fix: ...`, `Major overhaul: ...`).