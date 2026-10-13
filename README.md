# WPMonitor

A multi-user WordPress monitoring dashboard that runs entirely on **Cloudflare Workers (free tier)**.
One row per site: up/down status, response time, PageSpeed score, SSL/security, and WordPress
update counts. Each user sees **only their own** sites and data — isolation is the top security
requirement. Monitoring is strictly read-only: nothing is ever written to the monitored sites.

> **Status: Milestone 1 of 8 complete.**
> Accounts, magic-link auth, sessions, signup modes, admin approval, settings,
> sites repository layer (caps/blocklist/isolation), dashboard shell, and the full
> milestone-1 test suite are in. Roadmap: see the milestones table at the bottom.

## Stack (fixed)

- One Cloudflare Worker (TypeScript, `fetch` + `scheduled` handlers), `wrangler` as the only build tool
- [Hono](https://hono.dev) for routing + Hono JSX server-rendered HTML + **htmx** for partial updates
- One hand-written CSS file (`public/styles.css`) served as a Workers static asset
- **D1 (SQLite) with Drizzle ORM**, migrations in `migrations/`
- Resend REST API for email (console fallback in dev), generic webhook alerts (Slack/Discord JSON)
- Google PageSpeed Insights v5 (milestone 5), optional Google OAuth sign-in (milestone 8)
- Config in `wrangler.jsonc`; secrets via `wrangler secrets` / `.dev.vars` — never hardcoded
- Authentication is built in (passwordless): magic links + optional Google OAuth, Turnstile on the
  login form, HttpOnly `SameSite=Lax` session cookies. **No Cloudflare Access.**

## Free-tier design constraints (how the code respects them)

| Limit | How it's handled |
|---|---|
| 10 ms CPU/invocation | Server-rendered, no bundler, bounded regex parsing (no HTML parser deps), no password hashing |
| 50 subrequests/invocation | Jobs cap their outbound fan-out (25 uptime / 5 PageSpeed / 2 fingerprint + ≤15 wp.org lookups) and keep a counter that stops early below 45 |
| 5 cron triggers/account | Exactly **3**: `*/5` (uptime), `0 *` (PageSpeed + fingerprint slice), `0 3` (daily maintenance) |
| 100k req/day | Shared budget protected by `MAX_USERS` (50), `MAX_SITES_PER_USER` (5), `MAX_SITES_TOTAL` (150) env caps |
| Uptime check cost | `HEAD` only (fallback `GET` on 405/501), **never reads response bodies**, manual redirect follow (max 3, re-validated each hop) |
| D1 round trips | Jobs write with `db.batch()`; fair scheduling orders by last-checked time **across all users** (no user can starve others), min 5-minute per-site interval |

## Local development (zero external accounts needed)

Prereqs: Node 24+, a Cloudflare account is **not** required for `wrangler dev` with local D1.

```bash
cp .dev.vars.example .dev.vars        # defaults are dev-friendly
npx wrangler d1 execute wpmonitor --local --file=migrations/0001_initial.sql
npx wrangler dev                      # http://127.0.0.1:8787
```

- `RESEND_API_KEY` empty → emails (incl. the magic-link URL) are printed to the console.
- `DEV_MODE=true` → Turnstile is skipped (the worker logs a **loud** startup warning;
  never set this in production).
- `PAGESPEED_API_KEY` empty → PageSpeed job is skipped, dashboard shows "n/a" (milestone 5).
- `SIGNUP_MODE=open` (as in `.dev.vars` above) → new accounts approve instantly, so you can
  sign up and click the console magic link immediately. In `approval` mode (the default),
  the first request needs an admin: use `ADMIN_EMAIL` to create the admin account
  (auto-approved + `is_admin`).

### Run the scheduled handler locally

```bash
npx wrangler dev --test-scheduled
```

This fires the cron triggers on their schedule against your local worker (with a local D1
database). Jobs are dispatched from the `scheduled` handler in `src/index.ts` on `event.cron`.

### Tests

```bash
npm test                 # vitest run (unit + repo isolation + auth + signup modes)
npm run typecheck        # tsc --noEmit
```

The test suite runs against an in-memory D1-compatible SQLite database
(`tests/helpers/d1.ts`, `node:sqlite`) with the real migration applied — no network, no accounts.
Coverage in Milestone 1: token hashing/single-use/expiry, sessions (create/slide/delete/
"everywhere"/cascade), signup modes (`open`/`approval`/`closed`) + `MAX_USERS`, `ADMIN_EMAIL`
auto-approval, rate limiting (per key, window reset), user-data isolation (A cannot read/edit/
delete/verify B's site — all 404/no-op), site caps (per-user + total) and blocklist, URL
normalization, job eligibility (unverified/paused/pending-user sites are excluded from the
uptime batch), and fair cross-user scheduling order.

## Project layout

```
src/
  index.ts            Worker entry (fetch + scheduled/cron dispatch)
  app.ts              Hono app factory (middleware wiring per route prefix)
  env.ts              Env access + config + DEV_MODE loud warning
  routes/             auth, settings, admin, dashboard, public (privacy)
  middleware/         session, csrf, rateLimit, turnstile, signup modes
  db/
    schema.ts         Drizzle schema (mirrors migrations/0001_initial.sql)
    client.ts         drizzle(D1) + nowIso()
    repos/            the ONLY place user-scoped SQL lives (users, sites, auth, rateLimits)
  lib/                tokens (random/SHA-256/timing-safe), email (Resend/console)
public/styles.css     the one hand-written stylesheet (Workers static asset)
migrations/           SQL applied with wrangler d1 execute
tests/                vitest suites + D1 stub + seed helpers
```

## Security model (Milestone 1 scope)

- **Isolation:** every user-data query goes through `src/db/repos/*`, which REQUIRE a
  `userId` and filter `owner_id` (children via join to `sites`). A foreign site ID behaves
  exactly like a missing one → routes answer **404** (IDs can't be probed). Route handlers
  never run raw SQL.
- **Auth:** magic tokens and session tokens are 32 random bytes; **only SHA-256 hashes are
  stored** (`login_tokens`, `sessions`). Tokens are single-use (15 min TTL); sessions are
  30-day sliding. Responses are identical whether or not an email exists (no enumeration).
- **CSRF:** same-origin `Origin`/`Referer` check on all POSTs + `SameSite=Lax` cookies.
- **Rate limits:** D1 fixed-window per email and per IP (magic links 5/h), and per
  user/site where later milestones add them (scan-now, verify, add-site).
- **Secrets:** `.dev.vars` is git-ignored; `.dev.vars.example` documents every variable.
- **Privacy:** `/privacy` page documents stored data and deletion; "Delete my account and
  all data" (Settings) cascades to every row.

## Milestones (build order)

1. ✅ **Scaffold, D1 schema, repositories, magic-link auth + sessions + Turnstile,
   signup modes, admin approval page, account deletion, isolation + auth tests.**
2. Sites CRUD with caps/blocklist + ownership verification (DNS TXT / meta tag / file),
   dashboard layout with seed data for two test users.
3. Uptime job + down/up state machine + dashboard sorting/filtering/pagination/htmx auto-refresh.
4. Alerts (per-owner email + webhook, transition-only, logged).
5. PageSpeed job (least-recently-tested first, quota-safe).
6. WordPress fingerprinting + `wp_org_cache` + updates column + site detail page with charts.
7. SSL ingest endpoints (`INGEST_TOKEN`) + GitHub Actions `node:tls` checker.
8. Retention/aggregation, optional Google sign-in, full deploy README.

## Deploy (summary — full instructions land with Milestone 8)

```bash
npx wrangler login
npx wrangler d1 create wpmonitor
# paste the real database_id into wrangler.jsonc
npx wrangler d1 execute wpmonitor --remote --file=migrations/0001_initial.sql
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put INGEST_TOKEN            # milestone 7
npx wrangler deploy
```
