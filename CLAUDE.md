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

`/rules` is manage + dry-run, and that is enforced in two places, not just by convention:

- `RuleRow.tsx` ships a **Dry run** button only. The parent's live "Run now" button is deleted.
- `runRuleNowAction` takes **no `dryRun` parameter** — it hard-codes `dryRun: true`, so no client
  payload can request a live run. Keep it that way; the page promises no Meta writes.

Related: `lib/inngest/client.ts` must **not** use the parent's app id `ai-ads-agent`. Inngest keys an
app by (environment, id), so a shared id means the last deploy to sync wins — if Lite won, the
parent's rule runners would be archived and silently stop firing. Lite also needs its own Inngest
*environment*, since the two apps share event names. Step 9 of `/api/dev/setup` asserts both.

## Stack

Identical to the parent, so any fix ports across cleanly: Next.js 16 (App Router, Turbopack),
TypeScript, Tailwind v4, Drizzle ORM over Supabase Postgres, Inngest for durable jobs, Meta Graph
API pinned to v21 (`lib/meta/types.ts:META_API_VERSION`). **No Anthropic dependency** — the agent and
brief subsystems were removed, so there is no `ANTHROPIC_API_KEY`.

**There is no authentication.** The parent's password + signed-cookie login was removed on
request: no `/login` route, no password, no session cookie, no edge middleware. `getAppSession()`
(`lib/auth/session.ts`) resolves the single org member straight from the database, so every request
is the owner. The signature is unchanged, which is why its ~25 callers needed no edits.

Access control therefore lives **outside** the app. On Vercel, enable Deployment Protection
(Vercel Authentication or Password Protection) — without it, anyone with the URL can pause ads, move
budgets and bulk-launch on both live accounts. `users.password_hash` still exists in the schema and
is simply never read.

## Its own database

This app has its **own Supabase project**, separate from the parent's. `lib/db/schema.ts` is the
parent's schema kept whole — the surviving pages reach through to `decision_journal`,
`agent_actions`, `meta_api_calls`, `factory_runs` and `clone_jobs`, and pruning tables would break
more than it saves. Unused tables just sit empty.

## Layout

```
app/
  (app)/{dashboard,campaigns,copy,rules}/   The four surfaces (no auth gate)
  api/{inngest,meta/oauth,meta/deauthorize,dev}/
components/app-shell/                       Sidebar, Topbar, UserMenu, Logo, nav-items
                                            (no ProjectBar — single project)
lib/
  brand.ts                                  ★ logo geometry + palette
  lite/accounts.ts                          ★ the ad-account allowlist
  db/                                       schema.ts, client.ts, queries/<topic>.ts
  meta/                                     client.ts, sync.ts, actions.ts, posting.ts, get-client.ts
  rules/                                    engine.ts, runner.ts, types.ts (dry-run + manual run only)
  inngest/                                  4 registered functions
  auth/                                     session (no-op resolver), active-project, access
scripts/bootstrap-lite.ts                   One-shot idempotent provisioning
```

## Account scoping

Two layers, on purpose:

1. **Data**: bootstrap provisions one project holding only the two accounts, so every existing
   `projectId`-scoped query is already correct and needed no edits.
2. **Guard**: `lib/lite/accounts.ts` reads `LITE_AD_ACCOUNT_IDS` and is enforced at three
   chokepoints — `connectMeta()` filters Meta's inventory *before* insert (so re-running OAuth can
   never re-widen the app to all ~8 accounts the token can see), `syncProject()` skips
   non-allowlisted rows, and the two clone destinations in `lib/meta/actions.ts` refuse to write
   outside the list.

## Local dev

```bash
npm run dev          # :3000
npm run typecheck
npm run build
npm run bootstrap    # idempotent provisioning
npm run db:push      # apply lib/db/schema.ts to Supabase
```

Health check (read-only, never writes):

```bash
curl "http://localhost:3000/api/dev/setup?token=$DEV_SETUP_TOKEN"
```

Step 9 of that check fails loudly if a rule runner ever gets registered here.

## Branding

The AI Mastermind mark is **vector, defined once** in `lib/brand.ts` — facet paths, gradients and
the accent colour. Two consumers read it:

- `components/app-shell/Logo.tsx` inlines it as JSX (sidebar, 404). No `next/image`, so
  `dangerouslyAllowSVG` stays off and the logo costs no request on first paint.
- `scripts/generate-icons.ts` bakes it into `app/icon.svg`, `apple-icon.png`, `favicon.ico`,
  `public/icon-*` and `public/logo.{svg,png}`.

So **edit `lib/brand.ts`, then re-run the generator** — editing the script alone makes the tab icon
and the in-app logo drift apart:

```bash
node --import tsx scripts/generate-icons.ts
```

`BRAND_ACCENT` is the single source for `theme_color` / `themeColor`; it is read by `app/layout.tsx`,
`app/manifest.ts` and the per-route `.webmanifest` files the generator writes.

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
