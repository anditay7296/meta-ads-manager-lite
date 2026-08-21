import { db, schema } from "@/lib/db/client";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { getMetaClientForAdAccount } from "@/lib/meta/get-client";
import type { MetaClient } from "@/lib/meta/client";
import { journalAppend } from "@/lib/db/queries/journal";
import { MetaApiError } from "@/lib/meta/types";
import { isLiteAdAccount } from "@/lib/lite/accounts";

const { ads, adAccounts, adSets, campaigns } = schema;

/**
 * Returns true when the Meta API error indicates the ad account itself is
 * restricted/disabled (not a transient rate-limit or network hiccup).
 * Works on both MetaApiError instances and plain string messages.
 */
export function isAccountRestrictionError(err: unknown): boolean {
  if (err instanceof MetaApiError && err.metaError) {
    const { code, error_subcode } = err.metaError;
    if (code === 200 || error_subcode === 1487534) return true;
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("ineligible") ||
    msg.includes("account is disabled") ||
    msg.includes("account has been disabled") ||
    msg.includes("not allowed to manage") ||
    msg.includes("account restricted")
  );
}

export type ActionActor =
  | { type: "user"; userId: string }
  | { type: "agent"; actionId: string }
  | { type: "rule"; ruleId: string }
  | { type: "system" };

function actorRef(a: ActionActor): string {
  switch (a.type) {
    case "user": return a.userId;
    case "agent": return a.actionId;
    case "rule": return a.ruleId;
    case "system": return "system";
  }
}

export type AdActionResult = {
  ok: boolean;
  metaAdId: string;
  message?: string;
  /** True when Meta rejected because the ad account is restricted/disabled. */
  restricted?: boolean;
};

/**
 * Pause or resume a single ad. Calls Meta, updates the local cache, journals
 * the change. Idempotent (Meta accepts redundant status changes).
 */
export async function setAdStatusAction(opts: {
  orgId: string;
  adId: string; // local UUID
  status: "ACTIVE" | "PAUSED";
  actor: ActionActor;
  reasoning?: string;
}): Promise<AdActionResult> {
  // Look up the ad to get meta_ad_id + current state. Also join the parent
  // ad set + campaign to recover the owning ad account, so we can route the
  // Meta call through the connection that actually has access to it.
  const [adRow] = await db
    .select({
      id: ads.id,
      metaAdId: ads.metaAdId,
      name: ads.name,
      status: ads.status,
      effectiveStatus: ads.effectiveStatus,
      adAccountId: campaigns.adAccountId,
    })
    .from(ads)
    .innerJoin(adSets, eq(adSets.id, ads.adSetId))
    .innerJoin(campaigns, eq(campaigns.id, adSets.campaignId))
    .where(and(eq(ads.orgId, opts.orgId), eq(ads.id, opts.adId)))
    .limit(1);
  if (!adRow) {
    return { ok: false, metaAdId: "", message: "Ad not found in org" };
  }

  const meta = await getMetaClientForAdAccount(opts.orgId, adRow.adAccountId);
  if (!meta) {
    return {
      ok: false,
      metaAdId: adRow.metaAdId,
      message:
        "No active Meta connection found for this ad's ad account. Reconnect Meta.",
    };
  }

  const before = { status: adRow.status, effectiveStatus: adRow.effectiveStatus };
  try {
    await meta.client.setAdStatus(
      adRow.metaAdId,
      opts.status,
      callerLabel(opts.actor),
    );
    // Success proves the account is healthy — auto-clear any stale restriction flag.
    // The WHERE isRestricted = true makes this a no-op for normal accounts.
    await db
      .update(adAccounts)
      .set({ isRestricted: false, restrictedDetectedAt: null })
      .where(
        and(
          eq(adAccounts.id, adRow.adAccountId),
          eq(adAccounts.isRestricted, true),
        ),
      );
  } catch (err) {
    const restricted = isAccountRestrictionError(err);
    if (restricted) {
      await db
        .update(adAccounts)
        .set({ isRestricted: true, restrictedDetectedAt: sql`now()` })
        .where(eq(adAccounts.id, adRow.adAccountId));
    }
    return {
      ok: false,
      metaAdId: adRow.metaAdId,
      message: err instanceof Error ? err.message : String(err),
      restricted,
    };
  }

  await db
    .update(ads)
    .set({
      status: opts.status,
      effectiveStatus: opts.status,
      updatedAt: sql`now()`,
    })
    .where(eq(ads.id, opts.adId));

  await journalAppend({
    orgId: opts.orgId,
    actorType: opts.actor.type,
    actorRef: actorRef(opts.actor),
    summary:
      opts.status === "PAUSED"
        ? `Paused ad "${adRow.name}"`
        : `Resumed ad "${adRow.name}"`,
    reasoning: opts.reasoning ?? null,
    entityKind: "ad",
    entityId: adRow.id,
    before,
    after: { status: opts.status, effectiveStatus: opts.status },
    metadata: { metaAdId: adRow.metaAdId },
  });

  return { ok: true, metaAdId: adRow.metaAdId };
}

/**
 * Pause or resume a single ad set. Mirrors setAdStatusAction one level up the
 * hierarchy. Cascade isn't automatic — Meta cascades effective_status, but
 * the local cache only updates the ad_set row; child ads keep their own
 * effective_status until next sync.
 */
export async function setAdSetStatusAction(opts: {
  orgId: string;
  adSetId: string;
  status: "ACTIVE" | "PAUSED";
  actor: ActionActor;
  reasoning?: string;
}): Promise<{ ok: boolean; metaAdSetId: string; message?: string }> {
  const [row] = await db
    .select({
      id: adSets.id,
      metaAdSetId: adSets.metaAdSetId,
      name: adSets.name,
      status: adSets.status,
      effectiveStatus: adSets.effectiveStatus,
      adAccountId: campaigns.adAccountId,
    })
    .from(adSets)
    .innerJoin(campaigns, eq(campaigns.id, adSets.campaignId))
    .where(and(eq(adSets.orgId, opts.orgId), eq(adSets.id, opts.adSetId)))
    .limit(1);
  if (!row) return { ok: false, metaAdSetId: "", message: "Ad set not in org" };

  const meta = await getMetaClientForAdAccount(opts.orgId, row.adAccountId);
  if (!meta)
    return {
      ok: false,
      metaAdSetId: row.metaAdSetId,
      message:
        "No active Meta connection found for this ad set's ad account. Reconnect Meta.",
    };

  const before = { status: row.status, effectiveStatus: row.effectiveStatus };
  try {
    await meta.client.setAdSetStatus(
      row.metaAdSetId,
      opts.status,
      callerLabel(opts.actor),
    );
  } catch (err) {
    return {
      ok: false,
      metaAdSetId: row.metaAdSetId,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  await db
    .update(adSets)
    .set({
      status: opts.status,
      effectiveStatus: opts.status,
      updatedAt: sql`now()`,
    })
    .where(eq(adSets.id, opts.adSetId));

  await journalAppend({
    orgId: opts.orgId,
    actorType: opts.actor.type,
    actorRef: actorRef(opts.actor),
    summary:
      opts.status === "PAUSED"
        ? `Paused ad set "${row.name}"`
        : `Resumed ad set "${row.name}"`,
    reasoning: opts.reasoning ?? null,
    entityKind: "ad_set",
    entityId: row.id,
    before,
    after: { status: opts.status, effectiveStatus: opts.status },
    metadata: { metaAdSetId: row.metaAdSetId },
  });

  return { ok: true, metaAdSetId: row.metaAdSetId };
}

/**
 * Pause or resume a single campaign. Mirrors setAdSetStatusAction one level
 * up the hierarchy.
 */
export async function setCampaignStatusAction(opts: {
  orgId: string;
  campaignId: string;
  status: "ACTIVE" | "PAUSED";
  actor: ActionActor;
  reasoning?: string;
}): Promise<{ ok: boolean; metaCampaignId: string; message?: string }> {
  const [row] = await db
    .select({
      id: campaigns.id,
      metaCampaignId: campaigns.metaCampaignId,
      name: campaigns.name,
      status: campaigns.status,
      effectiveStatus: campaigns.effectiveStatus,
      adAccountId: campaigns.adAccountId,
    })
    .from(campaigns)
    .where(and(eq(campaigns.orgId, opts.orgId), eq(campaigns.id, opts.campaignId)))
    .limit(1);
  if (!row) return { ok: false, metaCampaignId: "", message: "Campaign not in org" };

  const meta = await getMetaClientForAdAccount(opts.orgId, row.adAccountId);
  if (!meta)
    return {
      ok: false,
      metaCampaignId: row.metaCampaignId,
      message:
        "No active Meta connection found for this campaign's ad account. Reconnect Meta.",
    };

  const before = { status: row.status, effectiveStatus: row.effectiveStatus };
  try {
    await meta.client.setCampaignStatus(
      row.metaCampaignId,
      opts.status,
      callerLabel(opts.actor),
    );
  } catch (err) {
    return {
      ok: false,
      metaCampaignId: row.metaCampaignId,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  await db
    .update(campaigns)
    .set({
      status: opts.status,
      effectiveStatus: opts.status,
      updatedAt: sql`now()`,
    })
    .where(eq(campaigns.id, opts.campaignId));

  await journalAppend({
    orgId: opts.orgId,
    actorType: opts.actor.type,
    actorRef: actorRef(opts.actor),
    summary:
      opts.status === "PAUSED"
        ? `Paused campaign "${row.name}"`
        : `Resumed campaign "${row.name}"`,
    reasoning: opts.reasoning ?? null,
    entityKind: "campaign",
    entityId: row.id,
    before,
    after: { status: opts.status, effectiveStatus: opts.status },
    metadata: { metaCampaignId: row.metaCampaignId },
  });

  return { ok: true, metaCampaignId: row.metaCampaignId };
}

/**
 * Bulk pause/resume. Returns a per-ad result list. Failures don't abort the batch.
 */
export async function bulkSetAdStatusAction(opts: {
  orgId: string;
  adIds: string[];
  status: "ACTIVE" | "PAUSED";
  actor: ActionActor;
  reasoning?: string;
}): Promise<{
  ok: number;
  failed: number;
  results: AdActionResult[];
}> {
  const results: AdActionResult[] = [];
  let ok = 0;
  let failed = 0;
  for (const adId of opts.adIds) {
    const r = await setAdStatusAction({
      orgId: opts.orgId,
      adId,
      status: opts.status,
      actor: opts.actor,
      reasoning: opts.reasoning,
    });
    results.push(r);
    if (r.ok) ok += 1;
    else failed += 1;
  }
  return { ok, failed, results };
}

/** Bulk pause/resume ad sets. Failures don't abort the batch. */
export async function bulkSetAdSetStatusAction(opts: {
  orgId: string;
  adSetIds: string[];
  status: "ACTIVE" | "PAUSED";
  actor: ActionActor;
  reasoning?: string;
}): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const adSetId of opts.adSetIds) {
    const r = await setAdSetStatusAction({
      orgId: opts.orgId,
      adSetId,
      status: opts.status,
      actor: opts.actor,
      reasoning: opts.reasoning,
    });
    if (r.ok) ok += 1;
    else failed += 1;
  }
  return { ok, failed };
}

/** Bulk pause/resume campaigns. Failures don't abort the batch. */
export async function bulkSetCampaignStatusAction(opts: {
  orgId: string;
  campaignIds: string[];
  status: "ACTIVE" | "PAUSED";
  actor: ActionActor;
  reasoning?: string;
}): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const campaignId of opts.campaignIds) {
    const r = await setCampaignStatusAction({
      orgId: opts.orgId,
      campaignId,
      status: opts.status,
      actor: opts.actor,
      reasoning: opts.reasoning,
    });
    if (r.ok) ok += 1;
    else failed += 1;
  }
  return { ok, failed };
}

/**
 * Update a campaign's daily or lifetime budget. Calls Meta, updates local
 * cache, journals the change. budgetCents is in minor units (sen/cents).
 * Pass budgetKind: "daily" | "lifetime".
 */
export async function setCampaignBudgetAction(opts: {
  orgId: string;
  campaignId: string;
  budgetCents: number;
  budgetKind: "daily" | "lifetime";
  actor: ActionActor;
}): Promise<{ ok: boolean; message?: string }> {
  const [row] = await db
    .select({
      id: campaigns.id,
      metaCampaignId: campaigns.metaCampaignId,
      name: campaigns.name,
      dailyBudget: campaigns.dailyBudget,
      lifetimeBudget: campaigns.lifetimeBudget,
      adAccountId: campaigns.adAccountId,
    })
    .from(campaigns)
    .where(and(eq(campaigns.orgId, opts.orgId), eq(campaigns.id, opts.campaignId)))
    .limit(1);
  if (!row) return { ok: false, message: "Campaign not in org" };

  const meta = await getMetaClientForAdAccount(opts.orgId, row.adAccountId);
  if (!meta)
    return {
      ok: false,
      message:
        "No active Meta connection found for this campaign's ad account. Reconnect Meta.",
    };

  const body =
    opts.budgetKind === "daily"
      ? { daily_budget: opts.budgetCents }
      : { lifetime_budget: opts.budgetCents };

  try {
    await meta.client.setCampaignBudget(row.metaCampaignId, body, callerLabel(opts.actor));
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  await db
    .update(campaigns)
    .set({
      ...(opts.budgetKind === "daily"
        ? { dailyBudget: opts.budgetCents }
        : { lifetimeBudget: opts.budgetCents }),
      updatedAt: sql`now()`,
    })
    .where(eq(campaigns.id, opts.campaignId));

  await journalAppend({
    orgId: opts.orgId,
    actorType: opts.actor.type,
    actorRef: actorRef(opts.actor),
    summary: `Updated ${opts.budgetKind} budget for campaign "${row.name}" to ${opts.budgetCents} cents`,
    reasoning: null,
    entityKind: "campaign",
    entityId: row.id,
    before: { dailyBudget: row.dailyBudget, lifetimeBudget: row.lifetimeBudget },
    after: body,
    metadata: { metaCampaignId: row.metaCampaignId },
  });

  return { ok: true };
}

/**
 * Update an ad set's daily or lifetime budget. Calls Meta, updates local
 * cache, journals the change. budgetCents is in minor units.
 */
export async function setAdSetBudgetAction(opts: {
  orgId: string;
  adSetId: string;
  budgetCents: number;
  budgetKind: "daily" | "lifetime";
  actor: ActionActor;
}): Promise<{ ok: boolean; message?: string }> {
  const [row] = await db
    .select({
      id: adSets.id,
      metaAdSetId: adSets.metaAdSetId,
      name: adSets.name,
      dailyBudget: adSets.dailyBudget,
      lifetimeBudget: adSets.lifetimeBudget,
      adAccountId: campaigns.adAccountId,
    })
    .from(adSets)
    .innerJoin(campaigns, eq(campaigns.id, adSets.campaignId))
    .where(and(eq(adSets.orgId, opts.orgId), eq(adSets.id, opts.adSetId)))
    .limit(1);
  if (!row) return { ok: false, message: "Ad set not in org" };

  const meta = await getMetaClientForAdAccount(opts.orgId, row.adAccountId);
  if (!meta)
    return {
      ok: false,
      message:
        "No active Meta connection found for this ad set's ad account. Reconnect Meta.",
    };

  const body =
    opts.budgetKind === "daily"
      ? { daily_budget: opts.budgetCents }
      : { lifetime_budget: opts.budgetCents };

  try {
    await meta.client.setAdSetBudget(row.metaAdSetId, body, callerLabel(opts.actor));
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  await db
    .update(adSets)
    .set({
      ...(opts.budgetKind === "daily"
        ? { dailyBudget: opts.budgetCents }
        : { lifetimeBudget: opts.budgetCents }),
      updatedAt: sql`now()`,
    })
    .where(eq(adSets.id, opts.adSetId));

  await journalAppend({
    orgId: opts.orgId,
    actorType: opts.actor.type,
    actorRef: actorRef(opts.actor),
    summary: `Updated ${opts.budgetKind} budget for ad set "${row.name}" to ${opts.budgetCents} cents`,
    reasoning: null,
    entityKind: "ad_set",
    entityId: row.id,
    before: { dailyBudget: row.dailyBudget, lifetimeBudget: row.lifetimeBudget },
    after: body,
    metadata: { metaAdSetId: row.metaAdSetId },
  });

  return { ok: true };
}

/**
 * Variation factory: bulk-create one paused ad per creative spec.
 *
 * Each spec must use ONE of two paths:
 *
 * 1. `post_id` — boost an existing FB/IG post (uses object_story_id). The
 *    post's caption + media flow through automatically.
 *
 * 2. `image_url` + copy fields — build a fresh creative. We download the
 *    image, upload it to the ad account, get an image_hash, then construct
 *    object_story_spec.link_data with the copy variants.
 */
export type VariationSpec = {
  pain_point_slug: string;
  variation_number: number;
  // Path 1: existing post
  post_id?: string;
  // Path 2: new creative from image URL
  image_url?: string;
  // Path 3: new creative from an ALREADY-UPLOADED + processed ad video. The
  // factory-run Inngest job uploads via /advideos and polls until ready before
  // building specs — this path never uploads. thumbnail_url is required by
  // Meta for video_data creatives.
  video_id?: string;
  thumbnail_url?: string;
  primary_text?: string;
  headline?: string;
  description?: string;
  link_url?: string;
  call_to_action?:
    | "LEARN_MORE"
    | "SHOP_NOW"
    | "SIGN_UP"
    | "GET_OFFER"
    | "BOOK_TRAVEL"
    | "DOWNLOAD"
    | "CONTACT_US"
    | "SUBSCRIBE"
    | "MESSAGE_PAGE"
    | "WHATSAPP_MESSAGE";
};

export type VariationResult = {
  ok: boolean;
  spec: VariationSpec;
  draftAdId?: string;
  metaAdId?: string;
  metaCreativeId?: string;
  error?: string;
};

export async function runVariationFactory(opts: {
  orgId: string;
  adAccountId: string; // local UUID
  adSetId: string; // local UUID
  pageId: string; // local UUID — used for object_story_spec
  specs: VariationSpec[];
  actor: ActionActor;
}): Promise<{ created: number; failed: number; results: VariationResult[] }> {
  // Pull pixel auto-attach config up-front so we can stamp tracking_specs
  // onto every ad we create.
  const [orgSettings] = await db
    .select({
      defaultPixelId: schema.orgSettings.defaultPixelId,
      pixelAutoAttach: schema.orgSettings.pixelAutoAttach,
    })
    .from(schema.orgSettings)
    .where(eq(schema.orgSettings.orgId, opts.orgId))
    .limit(1);
  const pixelToAttach =
    orgSettings?.pixelAutoAttach && orgSettings.defaultPixelId
      ? orgSettings.defaultPixelId
      : null;
  // Route through the connection that owns this specific ad account. For
  // staff-managed projects (e.g. Vibe Coding Workshop) the staff token is
  // what has the required ads_management + Page-level access.
  const meta = await getMetaClientForAdAccount(opts.orgId, opts.adAccountId);
  if (!meta) {
    return {
      created: 0,
      failed: opts.specs.length,
      results: opts.specs.map((s) => ({
        ok: false,
        spec: s,
        error:
          "No active Meta connection found for this ad account. Reconnect Meta.",
      })),
    };
  }

  const [acct] = await db
    .select({
      id: adAccounts.id,
      metaAccountId: adAccounts.metaAccountId,
      name: adAccounts.name,
    })
    .from(adAccounts)
    .where(
      and(eq(adAccounts.orgId, opts.orgId), eq(adAccounts.id, opts.adAccountId)),
    )
    .limit(1);
  if (!acct) {
    return {
      created: 0,
      failed: opts.specs.length,
      results: opts.specs.map((s) => ({ ok: false, spec: s, error: "Ad account not in org" })),
    };
  }

  const [adSet] = await db
    .select({
      id: adSets.id,
      metaAdSetId: adSets.metaAdSetId,
      name: adSets.name,
      campaignId: adSets.campaignId,
    })
    .from(adSets)
    .where(and(eq(adSets.orgId, opts.orgId), eq(adSets.id, opts.adSetId)))
    .limit(1);
  if (!adSet) {
    return {
      created: 0,
      failed: opts.specs.length,
      results: opts.specs.map((s) => ({ ok: false, spec: s, error: "Ad set not in org" })),
    };
  }

  const [pageRow] = await db
    .select({ metaPageId: schema.pages.metaPageId, name: schema.pages.name })
    .from(schema.pages)
    .where(and(eq(schema.pages.orgId, opts.orgId), eq(schema.pages.id, opts.pageId)))
    .limit(1);
  if (!pageRow) {
    return {
      created: 0,
      failed: opts.specs.length,
      results: opts.specs.map((s) => ({ ok: false, spec: s, error: "Page not in org" })),
    };
  }

  const results: VariationResult[] = [];
  let created = 0;
  let failed = 0;

  for (const spec of opts.specs) {
    const r = await createVariationAd({
      orgId: opts.orgId,
      actor: opts.actor,
      client: meta.client,
      acct: { metaAccountId: acct.metaAccountId, name: acct.name },
      adSet: { id: adSet.id, metaAdSetId: adSet.metaAdSetId, name: adSet.name },
      page: { metaPageId: pageRow.metaPageId, name: pageRow.name },
      pixelToAttach,
      spec,
    });
    results.push(r);
    if (r.ok) created += 1;
    else failed += 1;
  }

  return { created, failed, results };
}

/**
 * Create ONE paused variation ad in an ad set from a spec. Shared by the
 * synchronous JSON-spec path (runVariationFactory) and the durable bulk-launch
 * Inngest job (lib/inngest/factory-run.ts), so creative construction, the
 * local `ads` cache row, and the journal entry stay identical in both.
 */
export async function createVariationAd(opts: {
  orgId: string;
  actor: ActionActor;
  client: MetaClient;
  acct: { metaAccountId: string; name: string };
  adSet: { id: string; metaAdSetId: string; name: string };
  page: { metaPageId: string; name: string };
  pixelToAttach: string | null;
  spec: VariationSpec;
}): Promise<VariationResult> {
  const { spec, acct, adSet, page } = opts;
  const adName = `variation-${spec.pain_point_slug}-${spec.variation_number}`;
  try {
    if (!spec.post_id && !spec.image_url && !spec.video_id) {
      throw new Error("each spec needs post_id, image_url, or video_id");
    }

    let creativeBody: Record<string, unknown>;
    if (spec.post_id) {
      // Path 1: object_story_id references an existing FB/IG post.
      creativeBody = {
        name: `creative-${adName}`,
        object_story_id: spec.post_id,
      };
    } else if (spec.video_id) {
      // Path 3: already-uploaded + processed ad video → video_data creative.
      // Meta rejects thumbnail-less video creatives, and field names differ
      // from link_data: `title` (not name) + `link_description` (not description).
      if (!spec.primary_text) {
        throw new Error("video_id specs need primary_text");
      }
      if (!spec.thumbnail_url) {
        throw new Error("video_id specs need thumbnail_url");
      }
      creativeBody = {
        name: `creative-${adName}`,
        object_story_spec: {
          page_id: page.metaPageId,
          video_data: {
            video_id: spec.video_id,
            image_url: spec.thumbnail_url,
            message: spec.primary_text,
            ...(spec.headline ? { title: spec.headline } : {}),
            ...(spec.description ? { link_description: spec.description } : {}),
            ...(spec.call_to_action
              ? {
                  call_to_action: {
                    type: spec.call_to_action,
                    value: { link: spec.link_url ?? "https://www.facebook.com/" },
                  },
                }
              : {}),
          },
        },
      };
    } else {
      // Path 2: upload image, build link_data with the copy.
      if (!spec.primary_text) {
        throw new Error("image_url specs need primary_text");
      }
      const uploaded = await opts.client.uploadAdImage({
        adAccountId: acct.metaAccountId,
        imageUrl: spec.image_url!,
        filename: `${adName}.jpg`,
        calledBy: callerLabel(opts.actor),
      });
      const linkData: Record<string, unknown> = {
        message: spec.primary_text,
        image_hash: uploaded.hash,
        link: spec.link_url ?? "https://www.facebook.com/", // Meta requires a link for link_data
        ...(spec.headline ? { name: spec.headline } : {}),
        ...(spec.description ? { description: spec.description } : {}),
        ...(spec.call_to_action
          ? {
              call_to_action: {
                type: spec.call_to_action,
                value: { link: spec.link_url ?? "https://www.facebook.com/" },
              },
            }
          : {}),
      };
      creativeBody = {
        name: `creative-${adName}`,
        object_story_spec: {
          page_id: page.metaPageId,
          link_data: linkData,
        },
      };
    }

    const creativeRes = await opts.client.createAdCreative(
      acct.metaAccountId,
      creativeBody,
      callerLabel(opts.actor),
    );

    const adBody: Record<string, unknown> = {
      name: adName,
      adset_id: adSet.metaAdSetId,
      status: "PAUSED",
      creative: { creative_id: creativeRes.id },
    };
    if (opts.pixelToAttach) {
      // Attach the org's default pixel so conversions ladder up to the
      // right tracking spec. Stringified per Meta's API expectation.
      adBody.tracking_specs = JSON.stringify([
        { "action.type": ["offsite_conversion"], fb_pixel: [opts.pixelToAttach] },
      ]);
    }
    const adRes = await opts.client.createAd(
      acct.metaAccountId,
      adBody,
      callerLabel(opts.actor),
    );

    // Cache the new ad locally so it shows up in dashboard immediately.
    const [draft] = await db
      .insert(ads)
      .values({
        orgId: opts.orgId,
        adSetId: adSet.id,
        metaAdId: adRes.id,
        name: adName,
        status: "PAUSED",
        effectiveStatus: "PAUSED",
        raw: { factory: { spec } } as unknown,
      })
      .onConflictDoUpdate({
        target: [ads.orgId, ads.metaAdId],
        set: {
          adSetId: adSet.id,
          name: adName,
          status: "PAUSED",
          effectiveStatus: "PAUSED",
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: ads.id });

    await journalAppend({
      orgId: opts.orgId,
      actorType: opts.actor.type,
      actorRef: actorRef(opts.actor),
      summary: `Factory: created paused draft "${adName}"`,
      entityKind: "ad",
      entityId: draft.id,
      after: { name: adName, status: "PAUSED", metaAdId: adRes.id },
      metadata: {
        factoryRun: true,
        adAccount: acct.name,
        adSet: adSet.name,
        page: page.name,
        spec,
      },
    });

    return {
      ok: true,
      spec,
      draftAdId: draft.id,
      metaAdId: adRes.id,
      metaCreativeId: creativeRes.id,
    };
  } catch (err) {
    return {
      ok: false,
      spec,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Create a fresh PAUSED ad set for the bulk-launch factory from a template.
 *
 * First try Meta's native /copies (Meta validates bid strategy / budget
 * compatibility itself — same recipe as fallbackPrepCloneAdSet). /copies
 * re-validates the source's placement list against Meta's CURRENT taxonomy
 * though, and rejects many older ad sets with subcode 2490392 ("also select
 * Instagram Explore") even when the source is Facebook-only — so on any
 * /copies rejection, fall back to manual createAdSet with a source-primary
 * body lifted from the template's own details (Meta already accepted that
 * exact config once, so re-sending it passes; same strategy as
 * cloneAdSetToCampaign's manual path).
 */
export async function createFactoryAdSet(opts: {
  orgId: string;
  actor: ActionActor;
  client: MetaClient;
  templateMetaAdSetId: string;
  destAccountMetaId: string; // act_xxx — needed for the manual createAdSet path
  destCampaign: { id: string; metaCampaignId: string; name: string };
  name: string;
}): Promise<{ localId: string; metaAdSetId: string }> {
  let copiedId: string | undefined;
  let renameNeeded = false;
  try {
    const res = await opts.client.copyAdSet(
      opts.templateMetaAdSetId,
      {
        campaignId: opts.destCampaign.metaCampaignId,
        deepCopy: false,
        statusOption: "PAUSED",
      },
      callerLabel(opts.actor),
    );
    copiedId = res.copied_adset_id;
    renameNeeded = true;
  } catch {
    // /copies rejected — manual path below. The template's own settings are
    // the body; createAdSet sets the final name directly so no rename step.
    const src = await opts.client.getAdSetDetails(
      opts.templateMetaAdSetId,
      callerLabel(opts.actor),
    );
    const body: Record<string, unknown> = {
      name: opts.name,
      campaign_id: opts.destCampaign.metaCampaignId,
      status: "PAUSED",
    };
    if (src.optimization_goal) body.optimization_goal = src.optimization_goal;
    if (src.billing_event) body.billing_event = src.billing_event;
    if (src.bid_strategy) body.bid_strategy = src.bid_strategy;
    if (src.bid_amount) body.bid_amount = Number(src.bid_amount);
    if (src.bid_constraints) body.bid_constraints = src.bid_constraints;
    if (src.daily_budget) body.daily_budget = Number(src.daily_budget);
    else if (src.lifetime_budget) body.lifetime_budget = Number(src.lifetime_budget);
    if (src.targeting) body.targeting = src.targeting;
    if (src.promoted_object) body.promoted_object = src.promoted_object;
    const created = await opts.client.createAdSet(
      opts.destAccountMetaId,
      body,
      callerLabel(opts.actor),
    );
    copiedId = created.id;
  }

  if (renameNeeded) {
    try {
      await opts.client.updateAdSet(copiedId, { name: opts.name }, callerLabel(opts.actor));
    } catch (err) {
      await journalAppend({
        orgId: opts.orgId,
        actorType: opts.actor.type,
        actorRef: actorRef(opts.actor),
        summary: `Factory: rename failed for new ad set ${copiedId}`,
        reasoning: err instanceof Error ? err.message : String(err),
        entityKind: "adset",
        entityId: null,
        metadata: {
          action: "factory_adset_rename_failed",
          newAdSetMetaId: copiedId,
          intendedName: opts.name,
        },
      });
    }
  }

  const [inserted] = await db
    .insert(adSets)
    .values({
      orgId: opts.orgId,
      campaignId: opts.destCampaign.id,
      metaAdSetId: copiedId,
      name: opts.name,
      status: "PAUSED",
      effectiveStatus: "PAUSED",
      raw: {
        factory: { templateAdSetMetaId: opts.templateMetaAdSetId },
      } as unknown,
    })
    .onConflictDoUpdate({
      target: [adSets.orgId, adSets.metaAdSetId],
      set: {
        campaignId: opts.destCampaign.id,
        name: opts.name,
        status: "PAUSED",
        effectiveStatus: "PAUSED",
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: adSets.id });

  await journalAppend({
    orgId: opts.orgId,
    actorType: opts.actor.type,
    actorRef: actorRef(opts.actor),
    summary: `Factory: created paused ad set "${opts.name}" in ${opts.destCampaign.name}`,
    entityKind: "adset",
    entityId: inserted.id,
    after: { name: opts.name, status: "PAUSED", metaAdSetId: copiedId },
    metadata: {
      factoryRun: true,
      action: "factory_adset_created",
      templateAdSetMetaId: opts.templateMetaAdSetId,
    },
  });

  return { localId: inserted.id, metaAdSetId: copiedId };
}

export type SyncAdsResult = {
  created: number;
  skipped: number;
  failed: number;
  errors: string[];
  /** Number of created ads whose creative-spec fields (asset_feed_spec /
   * degrees_of_freedom_spec / contextual_multi_ads) survived the copy.
   * Captures Multi-advertiser ads OFF, Advantage+ destination OFF, browser
   * add-on (e.g. WhatsApp), and additional primary text variations. */
  enhancementsPreserved?: number;
  /** Number of created ads whose creative-spec fields had to be stripped
   * because Meta rejected with "(#3) Application does not have the
   * capability" — the ad was still created, but enhancements need manual
   * setup in Ads Manager. */
  enhancementsDropped?: number;
  /** Number of created ads where the post-clone preference-enforcement step
   * (Multi-advertiser OFF, Optimise destination OFF, copy variants) failed.
   * Per-ad errors land in the journal entry's metadata. */
  creativePrefsErrors?: number;
  /** Number of created ads where the rebuild fallback was used on an
   * IG-native source. These ads have their name prefixed with 🔧 in Ads
   * Manager and require operator to manually swap "Change post" → Instagram. */
  needsManualIgFix?: number;
};

// ─── Creative-clone helpers ─────────────────────────────────────────────────
//
// Both syncAdsBetweenAdSets and copyOneAdToAdSet need to:
//   1. Build a destination creative body that preserves the source's
//      creative-level enhancements (multi-advertiser ads OFF,
//      Advantage+ destination OFF, WhatsApp browser add-on ON, additional
//      primary text variations) — i.e. *whatever* the source had.
//   2. Gracefully degrade when Meta rejects with "(#3) Application does not
//      have the capability" by retrying without those enhancement fields.
// These helpers centralise both behaviours.

type SourceCreative = {
  object_story_id?: string;
  effective_object_story_id?: string;
  degrees_of_freedom_spec?: Record<string, unknown>;
  asset_feed_spec?: Record<string, unknown>;
  contextual_multi_ads?: Record<string, unknown>;
  /** When the source ad was IG-native, this captures the Instagram-side
   * permalink so the rebuild path can preserve it. Without it the
   * destination creative falls back to the underlying FB page post and the
   * cloned ad's "Ad creative" tab in Ads Manager shows "Facebook post"
   * instead of "Instagram post" — visually inconsistent with the source. */
  instagram_permalink_url?: string;
};

function buildCreativeBodyFromSource(
  creative: SourceCreative,
  _cleanedName: string,
): Record<string, unknown> {
  // Bare body intentionally — we tried recursively stripping
  // `standard_enhancements` from `degrees_of_freedom_spec`,
  // `asset_feed_spec`, and `contextual_multi_ads`, but Meta still hit
  // subcode 3858504 ("standard_enhancements field in creative is
  // deprecated") on cross-account ad creation. Either Meta re-injects the
  // legacy key into newly-created creatives that reference an
  // object_story_id whose underlying page post had it baked in, or the
  // validation fires on a path we can't sanitize from the request body.
  //
  // We pass both `object_story_id` AND `instagram_permalink_url` (when
  // present) even though Meta picks the FB-side reference as canonical
  // and labels the cloned creative as "Facebook post" in Ads Manager
  // for IG-native sources. We tried sending ONLY `instagram_permalink_url`
  // (commit be625dc) but Meta rejected with subcode 2446391 "Your ad is
  // missing one or more required fields" — apparently the bare IG-permalink
  // body needs more fields our app's capability tier can't provide.
  // Operator manually clicks "Change post" → Instagram tab to fix the
  // FB-vs-IG tag for now (a manual step the verification panel surfaces
  // before clone, so it's caught early).
  //
  // Account-level Advantage+ defaults backfill the user's creative-level
  // preferences (Multi-advertiser OFF, Advantage+ destination OFF,
  // WhatsApp browser add-on, additional caption variations) — manual
  // checklist captures the remainder.
  const storyId =
    creative.object_story_id ?? creative.effective_object_story_id;
  const body: Record<string, unknown> = {
    name: `creative-${_cleanedName}`,
    object_story_id: storyId,
  };
  if (creative.instagram_permalink_url) {
    body.instagram_permalink_url = creative.instagram_permalink_url;
  }
  return body;
}

export async function createCreativeWithFallback(
  meta: { client: { createAdCreative: (acct: string, body: Record<string, unknown>, by?: string) => Promise<{ id: string }> } },
  accountId: string,
  body: Record<string, unknown>,
  calledBy: string,
): Promise<{ creative: { id: string }; preserved: boolean }> {
  try {
    const creative = await meta.client.createAdCreative(accountId, body, calledBy);
    return { creative, preserved: true };
  } catch (err) {
    // Degrade gracefully when Meta rejects an enhancement field. Two cases:
    //   (a) (#3) "Application does not have the capability" — old behaviour.
    //   (b) Subcode 3858504 — `standard_enhancements` field deprecated in
    //       Marketing API v22.0 (Jan 2025). Strictly Part 1 of the fix
    //       sanitises this before send, but we keep the catch as a safety
    //       net for future bundle-toggle deprecations.
    if (!(err instanceof MetaApiError)) throw err;
    const meErr = err.metaError;
    const allMessages = `${meErr?.message ?? ""} ${err.message}`;
    const shouldDegrade =
      meErr?.code === 3 ||
      meErr?.error_subcode === 3858504 ||
      /capabilit/i.test(allMessages) ||
      /call.?to.?action/i.test(allMessages) ||
      (/standard.?enhancement/i.test(allMessages) && /deprecated/i.test(allMessages));
    if (!shouldDegrade) throw err;
    const stripped: Record<string, unknown> = {
      name: body.name,
      object_story_id: body.object_story_id,
    };
    const creative = await meta.client.createAdCreative(accountId, stripped, calledBy);
    return { creative, preserved: false };
  }
}

/**
 * Native ad copy via Meta's /{ad_id}/copies endpoint. Reuses the source
 * creative directly, so ALL creative-level settings are preserved and the
 * (#3) capability error is sidestepped entirely. Only valid when source ad
 * and destination ad set live in the same ad account.
 *
 * After copying, optionally renames the new ad to `desiredName` since Meta
 * appends " - Copy" by default.
 */
type CopyAdClient = {
  copyAd: (
    adMetaId: string,
    opts: { adsetId?: string; statusOption?: "ACTIVE" | "PAUSED" | "INHERITED_FROM_SOURCE" },
    calledBy?: string,
  ) => Promise<{
    copied_ad_id?: string;
    ad_object_ids?: Array<{ ad_object_type: string; source_id: string; copied_id: string }>;
  }>;
  updateAd: (adMetaId: string, fields: Record<string, unknown>, calledBy?: string) => Promise<{ success: boolean }>;
};

async function nativeCopyAdToAdSet(opts: {
  meta: { client: CopyAdClient };
  sourceAdMetaId: string;
  destAdSetMetaId: string;
  desiredName: string;
  calledBy: string;
}): Promise<{ newAdId: string }> {
  const res = await opts.meta.client.copyAd(
    opts.sourceAdMetaId,
    {
      adsetId: opts.destAdSetMetaId,
      statusOption: "PAUSED",
    },
    opts.calledBy,
  );
  // Meta returns either `copied_ad_id` directly or wraps in `ad_object_ids`.
  const newAdId =
    res.copied_ad_id ??
    res.ad_object_ids?.find((o) => o.ad_object_type === "ad")?.copied_id;
  if (!newAdId) throw new Error("Meta /copies returned no ad id");

  // Rename to drop Meta's default " - Copy" suffix and match the source's
  // cleaned name. Best-effort — failure here doesn't undo the copy.
  try {
    await opts.meta.client.updateAd(
      newAdId,
      { name: opts.desiredName },
      opts.calledBy,
    );
  } catch {
    /* non-fatal */
  }
  return { newAdId };
}

// ─── Post-clone creative-preferences audit ─────────────────────────────────
//
// Operator's locked-in defaults for every cloned ad (see Settings → Ad
// preferences):
//   1. Multi-advertiser ads → OFF
//   2. Browsers Add-on → WhatsApp
//   3. Primary text → original + 4 saved caption variations
//   4. Optimise website destination → OFF
//
// All four are MANUAL. An earlier iteration tried to enforce them by
// rebuilding the destination creative with `asset_feed_spec.bodies`, but
// that converted clones into "asset feed" creatives — Ads Manager no
// longer showed "Use existing post" pointing at the source IG/FB post,
// and writing the hybrid (object_story_id + bodies-only asset_feed_spec)
// requires a Meta App capability tier the app doesn't have. So clones
// stay as post-reference creatives and the journal records the audit
// result so operators know what to verify in Ads Manager.

export type CreativePrefsResult = {
  multiAdvertiserOff: boolean;
  whatsappAddOn: boolean;
  /** 1 when source's caption variations carried over via /copies, 0 when
   * the rebuild fallback was used (which strips them — operator must
   * paste manually). Kept as `number` rather than boolean so the journal
   * shape stays compatible with earlier rich-audit attempts. */
  copyVariantsAttached: number;
  optimizeDestinationOff: boolean;
  error?: string;
};

/**
 * Audit-only helper. Reports what the clone path preserved vs. dropped so the
 * journal entry tells the operator what to verify in Ads Manager. Does NOT
 * make any Meta API calls — purely derives from in-scope flags.
 *
 * History: earlier versions of this helper rebuilt the destination creative
 * with `asset_feed_spec` to inject Multi-advertiser OFF, WhatsApp browser
 * add-on, and caption variations. That converted clones into "asset feed"
 * creatives — Ads Manager no longer showed "Use existing post" pointing at
 * the source IG/FB post, and writing the hybrid (object_story_id + bodies-
 * only asset_feed_spec) requires a Meta App capability tier this app
 * doesn't have. So all four prefs (Multi-advertiser, Browsers Add-on,
 * caption variations, Optimise destination) are verified manually after
 * each clone. Function signature kept stable so call sites and the journal
 * metadata shape remain unchanged.
 */
async function applyCreativePrefsToClonedAd(opts: {
  meta: unknown;
  orgId: string;
  newAdMetaId: string;
  destAdAccountMetaId: string;
  sourceAdName: string;
  cleanedName: string;
  /** True if /copies was used — source's WhatsApp + multi-body captions
   * carried over via Meta's native duplication. False means creative-rebuild
   * was used and only `object_story_id` survived. */
  enhancementsPreservedFromCopy: boolean;
  sourceCreativeId?: string;
  destProjectId?: string;
  calledBy: string;
}): Promise<CreativePrefsResult> {
  return {
    // No working API path for these two — manual flips in Ads Manager.
    multiAdvertiserOff: false,
    optimizeDestinationOff: false,
    // /copies preserves source's `message_extensions` and `asset_feed_spec.bodies`;
    // rebuild fallback drops them.
    whatsappAddOn: opts.enhancementsPreservedFromCopy,
    copyVariantsAttached: opts.enhancementsPreservedFromCopy ? 1 : 0,
  };
}

/**
 * Copy ads from one ad set into another (potentially across ad accounts).
 * Uses the source creative's object_story_id so no media re-upload is needed.
 * All copied ads are created as PAUSED.
 *
 * Deduplication: extracts the ad code (e.g. "AI014A") from the name and skips
 * any source ad whose code already exists in the destination ad set.
 */
export async function syncAdsBetweenAdSets(opts: {
  orgId: string;
  sourceAdSetMetaId: string;
  destAdSetMetaId: string;
  sourceCampaignId?: string; // internal DB UUID, used as fallback when source ad set is not in DB
  actor: ActionActor;
}): Promise<SyncAdsResult> {
  const result: SyncAdsResult = { created: 0, skipped: 0, failed: 0, errors: [] };

  // Resolve source ad set from DB (may be absent if sync hasn't run yet).
  const [srcAdSet] = await db
    .select({
      id: adSets.id,
      metaAdSetId: adSets.metaAdSetId,
      name: adSets.name,
      campaignId: adSets.campaignId,
    })
    .from(adSets)
    .where(and(eq(adSets.orgId, opts.orgId), eq(adSets.metaAdSetId, opts.sourceAdSetMetaId)))
    .limit(1);

  // Resolve source ad account — via ad set in DB, or via the campaign fallback.
  let srcAccount: { id: string; metaAccountId: string; name: string } | undefined;
  if (srcAdSet) {
    const [srcCampaign] = await db
      .select({ adAccountId: campaigns.adAccountId })
      .from(campaigns)
      .where(eq(campaigns.id, srcAdSet.campaignId))
      .limit(1);
    if (srcCampaign) {
      const [a] = await db
        .select({ id: adAccounts.id, metaAccountId: adAccounts.metaAccountId, name: adAccounts.name })
        .from(adAccounts)
        .where(and(eq(adAccounts.orgId, opts.orgId), eq(adAccounts.id, srcCampaign.adAccountId)))
        .limit(1);
      srcAccount = a;
    }
  } else if (opts.sourceCampaignId) {
    const [srcCampaign] = await db
      .select({ adAccountId: campaigns.adAccountId })
      .from(campaigns)
      .where(and(eq(campaigns.orgId, opts.orgId), eq(campaigns.id, opts.sourceCampaignId)))
      .limit(1);
    if (srcCampaign) {
      const [a] = await db
        .select({ id: adAccounts.id, metaAccountId: adAccounts.metaAccountId, name: adAccounts.name })
        .from(adAccounts)
        .where(and(eq(adAccounts.orgId, opts.orgId), eq(adAccounts.id, srcCampaign.adAccountId)))
        .limit(1);
      srcAccount = a;
    }
  }
  if (!srcAccount) return { ...result, errors: ["Source ad account not found"] };

  // Resolve destination ad set and its ad account.
  const [dstAdSet] = await db
    .select({
      id: adSets.id,
      metaAdSetId: adSets.metaAdSetId,
      name: adSets.name,
      campaignId: adSets.campaignId,
    })
    .from(adSets)
    .where(and(eq(adSets.orgId, opts.orgId), eq(adSets.metaAdSetId, opts.destAdSetMetaId)))
    .limit(1);
  if (!dstAdSet) return { ...result, errors: ["Destination ad set not found in org"] };

  const [dstCampaign] = await db
    .select({ adAccountId: campaigns.adAccountId })
    .from(campaigns)
    .where(eq(campaigns.id, dstAdSet.campaignId))
    .limit(1);
  if (!dstCampaign) return { ...result, errors: ["Destination campaign not found"] };

  const [dstAccount] = await db
    .select({
      id: adAccounts.id,
      metaAccountId: adAccounts.metaAccountId,
      name: adAccounts.name,
      projectId: adAccounts.projectId,
    })
    .from(adAccounts)
    .where(and(eq(adAccounts.orgId, opts.orgId), eq(adAccounts.id, dstCampaign.adAccountId)))
    .limit(1);
  if (!dstAccount) return { ...result, errors: ["Destination ad account not found"] };
  // Lite guard: never write into an account outside the allowlist, whatever
  // account id the caller resolved.
  if (!isLiteAdAccount(dstAccount.metaAccountId)) {
    return {
      ...result,
      errors: [
        `Destination ad account ${dstAccount.metaAccountId} is outside LITE_AD_ACCOUNT_IDS`,
      ],
    };
  }

  // Cross-account clone writes against the destination ad account, so we
  // need the connection that owns the destination's token.
  const meta = await getMetaClientForAdAccount(opts.orgId, dstAccount.id);
  if (!meta)
    return {
      ...result,
      errors: [
        "No active Meta connection found for destination ad account. Reconnect Meta.",
      ],
    };

  // Fetch source ads — DB first, Meta API fallback (handles unsynced ad sets).
  type SrcAd = { id: string; name: string; creativeId: string };
  let srcAds: SrcAd[];
  if (srcAdSet) {
    const rows = await db
      .select({ id: ads.id, name: ads.name, raw: ads.raw })
      .from(ads)
      .where(and(eq(ads.orgId, opts.orgId), eq(ads.adSetId, srcAdSet.id)));
    srcAds = rows
      .map((r) => {
        const raw = r.raw as { creative?: { id?: string } } | null;
        return { id: r.id, name: r.name, creativeId: raw?.creative?.id ?? "" };
      })
      .filter((r) => r.creativeId);
    if (srcAds.length === 0 && rows.length > 0) {
      return { ...result, errors: ["Source ads have no creative IDs in DB — re-sync needed"] };
    }
  } else {
    const res = await meta.client.listAdsForAdSet(opts.sourceAdSetMetaId);
    srcAds = res.data
      .map((a) => ({ id: a.id, name: a.name, creativeId: a.creative?.id ?? "" }))
      .filter((a) => a.creativeId);
  }

  // Fetch destination ads and build a set of existing codes.
  const dstAdRows = await db
    .select({ name: ads.name })
    .from(ads)
    .where(and(eq(ads.orgId, opts.orgId), eq(ads.adSetId, dstAdSet.id)));
  const existingCodes = new Set(dstAdRows.map((a) => extractAdCode(a.name)).filter(Boolean));

  for (const srcAd of srcAds) {
    const code = extractAdCode(srcAd.name);
    if (code && existingCodes.has(code)) {
      result.skipped += 1;
      continue;
    }

    const creativeId = srcAd.creativeId;
    if (!creativeId) {
      result.failed += 1;
      result.errors.push(`Ad "${srcAd.name}": no creative ID`);
      continue;
    }

    try {
      const cleanedName = cleanAdName(srcAd.name);
      const sameAccount = srcAccount.metaAccountId === dstAccount.metaAccountId;

      // Always try Meta's native /{ad_id}/copies first — this is what Ads
      // Manager uses internally when you click "Duplicate" on an ad, and
      // it preserves creative-level settings without making us recreate the
      // creative. Cross-account /copies works when both ad accounts are in
      // the same Business Manager (which the AI 网络自由创业 project's
      // accounts are). Critically, it also bypasses Meta's v22
      // `standard_enhancements` deprecation check (subcode 3858504) that
      // hits the createAdCreative path on existing-post creatives.
      let newAd: { id: string };
      let enhancementsPreserved: boolean;
      let nativeCopyWorked = false;
      try {
        const { newAdId } = await nativeCopyAdToAdSet({
          meta,
          sourceAdMetaId: srcAd.id,
          destAdSetMetaId: dstAdSet.metaAdSetId,
          desiredName: cleanedName,
          calledBy: callerLabel(opts.actor),
        });
        newAd = { id: newAdId };
        enhancementsPreserved = true;
        nativeCopyWorked = true;
        result.enhancementsPreserved = (result.enhancementsPreserved ?? 0) + 1;
      } catch (copyErr) {
        if (sameAccount) {
          // Same-account /copies failure has no rebuild fallback — surface
          // it. The cross-account branch falls through to the rebuild path
          // below.
          throw copyErr;
        }
        newAd = { id: "" };
        enhancementsPreserved = false;
      }

      // When the rebuild fallback is used on an IG-native source, Meta
      // tags the dest creative as "Facebook post" (the FB-resolved
      // object_story_id wins over instagram_permalink_url). Operator must
      // manually click "Change post" → Instagram tab. Flag with a 🔧
      // prefix in the ad name so it stands out in Ads Manager's list.
      let needsManualIgFix = false;
      if (!nativeCopyWorked && !sameAccount) {
        // Cross-account fallback: rebuild the creative in the destination
        // account. Only reached if /copies rejected (e.g. Business Manager
        // linkage gone, or some other capability gate). NOTE: this path
        // currently fails on existing-post creatives because of Meta's v22
        // `standard_enhancements` deprecation — the strip helpers can't
        // sanitize the page-post-resolved spec. Kept as a defence-in-depth
        // layer for the day Meta tightens /copies further.
        const creative = await meta.client.getCreativeDetails(
          creativeId,
          callerLabel(opts.actor),
        );
        if (!creative.object_story_id && !creative.effective_object_story_id) {
          result.failed += 1;
          result.errors.push(`Ad "${srcAd.name}": creative has no object_story_id`);
          continue;
        }
        needsManualIgFix = Boolean(creative.instagram_permalink_url);
        const creativeBody = buildCreativeBodyFromSource(creative, cleanedName);
        const { creative: newCreative, preserved } =
          await createCreativeWithFallback(
            meta,
            dstAccount.metaAccountId,
            creativeBody,
            callerLabel(opts.actor),
          );
        enhancementsPreserved = preserved;
        if (preserved) result.enhancementsPreserved = (result.enhancementsPreserved ?? 0) + 1;
        else result.enhancementsDropped = (result.enhancementsDropped ?? 0) + 1;

        newAd = await meta.client.createAd(
          dstAccount.metaAccountId,
          {
            name: needsManualIgFix ? `🔧 ${cleanedName}` : cleanedName,
            adset_id: dstAdSet.metaAdSetId,
            status: "PAUSED",
            creative: { creative_id: newCreative.id },
          },
          callerLabel(opts.actor),
        );
      }

      const finalName = needsManualIgFix ? `🔧 ${cleanedName}` : cleanedName;
      if (needsManualIgFix) {
        result.needsManualIgFix = (result.needsManualIgFix ?? 0) + 1;
      }
      const [inserted] = await db
        .insert(ads)
        .values({
          orgId: opts.orgId,
          adSetId: dstAdSet.id,
          metaAdId: newAd.id,
          name: finalName,
          status: "PAUSED",
          effectiveStatus: "PAUSED",
          raw: { synced_from: { srcAdMetaId: srcAd.id, srcAdSetMetaId: opts.sourceAdSetMetaId }, needsManualIgFix } as unknown,
        })
        .onConflictDoUpdate({
          target: [ads.orgId, ads.metaAdId],
          set: {
            adSetId: dstAdSet.id,
            name: finalName,
            status: "PAUSED",
            effectiveStatus: "PAUSED",
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: ads.id });

      // Enforce operator's locked-in creative preferences on the cloned ad.
      // Best-effort: failure here is logged in journal metadata but never
      // breaks the clone.
      const creativePrefsApplied = await applyCreativePrefsToClonedAd({
        meta,
        orgId: opts.orgId,
        newAdMetaId: newAd.id,
        destAdAccountMetaId: dstAccount.metaAccountId,
        sourceAdName: srcAd.name,
        cleanedName,
        enhancementsPreservedFromCopy: nativeCopyWorked,
        sourceCreativeId: creativeId,
        destProjectId: dstAccount.projectId ?? undefined,
        calledBy: callerLabel(opts.actor),
      });
      if (creativePrefsApplied.error) {
        result.creativePrefsErrors = (result.creativePrefsErrors ?? 0) + 1;
      }

      await journalAppend({
        orgId: opts.orgId,
        actorType: opts.actor.type,
        actorRef: actorRef(opts.actor),
        summary: `Synced ad "${cleanedName}" from ${srcAccount.name} → ${dstAccount.name}`,
        entityKind: "ad",
        entityId: inserted.id,
        after: { name: cleanedName, status: "PAUSED", metaAdId: newAd.id },
        metadata: {
          syncFrom: { adSetMetaId: opts.sourceAdSetMetaId, adSetId: srcAdSet?.id, adAccountId: srcAccount.id },
          syncTo: { adSetId: dstAdSet.id, adAccountId: dstAccount.id },
          enhancementsPreserved,
          copyMethod: sameAccount ? "native" : "creative-rebuild",
          creativePrefsApplied,
        },
      });

      existingCodes.add(code ?? cleanedName);
      result.created += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push(
        `Ad "${srcAd.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

export function extractAdCode(name: string): string | null {
  // Take the LAST code-shaped token, not the first. The audience tier "GT1"
  // shares the same `[A-Z]+\d+[A-Z]?` shape as the AI-code and would otherwise
  // win and short-circuit the slice in deriveBoostedAdSetName.
  const matches = [...name.matchAll(/- ([A-Z]+\d+[A-Z]?) -/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

/**
 * Build the new adset name when boosting a fresh organic post into a
 * project's primary campaign. The reference adset's name follows the pattern
 *   `<scaffold> - <BRAND> - <AICODE> - VIDEO: <name> - COPY: <name>`
 * — we cut the source BEFORE the brand-code segment and attach the operator's
 * new ad name (which itself already starts with the brand code).
 *
 * Worked example:
 *   source   = "LAL - 21-65+ - MY - GT1 - Event: LDP - FB - AIA - AI015B - VIDEO: You're Not The Best - COPY: WeiLe01"
 *   new name = "AIA - AG04 - IMAGE: 4X - COPY: Sharlene01"
 *   →          "LAL - 21-65+ - MY - GT1 - Event: LDP - FB - AIA - AG04 - IMAGE: 4X - COPY: Sharlene01"
 *
 * `matched=false` flags fallback (no AI-code in source) so callers can show
 * a warning chip in the approval card.
 */
export function deriveBoostedAdSetName(
  sourceName: string,
  newAdName: string,
): { name: string; matched: boolean } {
  const trimmed = newAdName.trim();
  const code = extractAdCode(sourceName);
  if (code) {
    const codeIdx = sourceName.lastIndexOf(`- ${code} -`);
    if (codeIdx >= 0) {
      // The segment immediately before the AI-code is the brand code
      // (e.g. "AIA"). The operator's new ad name already starts with that
      // brand prefix, so we cut the source BEFORE the brand segment and
      // attach the new ad name as-is.
      const beforeCode = sourceName.slice(0, codeIdx).trimEnd();
      const brandSepIdx = beforeCode.lastIndexOf(" - ");
      if (brandSepIdx >= 0) {
        return {
          name: `${sourceName.slice(0, brandSepIdx)} - ${trimmed}`,
          matched: true,
        };
      }
      return {
        name: `${sourceName.slice(0, codeIdx)}- ${trimmed}`,
        matched: true,
      };
    }
  }
  return { name: `${sourceName} - ${trimmed}`, matched: false };
}

function cleanAdName(name: string): string {
  return name.replace(/ – Copy$/, "").replace(/ - Copy$/, "");
}

// ─── Fallback clone via Meta /copies endpoint ──────────────────────────────
//
// When the regular cloneAdSetToCampaign flow fails (e.g. Meta rejects the
// constructed body for bid_strategy mismatch), this fallback duplicates an
// existing ad set in the destination campaign using Meta's native /copies
// endpoint — guaranteed to produce a valid ad set since Meta itself handles
// all validation. The new ad set is then renamed to the source's name and
// ads are copied from the source one at a time so the UI can show progress.

export type FallbackPrepResult = {
  ok: boolean;
  newAdSetMetaId?: string;
  newAdSetLocalId?: string;
  referenceAdSetMetaId?: string;
  referenceAdSetName?: string;
  /** Source ads to copy. UI iterates this list calling copyOneAdToAdSet. */
  srcAds?: Array<{ metaId: string; name: string; creativeId: string }>;
  /** True when source ad set lives in the same ad account as the destination
   * campaign — enables the native /{ad_id}/copies path that preserves all
   * creative-level enhancements without needing the Meta app capability. */
  sameAccount?: boolean;
  message?: string;
};

/**
 * Step 1 of fallback clone: pick a reference ad set in the destination
 * campaign, duplicate it via Meta /copies, rename to the source's name,
 * then return the new ad set + list of source ads to copy.
 */
export async function fallbackPrepCloneAdSet(opts: {
  orgId: string;
  sourceAdSetMetaId: string;
  destCampaignId: string; // local UUID
  actor: ActionActor;
}): Promise<FallbackPrepResult> {
  const [dstCampaign] = await db
    .select({
      id: campaigns.id,
      metaCampaignId: campaigns.metaCampaignId,
      adAccountId: campaigns.adAccountId,
      name: campaigns.name,
    })
    .from(campaigns)
    .where(and(eq(campaigns.orgId, opts.orgId), eq(campaigns.id, opts.destCampaignId)))
    .limit(1);
  if (!dstCampaign) return { ok: false, message: "Destination campaign not found" };

  const [dstAccount] = await db
    .select({ id: adAccounts.id, metaAccountId: adAccounts.metaAccountId, name: adAccounts.name })
    .from(adAccounts)
    .where(and(eq(adAccounts.orgId, opts.orgId), eq(adAccounts.id, dstCampaign.adAccountId)))
    .limit(1);
  if (!dstAccount) return { ok: false, message: "Destination ad account not found" };
  // Lite guard: see the matching check in the sync path above.
  if (!isLiteAdAccount(dstAccount.metaAccountId)) {
    return {
      ok: false,
      message: `Destination ad account ${dstAccount.metaAccountId} is outside LITE_AD_ACCOUNT_IDS`,
    };
  }

  // Route through the destination account's connection — that's the token
  // that needs ads_management on the dest side.
  const meta = await getMetaClientForAdAccount(opts.orgId, dstAccount.id);
  if (!meta)
    return {
      ok: false,
      message:
        "No active Meta connection found for destination ad account. Reconnect Meta.",
    };

  // Get source ad set name + account_id (latter for same-account detection).
  let src: { name: string; account_id?: string };
  try {
    src = await meta.client.getAdSetDetails(opts.sourceAdSetMetaId, callerLabel(opts.actor));
  } catch (err) {
    return { ok: false, message: `Could not fetch source ad set: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Compare source account vs destination account. dstAccount.metaAccountId
  // is "act_<numeric>" — strip the prefix before comparing to src.account_id.
  const dstNumeric = dstAccount.metaAccountId.replace(/^act_/, "");
  const sameAccount = src.account_id != null && src.account_id === dstNumeric;

  // Pick a reference ad set as the structural template for Meta's
  // `/copies` endpoint. Preferred source: the destination campaign
  // itself. If it's empty (common for freshly-created campaigns like
  // AIA HK), widen the search to ANY ad set in the destination ad
  // account — Meta `/copies` accepts `campaign_id` to retarget into the
  // empty dest campaign within the same account.
  let referenceMetaId: string | undefined;
  let referenceName: string | undefined;
  let referenceFromOtherCampaign = false;
  try {
    const destAdSets = await meta.client.listAdSetsForCampaign(dstCampaign.metaCampaignId);
    if (destAdSets.data.length > 0) {
      // Random pick — any existing ad set in the dest campaign works as
      // a structural template.
      const idx = Math.floor(Math.random() * destAdSets.data.length);
      referenceMetaId = destAdSets.data[idx].id;
      referenceName = destAdSets.data[idx].name;
    } else {
      // Empty destination campaign — borrow a template from elsewhere
      // in the destination ad account.
      const acctAdSets = await meta.client.listAdSets(dstAccount.metaAccountId);
      if (acctAdSets.data.length === 0) {
        return { ok: false, message: "Destination ad account has no ad sets anywhere — seed at least one in any campaign in Ads Manager before retrying the fallback clone." };
      }
      const idx = Math.floor(Math.random() * acctAdSets.data.length);
      referenceMetaId = acctAdSets.data[idx].id;
      referenceName = acctAdSets.data[idx].name;
      referenceFromOtherCampaign = true;
    }
  } catch (err) {
    return { ok: false, message: `Could not list destination ad sets: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Duplicate via /copies — same campaign, no deep copy, paused.
  let copiedId: string;
  try {
    const res = await meta.client.copyAdSet(
      referenceMetaId,
      {
        campaignId: dstCampaign.metaCampaignId,
        deepCopy: false,
        statusOption: "PAUSED",
      },
      callerLabel(opts.actor),
    );
    copiedId = res.copied_adset_id;
  } catch (err) {
    let detail = err instanceof Error ? err.message : String(err);
    if (err instanceof MetaApiError && err.metaError) {
      const me = err.metaError;
      if (me.error_subcode) detail += ` (subcode ${me.error_subcode})`;
      if (me.error_user_msg) detail += ` — ${me.error_user_msg}`;
      if (me.fbtrace_id) detail += ` [trace ${me.fbtrace_id}]`;
    }
    return { ok: false, message: `Could not duplicate reference ad set: ${detail}` };
  }

  // Rename the new ad set to the source's name.
  try {
    await meta.client.updateAdSet(copiedId, { name: src.name }, callerLabel(opts.actor));
  } catch (err) {
    // Renaming failure isn't fatal — the new ad set still exists, user can rename manually.
    // But surface the error so the user knows.
    const detail = err instanceof Error ? err.message : String(err);
    await journalAppend({
      orgId: opts.orgId,
      actorType: opts.actor.type,
      actorRef: actorRef(opts.actor),
      summary: `Fallback rename failed for new ad set ${copiedId}`,
      reasoning: detail,
      entityKind: "adset",
      entityId: null,
      metadata: { action: "fallback_rename_failed", newAdSetMetaId: copiedId, intendedName: src.name },
    });
  }

  // Insert local cache row.
  const [inserted] = await db
    .insert(adSets)
    .values({
      orgId: opts.orgId,
      campaignId: dstCampaign.id,
      metaAdSetId: copiedId,
      name: src.name,
      status: "PAUSED",
      effectiveStatus: "PAUSED",
      raw: { cloned_from: { srcAdSetMetaId: opts.sourceAdSetMetaId }, fallback: true, referenceAdSetMetaId: referenceMetaId } as unknown,
    })
    .onConflictDoUpdate({
      target: [adSets.orgId, adSets.metaAdSetId],
      set: {
        campaignId: dstCampaign.id,
        name: src.name,
        status: "PAUSED",
        effectiveStatus: "PAUSED",
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: adSets.id });

  // List the source's ads (to be copied client-side one at a time).
  let srcAdsList: Array<{ metaId: string; name: string; creativeId: string }>;
  try {
    const res = await meta.client.listAdsForAdSet(opts.sourceAdSetMetaId);
    srcAdsList = res.data
      .map((a) => ({ metaId: a.id, name: a.name, creativeId: a.creative?.id ?? "" }))
      .filter((a) => a.creativeId);
  } catch (err) {
    srcAdsList = [];
    await journalAppend({
      orgId: opts.orgId,
      actorType: opts.actor.type,
      actorRef: actorRef(opts.actor),
      summary: `Fallback: could not list source ads for ${opts.sourceAdSetMetaId}`,
      reasoning: err instanceof Error ? err.message : String(err),
      entityKind: "adset",
      entityId: inserted.id,
      metadata: { action: "fallback_list_src_ads_failed" },
    });
  }

  await journalAppend({
    orgId: opts.orgId,
    actorType: opts.actor.type,
    actorRef: actorRef(opts.actor),
    summary: `Fallback clone prep: duplicated "${referenceName}" → "${src.name}" in ${dstCampaign.name}`,
    entityKind: "adset",
    entityId: inserted.id,
    metadata: {
      action: "fallback_prep",
      sourceAdSetMetaId: opts.sourceAdSetMetaId,
      sourceAdSetName: src.name,
      referenceAdSetMetaId: referenceMetaId,
      referenceAdSetName: referenceName,
      referenceFromOtherCampaign,
      newAdSetMetaId: copiedId,
      destCampaignName: dstCampaign.name,
      destAccountName: dstAccount.name,
      srcAdCount: srcAdsList.length,
      sameAccount,
    },
  });

  return {
    ok: true,
    newAdSetMetaId: copiedId,
    newAdSetLocalId: inserted.id,
    referenceAdSetMetaId: referenceMetaId,
    referenceAdSetName: referenceName,
    srcAds: srcAdsList,
    sameAccount,
  };
}

export type CopyOneAdResult = {
  ok: boolean;
  newAdId?: string;
  skipped?: boolean;
  /** True if the source's creative-spec fields (multi-advertiser, browser
   * add-on, caption variations) survived the copy. False when Meta forced a
   * fallback retry without them. Undefined for skipped ads. */
  enhancementsPreserved?: boolean;
  /** Result of the post-clone preference-enforcement step (Multi-advertiser
   * OFF, Optimise destination OFF, copy variants). Undefined for skipped
   * ads. The `error` field will be populated when the patch failed; the ad
   * itself is still successfully created. */
  creativePrefsApplied?: CreativePrefsResult;
  /** True when source was IG-native AND we used the creative-rebuild
   * fallback (which produces a "Facebook post"-tagged dest creative).
   * Operator must manually click "Change post" → Instagram in Ads Manager.
   * The ad name is prefixed with 🔧 so it stands out in the ads list. */
  needsManualIgFix?: boolean;
  message?: string;
};

/**
 * Step 2 of fallback clone: copy a single source ad into the new ad set.
 * Mirrors the per-ad logic of syncAdsBetweenAdSets but for one ad at a time
 * so the client can show progress between calls.
 */
export async function copyOneAdToAdSet(opts: {
  orgId: string;
  sourceAdMetaId: string;
  sourceAdName: string;
  sourceCreativeId: string;
  destAdSetMetaId: string;
  /** When true, use Meta's native /{ad_id}/copies — preserves all creative
   * enhancements automatically. When false/undefined, build a new creative
   * in the destination account (cross-account). */
  sameAccount?: boolean;
  actor: ActionActor;
}): Promise<CopyOneAdResult> {
  // Resolve dest ad set + account.
  const [dstAdSet] = await db
    .select({ id: adSets.id, metaAdSetId: adSets.metaAdSetId, campaignId: adSets.campaignId })
    .from(adSets)
    .where(and(eq(adSets.orgId, opts.orgId), eq(adSets.metaAdSetId, opts.destAdSetMetaId)))
    .limit(1);
  if (!dstAdSet) return { ok: false, message: "Destination ad set not found" };

  const [dstCampaign] = await db
    .select({ adAccountId: campaigns.adAccountId })
    .from(campaigns)
    .where(eq(campaigns.id, dstAdSet.campaignId))
    .limit(1);
  if (!dstCampaign) return { ok: false, message: "Destination campaign not found" };

  const [dstAccount] = await db
    .select({
      id: adAccounts.id,
      metaAccountId: adAccounts.metaAccountId,
      projectId: adAccounts.projectId,
    })
    .from(adAccounts)
    .where(and(eq(adAccounts.orgId, opts.orgId), eq(adAccounts.id, dstCampaign.adAccountId)))
    .limit(1);
  if (!dstAccount) return { ok: false, message: "Destination ad account not found" };

  // Same-account copies use Meta's native /{ad_id}/copies endpoint which
  // operates against the source's account. Cross-account paths rebuild the
  // creative in the destination account. Either way, the destination is the
  // write target so we route through its connection.
  const meta = await getMetaClientForAdAccount(opts.orgId, dstAccount.id);
  if (!meta)
    return {
      ok: false,
      message:
        "No active Meta connection found for destination ad account. Reconnect Meta.",
    };

  // Skip if a duplicate code already exists in the destination ad set.
  const code = extractAdCode(opts.sourceAdName);
  if (code) {
    const existing = await db
      .select({ id: ads.id })
      .from(ads)
      .where(and(eq(ads.orgId, opts.orgId), eq(ads.adSetId, dstAdSet.id)))
      .limit(50);
    if (existing.length > 0) {
      const existingNames = await db
        .select({ name: ads.name })
        .from(ads)
        .where(and(eq(ads.orgId, opts.orgId), eq(ads.adSetId, dstAdSet.id)));
      const codes = new Set(existingNames.map((r) => extractAdCode(r.name)).filter(Boolean));
      if (codes.has(code)) return { ok: true, skipped: true };
    }
  }

  try {
    const cleanedName = cleanAdName(opts.sourceAdName);

    let newAdId: string;
    let enhancementsPreserved: boolean;

    // Always try Meta's native /{ad_id}/copies first — same logic as
    // syncAdsBetweenAdSets above. /copies works cross-account when both
    // accounts share a Business Manager and bypasses Meta's v22
    // standard_enhancements deprecation entirely.
    let nativeCopyWorked = false;
    try {
      const res = await nativeCopyAdToAdSet({
        meta,
        sourceAdMetaId: opts.sourceAdMetaId,
        destAdSetMetaId: dstAdSet.metaAdSetId,
        desiredName: cleanedName,
        calledBy: callerLabel(opts.actor),
      });
      newAdId = res.newAdId;
      enhancementsPreserved = true;
      nativeCopyWorked = true;
    } catch (copyErr) {
      if (opts.sameAccount) throw copyErr;
      newAdId = "";
      enhancementsPreserved = false;
    }

    // 🔧 prefix when rebuild fallback is used on an IG-native source —
    // mirrors the same logic in syncAdsBetweenAdSets. Operator must
    // manually swap "Change post" → Instagram in Ads Manager.
    let needsManualIgFix = false;
    if (!nativeCopyWorked && !opts.sameAccount) {
      // Cross-account fallback: rebuild creative in destination account.
      // Currently broken on existing-post creatives by Meta's v22
      // standard_enhancements deprecation; kept as defence-in-depth.
      const creative = await meta.client.getCreativeDetails(opts.sourceCreativeId, callerLabel(opts.actor));
      if (!creative.object_story_id && !creative.effective_object_story_id) {
        return { ok: false, message: `Creative has no object_story_id (or effective)` };
      }
      needsManualIgFix = Boolean(creative.instagram_permalink_url);

      const creativeBody = buildCreativeBodyFromSource(creative, cleanedName);
      const { creative: newCreative, preserved } =
        await createCreativeWithFallback(
          meta,
          dstAccount.metaAccountId,
          creativeBody,
          callerLabel(opts.actor),
        );
      enhancementsPreserved = preserved;

      const newAd = await meta.client.createAd(
        dstAccount.metaAccountId,
        {
          name: needsManualIgFix ? `🔧 ${cleanedName}` : cleanedName,
          adset_id: dstAdSet.metaAdSetId,
          status: "PAUSED",
          creative: { creative_id: newCreative.id },
        },
        callerLabel(opts.actor),
      );
      newAdId = newAd.id;
    }

    const finalName = needsManualIgFix ? `🔧 ${cleanedName}` : cleanedName;
    const [inserted] = await db
      .insert(ads)
      .values({
        orgId: opts.orgId,
        adSetId: dstAdSet.id,
        metaAdId: newAdId,
        name: finalName,
        status: "PAUSED",
        effectiveStatus: "PAUSED",
        raw: { synced_from: { srcAdMetaId: opts.sourceAdMetaId }, needsManualIgFix } as unknown,
      })
      .onConflictDoUpdate({
        target: [ads.orgId, ads.metaAdId],
        set: {
          adSetId: dstAdSet.id,
          name: finalName,
          status: "PAUSED",
          effectiveStatus: "PAUSED",
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: ads.id });

    // Enforce operator's locked-in creative preferences. Best-effort —
    // failure is logged in the journal entry's metadata but the clone is
    // already considered successful at this point.
    const creativePrefsApplied = await applyCreativePrefsToClonedAd({
      meta,
      orgId: opts.orgId,
      newAdMetaId: newAdId,
      destAdAccountMetaId: dstAccount.metaAccountId,
      sourceAdName: opts.sourceAdName,
      cleanedName,
      enhancementsPreservedFromCopy: nativeCopyWorked,
      sourceCreativeId: opts.sourceCreativeId,
      destProjectId: dstAccount.projectId ?? undefined,
      calledBy: callerLabel(opts.actor),
    });

    await journalAppend({
      orgId: opts.orgId,
      actorType: opts.actor.type,
      actorRef: actorRef(opts.actor),
      summary: `Fallback: copied ad "${cleanedName}" → ad set ${opts.destAdSetMetaId}`,
      entityKind: "ad",
      entityId: inserted.id,
      metadata: {
        action: "fallback_copy_ad",
        srcAdMetaId: opts.sourceAdMetaId,
        newAdMetaId: newAdId,
        enhancementsPreserved,
        copyMethod: opts.sameAccount ? "native" : "creative-rebuild",
        creativePrefsApplied,
      },
    });

    return {
      ok: true,
      newAdId,
      enhancementsPreserved,
      creativePrefsApplied,
      needsManualIgFix,
    };
  } catch (err) {
    let detail = err instanceof Error ? err.message : String(err);
    if (err instanceof MetaApiError && err.metaError) {
      const me = err.metaError;
      if (me.error_subcode) detail += ` (subcode ${me.error_subcode})`;
      if (me.error_user_msg) detail += ` — ${me.error_user_msg}`;
    }
    return { ok: false, message: detail };
  }
}

export type CloneAdSetResult = {
  ok: boolean;
  newAdSetMetaId?: string;
  newAdSetLocalId?: string;
  ads: SyncAdsResult;
  customAudiencesFromRef?: boolean;
  customAudiencesStripped?: boolean;
  /** True when the new ad set was mirrored from an existing ad set in the
   * destination campaign — only name + ads came from the source. */
  mirrored?: boolean;
  message?: string;
};

/** Meta rejects an ad set whose audiences the destination cannot resolve. */
const SUBCODE_UNAVAILABLE_CUSTOM_AUDIENCE = 1359207;

/**
 * Keep only the writable keys of a promoted_object. Meta echoes derived flags
 * such as `smart_pse_enabled` on reads and rejects them on writes.
 */
function sanitizePromotedObject(po: unknown): Record<string, unknown> | undefined {
  if (!po || typeof po !== "object") return undefined;
  const WRITABLE = new Set([
    "pixel_id",
    "custom_event_type",
    "custom_event_str",
    "custom_conversion_id",
    "page_id",
    "application_id",
    "object_store_url",
    "product_set_id",
    "product_catalog_id",
    "offer_id",
    "place_page_set_id",
    "offline_conversion_data_set_id",
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(po as Record<string, unknown>)) {
    if (WRITABLE.has(k) && v !== null && v !== undefined) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * True when Meta refused the create specifically because the targeting names
 * custom/lookalike audiences that are unavailable in the destination account.
 * Matches on subcode first, message text second — Meta has been inconsistent
 * about which it populates.
 */
function isUnavailableAudienceError(err: unknown): boolean {
  if (!(err instanceof MetaApiError) || !err.metaError) return false;
  const me = err.metaError;
  if (me.error_subcode === SUBCODE_UNAVAILABLE_CUSTOM_AUDIENCE) return true;
  const text = `${me.message ?? ""} ${me.error_user_msg ?? ""}`.toLowerCase();
  return text.includes("custom audiences") && text.includes("no longer available");
}

/**
 * Strip every custom/lookalike audience reference out of a targeting spec.
 *
 * Audiences are ad-account-scoped: a cross-account clone carries IDs the
 * destination cannot resolve, and audiences shared between accounts can go
 * stale independently. Recursive because the IDs hide in nested structures
 * (`flexible_spec[]`, `exclusions`), not just at the top level.
 *
 * Returns `changed: false` when there was nothing to remove, so the caller can
 * skip a retry that would fail identically.
 */
function stripAudienceRefs(targeting: unknown): {
  targeting: Record<string, unknown>;
  changed: boolean;
} {
  if (!targeting || typeof targeting !== "object") {
    return { targeting: {}, changed: false };
  }
  const AUDIENCE_KEYS = new Set([
    "custom_audiences",
    "excluded_custom_audiences",
    "lookalike_audiences",
  ]);
  let changed = false;

  const scrub = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(scrub);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (AUDIENCE_KEYS.has(k)) {
        changed = true;
        continue;
      }
      out[k] = scrub(v);
    }
    return out;
  };

  const cleaned = scrub(targeting) as Record<string, unknown>;

  // A flexible_spec entry that held nothing but audiences is now `{}`, and Meta
  // rejects empty spec objects — drop them rather than send a malformed spec.
  const spec = cleaned.flexible_spec;
  if (Array.isArray(spec)) {
    const kept = spec.filter(
      (e) => e && typeof e === "object" && Object.keys(e as object).length > 0,
    );
    if (kept.length !== spec.length) changed = true;
    if (kept.length === 0) delete cleaned.flexible_spec;
    else cleaned.flexible_spec = kept;
  }

  return { targeting: cleaned, changed };
}

/**
 * Clone a source ad set into a destination campaign as a brand-new ad set, then
 * copy every ad inside it via syncAdsBetweenAdSets. The new ad set is created
 * PAUSED and carries forward the source's targeting, budget, optimization goal,
 * billing event, bid strategy/amount, attribution spec, promoted_object,
 * destination type, pacing, and schedule.
 *
 * Cross-account clones: custom-audience IDs belong to the source account and are
 * invalid in the destination. We borrow the custom_audiences from an existing ad
 * set in the destination campaign instead, keeping all other targeting intact.
 * If Meta still rejects them as unavailable, the audiences are dropped and the
 * ad set is created without them — a paused ad set the operator can attach
 * audiences to beats a failed clone (`customAudiencesStripped` flags this).
 */
export async function cloneAdSetToCampaign(opts: {
  orgId: string;
  sourceAdSetMetaId: string;
  destCampaignId: string; // local UUID
  actor: ActionActor;
}): Promise<CloneAdSetResult> {
  const empty: SyncAdsResult = { created: 0, skipped: 0, failed: 0, errors: [] };

  // Resolve destination campaign + ad account.
  const [dstCampaign] = await db
    .select({
      id: campaigns.id,
      metaCampaignId: campaigns.metaCampaignId,
      adAccountId: campaigns.adAccountId,
      name: campaigns.name,
    })
    .from(campaigns)
    .where(and(eq(campaigns.orgId, opts.orgId), eq(campaigns.id, opts.destCampaignId)))
    .limit(1);
  if (!dstCampaign) return { ok: false, ads: empty, message: "Destination campaign not found" };

  const [dstAccount] = await db
    .select({ id: adAccounts.id, metaAccountId: adAccounts.metaAccountId, name: adAccounts.name })
    .from(adAccounts)
    .where(and(eq(adAccounts.orgId, opts.orgId), eq(adAccounts.id, dstCampaign.adAccountId)))
    .limit(1);
  if (!dstAccount) return { ok: false, ads: empty, message: "Destination ad account not found" };

  // Cross-account clones write the new ad set + ads into the destination
  // account, so we need the connection that owns that account's token.
  const meta = await getMetaClientForAdAccount(opts.orgId, dstAccount.id);
  if (!meta)
    return {
      ok: false,
      ads: empty,
      message:
        "No active Meta connection found for destination ad account. Reconnect Meta.",
    };

  // Fetch source ad set details from Meta (authoritative — DB rows may be stale).
  let src;
  try {
    src = await meta.client.getAdSetDetails(opts.sourceAdSetMetaId, callerLabel(opts.actor));
  } catch (err) {
    return {
      ok: false,
      ads: empty,
      message: `Could not fetch source ad set: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Detect cross-account: resolve source ad account via the source campaign_id.
  const [srcCampaignRow] = await db
    .select({ adAccountId: campaigns.adAccountId, name: campaigns.name })
    .from(campaigns)
    .where(and(eq(campaigns.orgId, opts.orgId), eq(campaigns.metaCampaignId, src.campaign_id)))
    .limit(1);
  const srcAccountRow = srcCampaignRow
    ? (await db
        .select({ m: adAccounts.metaAccountId, name: adAccounts.name })
        .from(adAccounts)
        .where(eq(adAccounts.id, srcCampaignRow.adAccountId))
        .limit(1))[0]
    : undefined;
  const srcMetaAccountId = srcAccountRow?.m;
  const srcAccountName = srcAccountRow?.name;
  const isCrossAccount = !!srcMetaAccountId && srcMetaAccountId !== dstAccount.metaAccountId;

  // First-try: Meta's native /{ad_set_id}/copies endpoint. When both source
  // and destination accounts share a Business Manager, this delegates the
  // entire duplication (including bid_strategy / bid_constraints / targeting
  // compatibility) to Meta itself — no reference scanning, no body crafting.
  // Falls back to the manual createAdSet path below if Meta rejects.
  let nativeCopyError: string | undefined;
  try {
    const copyResult = await meta.client.copyAdSet(
      opts.sourceAdSetMetaId,
      {
        campaignId: dstCampaign.metaCampaignId,
        deepCopy: false,
        statusOption: "PAUSED",
      },
      callerLabel(opts.actor),
    );
    if (copyResult.copied_adset_id) {
      const nativeMetaId = copyResult.copied_adset_id;
      // Meta auto-renames duplicated ad sets (typically appending " - Copy").
      // Rename to source name. Failure is non-fatal — the clone exists,
      // operator can rename in Ads Manager.
      try {
        await meta.client.updateAdSet(
          nativeMetaId,
          { name: src.name },
          callerLabel(opts.actor),
        );
      } catch {
        /* tolerate */
      }

      const [inserted] = await db
        .insert(adSets)
        .values({
          orgId: opts.orgId,
          campaignId: dstCampaign.id,
          metaAdSetId: nativeMetaId,
          name: src.name,
          status: "PAUSED",
          effectiveStatus: "PAUSED",
          dailyBudget: src.daily_budget ? Number(src.daily_budget) : null,
          lifetimeBudget: src.lifetime_budget ? Number(src.lifetime_budget) : null,
          raw: {
            cloned_from: {
              srcAdSetMetaId: opts.sourceAdSetMetaId,
              via: "/copies",
            },
          } as unknown,
        })
        .onConflictDoUpdate({
          target: [adSets.orgId, adSets.metaAdSetId],
          set: {
            campaignId: dstCampaign.id,
            name: src.name,
            status: "PAUSED",
            effectiveStatus: "PAUSED",
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: adSets.id });

      await journalAppend({
        orgId: opts.orgId,
        actorType: opts.actor.type,
        actorRef: actorRef(opts.actor),
        summary: `Cloned ad set "${src.name}" into ${dstCampaign.name} (via /copies)`,
        entityKind: "adset",
        entityId: inserted.id,
        after: { name: src.name, metaAdSetId: nativeMetaId, status: "PAUSED" },
        metadata: {
          strategy: "native_copy",
          cloneFrom: { adSetMetaId: opts.sourceAdSetMetaId },
          cloneTo: { campaignId: dstCampaign.id, adAccountId: dstAccount.id },
          isCrossAccount,
        },
      });

      const adResult = await syncAdsBetweenAdSets({
        orgId: opts.orgId,
        sourceAdSetMetaId: opts.sourceAdSetMetaId,
        destAdSetMetaId: nativeMetaId,
        actor: opts.actor,
      });

      return {
        ok: true,
        newAdSetMetaId: nativeMetaId,
        newAdSetLocalId: inserted.id,
        ads: adResult,
        customAudiencesFromRef: false,
        customAudiencesStripped: false,
        mirrored: false,
      };
    }
  } catch (err) {
    // Meta /copies rejected — fall through to the manual createAdSet path.
    // Common rejections: cross-BM accounts, specific ad-set types Meta
    // refuses to duplicate, or transient permission issues. Capture the
    // error so the eventual failure path can surface why /copies didn't
    // help (otherwise the operator only sees the manual-path 2490487
    // hint and assumes /copies was never tried).
    if (err instanceof MetaApiError && err.metaError) {
      const me = err.metaError;
      nativeCopyError =
        `${me.message ?? "unknown"}` +
        (me.error_subcode ? ` (subcode ${me.error_subcode})` : "") +
        (me.error_user_msg ? ` — ${me.error_user_msg}` : "") +
        (me.fbtrace_id ? ` [trace ${me.fbtrace_id}]` : "");
    } else {
      nativeCopyError = err instanceof Error ? err.message : String(err);
    }
  }

  // Fetch a reference ad set whose bid settings already comply with what Meta
  // expects in the destination context. Strategy:
  //   1. Prefer an ad set inside the destination CAMPAIGN (most accurate match).
  //   2. If that campaign is empty, fall back to ANY ad set in the destination
  //      ACCOUNT — better than guessing from source values when source and
  //      destination ad accounts use different bid strategies / objectives.
  //   3. For cross-account custom-audience graft, only ad sets in the destination
  //      ACCOUNT have valid CA IDs we can borrow.
  let referenceAdSet: Awaited<ReturnType<typeof meta.client.getAdSetDetails>> | undefined;
  let referenceWithCAs: typeof referenceAdSet;
  let referenceSource = "none" as "campaign" | "account" | "none";

  // Local non-null reference so the inner function keeps the narrowing.
  const metaClient = meta.client;
  async function scanForReference(adSetIds: string[], source: "campaign" | "account") {
    // When destination needs bid_constraints, prefer ad sets that actually
    // have them — picking a constraint-less ad set produces a body Meta
    // rejects with subcode 2490487. Track first-with-constraints separately
    // and upgrade referenceAdSet if we find a better one.
    for (const id of adSetIds) {
      try {
        const details = await metaClient.getAdSetDetails(id, callerLabel(opts.actor));
        const hasConstraints = !!details.bid_constraints;
        if (!referenceAdSet) {
          referenceAdSet = details;
          referenceSource = source;
        } else if (
          dstNeedsConstraints &&
          hasConstraints &&
          !referenceAdSet.bid_constraints
        ) {
          // Upgrade: replace constraint-less reference with one that has them.
          referenceAdSet = details;
          referenceSource = source;
        }
        const dT = details.targeting as Record<string, unknown> | undefined;
        if (!referenceWithCAs && Array.isArray(dT?.custom_audiences) && dT.custom_audiences.length > 0) {
          referenceWithCAs = details;
        }
        // Stop early if we have a fully-satisfying reference + CAs.
        const refIsGoodEnough =
          !!referenceAdSet &&
          (!dstNeedsConstraints || !!referenceAdSet.bid_constraints);
        if (refIsGoodEnough && referenceWithCAs) break;
      } catch { continue; }
    }
  }

  // Fetch destination campaign's bid_strategy upfront — when set to a
  // constraint-required strategy (LOWEST_COST_WITH_MIN_ROAS / COST_CAP /
  // LOWEST_COST_WITH_BID_CAP) every child ad set MUST satisfy it. We use this
  // to filter the account-wide reference search to compatible siblings.
  let dstBidStrategy: string | undefined;
  try {
    const dstCampaignDetails = await metaClient.getCampaignDetails(
      dstCampaign.metaCampaignId,
      callerLabel(opts.actor),
    );
    dstBidStrategy = dstCampaignDetails.bid_strategy;
  } catch { /* tolerate; falls back to existing scan */ }

  const constraintRequiringStrategies = new Set([
    "LOWEST_COST_WITH_MIN_ROAS",
    "COST_CAP",
    "LOWEST_COST_WITH_BID_CAP",
  ]);
  const dstNeedsConstraints =
    !!dstBidStrategy && constraintRequiringStrategies.has(dstBidStrategy);

  try {
    const destAdSets = await metaClient.listAdSetsForCampaign(dstCampaign.metaCampaignId);
    await scanForReference(destAdSets.data.map((d) => d.id), "campaign");

    // Empty destination campaign + constraint-required bid_strategy: scan the
    // destination account for ad sets in OTHER campaigns that share the same
    // bid_strategy. Those siblings have valid bid_constraints we can copy.
    if (!referenceAdSet && dstNeedsConstraints) {
      try {
        const accountCampaigns = await metaClient.listCampaigns(dstAccount.metaAccountId);
        const matchingCampaigns = accountCampaigns.data.filter(
          (c) => c.bid_strategy === dstBidStrategy && c.id !== dstCampaign.metaCampaignId,
        );
        for (const c of matchingCampaigns) {
          const siblingAdSets = await metaClient.listAdSetsForCampaign(c.id);
          if (siblingAdSets.data.length > 0) {
            await scanForReference(siblingAdSets.data.map((d) => d.id), "account");
            if (referenceAdSet) break;
          }
        }
      } catch { /* tolerate */ }
    }

    // Generic fallback: any ad set in the account (covers non-constraint cases
    // and CA graft for cross-account clones).
    if (!referenceAdSet || (isCrossAccount && !referenceWithCAs)) {
      const accountAdSets = await metaClient.listAdSets(dstAccount.metaAccountId);
      await scanForReference(accountAdSets.data.map((d) => d.id), "account");
    }

    // Source-account fallback. When the destination side has nothing usable
    // for bid_constraints (empty dest campaign, no sibling ROAS campaigns in
    // dest account) AND the source ad set itself lacks constraints, scan the
    // SOURCE account's campaigns with matching bid_strategy. Operators
    // typically have working ROAS/COST_CAP ad sets in the source account
    // already; grafting their bid_constraints here is the missing piece that
    // unblocks "first clone into an empty dest campaign" without requiring
    // a manual seed ad set in Ads Manager.
    if (
      dstNeedsConstraints &&
      (!referenceAdSet || !referenceAdSet.bid_constraints) &&
      !src.bid_constraints &&
      isCrossAccount &&
      srcMetaAccountId
    ) {
      try {
        const srcCampaigns = await metaClient.listCampaigns(srcMetaAccountId);
        const matchingSrcCampaigns = srcCampaigns.data.filter(
          (c) => c.bid_strategy === dstBidStrategy,
        );
        for (const c of matchingSrcCampaigns) {
          const siblingAdSets = await metaClient.listAdSetsForCampaign(c.id);
          if (siblingAdSets.data.length > 0) {
            await scanForReference(
              siblingAdSets.data.map((d) => d.id),
              "account",
            );
            if (referenceAdSet?.bid_constraints) break;
          }
        }
      } catch { /* tolerate; falls through to the existing failure path */ }
    }
  } catch { /* falls back to source values */ }

  // Build createAdSet body. Two strategies depending on what reference we have.
  const body: Record<string, unknown> = {
    name: src.name,
    campaign_id: dstCampaign.metaCampaignId,
    status: "PAUSED",
  };
  let customAudiencesFromRef = false;
  let customAudiencesStripped = false;
  let mirrored = false;

  if (referenceAdSet && referenceSource === "campaign") {
    mirrored = true;
    // MIRROR: the destination campaign already has an equivalent ad set, so
    // duplicate it structurally and only rename it. Per user's clarified intent:
    // "the only difference is the Ads and naming — every other setting comes
    // from the existing destination ad set." Meta has already accepted the
    // reference's exact configuration in this campaign, so re-using it
    // guarantees the create call passes.
    if (referenceAdSet.optimization_goal) body.optimization_goal = referenceAdSet.optimization_goal;
    if (referenceAdSet.billing_event) body.billing_event = referenceAdSet.billing_event;
    if (referenceAdSet.bid_amount) body.bid_amount = Number(referenceAdSet.bid_amount);
    if (referenceAdSet.bid_constraints) body.bid_constraints = referenceAdSet.bid_constraints;
    if (referenceAdSet.targeting) body.targeting = referenceAdSet.targeting;
    if (referenceAdSet.promoted_object) body.promoted_object = referenceAdSet.promoted_object;
    customAudiencesFromRef = true;
    // Reference's budget first; only fall back to source if reference has none.
    if (referenceAdSet.daily_budget) body.daily_budget = Number(referenceAdSet.daily_budget);
    else if (referenceAdSet.lifetime_budget) body.lifetime_budget = Number(referenceAdSet.lifetime_budget);
    else if (src.daily_budget) body.daily_budget = Number(src.daily_budget);
    else if (src.lifetime_budget) body.lifetime_budget = Number(src.lifetime_budget);
  } else {
    // LIGHT BORROW / SOURCE-PRIMARY: no equivalent ad set in the destination
    // campaign. Use source values, cherry-pick from any account-level reference
    // for the parts that are account-specific (CAs, pixel) or campaign-strategy-
    // specific (bid amount/constraints) where source values may not fit.
    const optGoal = referenceAdSet?.optimization_goal ?? src.optimization_goal;
    const billingEvent = referenceAdSet?.billing_event ?? src.billing_event;
    const bidAmount = referenceAdSet?.bid_amount ?? src.bid_amount;
    const bidConstraints = referenceAdSet?.bid_constraints ?? src.bid_constraints;
    if (optGoal) body.optimization_goal = optGoal;
    if (billingEvent) body.billing_event = billingEvent;
    if (bidAmount) body.bid_amount = Number(bidAmount);
    if (bidConstraints) body.bid_constraints = bidConstraints;
    if (src.daily_budget) body.daily_budget = Number(src.daily_budget);
    else if (src.lifetime_budget) body.lifetime_budget = Number(src.lifetime_budget);

    if (src.targeting) {
      const srcT = src.targeting as Record<string, unknown>;
      const needsCAGraft =
        isCrossAccount && (srcT.custom_audiences || srcT.excluded_custom_audiences);
      if (needsCAGraft) {
        const refT = referenceWithCAs?.targeting as Record<string, unknown> | undefined;
        const refCAs = refT?.custom_audiences as unknown[] | undefined;
        if (refCAs) {
          const { excluded_custom_audiences: _excl, ...restT } = srcT;
          body.targeting = { ...restT, custom_audiences: refCAs };
          customAudiencesFromRef = true;
        } else {
          const { custom_audiences: _ca, excluded_custom_audiences: _excl, ...rest } = srcT;
          body.targeting = rest;
          customAudiencesStripped = true;
        }
      } else {
        body.targeting = src.targeting;
      }
    }

    // promoted_object was previously only carried on the non-graft path, so
    // every cross-account clone of a conversion-optimised ad set was sent
    // without one and Meta rejected it with subcode 1815430 ("Please select a
    // promoted object for your ad set"). OFFSITE_CONVERSIONS ad sets require
    // it — it names the pixel and the event being optimised for.
    //
    // Pixels are business-scoped rather than ad-account-scoped, so the
    // source's pixel is normally valid in the destination account; fall back
    // to a destination reference ad set's promoted_object when it is not.
    if (!body.promoted_object) {
      const po = src.promoted_object ?? referenceAdSet?.promoted_object;
      if (po) body.promoted_object = sanitizePromotedObject(po);
    }
  }

  // Resolve the strategy used so it can be logged + returned to the UI.
  const strategy: "mirror" | "light" | "source" = mirrored
    ? "mirror"
    : referenceAdSet
      ? "light"
      : "source";

  // Append an "attempt" journal entry so every Clone click is recorded in the
  // Decision Journal — including ones that fail at createAdSet downstream.
  // Includes the full body we're about to send so failures are debuggable
  // from /journal without trawling Meta API logs.
  await journalAppend({
    orgId: opts.orgId,
    actorType: opts.actor.type,
    actorRef: actorRef(opts.actor),
    summary: `Clone ad set attempt: "${src.name}" → ${dstCampaign.name}`,
    entityKind: "adset",
    entityId: null,
    metadata: {
      action: "clone_adset_attempt",
      strategy,
      referenceSource,
      sourceAdSetMetaId: opts.sourceAdSetMetaId,
      sourceAdSetName: src.name,
      sourceCampaignName: srcCampaignRow?.name ?? null,
      sourceMetaAccountId: srcMetaAccountId ?? null,
      destCampaignId: dstCampaign.id,
      destCampaignName: dstCampaign.name,
      destMetaAccountId: dstAccount.metaAccountId,
      destAccountName: dstAccount.name,
      isCrossAccount,
      bodySent: body,
    },
  });

  let newMetaId: string;
  try {
    let res;
    try {
      res = await meta.client.createAdSet(
        dstAccount.metaAccountId,
        body,
        callerLabel(opts.actor),
      );
    } catch (createErr) {
      // Audiences the destination can't resolve are the single most common
      // cross-account rejection (LAL campaigns especially: every lookalike
      // belongs to the source account). Losing the whole ad set over it is the
      // wrong trade — drop the audiences and keep the rest of the targeting so
      // the operator gets a paused ad set to attach audiences to.
      const stripped = isUnavailableAudienceError(createErr)
        ? stripAudienceRefs(body.targeting)
        : { targeting: {}, changed: false };
      if (!stripped.changed) throw createErr;
      res = await meta.client.createAdSet(
        dstAccount.metaAccountId,
        { ...body, targeting: stripped.targeting },
        callerLabel(opts.actor),
      );
      customAudiencesFromRef = false;
      customAudiencesStripped = true;
    }
    newMetaId = res.id;
  } catch (err) {
    // Surface full Meta error details (subcode + user message) to aid debugging.
    let detail = err instanceof Error ? err.message : String(err);
    let metaErrorDetail: Record<string, unknown> | undefined;
    let actionableHint: string | undefined;
    if (err instanceof MetaApiError && err.metaError) {
      const me = err.metaError;
      metaErrorDetail = {
        message: me.message,
        code: me.code,
        error_subcode: me.error_subcode,
        error_user_title: me.error_user_title,
        error_user_msg: me.error_user_msg,
        fbtrace_id: me.fbtrace_id,
      };
      if (me.error_subcode) detail += ` (subcode ${me.error_subcode})`;
      if (me.error_user_msg) detail += ` — ${me.error_user_msg}`;
      if (me.fbtrace_id) detail += ` [trace ${me.fbtrace_id}]`;

      // Subcode 2490487 = bid_constraints required. The cleanest fix is for
      // the user to manually create one ad set in the destination campaign in
      // Ads Manager — that gives MIRROR strategy a structural template to copy.
      // Without that template (and when the account-wide reference scan finds
      // no matching ad set), we can't synthesize valid ROAS / cost-cap values.
      if (me.error_subcode === 2490487) {
        const scannedAccounts = srcAccountName
          ? `${dstAccount.name} or ${srcAccountName}`
          : dstAccount.name;
        actionableHint =
          `The destination campaign "${dstCampaign.name}" uses a bid strategy ` +
          `that requires bid_constraints (typically ROAS) but is empty, and we ` +
          `couldn't find a compatible reference ad set in ${scannedAccounts}. ` +
          `Open Ads Manager and create one seed ad set with the required bid ` +
          `settings in either account, then retry — the clone will mirror it ` +
          `and succeed.`;
      }
    }

    // Auto-fallback: when manual createAdSet rejects (most commonly subcode
    // 2490487 on a brand-new ROAS destination campaign), re-route through
    // fallbackPrepCloneAdSet which duplicates ANY existing dest-account ad set
    // via Meta's same-account /copies endpoint, renames it, then grafts the
    // source's ads in. This is the same path the /campaigns UI's "Try
    // alternative method" button uses and is the proven workaround for the
    // cross-account-clone-into-empty-campaign case.
    try {
      const prep = await fallbackPrepCloneAdSet({
        orgId: opts.orgId,
        sourceAdSetMetaId: opts.sourceAdSetMetaId,
        destCampaignId: opts.destCampaignId,
        actor: opts.actor,
      });
      if (
        prep.ok &&
        prep.newAdSetMetaId &&
        prep.newAdSetLocalId &&
        prep.srcAds
      ) {
        let created = 0;
        let skipped = 0;
        let failed = 0;
        const adErrors: string[] = [];
        for (const a of prep.srcAds) {
          const r = await copyOneAdToAdSet({
            orgId: opts.orgId,
            sourceAdMetaId: a.metaId,
            sourceAdName: a.name,
            sourceCreativeId: a.creativeId,
            destAdSetMetaId: prep.newAdSetMetaId,
            sameAccount: prep.sameAccount,
            actor: opts.actor,
          });
          if (r.ok) {
            if (r.skipped) skipped += 1;
            else created += 1;
          } else {
            failed += 1;
            if (r.message) adErrors.push(`${a.name}: ${r.message}`);
          }
        }
        await journalAppend({
          orgId: opts.orgId,
          actorType: opts.actor.type,
          actorRef: actorRef(opts.actor),
          summary: `Cloned ad set "${src.name}" into ${dstCampaign.name} (via fallback /copies)`,
          entityKind: "adset",
          entityId: prep.newAdSetLocalId,
          after: { name: src.name, metaAdSetId: prep.newAdSetMetaId, status: "PAUSED" },
          metadata: {
            strategy: "fallback_copies",
            cloneFrom: { adSetMetaId: opts.sourceAdSetMetaId },
            cloneTo: { campaignId: dstCampaign.id, adAccountId: dstAccount.id },
            referenceAdSetMetaId: prep.referenceAdSetMetaId,
            referenceAdSetName: prep.referenceAdSetName,
            adsCreated: created,
            adsSkipped: skipped,
            adsFailed: failed,
            primaryError: detail,
          },
        });
        return {
          ok: true,
          newAdSetMetaId: prep.newAdSetMetaId,
          newAdSetLocalId: prep.newAdSetLocalId,
          ads: { created, skipped, failed, errors: adErrors },
          customAudiencesFromRef: false,
          customAudiencesStripped: false,
          mirrored: false,
        };
      }
    } catch (fallbackErr) {
      // Swallow — fall through to the existing failure return. Capture
      // the fallback's own error in the journal so it's debuggable.
      const fbDetail = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      await journalAppend({
        orgId: opts.orgId,
        actorType: opts.actor.type,
        actorRef: actorRef(opts.actor),
        summary: `Auto-fallback also failed for "${src.name}" → ${dstCampaign.name}`,
        reasoning: fbDetail,
        entityKind: "adset",
        entityId: null,
        metadata: { action: "auto_fallback_failed", error: fbDetail },
      });
    }

    // Journal the failure so the user can review what went wrong from /journal.
    await journalAppend({
      orgId: opts.orgId,
      actorType: opts.actor.type,
      actorRef: actorRef(opts.actor),
      summary: `Clone ad set FAILED: "${src.name}" → ${dstCampaign.name}`,
      reasoning: actionableHint ?? detail,
      entityKind: "adset",
      entityId: null,
      metadata: {
        action: "clone_adset_failed",
        strategy,
        sourceAdSetMetaId: opts.sourceAdSetMetaId,
        sourceAdSetName: src.name,
        destCampaignName: dstCampaign.name,
        destAccountName: dstAccount.name,
        isCrossAccount,
        referenceSource,
        bodySent: body,
        metaError: metaErrorDetail,
        actionableHint,
        nativeCopyError: nativeCopyError ?? null,
      },
    });
    const nativeCopySuffix = nativeCopyError
      ? `\n\n(Meta /copies also rejected: ${nativeCopyError})`
      : "";
    return {
      ok: false,
      ads: empty,
      message: actionableHint
        ? `${actionableHint}\n\n(Meta error: ${detail})${nativeCopySuffix}`
        : `Could not create ad set in destination: ${detail}${nativeCopySuffix}`,
    };
  }

  // Insert local cache row so syncAdsBetweenAdSets can resolve it.
  const [inserted] = await db
    .insert(adSets)
    .values({
      orgId: opts.orgId,
      campaignId: dstCampaign.id,
      metaAdSetId: newMetaId,
      name: src.name,
      status: "PAUSED",
      effectiveStatus: "PAUSED",
      dailyBudget: src.daily_budget ? Number(src.daily_budget) : null,
      lifetimeBudget: src.lifetime_budget ? Number(src.lifetime_budget) : null,
      raw: { cloned_from: { srcAdSetMetaId: opts.sourceAdSetMetaId } } as unknown,
    })
    .onConflictDoUpdate({
      target: [adSets.orgId, adSets.metaAdSetId],
      set: {
        campaignId: dstCampaign.id,
        name: src.name,
        status: "PAUSED",
        effectiveStatus: "PAUSED",
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: adSets.id });

  await journalAppend({
    orgId: opts.orgId,
    actorType: opts.actor.type,
    actorRef: actorRef(opts.actor),
    summary: `Cloned ad set "${src.name}" into ${dstCampaign.name}`,
    entityKind: "adset",
    entityId: inserted.id,
    after: { name: src.name, metaAdSetId: newMetaId, status: "PAUSED" },
    metadata: {
      cloneFrom: { adSetMetaId: opts.sourceAdSetMetaId },
      cloneTo: { campaignId: dstCampaign.id, adAccountId: dstAccount.id },
    },
  });

  // Now copy all ads from source into the new ad set.
  const adResult = await syncAdsBetweenAdSets({
    orgId: opts.orgId,
    sourceAdSetMetaId: opts.sourceAdSetMetaId,
    destAdSetMetaId: newMetaId,
    actor: opts.actor,
  });

  return {
    ok: true,
    newAdSetMetaId: newMetaId,
    newAdSetLocalId: inserted.id,
    ads: adResult,
    customAudiencesFromRef,
    customAudiencesStripped,
    mirrored,
  };
}

export type CreateMatchingCampaignResult =
  | { ok: true; campaignLocalId: string; metaCampaignId: string; name: string; created: boolean }
  | { ok: false; message: string };

/**
 * Ensure the destination ad account has a campaign with the same name as the
 * source campaign. If one is already cached locally it is returned as-is
 * (idempotent — double-clicks / stale dialogs can't race duplicates);
 * otherwise a fresh PAUSED campaign is created on Meta mirroring the source's
 * authoritative objective / special_ad_categories / buying_type (no budget →
 * ABO), a matching row is inserted into our `campaigns` table, and the create
 * is journaled.
 */
export async function createMatchingCampaignInAccount(opts: {
  orgId: string;
  sourceCampaignLocalId: string; // local UUID
  destAdAccountLocalId: string; // local UUID
  actor: ActionActor;
  /** Extra journal metadata keys (merged over the defaults). */
  journalMetadata?: Record<string, unknown>;
}): Promise<CreateMatchingCampaignResult> {
  // 1. Resolve destination ad account + source campaign.
  const [dstAccount] = await db
    .select({ id: adAccounts.id, metaAccountId: adAccounts.metaAccountId, name: adAccounts.name })
    .from(adAccounts)
    .where(and(eq(adAccounts.orgId, opts.orgId), eq(adAccounts.id, opts.destAdAccountLocalId)))
    .limit(1);
  if (!dstAccount) return { ok: false, message: "Destination ad account not found" };

  const [srcCampaignRow] = await db
    .select({
      id: campaigns.id,
      metaCampaignId: campaigns.metaCampaignId,
      name: campaigns.name,
    })
    .from(campaigns)
    .where(and(eq(campaigns.orgId, opts.orgId), eq(campaigns.id, opts.sourceCampaignLocalId)))
    .limit(1);
  if (!srcCampaignRow) return { ok: false, message: "Source campaign not found" };

  // 2. Reuse an existing same-named campaign in the destination if we have one.
  //
  // Archived/deleted twins are excluded on purpose: accounts often hold an
  // ARCHIVED campaign with the same name as the live one, and the unordered
  // limit(1) could hand the clone job a dead, invisible destination. Skipping
  // them means a live twin is reused as before, and when only a dead twin
  // exists we fall through to creating a fresh PAUSED campaign that mirrors
  // the source's objective / budget / bid strategy — which is what the
  // operator actually wants the job to proceed into.
  const [existing] = await db
    .select({ id: campaigns.id, metaCampaignId: campaigns.metaCampaignId })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.orgId, opts.orgId),
        eq(campaigns.adAccountId, dstAccount.id),
        eq(campaigns.name, srcCampaignRow.name),
        notInArray(campaigns.status, ["ARCHIVED", "DELETED"]),
      ),
    )
    .limit(1);
  if (existing) {
    return {
      ok: true,
      campaignLocalId: existing.id,
      metaCampaignId: existing.metaCampaignId,
      name: srcCampaignRow.name,
      created: false,
    };
  }

  const meta = await getMetaClientForAdAccount(opts.orgId, dstAccount.id);
  if (!meta) {
    return {
      ok: false,
      message: "No active Meta connection found for destination ad account. Reconnect Meta.",
    };
  }

  // 3. Fetch Meta details so we use the authoritative objective + special_ad_categories.
  let srcCampaignMeta;
  try {
    srcCampaignMeta = await meta.client.getCampaignDetails(
      srcCampaignRow.metaCampaignId,
      callerLabel(opts.actor),
    );
  } catch (err) {
    return {
      ok: false,
      message: `Could not fetch source campaign: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!srcCampaignMeta.objective) {
    return { ok: false, message: "Source campaign has no objective — cannot clone" };
  }

  // 4. Create the destination campaign on Meta. Budget must be mirrored HERE:
  //    Meta forbids adding a campaign budget (CBO) after creation, so a CBO
  //    source cloned as a budget-less ABO shell can never be fixed later.
  const srcDailyBudget = srcCampaignMeta.daily_budget ? Number(srcCampaignMeta.daily_budget) : undefined;
  const srcLifetimeBudget = srcCampaignMeta.lifetime_budget ? Number(srcCampaignMeta.lifetime_budget) : undefined;
  let createRes;
  try {
    createRes = await meta.client.createCampaign(
      dstAccount.metaAccountId,
      {
        name: srcCampaignMeta.name,
        objective: srcCampaignMeta.objective,
        special_ad_categories: srcCampaignMeta.special_ad_categories,
        buying_type: srcCampaignMeta.buying_type,
        daily_budget: srcDailyBudget || undefined,
        lifetime_budget: srcLifetimeBudget || undefined,
        bid_strategy: srcCampaignMeta.bid_strategy || undefined,
      },
      callerLabel(opts.actor),
    );
  } catch (err) {
    return {
      ok: false,
      message: `Failed to create destination campaign: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 5. Insert local campaign row so downstream clone paths can find it by UUID.
  const [insertedCampaign] = await db
    .insert(campaigns)
    .values({
      orgId: opts.orgId,
      adAccountId: dstAccount.id,
      metaCampaignId: createRes.id,
      name: srcCampaignMeta.name,
      objective: srcCampaignMeta.objective,
      status: "PAUSED",
      effectiveStatus: "PAUSED",
      dailyBudget: srcDailyBudget ?? null,
      lifetimeBudget: srcLifetimeBudget ?? null,
      raw: srcCampaignMeta as unknown,
      lastSyncedAt: new Date(),
    })
    .returning({ id: campaigns.id });

  await journalAppend({
    orgId: opts.orgId,
    actorType: opts.actor.type,
    actorRef: actorRef(opts.actor),
    summary: `Created campaign "${srcCampaignMeta.name}" in ${dstAccount.name} as clone target`,
    reasoning: null,
    entityKind: "campaign",
    entityId: insertedCampaign.id,
    before: null,
    after: { name: srcCampaignMeta.name, metaCampaignId: createRes.id, status: "PAUSED" },
    metadata: {
      cloneFrom: { campaignId: srcCampaignRow.id },
      cloneTo: { adAccountId: dstAccount.id },
      kind: "create_clone_target_campaign",
      ...opts.journalMetadata,
    },
  });

  return {
    ok: true,
    campaignLocalId: insertedCampaign.id,
    metaCampaignId: createRes.id,
    name: srcCampaignMeta.name,
    created: true,
  };
}

/**
 * Clone an ad set into an ad account that has no same-named campaign yet.
 * Ensures the destination campaign exists via createMatchingCampaignInAccount
 * (creating a PAUSED mirror when needed), then delegates to
 * cloneAdSetToCampaign for the ad-set + ads copy.
 *
 * Partial failure: if campaign create succeeds but the inner clone fails, we
 * leave the empty paused campaign in place rather than rolling it back. Meta
 * deletes are risky and the operator can re-run the clone or delete the
 * campaign manually.
 */
export async function cloneAdSetToNewCampaignInAccount(opts: {
  orgId: string;
  sourceAdSetMetaId: string;
  destAdAccountId: string; // local UUID
  actor: ActionActor;
}): Promise<CloneAdSetResult> {
  const empty: SyncAdsResult = { created: 0, skipped: 0, failed: 0, errors: [] };

  // Resolve source ad set → source campaign (DB cached).
  const [srcAdSetRow] = await db
    .select({ id: adSets.id, campaignId: adSets.campaignId })
    .from(adSets)
    .where(and(eq(adSets.orgId, opts.orgId), eq(adSets.metaAdSetId, opts.sourceAdSetMetaId)))
    .limit(1);
  if (!srcAdSetRow) return { ok: false, ads: empty, message: "Source ad set not found" };

  const target = await createMatchingCampaignInAccount({
    orgId: opts.orgId,
    sourceCampaignLocalId: srcAdSetRow.campaignId,
    destAdAccountLocalId: opts.destAdAccountId,
    actor: opts.actor,
    journalMetadata: {
      kind: "clone_ad_set_into_new_campaign",
      sourceAdSetMetaId: opts.sourceAdSetMetaId,
    },
  });
  if (!target.ok) return { ok: false, ads: empty, message: target.message };

  // Delegate to the existing ad-set clone path with the dest campaign UUID.
  return cloneAdSetToCampaign({
    orgId: opts.orgId,
    sourceAdSetMetaId: opts.sourceAdSetMetaId,
    destCampaignId: target.campaignLocalId,
    actor: opts.actor,
  });
}

function callerLabel(actor: ActionActor): string {
  switch (actor.type) {
    case "user": return `user:${actor.userId}`;
    case "agent": return `agent:${actor.actionId}`;
    case "rule": return `rule:${actor.ruleId}`;
    case "system": return "system";
  }
}

export type CreateStarterCampaignResult =
  | { ok: true; campaignId: string; adSetId: string; campaignName: string; adSetName: string }
  | { ok: false; message: string };

/**
 * Bootstrap a brand-new, genuinely empty ad account with one PAUSED campaign
 * + one PAUSED ad set following Andi's GT1 naming convention (see
 * `lib/meta/naming.ts`). No ad is created — ads get added later through the
 * Telegram post-picker flow once a real video/copy is chosen.
 *
 * Deliberately a "bare shell": campaign-level CBO budget (RM100/day) but the
 * ad set only carries broad demographic/geo targeting (21-65+, MY) — no
 * interest, no pixel/custom-conversion, since neither is known yet. The only
 * OUTCOME_LEADS optimization_goal that needs no pixel is LEAD_GENERATION
 * (on-Facebook Instant Forms), which needs promoted_object.page_id instead —
 * so this requires the project to already have a Page assigned.
 */
export async function createStarterCampaign(opts: {
  orgId: string;
  projectId: string;
  adAccountId: string; // local UUID
  actor: ActionActor;
}): Promise<CreateStarterCampaignResult> {
  const [project] = await db
    .select({ adNamingCode: schema.projects.adNamingCode })
    .from(schema.projects)
    .where(and(eq(schema.projects.orgId, opts.orgId), eq(schema.projects.id, opts.projectId)))
    .limit(1);
  if (!project) return { ok: false, message: "Project not found" };
  const adNamingCode = project.adNamingCode?.trim();
  if (!adNamingCode) {
    return {
      ok: false,
      message: "Set this project's ad-naming code first — projects.ad_naming_code is unset.",
    };
  }

  const [page] = await db
    .select({ metaPageId: schema.pages.metaPageId })
    .from(schema.pages)
    .where(and(eq(schema.pages.orgId, opts.orgId), eq(schema.pages.projectId, opts.projectId)))
    .limit(1);
  if (!page) {
    return {
      ok: false,
      message: "No Facebook Page is attached to this project — re-run scripts/bootstrap-lite.ts, which assigns them.",
    };
  }

  const [account] = await db
    .select({ id: adAccounts.id, metaAccountId: adAccounts.metaAccountId, name: adAccounts.name })
    .from(adAccounts)
    .where(and(eq(adAccounts.orgId, opts.orgId), eq(adAccounts.id, opts.adAccountId)))
    .limit(1);
  if (!account) return { ok: false, message: "Ad account not found" };

  const meta = await getMetaClientForAdAccount(opts.orgId, account.id);
  if (!meta) {
    return {
      ok: false,
      message: "No active Meta connection found for this ad account. Reconnect Meta.",
    };
  }

  const campaignName = `${adNamingCode} - 1_Cold - Lead - GT1 - FB - MY - Interest`;
  const adSetName = `Interest - 21-65+ - MY - GT1 - Event: LDP - FB - ${adNamingCode} - AD01A - VIDEO: VideoName - COPY: YourName01`;

  let createCampaignRes;
  try {
    createCampaignRes = await meta.client.createCampaign(
      account.metaAccountId,
      {
        name: campaignName,
        objective: "OUTCOME_LEADS",
        special_ad_categories: [],
        daily_budget: 10000, // RM100/day CBO
      },
      callerLabel(opts.actor),
    );
  } catch (err) {
    return {
      ok: false,
      message: `Failed to create starter campaign: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const [insertedCampaign] = await db
    .insert(campaigns)
    .values({
      orgId: opts.orgId,
      adAccountId: account.id,
      metaCampaignId: createCampaignRes.id,
      name: campaignName,
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      effectiveStatus: "PAUSED",
      dailyBudget: 10000,
      lastSyncedAt: new Date(),
    })
    .returning({ id: campaigns.id });

  await journalAppend({
    orgId: opts.orgId,
    actorType: opts.actor.type,
    actorRef: actorRef(opts.actor),
    summary: `Created starter campaign "${campaignName}" in ${account.name}`,
    reasoning: null,
    entityKind: "campaign",
    entityId: insertedCampaign.id,
    before: null,
    after: { name: campaignName, metaCampaignId: createCampaignRes.id, status: "PAUSED" },
    metadata: { kind: "create_starter_campaign" },
  });

  let createAdSetRes;
  try {
    createAdSetRes = await meta.client.createAdSet(
      account.metaAccountId,
      {
        name: adSetName,
        campaign_id: createCampaignRes.id,
        status: "PAUSED",
        targeting: { age_min: 21, age_max: 65, geo_locations: { countries: ["MY"] } },
        optimization_goal: "LEAD_GENERATION",
        billing_event: "IMPRESSIONS",
        promoted_object: { page_id: page.metaPageId },
      },
      callerLabel(opts.actor),
    );
  } catch (err) {
    return {
      ok: false,
      message: `Created campaign but failed to create ad set: ${err instanceof Error ? err.message : String(err)}. The paused campaign was left in place.`,
    };
  }

  const [insertedAdSet] = await db
    .insert(adSets)
    .values({
      orgId: opts.orgId,
      campaignId: insertedCampaign.id,
      metaAdSetId: createAdSetRes.id,
      name: adSetName,
      status: "PAUSED",
      effectiveStatus: "PAUSED",
      optimizationGoal: "LEAD_GENERATION",
      billingEvent: "IMPRESSIONS",
      targeting: { age_min: 21, age_max: 65, geo_locations: { countries: ["MY"] } },
    })
    .returning({ id: adSets.id });

  await journalAppend({
    orgId: opts.orgId,
    actorType: opts.actor.type,
    actorRef: actorRef(opts.actor),
    summary: `Created starter ad set "${adSetName}" in ${account.name}`,
    reasoning: null,
    entityKind: "ad_set",
    entityId: insertedAdSet.id,
    before: null,
    after: { name: adSetName, metaAdSetId: createAdSetRes.id, status: "PAUSED" },
    metadata: { kind: "create_starter_campaign" },
  });

  return {
    ok: true,
    campaignId: insertedCampaign.id,
    adSetId: insertedAdSet.id,
    campaignName,
    adSetName,
  };
}

/**
 * Fetches the current `account_status` from Meta for one ad account and
 * reconciles the local `is_restricted` flag both ways:
 * - account_status === 1 (ACTIVE) → clears `isRestricted` if it was set
 * - any other status → sets `isRestricted`, preserving the original detection timestamp
 *
 * Called from the daily insights-sync cron so reinstatement is picked up
 * overnight without operator intervention. Errors are non-fatal: the caller
 * should catch and log them rather than blocking the sync.
 */
export async function checkAndUpdateAccountStatus(opts: {
  orgId: string;
  accountId: string;     // local UUID in ad_accounts
  metaAccountId: string; // act_xxx
}): Promise<{
  account_status: number;
  restricted: boolean;
  changed: boolean;
} | null> {
  const meta = await getMetaClientForAdAccount(opts.orgId, opts.accountId);
  if (!meta) return null;

  const data = await meta.client.getAdAccountStatus(opts.metaAccountId);
  const isActive = data.account_status === 1;

  if (isActive) {
    // Clear restriction — WHERE isRestricted = true makes this a no-op for healthy accounts.
    const result = await db
      .update(adAccounts)
      .set({ isRestricted: false, restrictedDetectedAt: null })
      .where(
        and(
          eq(adAccounts.id, opts.accountId),
          eq(adAccounts.isRestricted, true),
        ),
      );
    const changed = (result as { rowCount?: number }).rowCount !== 0;
    return { account_status: data.account_status, restricted: false, changed };
  } else {
    // Mark restricted — COALESCE preserves the original detection timestamp.
    const result = await db
      .update(adAccounts)
      .set({
        isRestricted: true,
        restrictedDetectedAt: sql`COALESCE(restricted_detected_at, now())`,
      })
      .where(eq(adAccounts.id, opts.accountId));
    const changed = (result as { rowCount?: number }).rowCount !== 0;
    return { account_status: data.account_status, restricted: true, changed };
  }
}
