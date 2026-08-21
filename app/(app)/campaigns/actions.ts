"use server";

import { revalidatePath } from "next/cache";
import { requireAppSession } from "@/lib/auth/session";
import { resolveActiveProject } from "@/lib/auth/active-project";
import { syncProject } from "@/lib/meta/sync";
import type { DashboardRange } from "@/lib/db/queries/dashboard";
import {
  setAdStatusAction,
  setAdSetStatusAction,
  setCampaignStatusAction,
  bulkSetAdStatusAction,
  bulkSetAdSetStatusAction,
  bulkSetCampaignStatusAction,
  setCampaignBudgetAction,
  setAdSetBudgetAction,
  syncAdsBetweenAdSets,
  cloneAdSetToCampaign,
  cloneAdSetToNewCampaignInAccount,
  createMatchingCampaignInAccount,
  fallbackPrepCloneAdSet,
  copyOneAdToAdSet,
  type SyncAdsResult,
  type CloneAdSetResult,
  type FallbackPrepResult,
  type CopyOneAdResult,
} from "@/lib/meta/actions";
import {
  listAdSetsForCampaign,
  countAdsInAdSet,
  type AdSetRow,
} from "@/lib/db/queries/manager";
import { db, schema } from "@/lib/db/client";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getMetaClientForAdAccount } from "@/lib/meta/get-client";
import { journalAppend } from "@/lib/db/queries/journal";
import { inngest } from "@/lib/inngest/client";

export type RefreshState = { ok: boolean; message: string };

export async function refreshFromMetaAction(
  _prev: RefreshState | null,
  formData: FormData,
): Promise<RefreshState> {
  const range = String(formData.get("range") ?? "yesterday") as DashboardRange;
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in." };
  }
  const active = await resolveActiveProject({
    orgId: session.orgId,
    userId: session.userId,
  });
  if (!active) {
    return { ok: false, message: "No active project — run scripts/bootstrap-lite.ts." };
  }
  const datePreset =
    range === "today" || range === "yesterday" || range === "last_30d"
      ? range
      : "last_7d";
  try {
    const result = await syncProject({
      orgId: session.orgId,
      projectId: active.id,
      datePreset,
    });
    revalidatePath("/campaigns");
    revalidatePath("/campaigns/adsets");
    revalidatePath("/campaigns/ads");
    revalidatePath("/dashboard");
    return {
      ok: true,
      message: `Synced: ${result.campaigns} campaigns, ${result.adSets} ad sets, ${result.ads} ads, ${result.insightsRows} insight rows.`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getAdSetsForCampaignAction(
  campaignId: string,
): Promise<{ ok: boolean; adSets?: AdSetRow[]; message?: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in" };
  }

  // Always go to Meta first (paginated + filtered to all non-deleted statuses)
  // for the sync dialog — DB cache may be incomplete when an account has many
  // ad sets, since the periodic sync caps at 200 entries per page. Falls back
  // to DB only if Meta is unavailable.
  const [campaignRow] = await db
    .select({
      metaCampaignId: schema.campaigns.metaCampaignId,
      adAccountId: schema.campaigns.adAccountId,
    })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.orgId, session.orgId), eq(schema.campaigns.id, campaignId)))
    .limit(1);

  const meta = campaignRow
    ? await getMetaClientForAdAccount(session.orgId, campaignRow.adAccountId)
    : null;
  if (campaignRow && meta) {
    try {
      const res = await meta.client.listAdSetsForCampaign(campaignRow.metaCampaignId);
      const adSetsFromMeta: AdSetRow[] = res.data.map((s) => ({
        id: s.id,
        metaAdSetId: s.id,
        name: s.name,
        status: s.status,
        effectiveStatus: s.effective_status ?? null,
      }));
      if (adSetsFromMeta.length > 0) return { ok: true, adSets: adSetsFromMeta };
    } catch {
      // Fall through to DB cache.
    }
  }

  // DB cache fallback.
  const adSets = await listAdSetsForCampaign({ orgId: session.orgId, campaignId });
  return { ok: true, adSets };
}

export async function previewSyncAdSetsAction(
  sourceAdSetMetaId: string,
  destAdSetMetaId: string,
): Promise<{
  ok: boolean;
  sourceCount: number;
  destCount: number;
  toCreate: number;
  toSkip: number;
  message?: string;
}> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, sourceCount: 0, destCount: 0, toCreate: 0, toSkip: 0, message: "Not signed in" };
  }
  const orgId = session.orgId;

  // Try to resolve ad sets from DB; fall back to Meta API if missing. We
  // also pull the owning ad account so we can route the (potential) Meta
  // fallback call through the connection that has access — prefer source's
  // connection since the source listing is the primary fallback path.
  const [srcAdSet] = await db
    .select({
      id: schema.adSets.id,
      adAccountId: schema.campaigns.adAccountId,
    })
    .from(schema.adSets)
    .innerJoin(
      schema.campaigns,
      eq(schema.campaigns.id, schema.adSets.campaignId),
    )
    .where(and(eq(schema.adSets.orgId, orgId), eq(schema.adSets.metaAdSetId, sourceAdSetMetaId)))
    .limit(1);
  const [dstAdSet] = await db
    .select({
      id: schema.adSets.id,
      adAccountId: schema.campaigns.adAccountId,
    })
    .from(schema.adSets)
    .innerJoin(
      schema.campaigns,
      eq(schema.campaigns.id, schema.adSets.campaignId),
    )
    .where(and(eq(schema.adSets.orgId, orgId), eq(schema.adSets.metaAdSetId, destAdSetMetaId)))
    .limit(1);

  const routingAccountId = srcAdSet?.adAccountId ?? dstAdSet?.adAccountId ?? null;
  const meta = routingAccountId
    ? await getMetaClientForAdAccount(orgId, routingAccountId)
    : null;

  // Fetch source ad names — DB first, Meta API fallback.
  let srcAdNames: string[];
  if (srcAdSet) {
    const rows = await db.select({ name: schema.ads.name }).from(schema.ads)
      .where(and(eq(schema.ads.orgId, orgId), eq(schema.ads.adSetId, srcAdSet.id)));
    srcAdNames = rows.map((r) => r.name);
  } else if (meta) {
    const res = await meta.client.listAdsForAdSet(sourceAdSetMetaId);
    srcAdNames = res.data.map((a) => a.name);
  } else {
    return { ok: false, sourceCount: 0, destCount: 0, toCreate: 0, toSkip: 0, message: "No Meta connection" };
  }

  // Fetch dest ad names — DB first, Meta API fallback.
  let dstAdNames: string[];
  if (dstAdSet) {
    const rows = await db.select({ name: schema.ads.name }).from(schema.ads)
      .where(and(eq(schema.ads.orgId, orgId), eq(schema.ads.adSetId, dstAdSet.id)));
    dstAdNames = rows.map((r) => r.name);
  } else if (meta) {
    const res = await meta.client.listAdsForAdSet(destAdSetMetaId);
    dstAdNames = res.data.map((a) => a.name);
  } else {
    dstAdNames = [];
  }

  const dstCodes = new Set(dstAdNames.map((n) => extractCode(n)).filter(Boolean));
  let toSkip = 0;
  let toCreate = 0;
  for (const name of srcAdNames) {
    const code = extractCode(name);
    if (code && dstCodes.has(code)) toSkip++;
    else toCreate++;
  }
  return { ok: true, sourceCount: srcAdNames.length, destCount: dstAdNames.length, toCreate, toSkip };
}

function extractCode(name: string): string | null {
  const m = name.match(/- ([A-Z]+\d+[A-Z]?) -/);
  return m ? m[1] : null;
}

export async function syncAdSetsServerAction(
  sourceAdSetMetaId: string,
  destAdSetMetaId: string,
  sourceCampaignId?: string,
): Promise<{ ok: boolean; result?: SyncAdsResult; message?: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in" };
  }
  const result = await syncAdsBetweenAdSets({
    orgId: session.orgId,
    sourceAdSetMetaId,
    destAdSetMetaId,
    sourceCampaignId,
    actor: { type: "user", userId: session.userId },
  });
  revalidatePath("/campaigns");
  revalidatePath("/dashboard");
  revalidatePath("/journal");
  return { ok: true, result };
}

export async function cloneAdSetServerAction(
  sourceAdSetMetaId: string,
  destCampaignId: string,
): Promise<{ ok: boolean; result?: CloneAdSetResult; message?: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in" };
  }
  const result = await cloneAdSetToCampaign({
    orgId: session.orgId,
    sourceAdSetMetaId,
    destCampaignId,
    actor: { type: "user", userId: session.userId },
  });
  revalidatePath("/campaigns");
  revalidatePath("/dashboard");
  revalidatePath("/journal");
  if (!result.ok) return { ok: false, message: result.message, result };
  return { ok: true, result };
}

/**
 * Clone an ad set into an ad account that has zero campaigns yet. Creates a
 * fresh PAUSED campaign in the destination account first, then clones the
 * source ad set into it. Used by SyncAdSetsDialog's "→ New campaign in this
 * account" option for newly-assigned accounts.
 */
export async function cloneAdSetIntoNewCampaignAction(
  sourceAdSetMetaId: string,
  destAdAccountId: string,
): Promise<{ ok: boolean; result?: CloneAdSetResult; message?: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in" };
  }
  const result = await cloneAdSetToNewCampaignInAccount({
    orgId: session.orgId,
    sourceAdSetMetaId,
    destAdAccountId,
    actor: { type: "user", userId: session.userId },
  });
  revalidatePath("/campaigns");
  revalidatePath("/dashboard");
  revalidatePath("/journal");
  if (!result.ok) return { ok: false, message: result.message, result };
  return { ok: true, result };
}

export async function previewCloneAdSetAction(
  sourceAdSetMetaId: string,
): Promise<{ ok: boolean; sourceCount: number; message?: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, sourceCount: 0, message: "Not signed in" };
  }
  const orgId = session.orgId;
  const [srcAdSet] = await db
    .select({
      id: schema.adSets.id,
      adAccountId: schema.campaigns.adAccountId,
    })
    .from(schema.adSets)
    .innerJoin(
      schema.campaigns,
      eq(schema.campaigns.id, schema.adSets.campaignId),
    )
    .where(and(eq(schema.adSets.orgId, orgId), eq(schema.adSets.metaAdSetId, sourceAdSetMetaId)))
    .limit(1);

  if (srcAdSet) {
    const rows = await db
      .select({ id: schema.ads.id })
      .from(schema.ads)
      .where(and(eq(schema.ads.orgId, orgId), eq(schema.ads.adSetId, srcAdSet.id)));
    return { ok: true, sourceCount: rows.length };
  }
  // No DB row — we can't determine which connection owns the source ad set
  // without it. Operator should sync first; otherwise we'd have to guess.
  return {
    ok: false,
    sourceCount: 0,
    message:
      "Source ad set not synced to DB yet — click 'Sync now' on the source campaign first.",
  };
}

export type SourceAdPreview = {
  /** Source ad's Meta ID */
  metaAdId: string;
  /** Source ad's name */
  name: string;
  /** The post identifier the operator sees in Ads Manager. For IG-native
   * sources this is the IG-side `effective_instagram_media_id` (matches
   * the URL Ads Manager shows under the post header); for FB sources
   * this is `object_story_id` in `<page_id>_<post_id>` format. */
  postId: string | null;
  /** IG-side legacy media ID (17-18 digits, e.g. "18437847079100347") for
   * IG-native sources. This is the number Ads Manager's "Edit Ad → Select
   * Post → Instagram → Search by ID" picker matches against — different
   * from `postId` (the 16-digit Graph reference). Null for FB sources or
   * when the IG node fetch fails. */
  instagramIgId: string | null;
  /** Original IG media ID the creative was built from (`source_instagram_media_id`
   * on the creative). This is the operator-facing ID Ads Manager displays
   * under the post header in "Use existing post → Instagram post" and accepts
   * in the "Enter post ID" field — distinct from `postId` (Graph reference)
   * and `instagramIgId` (legacy IG-side ID). Null for FB sources. */
  instagramSourceMediaId: string | null;
  /** Public IG permalink when present (e.g. https://www.instagram.com/p/<shortcode>).
   * Surfaced as a clickable link so operators can verify the source post
   * matches what they expect before cloning. */
  instagramPermalinkUrl: string | null;
  /** Best-guess placement based on creative fields. "instagram" when
   * `instagram_permalink_url` is populated; "facebook" when only
   * `object_story_id` is set; "unknown" if neither could be resolved. */
  placement: "facebook" | "instagram" | "unknown";
  /** Destination URL the source's CTA points at (extracted from
   * `object_story_spec.video_data.call_to_action.value.link` or the
   * link_data equivalent). */
  ctaUrl: string | null;
};

/** Fetches per-source-ad audit info (post ID, placement, CTA URL) so the
 * Sync dialog can show operators what they're about to clone before they
 * commit. Used purely for display — does NOT mutate any creative. */
export async function previewSourceAdsAction(
  sourceAdSetMetaId: string,
): Promise<{ ok: boolean; ads?: SourceAdPreview[]; message?: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in" };
  }
  const orgId = session.orgId;

  type Pair = { metaAdId: string; name: string; creativeId: string };
  const [srcAdSet] = await db
    .select({
      id: schema.adSets.id,
      adAccountId: schema.campaigns.adAccountId,
    })
    .from(schema.adSets)
    .innerJoin(
      schema.campaigns,
      eq(schema.campaigns.id, schema.adSets.campaignId),
    )
    .where(and(eq(schema.adSets.orgId, orgId), eq(schema.adSets.metaAdSetId, sourceAdSetMetaId)))
    .limit(1);

  // Route Meta-side calls through the connection that owns this ad set's
  // ad account (Andi or staff depending on which project owns it). All
  // subsequent meta.client calls below — listAdsForAdSet, getCreativeDetails
  // — read source-account state, so we use the source's connection.
  const meta = srcAdSet
    ? await getMetaClientForAdAccount(orgId, srcAdSet.adAccountId)
    : null;
  if (!meta) {
    return {
      ok: false,
      message: srcAdSet
        ? "No active Meta connection found for source ad account. Reconnect Meta."
        : "Source ad set not synced to DB yet — click 'Sync now' on the source campaign first.",
    };
  }

  let pairs: Pair[];
  if (srcAdSet) {
    const rows = await db
      .select({
        metaAdId: schema.ads.metaAdId,
        name: schema.ads.name,
        raw: schema.ads.raw,
      })
      .from(schema.ads)
      .where(and(eq(schema.ads.orgId, orgId), eq(schema.ads.adSetId, srcAdSet.id)));
    pairs = rows
      .map((r) => {
        const raw = r.raw as { creative?: { id?: string } } | null;
        return {
          metaAdId: r.metaAdId,
          name: r.name,
          creativeId: raw?.creative?.id ?? "",
        };
      })
      .filter((p) => p.creativeId);
  } else {
    const res = await meta.client.listAdsForAdSet(sourceAdSetMetaId);
    pairs = res.data
      .map((a) => ({
        metaAdId: a.id,
        name: a.name,
        creativeId: a.creative?.id ?? "",
      }))
      .filter((p) => p.creativeId);
  }

  const ads = await Promise.all(
    pairs.map(async (p): Promise<SourceAdPreview> => {
      try {
        const c = await meta.client.getCreativeDetails(
          p.creativeId,
          "previewSourceAds",
        );
        const placement: SourceAdPreview["placement"] = c.instagram_permalink_url
          ? "instagram"
          : c.object_story_id || c.effective_object_story_id
            ? "facebook"
            : "unknown";
        const oss = (c.object_story_spec ?? {}) as {
          video_data?: { call_to_action?: { value?: { link?: string } } };
          link_data?: {
            link?: string;
            call_to_action?: { value?: { link?: string } };
          };
        };
        const ctaUrl =
          oss.video_data?.call_to_action?.value?.link ??
          oss.link_data?.call_to_action?.value?.link ??
          oss.link_data?.link ??
          null;
        // For IG-native sources show the IG-side numeric ID — that's what
        // Ads Manager displays under the post header. The FB-resolved
        // `object_story_id` (e.g. "813641851827994_2129196974587410") is
        // the back-end reference but doesn't match the operator's view.
        const postId =
          placement === "instagram"
            ? (c.effective_instagram_media_id ??
              c.object_story_id ??
              c.effective_object_story_id ??
              null)
            : (c.object_story_id ?? c.effective_object_story_id ?? null);
        let instagramIgId: string | null = null;
        if (placement === "instagram" && c.effective_instagram_media_id) {
          try {
            const ig = await meta.client.getIgMediaInfo(
              c.effective_instagram_media_id,
              "previewSourceAds",
            );
            instagramIgId = ig.ig_id ?? null;
          } catch {
            instagramIgId = null;
          }
        }
        return {
          metaAdId: p.metaAdId,
          name: p.name,
          postId,
          instagramIgId,
          instagramSourceMediaId: c.source_instagram_media_id ?? null,
          instagramPermalinkUrl: c.instagram_permalink_url ?? null,
          placement,
          ctaUrl,
        };
      } catch {
        return {
          metaAdId: p.metaAdId,
          name: p.name,
          postId: null,
          instagramIgId: null,
          instagramSourceMediaId: null,
          instagramPermalinkUrl: null,
          placement: "unknown",
          ctaUrl: null,
        };
      }
    }),
  );

  return { ok: true, ads };
}

export async function toggleAdSetStatusAction(
  adSetId: string,
  status: "ACTIVE" | "PAUSED",
): Promise<{ ok: boolean; message?: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in" };
  }
  const r = await setAdSetStatusAction({
    orgId: session.orgId,
    adSetId,
    status,
    actor: { type: "user", userId: session.userId },
  });
  revalidatePath("/campaigns");
  revalidatePath("/dashboard");
  revalidatePath("/journal");
  return { ok: r.ok, message: r.message };
}

export async function toggleAdStatusAction(
  adId: string,
  status: "ACTIVE" | "PAUSED",
): Promise<{ ok: boolean; message?: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in" };
  }
  const r = await setAdStatusAction({
    orgId: session.orgId,
    adId,
    status,
    actor: { type: "user", userId: session.userId },
  });
  revalidatePath("/campaigns");
  revalidatePath("/dashboard");
  revalidatePath("/journal");
  return { ok: r.ok, message: r.message };
}

export async function toggleCampaignStatusAction(
  campaignId: string,
  status: "ACTIVE" | "PAUSED",
): Promise<{ ok: boolean; message?: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in" };
  }
  const r = await setCampaignStatusAction({
    orgId: session.orgId,
    campaignId,
    status,
    actor: { type: "user", userId: session.userId },
  });
  revalidatePath("/campaigns");
  revalidatePath("/dashboard");
  revalidatePath("/journal");
  return { ok: r.ok, message: r.message };
}

export async function toggleCampaignAutoPauseExemptAction(
  campaignId: string,
  exempt: boolean,
  reason?: string,
): Promise<{ ok: boolean; message?: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in" };
  }

  const [before] = await db
    .select({
      id: schema.campaigns.id,
      name: schema.campaigns.name,
      autoPauseExempt: schema.campaigns.autoPauseExempt,
      autoPauseExemptReason: schema.campaigns.autoPauseExemptReason,
    })
    .from(schema.campaigns)
    .where(
      and(
        eq(schema.campaigns.orgId, session.orgId),
        eq(schema.campaigns.id, campaignId),
      ),
    )
    .limit(1);
  if (!before) return { ok: false, message: "Campaign not in org" };

  const trimmedReason = reason?.trim() || null;
  await db
    .update(schema.campaigns)
    .set({
      autoPauseExempt: exempt,
      autoPauseExemptReason: exempt ? trimmedReason : null,
      autoPauseExemptAt: exempt ? new Date() : null,
      autoPauseExemptBy: exempt ? session.userId : null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(schema.campaigns.orgId, session.orgId),
        eq(schema.campaigns.id, campaignId),
      ),
    );

  await journalAppend({
    orgId: session.orgId,
    actorType: "user",
    actorRef: session.userId,
    summary: exempt
      ? `Campaign "${before.name}" → auto-pause exempt ON`
      : `Campaign "${before.name}" → auto-pause exempt OFF`,
    reasoning: trimmedReason,
    entityKind: "campaign",
    entityId: before.id,
    before: {
      autoPauseExempt: before.autoPauseExempt,
      autoPauseExemptReason: before.autoPauseExemptReason,
    },
    after: {
      autoPauseExempt: exempt,
      autoPauseExemptReason: exempt ? trimmedReason : null,
    },
    metadata: { kind: "campaign_auto_pause_exempt", exempt },
  });

  revalidatePath("/campaigns");
  revalidatePath("/journal");
  return { ok: true };
}

export async function bulkToggleCampaignStatusAction(
  campaignIds: string[],
  status: "ACTIVE" | "PAUSED",
): Promise<{ ok: number; failed: number }> {
  let session;
  try { session = await requireAppSession(); } catch { return { ok: 0, failed: campaignIds.length }; }
  const r = await bulkSetCampaignStatusAction({
    orgId: session.orgId,
    campaignIds,
    status,
    actor: { type: "user", userId: session.userId },
  });
  revalidatePath("/campaigns");
  revalidatePath("/dashboard");
  revalidatePath("/journal");
  return r;
}

export async function bulkToggleAdSetStatusAction(
  adSetIds: string[],
  status: "ACTIVE" | "PAUSED",
): Promise<{ ok: number; failed: number }> {
  let session;
  try { session = await requireAppSession(); } catch { return { ok: 0, failed: adSetIds.length }; }
  const r = await bulkSetAdSetStatusAction({
    orgId: session.orgId,
    adSetIds,
    status,
    actor: { type: "user", userId: session.userId },
  });
  revalidatePath("/campaigns");
  revalidatePath("/dashboard");
  revalidatePath("/journal");
  return r;
}

export async function bulkToggleAdStatusAction(
  adIds: string[],
  status: "ACTIVE" | "PAUSED",
): Promise<{ ok: number; failed: number }> {
  let session;
  try { session = await requireAppSession(); } catch { return { ok: 0, failed: adIds.length }; }
  const r = await bulkSetAdStatusAction({
    orgId: session.orgId,
    adIds,
    status,
    actor: { type: "user", userId: session.userId },
  });
  revalidatePath("/campaigns");
  revalidatePath("/dashboard");
  revalidatePath("/journal");
  return r;
}

export async function updateCampaignBudgetAction(
  campaignId: string,
  budgetCents: number,
  budgetKind: "daily" | "lifetime",
): Promise<{ ok: boolean; message?: string }> {
  let session;
  try { session = await requireAppSession(); } catch { return { ok: false, message: "Not signed in" }; }
  const r = await setCampaignBudgetAction({
    orgId: session.orgId,
    campaignId,
    budgetCents,
    budgetKind,
    actor: { type: "user", userId: session.userId },
  });
  revalidatePath("/campaigns");
  revalidatePath("/journal");
  return r;
}

export async function updateAdSetBudgetAction(
  adSetId: string,
  budgetCents: number,
  budgetKind: "daily" | "lifetime",
): Promise<{ ok: boolean; message?: string }> {
  let session;
  try { session = await requireAppSession(); } catch { return { ok: false, message: "Not signed in" }; }
  const r = await setAdSetBudgetAction({
    orgId: session.orgId,
    adSetId,
    budgetCents,
    budgetKind,
    actor: { type: "user", userId: session.userId },
  });
  revalidatePath("/campaigns");
  revalidatePath("/journal");
  return r;
}

// ─── Fallback clone (run when the regular clone errors out) ─────────────────

export async function fallbackPrepCloneAction(
  sourceAdSetMetaId: string,
  destCampaignId: string,
): Promise<FallbackPrepResult> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in" };
  }
  const r = await fallbackPrepCloneAdSet({
    orgId: session.orgId,
    sourceAdSetMetaId,
    destCampaignId,
    actor: { type: "user", userId: session.userId },
  });
  // Don't revalidate here — UI is mid-flow and will revalidate after copyOneAd loop.
  return r;
}

export async function copyOneAdAction(
  sourceAdMetaId: string,
  sourceAdName: string,
  sourceCreativeId: string,
  destAdSetMetaId: string,
  sameAccount?: boolean,
): Promise<CopyOneAdResult> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in" };
  }
  return copyOneAdToAdSet({
    orgId: session.orgId,
    sourceAdMetaId,
    sourceAdName,
    sourceCreativeId,
    destAdSetMetaId,
    sameAccount,
    actor: { type: "user", userId: session.userId },
  });
}

export async function fallbackCloneFinalizeAction() {
  // Called once after all per-ad copies finish, to invalidate caches.
  revalidatePath("/campaigns");
  revalidatePath("/dashboard");
  revalidatePath("/journal");
  return { ok: true };
}

/**
 * Triggered when the operator clicks the Sync ad sets button on a row
 * whose campaign name doesn't yet appear in 2+ ad accounts in our DB.
 *
 * Bypasses `syncProject` (which would pull all ad sets + ads + insights
 * across the project and take 60-90s) in favour of just calling Meta's
 * `/{ad_account}/campaigns` endpoint per allocated account in parallel —
 * we only need the campaign-list metadata to check name matches. Any
 * matching campaigns get a minimal upsert so the page revalidates with
 * the new rows and the Sync dialog's destination dropdown sees them.
 */
export async function refreshCampaignsForSyncAction(
  campaignName: string,
): Promise<{ ok: boolean; matchFound: boolean; message?: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, matchFound: false, message: "Not signed in" };
  }
  const active = await resolveActiveProject({
    orgId: session.orgId,
    userId: session.userId,
  });
  if (!active) {
    return { ok: false, matchFound: false, message: "No active project." };
  }

  const accountRows = await db
    .select({
      id: schema.adAccounts.id,
      metaAccountId: schema.adAccounts.metaAccountId,
    })
    .from(schema.adAccounts)
    .where(
      and(
        eq(schema.adAccounts.orgId, session.orgId),
        eq(schema.adAccounts.projectId, active.id),
      ),
    );
  if (accountRows.length < 2) {
    revalidatePath("/campaigns");
    return {
      ok: true,
      matchFound: false,
      message:
        "Fewer than two ad accounts are attached to this project — check LITE_AD_ACCOUNT_IDS and re-run scripts/bootstrap-lite.ts.",
    };
  }

  type FoundCampaign = {
    adAccountId: string;
    metaCampaignId: string;
    name: string;
    objective: string | null;
    status: string;
    effectiveStatus: string | null;
  };
  const found: FoundCampaign[] = [];
  const errors: string[] = [];

  await Promise.all(
    accountRows.map(async (acct) => {
      try {
        const meta = await getMetaClientForAdAccount(session.orgId, acct.id);
        if (!meta) return;
        const res = await meta.client.listCampaigns(acct.metaAccountId);
        for (const c of res.data) {
          if (c.name === campaignName) {
            found.push({
              adAccountId: acct.id,
              metaCampaignId: c.id,
              name: c.name,
              objective: c.objective ?? null,
              status: c.status,
              effectiveStatus: c.effective_status ?? null,
            });
          }
        }
      } catch (err) {
        errors.push(
          `${acct.metaAccountId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  if (found.length === 0 && errors.length === accountRows.length) {
    return {
      ok: false,
      matchFound: false,
      message: `Meta refresh failed for all accounts: ${errors[0]}`,
    };
  }

  // Minimal upsert of any matching campaigns so the page sees them on
  // the next render. Uses raw SQL to skip Drizzle's enum strictness on
  // status (we only know the string from Meta).
  for (const f of found) {
    await db
      .insert(schema.campaigns)
      .values({
        orgId: session.orgId,
        adAccountId: f.adAccountId,
        metaCampaignId: f.metaCampaignId,
        name: f.name,
        objective: f.objective,
        status: f.status as never,
        effectiveStatus: (f.effectiveStatus ?? null) as never,
      })
      .onConflictDoUpdate({
        target: [schema.campaigns.orgId, schema.campaigns.metaCampaignId],
        set: {
          name: f.name,
          objective: f.objective,
          status: f.status as never,
          effectiveStatus: (f.effectiveStatus ?? null) as never,
          updatedAt: sql`now()`,
        },
      });
  }

  const distinctAccountIds = new Set(found.map((f) => f.adAccountId));
  revalidatePath("/campaigns");
  return {
    ok: true,
    matchFound: distinctAccountIds.size >= 2,
    message:
      distinctAccountIds.size >= 2
        ? undefined
        : "No matching campaign found in another ad account. Create the campaign in Ads Manager with the exact same name first.",
  };
}

/**
 * Queue a durable cross-account campaign clone: clone every live ad set of
 * `sourceCampaignId` into the same-named campaign `destCampaignId` in another
 * ad account. Inserts a `clone_jobs` row (so the UI has a jobId to poll
 * immediately) then fires the `campaign/clone-to-account` Inngest event, which
 * runs the multi-hour job server-side. Returns the jobId for the progress page.
 */
export async function cloneCampaignToAccountAction(
  sourceCampaignId: string,
  dest: { campaignId: string } | { adAccountId: string }, // local UUIDs
): Promise<{ ok: boolean; jobId?: string; message?: string }> {
  let session;
  try {
    session = await requireAppSession();
  } catch {
    return { ok: false, message: "Not signed in" };
  }
  const orgId = session.orgId;

  const resolve = (campaignId: string) =>
    db
      .select({
        id: schema.campaigns.id,
        name: schema.campaigns.name,
        status: schema.campaigns.status,
        adAccountId: schema.campaigns.adAccountId,
        metaAccountId: schema.adAccounts.metaAccountId,
        accountName: schema.adAccounts.name,
      })
      .from(schema.campaigns)
      .innerJoin(schema.adAccounts, eq(schema.adAccounts.id, schema.campaigns.adAccountId))
      .where(and(eq(schema.campaigns.orgId, orgId), eq(schema.campaigns.id, campaignId)))
      .limit(1);

  const [src] = await resolve(sourceCampaignId);
  if (!src) return { ok: false, message: "Source campaign not found" };

  let destCampaignId: string;
  if ("campaignId" in dest) {
    // A stale dialog (or "Active only" hiding the live twin) can hand us an
    // ARCHIVED destination. Never clone into a dead campaign — re-route
    // through createMatchingCampaignInAccount for that campaign's account,
    // which reuses the live twin if one exists or creates a fresh PAUSED
    // campaign mirroring the source's settings, and the job proceeds there.
    const [picked] = await resolve(dest.campaignId);
    if (!picked) return { ok: false, message: "Destination campaign not found" };
    if (picked.status === "ARCHIVED" || picked.status === "DELETED") {
      const target = await createMatchingCampaignInAccount({
        orgId,
        sourceCampaignLocalId: src.id,
        destAdAccountLocalId: picked.adAccountId,
        actor: { type: "user", userId: session.userId },
      });
      if (!target.ok) return { ok: false, message: target.message };
      destCampaignId = target.campaignLocalId;
      revalidatePath("/campaigns");
    } else {
      destCampaignId = dest.campaignId;
    }
  } else {
    // Account-only destination: ensure a same-named campaign exists there
    // (creates a PAUSED mirror of the source's objective when missing).
    const [acct] = await db
      .select({ id: schema.adAccounts.id, metaAccountId: schema.adAccounts.metaAccountId })
      .from(schema.adAccounts)
      .where(and(eq(schema.adAccounts.orgId, orgId), eq(schema.adAccounts.id, dest.adAccountId)))
      .limit(1);
    if (!acct) return { ok: false, message: "Destination ad account not found" };
    if (acct.metaAccountId === src.metaAccountId)
      return { ok: false, message: "Source and destination are the same ad account." };

    const target = await createMatchingCampaignInAccount({
      orgId,
      sourceCampaignLocalId: src.id,
      destAdAccountLocalId: acct.id,
      actor: { type: "user", userId: session.userId },
    });
    if (!target.ok) return { ok: false, message: target.message };
    destCampaignId = target.campaignLocalId;
    revalidatePath("/campaigns");
  }

  const [dst] = await resolve(destCampaignId);
  if (!dst) return { ok: false, message: "Destination campaign not found" };

  if (src.metaAccountId === dst.metaAccountId)
    return { ok: false, message: "Source and destination are the same ad account." };
  if (src.name !== dst.name)
    return {
      ok: false,
      message: `Campaign names must match — source "${src.name}" vs destination "${dst.name}".`,
    };

  // Create the job row first → the UI can poll progress the instant send returns.
  const [job] = await db
    .insert(schema.cloneJobs)
    .values({
      orgId,
      sourceMetaAccountId: src.metaAccountId,
      sourceCampaignId: src.id,
      sourceCampaignName: src.name,
      destMetaAccountId: dst.metaAccountId,
      destCampaignId: dst.id,
      destCampaignName: dst.name,
      destAccountName: dst.accountName,
      triggeredBy: session.userId,
      status: "queued",
    })
    .returning({ id: schema.cloneJobs.id });

  try {
    await inngest.send({
      name: "campaign/clone-to-account",
      data: {
        orgId,
        sourceMetaAccountId: src.metaAccountId,
        sourceCampaignId: src.id,
        destMetaAccountId: dst.metaAccountId,
        destCampaignId: dst.id,
        jobId: job.id,
        triggeredBy: session.userId,
      },
    });
  } catch (err) {
    await db
      .update(schema.cloneJobs)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        updatedAt: sql`now()`,
      })
      .where(eq(schema.cloneJobs.id, job.id));
    return { ok: false, jobId: job.id, message: err instanceof Error ? err.message : String(err) };
  }

  revalidatePath("/campaigns/clone-jobs");
  return { ok: true, jobId: job.id };
}
