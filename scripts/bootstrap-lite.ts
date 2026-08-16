/**
 * One-shot provisioning for Meta Ads Manager Lite. Idempotent — safe to
 * re-run; every step skips work that already exists.
 *
 * Creates: org → user (password login) → project → Meta connection →
 * exactly the two allowlisted ad accounts → storage bucket → first sync.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx scripts/bootstrap-lite.ts --password 'your-password'
 *
 * The Meta token comes from one of two places, checked in order:
 *   1. META_LONG_LIVED_TOKEN in the env — paste a token directly.
 *   2. PARENT_DATABASE_URL + PARENT_APP_ENCRYPTION_KEY — copies the token out
 *      of the parent AI Ads Agent database, decrypting with the parent's key
 *      and re-encrypting with this app's APP_ENCRYPTION_KEY. Nothing in the
 *      parent database is modified.
 *
 * Option 2 avoids re-running Meta OAuth, which would need this app's callback
 * URL whitelisted in the Meta app settings first.
 */
import { randomUUID } from "crypto";
import postgres from "postgres";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db, schema } from "../lib/db/client";
import { connectMeta } from "../lib/db/queries/meta-connections";
import { createProject, assignAdAccountsByMetaIds } from "../lib/db/queries/projects";
import { hashPassword } from "../lib/auth/password";
import { decryptToken } from "../lib/crypto/tokens";
import { LITE_AD_ACCOUNT_IDS } from "../lib/lite/accounts";
import { syncProject } from "../lib/meta/sync";
import { ensurePostAssetsBucket } from "../lib/storage";

const ORG_NAME = "Meta Ads Manager Lite";
const PROJECT_NAME = "AI Agency";
const OWNER_EMAIL = (process.env.LITE_OWNER_EMAIL ?? "andi@funnelduo.com")
  .trim()
  .toLowerCase();

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function log(step: string, msg: string) {
  console.log(`[${step}] ${msg}`);
}

/**
 * Pull the long-lived Meta token. Prefers an explicitly supplied token;
 * otherwise reads and decrypts the parent app's stored connection.
 */
async function resolveMetaToken(): Promise<{
  token: string;
  metaUserId: string;
  metaUserName: string | null;
  scopes: string[];
  expiresAt: Date | null;
} | null> {
  const direct = process.env.META_LONG_LIVED_TOKEN?.trim();
  if (direct) {
    return {
      token: direct,
      metaUserId: process.env.META_USER_ID?.trim() || "me",
      metaUserName: null,
      scopes: ["ads_management", "ads_read", "business_management"],
      expiresAt: null,
    };
  }

  const parentUrl = process.env.PARENT_DATABASE_URL?.trim();
  const parentKey = process.env.PARENT_APP_ENCRYPTION_KEY?.trim();
  if (!parentUrl || !parentKey) return null;

  const parentSql = postgres(parentUrl, { prepare: false });
  try {
    const rows = await parentSql<
      Array<{
        meta_user_id: string;
        meta_user_name: string | null;
        token_encrypted: Buffer;
        token_scopes: string[] | null;
        token_expires_at: Date | null;
      }>
    >`select meta_user_id, meta_user_name, token_encrypted, token_scopes, token_expires_at
      from meta_connections
      where revoked_at is null
      order by updated_at desc
      limit 1`;
    if (rows.length === 0) return null;
    const row = rows[0];

    // Decrypt with the PARENT key, not ours. Swap the env var for the length
    // of this call so the shared decryptToken() helper reads the right key.
    const ourKey = process.env.APP_ENCRYPTION_KEY;
    process.env.APP_ENCRYPTION_KEY = parentKey;
    let token: string;
    try {
      token = decryptToken(row.token_encrypted);
    } finally {
      process.env.APP_ENCRYPTION_KEY = ourKey;
    }

    return {
      token,
      metaUserId: row.meta_user_id,
      metaUserName: row.meta_user_name,
      scopes: row.token_scopes ?? ["ads_management", "ads_read"],
      expiresAt: row.token_expires_at,
    };
  } finally {
    await parentSql.end();
  }
}

async function main() {
  const password = arg("--password") ?? process.env.LITE_OWNER_PASSWORD ?? null;

  // ─── 1. Org ─────────────────────────────────────────────────────────────
  let [org] = await db
    .select({ id: schema.orgs.id })
    .from(schema.orgs)
    .where(eq(schema.orgs.slug, "meta-ads-manager-lite"))
    .limit(1);
  if (!org) {
    [org] = await db
      .insert(schema.orgs)
      .values({
        name: ORG_NAME,
        slug: "meta-ads-manager-lite",
        currency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
      })
      .returning({ id: schema.orgs.id });
    log("org", `created ${ORG_NAME}`);
  } else {
    log("org", "already exists");
  }

  await db
    .insert(schema.orgSettings)
    .values({ orgId: org.id })
    .onConflictDoNothing();

  // ─── 2. Owner user + membership ─────────────────────────────────────────
  let [user] = await db
    .select({ id: schema.users.id, passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.email, OWNER_EMAIL))
    .limit(1);

  if (!user) {
    if (!password) {
      throw new Error(
        `No user yet for ${OWNER_EMAIL} — pass --password '<password>' so sign-in works.`,
      );
    }
    [user] = await db
      .insert(schema.users)
      .values({
        id: randomUUID(),
        email: OWNER_EMAIL,
        passwordHash: hashPassword(password),
      })
      .returning({ id: schema.users.id, passwordHash: schema.users.passwordHash });
    log("user", `created ${OWNER_EMAIL}`);
  } else if (password) {
    await db
      .update(schema.users)
      .set({ passwordHash: hashPassword(password) })
      .where(eq(schema.users.id, user.id));
    log("user", `password reset for ${OWNER_EMAIL}`);
  } else {
    log("user", `${OWNER_EMAIL} already exists (password unchanged)`);
  }

  await db
    .insert(schema.orgMembers)
    .values({ orgId: org.id, userId: user.id, role: "owner" })
    .onConflictDoNothing();

  // ─── 3. Project ─────────────────────────────────────────────────────────
  let [project] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.orgId, org.id), eq(schema.projects.name, PROJECT_NAME)))
    .limit(1);
  if (!project) {
    const created = await createProject({
      orgId: org.id,
      name: PROJECT_NAME,
      description: "The two ad accounts this Lite app manages.",
      createdBy: user.id,
    });
    project = { id: created.id };
    log("project", `created ${PROJECT_NAME}`);
  } else {
    log("project", "already exists");
  }

  await db
    .insert(schema.projectMembers)
    .values({ projectId: project.id, userId: user.id, role: "admin" })
    .onConflictDoNothing();

  // ─── 4. Meta connection ─────────────────────────────────────────────────
  const [existingConn] = await db
    .select({ id: schema.metaConnections.id })
    .from(schema.metaConnections)
    .where(
      and(eq(schema.metaConnections.orgId, org.id), isNull(schema.metaConnections.revokedAt)),
    )
    .limit(1);

  if (existingConn) {
    log("meta", "connection already present — skipping token import");
  } else {
    const resolved = await resolveMetaToken();
    if (!resolved) {
      throw new Error(
        "No Meta token available. Set META_LONG_LIVED_TOKEN, or set " +
          "PARENT_DATABASE_URL + PARENT_APP_ENCRYPTION_KEY to copy the parent app's token.",
      );
    }
    const expiresInSeconds = resolved.expiresAt
      ? Math.max(0, Math.floor((resolved.expiresAt.getTime() - Date.now()) / 1000))
      : undefined;
    const result = await connectMeta({
      orgId: org.id,
      connectedBy: user.id,
      metaUserId: resolved.metaUserId,
      metaUserName: resolved.metaUserName ?? undefined,
      longLivedToken: resolved.token,
      scopes: resolved.scopes,
      expiresInSeconds,
    });
    log(
      "meta",
      `connected — Meta returned ${result.adAccountCount} ad accounts, ${result.pageCount} pages`,
    );
  }

  // ─── 5. Narrow to the allowlist ─────────────────────────────────────────
  // connectMeta pulls EVERY ad account the token can see. Lite manages two.
  const removed = await db
    .delete(schema.adAccounts)
    .where(
      and(
        eq(schema.adAccounts.orgId, org.id),
        notInArray(schema.adAccounts.metaAccountId, LITE_AD_ACCOUNT_IDS),
      ),
    )
    .returning({ metaAccountId: schema.adAccounts.metaAccountId });
  if (removed.length > 0) {
    log("accounts", `removed ${removed.length} account(s) outside the Lite allowlist`);
  }

  const assigned = await assignAdAccountsByMetaIds({
    orgId: org.id,
    metaAccountIds: LITE_AD_ACCOUNT_IDS,
    projectId: project.id,
  });
  const missing = LITE_AD_ACCOUNT_IDS.filter(
    (id) => !assigned.some((a) => a.metaAccountId === id),
  );
  if (missing.length > 0) {
    throw new Error(
      `These allowlisted accounts were not returned by Meta for this token: ${missing.join(", ")}. ` +
        `Check the token has access to them.`,
    );
  }
  log("accounts", `attached ${assigned.map((a) => a.metaAccountId).join(", ")}`);

  // ─── 6. Storage bucket (Factory uploads) ────────────────────────────────
  try {
    await ensurePostAssetsBucket();
    log("storage", "post-assets bucket ready");
  } catch (err) {
    log(
      "storage",
      `skipped — ${err instanceof Error ? err.message : String(err)} (Factory uploads will fail until this works)`,
    );
  }

  // ─── 7. First sync + insights backfill ──────────────────────────────────
  log("sync", "pulling campaigns / ad sets / ads (last_30d insights)…");
  const synced = await syncProject({
    orgId: org.id,
    projectId: project.id,
    datePreset: "last_30d",
  });
  log(
    "sync",
    `campaigns ${synced.campaigns}, ad sets ${synced.adSets}, ads ${synced.ads}, ` +
      `insight rows ${synced.insightsRows}, creatives ${synced.creatives}`,
  );

  const [counts] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.adAccounts)
    .where(eq(schema.adAccounts.orgId, org.id));

  console.log("\n✅ Bootstrap complete.");
  console.log(`   org        ${ORG_NAME}`);
  console.log(`   project    ${PROJECT_NAME}`);
  console.log(`   accounts   ${counts.n} (expected ${LITE_AD_ACCOUNT_IDS.length})`);
  console.log(`   sign in    ${OWNER_EMAIL}`);
  console.log("\n   Next: npm run dev, then open http://localhost:3000/dashboard");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ Bootstrap failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
