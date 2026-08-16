import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { syncAdsBetweenAdSets } from "@/lib/meta/actions";
import { getMetaClientForAdAccount } from "@/lib/meta/get-client";

/**
 * Dev-only: trigger ad-set sync without going through the UI. Token-gated.
 *
 * GET /api/dev/sync-adsets
 *   ?token=DEV_SETUP_TOKEN
 *   &src=120238511259920077
 *   &dst=120246850466900502
 *   &orgId=...                 // optional; defaults to first org
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== process.env.DEV_SETUP_TOKEN) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }
  const src = url.searchParams.get("src");
  const dst = url.searchParams.get("dst");
  if (!src || !dst) {
    return NextResponse.json({ ok: false, error: "src and dst required" }, { status: 400 });
  }
  let orgId = url.searchParams.get("orgId") ?? "";
  if (!orgId) {
    const [first] = await db.select({ id: schema.orgs.id }).from(schema.orgs).limit(1);
    if (!first) return NextResponse.json({ ok: false, error: "no orgs" }, { status: 500 });
    orgId = first.id;
  }
  // If the source ad set isn't in our DB, the action needs a sourceCampaignId
  // (DB UUID) so it can resolve the source ad account. Look it up via Meta API.
  let sourceCampaignId: string | undefined;
  const [srcAdSetRow] = await db
    .select({ id: schema.adSets.id })
    .from(schema.adSets)
    .where(and(eq(schema.adSets.orgId, orgId), eq(schema.adSets.metaAdSetId, src)))
    .limit(1);
  if (!srcAdSetRow) {
    // Use the destination ad set's owning connection to introspect the
    // source ad set — same Meta App, just a different token. If dst isn't
    // synced either, we have to fail since we can't pick a connection.
    const [dstAdSet] = await db
      .select({ adAccountId: schema.campaigns.adAccountId })
      .from(schema.adSets)
      .innerJoin(
        schema.campaigns,
        eq(schema.campaigns.id, schema.adSets.campaignId),
      )
      .where(and(eq(schema.adSets.orgId, orgId), eq(schema.adSets.metaAdSetId, dst)))
      .limit(1);
    if (!dstAdSet) {
      return NextResponse.json(
        { ok: false, error: "dst not in DB — sync project first" },
        { status: 400 },
      );
    }
    const meta = await getMetaClientForAdAccount(orgId, dstAdSet.adAccountId);
    if (!meta)
      return NextResponse.json(
        { ok: false, error: "no Meta connection for dst ad account" },
        { status: 500 },
      );
    const adSet = await meta.client.request<{ campaign_id: string }>(`/${src}`, {
      query: { fields: "campaign_id" },
      calledBy: "dev:sync-adsets",
    });
    const [srcCampaign] = await db
      .select({ id: schema.campaigns.id })
      .from(schema.campaigns)
      .where(
        and(
          eq(schema.campaigns.orgId, orgId),
          eq(schema.campaigns.metaCampaignId, adSet.campaign_id),
        ),
      )
      .limit(1);
    if (!srcCampaign) {
      return NextResponse.json(
        { ok: false, error: `source campaign ${adSet.campaign_id} not in DB — sync project first` },
        { status: 400 },
      );
    }
    sourceCampaignId = srcCampaign.id;
  }

  const result = await syncAdsBetweenAdSets({
    orgId,
    sourceAdSetMetaId: src,
    destAdSetMetaId: dst,
    sourceCampaignId,
    actor: { type: "system" },
  });
  return NextResponse.json({ ok: result.failed === 0, ...result });
}
