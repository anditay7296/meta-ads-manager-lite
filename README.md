# Meta Ads Manager Lite

A cut-down clone of [AI Ads Agent](https://github.com/anditay7296/ai-ads-agent), scoped to two Meta
ad accounts and four pages.

**Accounts:** `act_1690421202260749` (AI Agency 02) · `act_1386521543403841` (AI Agency 05)

**Pages:** Dashboard · Campaigns · Copywriting · Automated Rules

Same stack as the parent, so the UI is identical: Next.js 16 (App Router) + TypeScript + Tailwind v4,
Drizzle over Supabase Postgres, Inngest for durable jobs, Meta Graph API v21. Password auth with an
HMAC-signed cookie — no Supabase Auth, no Anthropic dependency.

---

## ⚠️ Rules are managed here, not executed here

This app registers **no rule-running cron**. Both ad accounts are already policed by the parent app's
schedulers (00:00 KL daily + every 5 minutes). Two schedulers evaluating the same ads would
double-pause them.

`/rules` lets you draft, edit and **dry-run** rules — dry run makes no Meta write calls. To make a
rule live, mirror it into the parent app. The parent's live "Run now" button is deliberately absent
here, and the server action hard-codes `dryRun: true`, so nothing on this page can pause a real ad.

The four Inngest functions that *are* registered: daily insights sync (01:00 KL), on-demand insights
sync, the bulk-launch Factory, and cross-account clone jobs.

⚠️ **Inngest must be a separate app and a separate environment from the parent.** The two share
event names, and a shared app id would make the last deploy to sync archive the other's functions —
including the parent's rule runners.

---

## Setup

### 1. Supabase

Create a **new** Supabase project (this app must not share the parent's database), then:

```bash
cp .env.example .env.local
```

Fill in `DATABASE_URL` (pooled, port 6543), `DATABASE_URL_DIRECT` (port 5432),
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

Generate the app secrets — fresh values, not the parent's:

```bash
node -e "const c=require('crypto');console.log('SESSION_SECRET='+c.randomBytes(32).toString('hex'));console.log('APP_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64'));console.log('DEV_SETUP_TOKEN='+c.randomBytes(16).toString('hex'))"
```

### 2. Schema

```bash
npm install
npm run db:push
```

### 3. Provision

The bootstrap script creates the org, your login, the project, the Meta connection, and attaches
exactly the two allowlisted ad accounts, then runs the first sync. It is idempotent.

The Meta token comes from either:

- `META_LONG_LIVED_TOKEN` in `.env.local`, or
- `PARENT_DATABASE_URL` + `PARENT_APP_ENCRYPTION_KEY` — copies the token out of the parent app's
  database (read-only) and re-encrypts it with this app's key. This avoids re-running Meta OAuth,
  which would require whitelisting this app's callback URL in the Meta app settings first.

```bash
npm run bootstrap -- --password 'your-login-password'
```

### 4. Run

```bash
npm run dev
```

Sign in at http://localhost:3000/login.

---

## Commands

| Command | What |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:push` | Apply `lib/db/schema.ts` to Supabase |
| `npm run db:studio` | Drizzle Studio |
| `npm run bootstrap` | Idempotent provisioning (see above) |

Health check — read-only, verifies env, crypto, DB, the account allowlist, the Meta token, synced
inventory, and that **no rule runner is registered**:

```bash
curl "http://localhost:3000/api/dev/setup?token=$DEV_SETUP_TOKEN"
```

---

## Deploying to Vercel

Import the repo, then set every variable from `.env.example` in the Vercel project. Notes:

- `NEXT_PUBLIC_APP_URL` and `META_OAUTH_REDIRECT_URI` must point at the deployed domain.
- Set `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` and drop `INNGEST_DEV`; the Inngest app syncs from
  `/api/inngest`. Take these from a **separate Inngest app and environment** from the parent — see
  the warning above.
- Factory creative uploads need `SUPABASE_SERVICE_ROLE_KEY` and the `post-assets` storage bucket,
  which the bootstrap script creates.

## Scope

Kept: the four pages above, including the Campaigns sub-tabs, Factory bulk-launch and clone jobs.

Removed from the parent: AI Agent, Morning Briefs, Content, Creatives, Decision Journal UI, Andigram,
Manual, Integrations, Settings, Telegram / WhatsApp / email delivery, CAPI ingest, web push, and the
26 Inngest jobs backing them.
