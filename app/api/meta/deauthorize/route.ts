import { NextResponse, type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db, schema } from "@/lib/db/client";
import { eq, sql } from "drizzle-orm";
import { cleanEnv } from "@/lib/meta/oauth";
import { journalAppend } from "@/lib/db/queries/journal";

/**
 * Meta's Deauthorize callback. When a user removes the app (Facebook
 * Settings → Business integrations → Remove), Meta POSTs a signed_request
 * here. We verify the HMAC and logically revoke every connection for that
 * Meta user so the app stops using a token Meta has already invalidated.
 *
 * Configure in the Meta app dashboard: Facebook Login for Business →
 * Settings → Deauthorize callback URL →
 *   https://ai-ads-agent-five.vercel.app/api/meta/deauthorize
 */
export async function POST(request: NextRequest) {
  const secret = cleanEnv(process.env.META_APP_SECRET);
  if (!secret) {
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  let signed = "";
  try {
    const form = await request.formData();
    signed = String(form.get("signed_request") ?? "");
  } catch {
    // fall through to the empty check
  }
  const [sigB64, payloadB64] = signed.split(".", 2);
  if (!sigB64 || !payloadB64) {
    return NextResponse.json({ error: "missing signed_request" }, { status: 400 });
  }

  const expected = createHmac("sha256", secret)
    .update(payloadB64)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sigB64, "base64url");
  } catch {
    return NextResponse.json({ error: "bad signature encoding" }, { status: 403 });
  }
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return NextResponse.json({ error: "bad signature" }, { status: 403 });
  }

  let payload: { user_id?: string; algorithm?: string };
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }
  if (!payload.user_id) {
    return NextResponse.json({ error: "no user_id" }, { status: 400 });
  }

  // Logical revocation (never delete — cached assets stay visible, they just
  // stop syncing). One Meta user may be connected in several orgs.
  const revoked = await db
    .update(schema.metaConnections)
    .set({ revokedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(schema.metaConnections.metaUserId, payload.user_id))
    .returning({
      id: schema.metaConnections.id,
      orgId: schema.metaConnections.orgId,
      metaUserName: schema.metaConnections.metaUserName,
    });

  for (const conn of revoked) {
    try {
      await journalAppend({
        orgId: conn.orgId,
        actorType: "system",
        actorRef: "meta-deauthorize-webhook",
        summary: `Meta connection revoked by ${conn.metaUserName ?? payload.user_id} (removed the app on Facebook)`,
        reasoning: null,
        entityKind: "meta_connection",
        entityId: conn.id,
        before: null,
        after: { revoked: true },
        metadata: { metaUserId: payload.user_id },
      });
    } catch {
      // Journal failure must not make Meta retry the webhook forever.
    }
  }

  return NextResponse.json({ ok: true, revoked: revoked.length });
}
