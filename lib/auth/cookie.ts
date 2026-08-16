import { createHmac, timingSafeEqual } from "crypto";

/**
 * HMAC-signed session token.
 *
 *   <base64url(JSON.stringify({ u: userId, e: expiryMs }))>.<base64url(HMAC-SHA256)>
 *
 * Verified with timingSafeEqual + expiry check. No external dep; the
 * Node `crypto` builtin does the heavy lifting.
 *
 * SESSION_SECRET MUST be set in env (32+ random bytes). Generate with
 * `openssl rand -base64 32`. Missing secret → signSessionToken throws on
 * first request; we'd rather fail loudly than mint unforgeable cookies.
 */

export const SESSION_COOKIE_NAME = "app_session";
const DEFAULT_TTL_DAYS = 30;

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "SESSION_SECRET env var is missing or too short. Set 32+ random bytes (e.g. `openssl rand -base64 32`).",
    );
  }
  return secret;
}

function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString("base64url");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

type Payload = { u: string; e: number };

export function signSessionToken(
  userId: string,
  ttlDays: number = DEFAULT_TTL_DAYS,
): string {
  const payload: Payload = {
    u: userId,
    e: Date.now() + ttlDays * 86400_000,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(
    createHmac("sha256", getSecret()).update(body).digest(),
  );
  return `${body}.${sig}`;
}

export function verifySessionToken(
  token: string | null | undefined,
): { userId: string } | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 1 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let expected: Buffer;
  let provided: Buffer;
  try {
    expected = createHmac("sha256", getSecret()).update(body).digest();
    provided = fromB64url(sig);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let payload: Payload;
  try {
    payload = JSON.parse(fromB64url(body).toString("utf8")) as Payload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.u !== "string" || typeof payload.e !== "number") {
    return null;
  }
  if (payload.e < Date.now()) return null;
  return { userId: payload.u };
}

export type CookieOptions = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
};

export function sessionCookieOptions(
  ttlDays: number = DEFAULT_TTL_DAYS,
): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ttlDays * 86400,
  };
}

export function clearedCookieOptions(): CookieOptions {
  return {
    ...sessionCookieOptions(),
    maxAge: 0,
  };
}
