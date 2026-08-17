import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { buildAuthorizeUrl, cleanEnv, isValidMetaAppId } from "@/lib/meta/oauth";
import { getAppSession } from "@/lib/auth/session";

/** Bounce back to /campaigns with a human-readable banner (page renders ?error=). */
function settingsError(request: NextRequest, message: string) {
  // Lite has no /settings page — /campaigns is the surface that owns Meta sync.
  const dest = new URL("/campaigns", request.url);
  dest.searchParams.set("error", message);
  return NextResponse.redirect(dest);
}

export async function GET(request: NextRequest) {
  const session = await getAppSession();
  if (!session) {
    // No sign-in exists to bounce to (see lib/auth/session.ts) — a null session
    // means the workspace was never provisioned, so say that instead of 404ing.
    return settingsError(
      request,
      "No workspace found — run `npm run bootstrap` to provision it.",
    );
  }

  // Normalize defensively (trim + strip wrapping quotes), then validate the
  // shape BEFORE redirecting to Facebook. A present-but-malformed META_APP_ID
  // used to sail through the old truthy check and make Facebook return
  // "Invalid App ID"; now it fails loudly in-app with a fixable message.
  const appId = cleanEnv(process.env.META_APP_ID);
  const redirectUri = cleanEnv(process.env.META_OAUTH_REDIRECT_URI);
  if (!appId || !redirectUri) {
    return settingsError(
      request,
      "Meta OAuth isn't configured — set META_APP_ID and META_OAUTH_REDIRECT_URI in the environment (Vercel).",
    );
  }
  if (!isValidMetaAppId(appId)) {
    return settingsError(
      request,
      "META_APP_ID is misconfigured — it must be the numeric Facebook App ID with no quotes or spaces. Fix it in the environment (Vercel) and redeploy.",
    );
  }
  if (!/^https?:\/\//i.test(redirectUri)) {
    return settingsError(
      request,
      "META_OAUTH_REDIRECT_URI must be an absolute http(s) URL ending in /api/meta/oauth/callback. Fix it in the environment (Vercel).",
    );
  }

  // Facebook Login for Business configuration. Required for apps whose only
  // login product is "Facebook Login for Business" — without it the dialog
  // shows "Feature unavailable". Numeric like the app ID.
  //
  // Two configurations, because Meta gates them differently:
  //  - operator (META_LOGIN_CONFIG_ID): full ads + pages + IG. Heavy scopes
  //    (ads_management, business_management) that realistically stay on
  //    Standard Access — fine, the operator holds a role on the Meta app.
  //  - staff (META_LOGIN_CONFIG_ID_STAFF, ?intent=pages): pages + IG only.
  //    The light set we put through App Review so ANY staff member can grant
  //    the page they admin without being added to the Meta app's roster.
  // Falls back to the operator config when the staff one isn't set yet, so
  // this is inert until the configuration exists in the Meta dashboard.
  const intent = request.nextUrl.searchParams.get("intent");
  const staffConfigId = cleanEnv(process.env.META_LOGIN_CONFIG_ID_STAFF);
  const operatorConfigId = cleanEnv(process.env.META_LOGIN_CONFIG_ID);
  const configId =
    intent === "pages" ? (staffConfigId ?? operatorConfigId) : operatorConfigId;
  if (configId && !isValidMetaAppId(configId)) {
    return settingsError(
      request,
      `${intent === "pages" && staffConfigId ? "META_LOGIN_CONFIG_ID_STAFF" : "META_LOGIN_CONFIG_ID"} is misconfigured — it must be the numeric Facebook Login for Business configuration ID, no quotes or spaces.`,
    );
  }

  const state = randomBytes(24).toString("hex");
  const authUrl = buildAuthorizeUrl({ appId, redirectUri, state, configId });

  const res = NextResponse.redirect(authUrl);
  res.cookies.set("meta_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10, // 10 minutes
  });
  return res;
}
