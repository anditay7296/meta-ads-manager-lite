"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { verifyPassword } from "@/lib/auth/password";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  signSessionToken,
} from "@/lib/auth/cookie";

export type LoginState = { ok: boolean; message: string };

const GENERIC_FAILURE = "Email or password is incorrect.";

/**
 * Sign in with email + password. Credentials are issued by the workspace
 * owner in Settings → Staff accounts and stored as a scrypt hash on
 * `users.password_hash`. No Supabase Auth call anywhere — entirely
 * Postgres + a signed cookie.
 *
 * Returns the same generic error for "no user", "no password set", and
 * "wrong password" so an attacker can't enumerate accounts.
 */
export async function signInWithPasswordAction(
  _prev: LoginState | null,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");
  const nextRaw = String(formData.get("next") ?? "").trim();

  if (!email || !email.includes("@")) {
    return { ok: false, message: "Enter a valid email address." };
  }
  if (!password) {
    return { ok: false, message: "Enter your password." };
  }

  const [user] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      passwordHash: schema.users.passwordHash,
    })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  if (!user || !user.passwordHash) {
    return { ok: false, message: GENERIC_FAILURE };
  }
  if (!verifyPassword(password, user.passwordHash)) {
    return { ok: false, message: GENERIC_FAILURE };
  }

  // Confirm the user belongs to an org — otherwise getAppSession() would
  // return null right after sign-in and the next request would bounce
  // back to /login, confusing the user.
  const [member] = await db
    .select({ orgId: schema.orgMembers.orgId })
    .from(schema.orgMembers)
    .where(eq(schema.orgMembers.userId, user.id))
    .limit(1);
  if (!member) {
    return {
      ok: false,
      message: "Your account isn't linked to a workspace. Contact the workspace owner.",
    };
  }

  // Mint the cookie. Throws loudly if SESSION_SECRET is missing — that's
  // a deploy misconfiguration we want to surface immediately.
  const token = signSessionToken(user.id);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());

  // Only allow same-origin redirects so a tampered next= can't bounce us
  // off-site. An explicit next= (set by the middleware when a deep link was
  // interrupted) always wins — we only choose the *default* landing page.
  const explicitNext =
    nextRaw.startsWith("/") && !nextRaw.startsWith("//") ? nextRaw : null;

  // Lite has no onboarding tour and no push devices — /dashboard is always
  // the default landing page.
  redirect(explicitNext ?? "/dashboard");
}
