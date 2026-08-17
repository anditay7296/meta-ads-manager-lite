import { NextResponse, type NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { encryptToken, decryptToken } from "@/lib/crypto/tokens";
import { MetaClient } from "@/lib/meta/client";
import { cleanEnv, isValidMetaAppId } from "@/lib/meta/oauth";
import { LITE_AD_ACCOUNT_IDS, getLiteAdAccountUuids } from "@/lib/lite/accounts";

/**
 * Token-gated health check for Meta Ads Manager Lite.
 *
 *   GET /api/dev/setup?token=$DEV_SETUP_TOKEN
 *
 * Read-only — it never writes. Provisioning lives in
 * `scripts/bootstrap-lite.ts`, which is the one place that creates the org,
 * user, project, Meta connection and ad accounts.
 *
 * Each step is wrapped so a partial failure still returns useful info.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const expected = process.env.DEV_SETUP_TOKEN;
  if (!expected || url.searchParams.get("token") !== expected) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  const out: Record<string, Step> = {};
  const t0 = Date.now();

  // ─── 1. Env presence ────────────────────────────────────────────────────
  out.env = step(() => {
    const required = [
      "DATABASE_URL",
      "DATABASE_URL_DIRECT",
      "NEXT_PUBLIC_SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "APP_ENCRYPTION_KEY",
      "META_APP_ID",
      "META_APP_SECRET",
    ];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) throw new Error("missing: " + missing.join(", "));
    const optional = ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"];
    return { present: required.length, missingOptional: optional.filter((k) => !process.env[k]) };
  });

  // ─── 2. Meta app config ─────────────────────────────────────────────────
  out.metaOauthConfig = step(() => {
    const appId = cleanEnv(process.env.META_APP_ID);
    if (!appId || !isValidMetaAppId(appId)) {
      throw new Error("META_APP_ID missing or not a numeric app id");
    }
    return { appId };
  });

  // ─── 3. Token encryption round-trip ─────────────────────────────────────
  out.crypto = step(() => {
    const probe = "lite-crypto-probe";
    if (decryptToken(encryptToken(probe)) !== probe) {
      throw new Error("encrypt/decrypt round-trip mismatch");
    }
    return { alg: "aes-256-gcm" };
  });

  // ─── 4. Database reachable ──────────────────────────────────────────────
  out.database = await stepAsync(async () => {
    const [row] = await db.execute<{ now: string }>(sql`select now()::text as now`);
    return { now: row?.now ?? null };
  });

  // ─── 5. Workspace bootstrapped ──────────────────────────────────────────
  out.workspace = await stepAsync(async () => {
    const [org] = await db.select({ id: schema.orgs.id, name: schema.orgs.name }).from(schema.orgs).limit(1);
    if (!org) throw new Error("no org — run scripts/bootstrap-lite.ts");
    const users = await db
      .select({ email: schema.users.email })
      .from(schema.users)
      .innerJoin(schema.orgMembers, eq(schema.orgMembers.userId, schema.users.id))
      .where(eq(schema.orgMembers.orgId, org.id));
    const projects = await db
      .select({ id: schema.projects.id, name: schema.projects.name })
      .from(schema.projects)
      .where(eq(schema.projects.orgId, org.id));
    return { org: org.name, users: users.map((u) => u.email), projects: projects.map((p) => p.name) };
  });

  // ─── 6. Ad accounts — must be exactly the Lite allowlist ────────────────
  out.adAccounts = await stepAsync(async () => {
    const rows = await db
      .select({
        orgId: schema.adAccounts.orgId,
        metaAccountId: schema.adAccounts.metaAccountId,
        name: schema.adAccounts.name,
      })
      .from(schema.adAccounts);
    const found = rows.map((r) => r.metaAccountId).sort();
    const want = [...LITE_AD_ACCOUNT_IDS].sort();
    const extra = found.filter((id) => !want.includes(id));
    const missing = want.filter((id) => !found.includes(id));
    if (extra.length > 0) {
      throw new Error(`accounts outside the Lite allowlist are present: ${extra.join(", ")}`);
    }
    if (missing.length > 0) {
      throw new Error(`allowlisted accounts not provisioned: ${missing.join(", ")}`);
    }
    const uuids = rows[0] ? await getLiteAdAccountUuids(rows[0].orgId) : [];
    return {
      accounts: rows.map((r) => `${r.metaAccountId} (${r.name})`),
      resolvedUuids: uuids.length,
    };
  });

  // ─── 7. Meta connection + live token ────────────────────────────────────
  out.metaConnection = await stepAsync(async () => {
    const [conn] = await db
      .select({
        id: schema.metaConnections.id,
        orgId: schema.metaConnections.orgId,
        tokenEncrypted: schema.metaConnections.tokenEncrypted,
        expiresAt: schema.metaConnections.tokenExpiresAt,
      })
      .from(schema.metaConnections)
      .where(sql`${schema.metaConnections.revokedAt} is null`)
      .limit(1);
    if (!conn) throw new Error("no Meta connection — run scripts/bootstrap-lite.ts");
    const client = new MetaClient({
      accessToken: decryptToken(conn.tokenEncrypted),
      orgId: conn.orgId,
    });
    const me = await client.request<{ id: string; name?: string }>("/me", {
      query: { fields: "id,name" },
    });
    return { metaUser: me.name ?? me.id, tokenExpiresAt: conn.expiresAt };
  });

  // ─── 8. Synced inventory + insights freshness ───────────────────────────
  out.inventory = await stepAsync(async () => {
    const [counts] = await db
      .select({
        campaigns: sql<number>`(select count(*) from campaigns)`,
        adSets: sql<number>`(select count(*) from ad_sets)`,
        ads: sql<number>`(select count(*) from ads)`,
        insights: sql<number>`(select count(*) from insights_daily)`,
        latestInsight: sql<string | null>`(select max(date)::text from insights_daily)`,
      })
      .from(sql`(select 1) as _`);
    if (Number(counts.campaigns) === 0) {
      throw new Error("no campaigns synced — run scripts/bootstrap-lite.ts or hit Refresh from Meta");
    }
    return counts;
  });

  // ─── 9. Rule runners must NOT be scheduled here ─────────────────────────
  out.rulesNotScheduled = await stepAsync(async () => {
    const { functions } = await import("@/lib/inngest/functions");
    const { inngest } = await import("@/lib/inngest/client");
    const ids = functions.map((f) => (f as { id: (prefix?: string) => string }).id());
    const forbidden = ids.filter((id) => id.includes("rules-"));
    if (forbidden.length > 0) {
      throw new Error(
        `rule runners registered in Lite (${forbidden.join(", ")}) — the parent app already ` +
          `runs these against both accounts; two schedulers would double-pause the same ads`,
      );
    }
    // A shared app id means whichever app syncs last owns the registration —
    // if Lite won that race, the parent's rule runners would be archived and
    // silently stop firing.
    if (inngest.id === "ai-ads-agent") {
      throw new Error(
        "Inngest app id collides with the parent app — set a distinct id in lib/inngest/client.ts",
      );
    }
    return { registered: ids, inngestAppId: inngest.id };
  });

  // ─── 10. Rules present (managed here, executed by the parent app) ───────
  out.rules = await stepAsync(async () => {
    const rows = await db
      .select({ name: schema.automatedRules.name, enabled: schema.automatedRules.enabled })
      .from(schema.automatedRules);
    return {
      count: rows.length,
      note: "execution lives in the parent app (ai-ads-agent); /rules here is manage + dry-run",
    };
  });

  const failed = Object.entries(out).filter(([, v]) => "ok" in v && v.ok === false);

  return NextResponse.json({
    ok: failed.length === 0,
    ms: Date.now() - t0,
    failed: failed.map(([k]) => k),
    steps: out,
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

type Step =
  | { ok: true; [k: string]: unknown }
  | { ok: false; error: string }
  | { status: "skip"; reason: string };

function step(fn: () => Step | object): Step {
  try {
    const r = fn();
    if ("ok" in r || "status" in r) return r as Step;
    return { ok: true, ...(r as object) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function stepAsync(fn: () => Promise<Step | object>): Promise<Step> {
  try {
    const r = await fn();
    if ("ok" in r || "status" in r) return r as Step;
    return { ok: true, ...(r as object) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
