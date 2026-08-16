import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from "@/lib/auth/cookie";

/**
 * Edge middleware that gates the app behind a valid session cookie. No
 * Supabase Auth involvement — the cookie is signed by us
 * (lib/auth/cookie.ts) and verified here on every request.
 *
 * Three short-circuits:
 *   1. AUTH_BYPASS_MODE — let everything through; getAppSession() resolves
 *      via AUTH_BYPASS_EMAIL direct lookup.
 *   2. Public routes — /login, /invite, /data-deletion (linked from the
 *      Meta app settings), /api/inngest, /api/webhooks, /api/capi,
 *      /api/meta/oauth, /api/auth (signout/signin), /api/dev,
 *      /api/cron (Vercel cron; route self-enforces CRON_SECRET).
 *   3. Valid cookie — allow.
 *
 * Otherwise → redirect to /login?next=<pathname>.
 *
 * The filename stays `lib/supabase/middleware.ts` for now to avoid
 * churning the proxy.ts import — nothing Supabase-specific remains inside.
 */
export async function updateSession(request: NextRequest) {
  const response = NextResponse.next({ request });
  const { pathname } = request.nextUrl;

  // Bypass mode — skip auth entirely.
  if (process.env.AUTH_BYPASS_MODE === "true") {
    return response;
  }

  const isAuthRoute =
    pathname.startsWith("/login") || pathname.startsWith("/invite");
  // Public because Meta's app settings link to it (User data deletion
  // instructions URL) and Meta fetches it without credentials.
  const isPublicPage = pathname === "/data-deletion";
  const isPublicApi =
    pathname.startsWith("/api/inngest") ||
    pathname.startsWith("/api/webhooks") ||
    pathname.startsWith("/api/capi") ||
    pathname.startsWith("/api/meta/oauth") ||
    // Meta calls this server-to-server when a user removes the app.
    pathname.startsWith("/api/meta/deauthorize") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/dev") ||
    // Vercel cron invocations carry no session cookie; the route enforces
    // CRON_SECRET itself when set (see app/api/cron/inngest-watchdog).
    pathname.startsWith("/api/cron");

  if (isAuthRoute || isPublicApi || isPublicPage || pathname === "/") {
    return response;
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const verified = verifySessionToken(token);
  if (verified) {
    return response;
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}
