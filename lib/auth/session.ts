import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

export type AppSession = {
  userId: string;
  email: string;
  orgId: string;
};

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THIS APP HAS NO SIGN-IN. Every request is the owner.
 * ─────────────────────────────────────────────────────────────────────────
 * The parent app authenticates with a scrypt password hash and an HMAC-signed
 * cookie. Lite deliberately ships none of that — no /login route, no password,
 * no session cookie, no middleware gate. Anyone who can reach the URL is
 * treated as the owner.
 *
 * Lite is single-tenant by construction: bootstrap creates exactly one org
 * with one member, so "the session" is just that row. `LITE_OWNER_EMAIL`
 * picks the user when more than one exists; otherwise the first (and only)
 * org member wins.
 *
 * ⚠️ Access control therefore lives entirely OUTSIDE this app. On Vercel,
 * turn on Deployment Protection (Vercel Authentication or Password
 * Protection) — without it, anyone with the deployment URL can pause ads,
 * move budgets and bulk-launch on both live Meta accounts.
 *
 * The signature is unchanged from the parent so the ~25 callers of
 * getAppSession() / requireAppSession() needed no edits.
 */
export async function getAppSession(): Promise<AppSession | null> {
  const preferredEmail = process.env.LITE_OWNER_EMAIL?.trim().toLowerCase();

  const rows = await db
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      orgId: schema.orgMembers.orgId,
    })
    .from(schema.orgMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.orgMembers.userId))
    .orderBy(schema.users.createdAt);

  if (rows.length === 0) return null;

  const chosen = preferredEmail
    ? (rows.find((r) => r.email.toLowerCase() === preferredEmail) ?? rows[0])
    : rows[0];

  return { userId: chosen.userId, email: chosen.email, orgId: chosen.orgId };
}

export async function requireAppSession(): Promise<AppSession> {
  const session = await getAppSession();
  if (!session) {
    throw new Error(
      "No workspace found — run scripts/bootstrap-lite.ts to provision the org.",
    );
  }
  return session;
}
