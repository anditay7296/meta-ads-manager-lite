import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import {
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from "@/lib/auth/cookie";

export type AppSession = {
  userId: string;
  email: string;
  orgId: string;
};

/**
 * Server-side session lookup. Returns null if not signed in OR not yet
 * bootstrapped into an org. No Supabase Auth calls anywhere — auth lives
 * entirely in our Postgres + a signed cookie.
 *
 * Two paths:
 *   1. AUTH_BYPASS_MODE — resolve via AUTH_BYPASS_EMAIL direct lookup, no cookie required.
 *   2. Normal — read app_session cookie, verify HMAC, look up user + org.
 */
export async function getAppSession(): Promise<AppSession | null> {
  // Bypass mode — resolve the session by AUTH_BYPASS_EMAIL via direct
  // Postgres. Kept as the escape hatch so the owner can stay signed in
  // while transitioning to password auth.
  const bypassEmail = process.env.AUTH_BYPASS_EMAIL?.trim().toLowerCase();
  if (process.env.AUTH_BYPASS_MODE === "true" && bypassEmail) {
    const userRow = await db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.email, bypassEmail))
      .limit(1);
    if (userRow.length === 0) return null;
    const member = await db
      .select({ orgId: schema.orgMembers.orgId })
      .from(schema.orgMembers)
      .where(eq(schema.orgMembers.userId, userRow[0].id))
      .limit(1);
    if (member.length === 0) return null;
    return {
      userId: userRow[0].id,
      email: userRow[0].email,
      orgId: member[0].orgId,
    };
  }

  // Normal path: verify the signed cookie, then resolve to a user row.
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const verified = verifySessionToken(token);
  if (!verified) return null;

  const [user] = await db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, verified.userId))
    .limit(1);
  if (!user) return null;

  const [member] = await db
    .select({ orgId: schema.orgMembers.orgId })
    .from(schema.orgMembers)
    .where(eq(schema.orgMembers.userId, user.id))
    .limit(1);
  if (!member) return null;

  return { userId: user.id, email: user.email, orgId: member.orgId };
}

export async function requireAppSession(): Promise<AppSession> {
  const session = await getAppSession();
  if (!session) throw new Error("Not authenticated");
  return session;
}
