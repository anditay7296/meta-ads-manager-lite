import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE_NAME,
  clearedCookieOptions,
} from "@/lib/auth/cookie";

/**
 * Sign out by clearing the app_session cookie. No Supabase Auth call —
 * the cookie is the only piece of session state we keep.
 */
export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/login", request.url), {
    status: 303,
  });
  response.cookies.set(SESSION_COOKIE_NAME, "", clearedCookieOptions());
  return response;
}
