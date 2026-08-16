# Meta Ads Manager Lite — project guide for Claude

Read at the start of every session opened in this directory. Keep it current.

## What this is

A cut-down fork of **AI Ads Agent** (`~/AI Ads Agent`, github.com/anditay7296/ai-ads-agent,
ai-ads-agent-five.vercel.app) scoped to **two ad accounts** and **four pages**.

| Meta account | Name |
|---|---|
| `act_1690421202260749` | AI Agency 02 |
| `act_1386521543403841` | AI Agency 05 |

| Page | Route | What it does |
|---|---|---|
| Dashboard | `/dashboard` | Ad-card reporting, range presets, keep/kill views, pause/resume |
| Campaigns | `/campaigns` | Ads Manager — Campaigns / Ad sets / Ads tabs, budgets, bulk actions, Factory bulk-launch, cross-account clone jobs |
| Copywriting | `/copy` | Copy library, up to 4 variants per entry, tags |
| Automated Rules | `/rules` | Draft, edit and **dry-run** rules — see the hard rule below |

Everything else from the parent — AI Agent, Morning Briefs, Content, Creatives, Decision Journal,
Andigram, Manual, Integrations, Settings — is deliberately absent.

## 🔒 The one rule that must not be broken

**No rule-executing scheduler runs in this app.**

Both ad accounts live inside the parent app's project "AI 网络自由创业", so the parent already
evaluates them at 00:00 KL and every 5 minutes. If this app registered its own rule runners, two
schedulers would pause the same real Meta ads — the same class of failure that produced a blank row
and an overwritten day on 2026-07-04.

`lib/inngest/functions.ts` therefore registers exactly four functions and carries a comment block
naming the excluded runners. **Do not add `ruleRunnerFrequent`, `ruleRunnerDaily` or
`ruleDailyPreview`** without moving enforcement off the parent app first.

`/rules` is manage + dry-run. Dry run makes no Meta write calls.

## Stack

Identical to the parent, so any fix ports across cleanly: Next.js 16 (App Router, Turbopack),
TypeScript, Tailwind v4, Drizzle ORM over Supabase Postgres, Inngest for durable jobs, Meta Graph
API pinned to v21 (`lib/meta/types.ts:META_API_VERSION`). **No Anthropic dependency** — the agent and
brief subsystems were removed, so there is no `ANTHROPIC_API_KEY`.

Auth is custom: scrypt password hash in `users.password_hash`, HMAC-signed cookie
(`lib/auth/cookie.ts`), edge gate in `lib/auth/middleware.ts`. No Supabase Auth anywhere.

## Its own database

This app has its **own Supabase project**, separate from the parent's. `lib/db/schema.ts` is the
parent's schema kept whole — the surviving pages reach through to `decision_journal`,
`agent_actions`, `meta_api_calls`, `factory_runs` and `clone_jobs`, and pruning tables would break
more than it saves. Unused tables just sit empty.

## Layout

```
app/
  (app)/{dashboard,campaigns,copy,rules}/   The four surfaces
  (auth)/login/                             Email + password
  api/{auth/signout,inngest,meta/oauth,meta/deauthorize,dev}/
components/app-shell/                       Sidebar, Topbar, UserMenu, nav-items
                                            (no ProjectBar — single project)
lib/
  lite/accounts.ts                          ★ the ad-account allowlist
  db/                                       schema.ts, client.ts, queries/<topic>.ts
  meta/                                     client.ts, sync.ts, actions.ts, posting.ts, get-client.ts
  rules/                                    engine.ts, runner.ts, types.ts (dry-run + manual run only)
  inngest/                                  4 registered functions
  auth/                                     session, cookie, password, active-project
scripts/bootstrap-lite.ts                   One-shot idempotent provisioning
```

## Account scoping

Two layers, on purpose:

1. **Data**: bootstrap provisions one project holding only the two accounts, so every existing
   `projectId`-scoped query is already correct and needed no edits.
2. **Guard**: `lib/lite/accounts.ts` reads `LITE_AD_ACCOUNT_IDS` and `syncProject()` filters through
   `filterToLiteAccounts()`. A stray account that lands in the table never gets synced or shown.

## Local dev

```bash
npm run dev          # :3000
npm run typecheck
npm run build
npm run bootstrap -- --password '<password>'   # idempotent provisioning
npm run db:push      # apply lib/db/schema.ts to Supabase
```

Health check (read-only, never writes):

```bash
curl "http://localhost:3000/api/dev/setup?token=$DEV_SETUP_TOKEN"
```

Step 9 of that check fails loudly if a rule runner ever gets registered here.

## Conventions

Inherited from the parent — keep them:

- **Server Actions** live next to the page in `actions.ts`; `requireAppSession()` first,
  `revalidatePath` after mutations.
- **Currency**: `formatMyr()` in `lib/utils.ts`. Budgets are stored in cents (Meta convention).
- **Time**: KL is UTC+8, no DST. Inngest crons are UTC — comment the KL equivalent beside them.
- **Tokens**: AES-256-GCM at rest via `APP_ENCRYPTION_KEY`. Never log raw tokens.
- **JSDoc gotcha**: never put a literal `*/` inside a `/** */` block — use `//` for cron expressions.

## Things not to do

- Don't register rule runners (see above).
- Don't point `DATABASE_URL` at the parent's Supabase — the two apps are meant to be independent.
- Don't `git add .` — `.env.local` holds `META_APP_SECRET` and the service-role key. Add files explicitly.
- Don't rotate `APP_ENCRYPTION_KEY` casually — stored Meta tokens become undecryptable and the app
  must be re-bootstrapped.
