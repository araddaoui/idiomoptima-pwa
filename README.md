# IdiomOptima

Grammar, punctuation and spelling correction plus "nativize prose" — a React 19 +
Vite SPA backed by a single-file Cloudflare Worker.

- **Frontend** (`src/`) — React 19, Vite 6, Tailwind v4, TipTap, Clerk auth. Deployed on Vercel.
- **Backend** (`index.js`) — one Cloudflare Worker that verifies Clerk JWTs, enforces
  usage tiers, calls LLM providers, and runs the deterministic post-processing pipeline.
- **Data** — Supabase (`users`, `usage`) and Stripe subscriptions, both touched only by
  the worker. There is no frontend Supabase client.

## Run locally

1. `npm install`
2. Copy `.env.example` to `.env` and set `VITE_CLERK_PUBLISHABLE_KEY`
   (optional: `VITE_WORKER_URL` to point at a local worker).
3. `npm run dev` — Vite dev server on port 3000.

The frontend calls the deployed worker by default. To run the worker locally, set the
secrets in `.dev.vars` and run `npx wrangler dev --config wrangler.toml`, then point
`VITE_WORKER_URL` at it. Worker secrets are listed in `.env.example`.

## Scripts

- `npm run build` — Vite production build
- `npm run lint` — `tsc --noEmit` (the typecheck)
- `npm test` — worker transform test suite
- `npm run consistency` — offline determinism + coverage + resource budgets
- `npm run deploy` — build + `wrangler deploy --config wrangler.toml` (the transform
  worker). `wrangler.toml` is the only root config wrangler auto-discovers; the Vite
  SPA config lives at `wrangler.frontend.jsonc` and is referenced explicitly by the
  Cloudflare Vite plugin, so a bare `wrangler deploy` now targets the transform worker
- `npm run profile` / `profile:mem` / `profile:cmp` — worker CPU/memory + output-identity

See `AGENTS.md` for the full architecture, behavioral contract, and verification matrix.
