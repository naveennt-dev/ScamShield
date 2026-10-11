# ScamShield — Current-State Audit (pre-upgrade)

Audit date: 2026-10-07. This document describes the repository **as it was received**, before the
production upgrade. It is kept for traceability; see `docs/architecture/production.md` for the
target/implemented architecture.

## 1. Architecture

A single Next.js 15.2.3 App Router application:

```
Browser (MainChatPage, client component)
   │  axios POST /api/scam { message }
   ▼
src/app/api/scam/route.ts ──► OpenAI SDK ──► gpt-4o (structured output)
   │
   └─► JSON { scam_words, reason, scamPercentage, scamScore, response }

Browser ──► /api/auth/[...all] (better-auth, Google OAuth) ──► Prisma ──► PostgreSQL (Neon)
```

There is no service layer, no persistence of analyses, no versioned API and no tests.

## 2. Files inspected

| Area | Files |
|---|---|
| Config | `package.json`, `tsconfig.json`, `next.config.ts`, `vercel.json`, `postcss.config.mjs`, `components.json`, `.gitignore`, `.vscode/settings.json` |
| DB | `prisma/schema.prisma`, 2 migrations |
| Auth | `src/lib/auth.ts`, `src/lib/auth-client.ts`, `src/app/api/auth/[...all]/route.ts`, `src/middleware.ts`, `src/app/auth/*` |
| API | `src/app/api/scam/route.ts` |
| UI | `src/app/layout.tsx`, `src/app/page.tsx`, `src/components/MainChatPage.tsx`, `src/components/ui/*` (shadcn), `src/providers/QueryClient.tsx`, `src/app/globals.css` |
| Docs | `README.md` |

## 3. Existing features

- Google sign-in via better-auth (Prisma adapter, PostgreSQL).
- Protected home page (server-side `auth.api.getSession` check + middleware cookie check).
- Chat-style page where the user pastes a message and receives GPT-4o's opinion
  (scam words, reason, percentage, score).

## 4. Dependencies (as received)

Runtime: next 15.2.3, react 19.0, better-auth ^1.2.4, @prisma/client ^6.5, openai ^4.89, axios,
@tanstack/react-query, framer-motion, radix-ui primitives, react-circular-progressbar, sonner,
vaul, zod ^3.24, `@auth/prisma-adapter` (unused), `react-virtuoso` (unused), `prettier` (in
runtime deps).

`npm audit` on the received lockfile: **15 vulnerabilities (5 critical, 7 high)**, including
Next.js RCE/authorization advisories (next 15.2.3), better-auth ≤1.6.21, axios, `@auth/core`.

## 5. Data flow / API flow

1. `MainChatPage` posts `{ message }` to `/api/scam`.
2. Route parses JSON, checks `typeof message === "string"` (no length limit).
3. Calls `client.beta.chat.completions.parse({ model: "gpt-4o", ... })` with the user message
   as the `user` turn and a system prompt.
4. Returns the parsed object with `Access-Control-Allow-Origin: *`.
5. Errors → `500 { error: "Internal server error" }` and `console.error` of the full error.

No result is stored. No request ID, no logging structure, no metrics.

## 6. Authentication flow

1. `/auth` → `authClient.signIn.social({ provider: "google", callbackURL: "/" })`.
2. better-auth handles OAuth callback at `/api/auth/callback/google`, creates `user`, `account`,
   `session` rows, sets the session cookie.
3. `middleware.ts` (matcher `/`, `/dashboard`) redirects to `/auth` when no session cookie
   exists (optimistic check only).
4. `page.tsx` performs the authoritative `auth.api.getSession` check.

`/api/scam` is **not** authenticated.

## 7. Database structure

better-auth core tables only: `user`, `session`, `account`, `verification`. The second migration
converts `user.id` from SERIAL to TEXT. No domain tables.

## 8. Bugs found

| # | Location | Bug |
|---|---|---|
| B1 | `next.config.ts` | `typescript.ignoreBuildErrors: true` hides type errors in production builds. |
| B2 | `api/scam/route.ts` | Stray `[]` expression after `return`; dead code. |
| B3 | `MainChatPage.tsx` | Conversation only renders when `messages.length > 1`, so the user's first message is invisible until the response arrives; on error the user message is shown nowhere. |
| B4 | `MainChatPage.tsx` | `scamPercentage!` non-null assertions on optional values; `getScamColor(0)` treats 0 as "no score". |
| B5 | `layout.tsx` | A client provider wraps `<body>` *inside* `<html>` (invalid nesting for hydration). |
| B6 | `layout.tsx` | `--font-geist-*` CSS vars referenced but Geist never loaded; OG image `/scamshield-og.png` does not exist. |
| B7 | `auth.ts` | `new PrismaClient()` per module load (connection exhaustion under dev HMR / serverless). |
| B8 | `auth.ts` | Missing `GOOGLE_CLIENT_ID/SECRET` silently become `""`. |
| B9 | `page.tsx` | Unused `createAuthClient` import. |
| B10 | `.gitignore` | `.env*` also ignores `.env.example`. |
| B11 | `package.json` | No lint configuration although a `lint` script exists; no tests. |
| B12 | README | Claims rate limiting, input sanitization and CORS in `next.config.ts` that do not exist or are inconsistent. |

## 9. Security problems

| # | Severity | Problem |
|---|---|---|
| S1 | High | `/api/scam` is unauthenticated and unrate-limited → anyone can spend the OpenAI budget (denial-of-wallet). |
| S2 | High | `Access-Control-Allow-Origin: *` on `/api/scam`; three *different* CORS origins configured in `vercel.json`, `next.config.ts` and the auth `OPTIONS` handler. |
| S3 | High | `middleware.ts` logs the session cookie; `page.tsx` logs the full session object (session tokens in logs). |
| S4 | High | Vulnerable dependency versions (Next.js 15.2.3, better-auth, axios, @auth/core). |
| S5 | Medium | No input size limit → large prompt costs, memory pressure. |
| S6 | Medium | Prompt injection: user text is sent as the user turn with no delimiting; the model's verdict is returned verbatim; the LLM is the **sole** decision-maker. |
| S7 | Medium | The model's JSON is trusted for scores (no bounds: percentage could be 900 or negative). |
| S8 | Medium | No security headers (CSP, HSTS, frame protection, nosniff, referrer policy). |
| S9 | Low | `console.error(error)` may log provider responses/headers. |
| S10 | Low | No `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` documented. |

## 10. Architectural problems / duplicated logic

- Business logic, provider code, prompt, validation and CORS all live in one route handler.
- Hard-coded single model (`gpt-4o`) and provider; no timeout, retry or fallback.
- If OpenAI is unavailable the product returns 500 — there is no deterministic baseline.
- CORS logic duplicated (3 places, 3 different origins).
- Score/colour thresholds duplicated in UI (`>75`, `>40`) with no server-side definition.

## 11. Production gaps

No persistence of analyses, no history, no reporting, no URL/image/email analysis, no ML, no
risk fusion, no API versioning, no consistent response envelope, no request IDs, no structured
logging, no metrics, no rate limiting, no tests, no `.env.example`, no deployment docs.

## 12. What was preserved

Google OAuth through better-auth, the Prisma auth models and migrations, shadcn UI primitives,
React Query, and (for backward compatibility) a `/api/scam` route that now delegates to the new
pipeline and returns the legacy response shape with deprecation headers.
