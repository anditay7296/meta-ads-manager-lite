import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  META_OAUTH_SCOPES,
} from "@/lib/meta/oauth";
import { MetaClient } from "@/lib/meta/client";
import { connectMeta } from "@/lib/db/queries/meta-connections";
import { getAppSession } from "@/lib/auth/session";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error_description");

  if (errorParam) {
    return redirectToSettings(request, { error: errorParam });
  }
  if (!code || !state) {
    return redirectToSettings(request, { error: "Missing code or state" });
  }

  const cookieState = request.cookies.get("meta_oauth_state")?.value;
  if (!cookieState || cookieState !== state) {
    return redirectToSettings(request, { error: "OAuth state mismatch" });
  }

  const session = await getAppSession();
  if (!session) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_OAUTH_REDIRECT_URI;
  if (!appId || !appSecret || !redirectUri) {
    return redirectToSettings(request, {
      error: "Meta App env not configured",
    });
  }

  try {
    const short = await exchangeCodeForToken({
      appId,
      appSecret,
      redirectUri,
      code,
    });
    const long = await exchangeForLongLivedToken({
      appId,
      appSecret,
      shortLivedToken: short.access_token,
    });

    const meta = new MetaClient({ accessToken: long.access_token });
    const me = await meta.me(["id", "name"]);

    const result = await connectMeta({
      orgId: session.orgId,
      connectedBy: session.userId,
      metaUserId: me.id,
      metaUserName: me.name ?? null,
      longLivedToken: long.access_token,
      scopes: [...META_OAUTH_SCOPES],
      expiresInSeconds: long.expires_in,
    });

    const res = redirectToSettings(request, {
      connected: me.name ?? me.id,
      accounts: String(result.adAccountCount),
      pages: String(result.pageCount),
      ig: String(result.igAccountCount),
    });
    res.cookies.delete("meta_oauth_state");
    return res;
  } catch (err) {
    return redirectToSettings(request, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function redirectToSettings(
  request: NextRequest,
  params: Record<string, string>,
): NextResponse {
  const url = new URL("/settings", request.url);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return NextResponse.redirect(url);
}
