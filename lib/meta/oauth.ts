import { META_API_VERSION } from "./types";

export const META_OAUTH_SCOPES = [
  "ads_management",
  "ads_read",
  "business_management",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "pages_manage_metadata",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights",
  "read_insights",
] as const;

/**
 * Defensively normalize an env-provided value (app ID, redirect URI): trim
 * whitespace and strip a single pair of wrapping quotes — the most common
 * dashboard paste mistake (e.g. pasting `"3933…"` into Vercel stores the
 * literal quotes). Returns undefined for missing/empty so callers can guard.
 */
export function cleanEnv(value: string | undefined | null): string | undefined {
  if (value == null) return undefined;
  let v = value.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'")))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v.length > 0 ? v : undefined;
}

/**
 * Facebook app IDs are purely numeric (today's are 15–16 digits; 8–20 is a
 * safe permissive range that still rejects placeholders, quoted values, and
 * other garbage that makes Facebook return "Invalid App ID").
 */
export function isValidMetaAppId(appId: string): boolean {
  return /^\d{8,20}$/.test(appId);
}

export function buildAuthorizeUrl(opts: {
  appId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
  /**
   * Facebook Login for Business configuration ID. Apps that only have the
   * "Facebook Login for Business" product reject plain scope-based dialog
   * requests ("Feature unavailable"); they require config_id, and the
   * configuration itself defines the granted permissions — so when set,
   * scope is omitted.
   */
  configId?: string;
}): string {
  const url = new URL(`https://www.facebook.com/${META_API_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", opts.appId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("response_type", "code");
  if (opts.configId) {
    url.searchParams.set("config_id", opts.configId);
  } else {
    url.searchParams.set(
      "scope",
      (opts.scopes ?? META_OAUTH_SCOPES).join(","),
    );
  }
  return url.toString();
}

export type ShortLivedTokenResponse = {
  access_token: string;
  token_type: "bearer";
  expires_in?: number;
};

export async function exchangeCodeForToken(opts: {
  appId: string;
  appSecret: string;
  redirectUri: string;
  code: string;
}): Promise<ShortLivedTokenResponse> {
  const url = new URL(
    `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token`,
  );
  url.searchParams.set("client_id", opts.appId);
  url.searchParams.set("client_secret", opts.appSecret);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("code", opts.code);
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }
  return (await res.json()) as ShortLivedTokenResponse;
}

export type LongLivedTokenResponse = ShortLivedTokenResponse;

export async function exchangeForLongLivedToken(opts: {
  appId: string;
  appSecret: string;
  shortLivedToken: string;
}): Promise<LongLivedTokenResponse> {
  const url = new URL(
    `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token`,
  );
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", opts.appId);
  url.searchParams.set("client_secret", opts.appSecret);
  url.searchParams.set("fb_exchange_token", opts.shortLivedToken);
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Long-lived exchange failed (${res.status}): ${body}`);
  }
  return (await res.json()) as LongLivedTokenResponse;
}
