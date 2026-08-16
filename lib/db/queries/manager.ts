import { db, schema } from "@/lib/db/client";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { extractAdCode } from "@/lib/meta/actions";
import {
  platformFromCampaignName,
  spliceAdSetName,
  temperatureFromCampaignName,
} from "@/lib/meta/naming";

const { adAccounts, campaigns, adSets, ads, insightsDaily } = schema;

// ─── Utility types shared by SyncAdSetsDialog ─────────────────────────────

export type AdSetRow = {
  id: string;
  metaAdSetId: string;
  name: string;
  status: string;
  effectiveStatus: string | null;
};

export async function listAdSetsForCampaign(opts: {
  orgId: string;
  campaignId: string;
}): Promise<AdSetRow[]> {
  return db
    .select({
      id: schema.adSets.id,
      metaAdSetId: schema.adSets.metaAdSetId,
      name: schema.adSets.name,
      status: schema.adSets.status,
      effectiveStatus: schema.adSets.effectiveStatus,
    })
    .from(schema.adSets)
    .where(
      and(
        eq(schema.adSets.orgId, opts.orgId),
        eq(schema.adSets.campaignId, opts.campaignId),
      ),
    );
}

export async function countAdsInAdSet(opts: {
  orgId: string;
  metaAdSetId: string;
}): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.ads)
    .innerJoin(schema.adSets, eq(schema.ads.adSetId, schema.adSets.id))
    .where(
      and(
        eq(schema.ads.orgId, opts.orgId),
        eq(schema.adSets.metaAdSetId, opts.metaAdSetId),
      ),
    );
  return Number(row?.count ?? 0);
}

// ─── Shared insight aggregation type ──────────────────────────────────────

type InsightAgg = {
  spend: number;
  results: number;
  impressions: number;
  clicks: number;
  costPerResult: number | null;
  ctr: number | null;
  purchaseRoas: number | null;
  purchases: number | null;
  webPurchases: number | null;
  conversionValue: number | null;
};

const ZERO_INSIGHTS: InsightAgg = {
  spend: 0,
  results: 0,
  impressions: 0,
  clicks: 0,
  costPerResult: null,
  ctr: null,
  purchaseRoas: null,
  purchases: null,
  webPurchases: null,
  conversionValue: null,
};

/**
 * Aggregate insights_daily at level="ad" for a set of ad UUIDs, grouped by
 * an arbitrary key (adId → groupKey mapping provided by caller). Returns a
 * map of groupKey → aggregated metrics. This is the single source of truth
 * for all manager table metrics — campaign and adset totals are built by
 * summing their constituent ad-level rows.
 */
async function aggregateAdInsights(opts: {
  orgId: string;
  adIds: string[];
  adIdToGroupKey: Map<string, string>; // adId → groupKey (campaignId / adSetId / adId)
  rangeStart: Date;
  rangeEnd: Date;
}): Promise<Map<string, InsightAgg>> {
  if (opts.adIds.length === 0) return new Map();

  const rows = await db
    .select({
      entityId: insightsDaily.entityId,
      spend: sql<string | null>`sum(${insightsDaily.spend})`,
      results: sql<number | null>`sum(${insightsDaily.results})`,
      impressions: sql<number | null>`sum(${insightsDaily.impressions})`,
      clicks: sql<number | null>`sum(${insightsDaily.clicks})`,
      purchases: sql<number | null>`sum(${insightsDaily.purchases})`,
      webPurchases: sql<number | null>`sum(${insightsDaily.webPurchases})`,
      conversionValue: sql<string | null>`sum(${insightsDaily.conversionValue})`,
      purchaseRoas: sql<string | null>`
        case when sum(${insightsDaily.spend}) > 0 and sum(${insightsDaily.conversionValue}) > 0
          then sum(${insightsDaily.conversionValue}) / sum(${insightsDaily.spend})
          else avg(${insightsDaily.purchaseRoas})
        end
      `,
    })
    .from(insightsDaily)
    .where(
      and(
        eq(insightsDaily.orgId, opts.orgId),
        eq(insightsDaily.level, "ad"),
        inArray(insightsDaily.entityId, opts.adIds),
        gte(insightsDaily.date, opts.rangeStart),
        lte(insightsDaily.date, opts.rangeEnd),
      ),
    )
    .groupBy(insightsDaily.entityId);

  // Aggregate by groupKey (may be many adIds per campaign / adset group).
  const grouped = new Map<string, InsightAgg>();

  for (const r of rows) {
    const groupKey = opts.adIdToGroupKey.get(r.entityId);
    if (!groupKey) continue;

    const existing = grouped.get(groupKey) ?? { ...ZERO_INSIGHTS };
    const spend = numOr0(r.spend);
    const results = numOr0(r.results);
    const impressions = numOr0(r.impressions);
    const clicks = numOr0(r.clicks);
    const purchases = r.purchases != null ? numOr0(r.purchases) : null;
    const webPurchases = r.webPurchases != null ? numOr0(r.webPurchases) : null;
    const convValue = r.conversionValue ? Number(r.conversionValue) : null;

    grouped.set(groupKey, {
      spend: existing.spend + spend,
      results: existing.results + results,
      impressions: existing.impressions + impressions,
      clicks: existing.clicks + clicks,
      purchases:
        purchases != null || existing.purchases != null
          ? (existing.purchases ?? 0) + (purchases ?? 0)
          : null,
      webPurchases:
        webPurchases != null || existing.webPurchases != null
          ? (existing.webPurchases ?? 0) + (webPurchases ?? 0)
          : null,
      conversionValue:
        convValue != null || existing.conversionValue != null
          ? (existing.conversionValue ?? 0) + (convValue ?? 0)
          : null,
      // Derived — recomputed below after all rows are summed.
      costPerResult: null,
      ctr: null,
      purchaseRoas: null,
    });
  }

  // Compute derived metrics from final sums.
  for (const [key, ins] of grouped) {
    grouped.set(key, {
      ...ins,
      costPerResult:
        ins.results > 0 ? ins.spend / ins.results : null,
      ctr:
        ins.impressions > 0
          ? (ins.clicks / ins.impressions) * 100
          : null,
      purchaseRoas:
        ins.conversionValue != null && ins.spend > 0
          ? ins.conversionValue / ins.spend
          : null,
    });
  }

  return grouped;
}

// ─── Campaigns manager view ───────────────────────────────────────────────

export type CampaignRow = {
  id: string;
  metaCampaignId: string;
  name: string;
  objective: string | null;
  status: string;
  effectiveStatus: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  adAccountId: string;
  adAccountName: string;
  autoPauseExempt: boolean;
  autoPauseExemptReason: string | null;
  spend: number;
  results: number;
  costPerResult: number | null;
  ctr: number | null;
  purchaseRoas: number | null;
  purchases: number | null;
  webPurchases: number | null;
  conversionValue: number | null;
  impressions: number;
  clicks: number;
};

export type CampaignsByAccount = {
  adAccountId: string;
  adAccountName: string;
  metaAccountId: string;
  campaigns: CampaignRow[];
};

/**
 * Reads cached campaigns + their aggregated insights for every ad account in
 * a project, over the requested date range. Insights are aggregated from
 * level="ad" rows (the only level the sync writes) so campaign totals always
 * reflect real data. Optionally filters to ACTIVE campaigns only.
 */
export async function listCampaignsForProject(opts: {
  orgId: string;
  projectId: string;
  rangeStart: Date;
  rangeEnd: Date;
  activeOnly: boolean;
}): Promise<CampaignsByAccount[]> {
  const accounts = await db
    .select({
      id: adAccounts.id,
      name: adAccounts.name,
      metaAccountId: adAccounts.metaAccountId,
    })
    .from(adAccounts)
    .where(
      and(
        eq(adAccounts.orgId, opts.orgId),
        eq(adAccounts.projectId, opts.projectId),
      ),
    );
  if (accounts.length === 0) return [];

  const accountIds = accounts.map((a) => a.id);

  const campaignRows = await db
    .select({
      id: campaigns.id,
      metaCampaignId: campaigns.metaCampaignId,
      name: campaigns.name,
      objective: campaigns.objective,
      status: campaigns.status,
      effectiveStatus: campaigns.effectiveStatus,
      dailyBudget: campaigns.dailyBudget,
      lifetimeBudget: campaigns.lifetimeBudget,
      adAccountId: campaigns.adAccountId,
      autoPauseExempt: campaigns.autoPauseExempt,
      autoPauseExemptReason: campaigns.autoPauseExemptReason,
    })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.orgId, opts.orgId),
        inArray(campaigns.adAccountId, accountIds),
        opts.activeOnly ? eq(campaigns.effectiveStatus, "ACTIVE") : sql`true`,
      ),
    );
  if (campaignRows.length === 0) return [];

  // Fetch all ads under those campaigns to build the adId → campaignId map.
  const campaignIds = campaignRows.map((c) => c.id);
  const adRows = await db
    .select({ id: ads.id, campaignId: adSets.campaignId })
    .from(ads)
    .innerJoin(adSets, eq(adSets.id, ads.adSetId))
    .where(
      and(
        eq(ads.orgId, opts.orgId),
        inArray(adSets.campaignId, campaignIds),
      ),
    );

  const adIdToGroupKey = new Map(adRows.map((a) => [a.id, a.campaignId]));
  const insightMap = await aggregateAdInsights({
    orgId: opts.orgId,
    adIds: adRows.map((a) => a.id),
    adIdToGroupKey,
    rangeStart: opts.rangeStart,
    rangeEnd: opts.rangeEnd,
  });

  const accountIndex = new Map(accounts.map((a) => [a.id, a]));
  const grouped = new Map<string, CampaignsByAccount>();
  for (const a of accounts) {
    grouped.set(a.id, {
      adAccountId: a.id,
      adAccountName: a.name,
      metaAccountId: a.metaAccountId,
      campaigns: [],
    });
  }
  for (const c of campaignRows) {
    const ins = insightMap.get(c.id) ?? ZERO_INSIGHTS;
    const acct = accountIndex.get(c.adAccountId);
    grouped.get(c.adAccountId)!.campaigns.push({
      id: c.id,
      metaCampaignId: c.metaCampaignId,
      name: c.name,
      objective: c.objective,
      status: c.status,
      effectiveStatus: c.effectiveStatus,
      dailyBudget: c.dailyBudget != null ? Number(c.dailyBudget) : null,
      lifetimeBudget: c.lifetimeBudget != null ? Number(c.lifetimeBudget) : null,
      adAccountId: c.adAccountId,
      adAccountName: acct?.name ?? "—",
      autoPauseExempt: c.autoPauseExempt,
      autoPauseExemptReason: c.autoPauseExemptReason,
      spend: ins.spend,
      results: ins.results,
      costPerResult: ins.costPerResult,
      ctr: ins.ctr,
      purchaseRoas: ins.purchaseRoas,
      purchases: ins.purchases,
      webPurchases: ins.webPurchases,
      conversionValue: ins.conversionValue,
      impressions: ins.impressions,
      clicks: ins.clicks,
    });
  }

  for (const g of grouped.values()) {
    g.campaigns.sort((a, b) => b.spend - a.spend);
  }
  return Array.from(grouped.values());
}

// ─── Ad Sets manager view ─────────────────────────────────────────────────

export type AdSetManagerRow = {
  id: string;
  metaAdSetId: string;
  name: string;
  status: string;
  effectiveStatus: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  campaignId: string;
  campaignName: string;
  metaCampaignId: string;
  adAccountId: string;
  adAccountName: string;
  metaAccountId: string;
  spend: number;
  results: number;
  costPerResult: number | null;
  ctr: number | null;
  purchaseRoas: number | null;
  purchases: number | null;
  webPurchases: number | null;
  conversionValue: number | null;
  impressions: number;
  clicks: number;
};

export type AdSetsByCampaign = {
  campaignId: string;
  campaignName: string;
  metaCampaignId: string;
  adAccountName: string;
  metaAccountId: string;
  adSets: AdSetManagerRow[];
};

/**
 * Returns all ad sets across every campaign in the project, with aggregated
 * insights for the requested date range. Grouped by campaign for display.
 * Insights aggregate from level="ad" rows so data is always accurate.
 *
 * When `activeCampaignsOnly` is true only ad sets belonging to ACTIVE
 * campaigns are returned (ad sets themselves are always shown regardless).
 */
export async function listAdSetsForProject(opts: {
  orgId: string;
  projectId: string;
  rangeStart: Date;
  rangeEnd: Date;
  activeCampaignsOnly: boolean;
}): Promise<AdSetsByCampaign[]> {
  const accounts = await db
    .select({
      id: adAccounts.id,
      name: adAccounts.name,
      metaAccountId: adAccounts.metaAccountId,
    })
    .from(adAccounts)
    .where(
      and(
        eq(adAccounts.orgId, opts.orgId),
        eq(adAccounts.projectId, opts.projectId),
      ),
    );
  if (accounts.length === 0) return [];

  const accountIds = accounts.map((a) => a.id);

  const campaignRows = await db
    .select({
      id: campaigns.id,
      metaCampaignId: campaigns.metaCampaignId,
      name: campaigns.name,
      effectiveStatus: campaigns.effectiveStatus,
      adAccountId: campaigns.adAccountId,
    })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.orgId, opts.orgId),
        inArray(campaigns.adAccountId, accountIds),
        opts.activeCampaignsOnly
          ? eq(campaigns.effectiveStatus, "ACTIVE")
          : sql`true`,
      ),
    );
  if (campaignRows.length === 0) return [];

  const campaignIds = campaignRows.map((c) => c.id);

  const adSetRows = await db
    .select({
      id: adSets.id,
      metaAdSetId: adSets.metaAdSetId,
      name: adSets.name,
      status: adSets.status,
      effectiveStatus: adSets.effectiveStatus,
      dailyBudget: adSets.dailyBudget,
      lifetimeBudget: adSets.lifetimeBudget,
      campaignId: adSets.campaignId,
    })
    .from(adSets)
    .where(
      and(
        eq(adSets.orgId, opts.orgId),
        inArray(adSets.campaignId, campaignIds),
      ),
    );
  if (adSetRows.length === 0) return [];

  const adSetIds = adSetRows.map((s) => s.id);

  // Fetch all ads under those ad sets to build adId → adSetId map.
  const adRows = await db
    .select({ id: ads.id, adSetId: ads.adSetId })
    .from(ads)
    .where(
      and(
        eq(ads.orgId, opts.orgId),
        inArray(ads.adSetId, adSetIds),
      ),
    );

  const adIdToGroupKey = new Map(adRows.map((a) => [a.id, a.adSetId]));
  const insightMap = await aggregateAdInsights({
    orgId: opts.orgId,
    adIds: adRows.map((a) => a.id),
    adIdToGroupKey,
    rangeStart: opts.rangeStart,
    rangeEnd: opts.rangeEnd,
  });

  const accountIndex = new Map(accounts.map((a) => [a.id, a]));
  const campaignIndex = new Map(campaignRows.map((c) => [c.id, c]));

  const grouped = new Map<string, AdSetsByCampaign>();
  for (const c of campaignRows) {
    const acct = accountIndex.get(c.adAccountId);
    grouped.set(c.id, {
      campaignId: c.id,
      campaignName: c.name,
      metaCampaignId: c.metaCampaignId,
      adAccountName: acct?.name ?? "—",
      metaAccountId: acct?.metaAccountId ?? "",
      adSets: [],
    });
  }

  for (const s of adSetRows) {
    const ins = insightMap.get(s.id) ?? ZERO_INSIGHTS;
    const campaign = campaignIndex.get(s.campaignId);
    const acct = campaign ? accountIndex.get(campaign.adAccountId) : undefined;
    grouped.get(s.campaignId)?.adSets.push({
      id: s.id,
      metaAdSetId: s.metaAdSetId,
      name: s.name,
      status: s.status,
      effectiveStatus: s.effectiveStatus ?? null,
      dailyBudget: s.dailyBudget != null ? Number(s.dailyBudget) : null,
      lifetimeBudget: s.lifetimeBudget != null ? Number(s.lifetimeBudget) : null,
      campaignId: s.campaignId,
      campaignName: campaign?.name ?? "—",
      metaCampaignId: campaign?.metaCampaignId ?? "",
      adAccountId: campaign?.adAccountId ?? "",
      adAccountName: acct?.name ?? "—",
      metaAccountId: acct?.metaAccountId ?? "",
      spend: ins.spend,
      results: ins.results,
      costPerResult: ins.costPerResult,
      ctr: ins.ctr,
      purchaseRoas: ins.purchaseRoas,
      purchases: ins.purchases,
      webPurchases: ins.webPurchases,
      conversionValue: ins.conversionValue,
      impressions: ins.impressions,
      clicks: ins.clicks,
    });
  }

  for (const g of grouped.values()) {
    g.adSets.sort((a, b) => b.spend - a.spend);
  }

  return Array.from(grouped.values()).sort((a, b) =>
    a.campaignName.localeCompare(b.campaignName),
  );
}

// ─── Ads manager view ─────────────────────────────────────────────────────

export type AdManagerRow = {
  id: string;
  metaAdId: string;
  name: string;
  status: string;
  effectiveStatus: string | null;
  adSetId: string;
  adSetName: string;
  metaAdSetId: string;
  campaignId: string;
  campaignName: string;
  metaCampaignId: string;
  adAccountName: string;
  metaAccountId: string;
  spend: number;
  results: number;
  costPerResult: number | null;
  ctr: number | null;
  purchaseRoas: number | null;
  purchases: number | null;
  webPurchases: number | null;
  conversionValue: number | null;
  impressions: number;
  clicks: number;
};

export type AdsByAdSet = {
  adSetId: string;
  adSetName: string;
  metaAdSetId: string;
  campaignName: string;
  adAccountName: string;
  metaAccountId: string;
  adItems: AdManagerRow[];
};

/**
 * Returns all ads for every ad set in the project, with aggregated insights
 * for the requested date range. Grouped by ad set for display.
 * `activeCampaignsOnly` restricts to ads in ACTIVE campaigns.
 */
export async function listAdsForProjectManager(opts: {
  orgId: string;
  projectId: string;
  rangeStart: Date;
  rangeEnd: Date;
  activeCampaignsOnly: boolean;
}): Promise<AdsByAdSet[]> {
  const accounts = await db
    .select({
      id: adAccounts.id,
      name: adAccounts.name,
      metaAccountId: adAccounts.metaAccountId,
    })
    .from(adAccounts)
    .where(
      and(
        eq(adAccounts.orgId, opts.orgId),
        eq(adAccounts.projectId, opts.projectId),
      ),
    );
  if (accounts.length === 0) return [];

  const accountIds = accounts.map((a) => a.id);

  const campaignRows = await db
    .select({
      id: campaigns.id,
      metaCampaignId: campaigns.metaCampaignId,
      name: campaigns.name,
      effectiveStatus: campaigns.effectiveStatus,
      adAccountId: campaigns.adAccountId,
    })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.orgId, opts.orgId),
        inArray(campaigns.adAccountId, accountIds),
        opts.activeCampaignsOnly
          ? eq(campaigns.effectiveStatus, "ACTIVE")
          : sql`true`,
      ),
    );
  if (campaignRows.length === 0) return [];

  const campaignIds = campaignRows.map((c) => c.id);

  const adSetRows = await db
    .select({
      id: adSets.id,
      metaAdSetId: adSets.metaAdSetId,
      name: adSets.name,
      campaignId: adSets.campaignId,
    })
    .from(adSets)
    .where(
      and(
        eq(adSets.orgId, opts.orgId),
        inArray(adSets.campaignId, campaignIds),
      ),
    );
  if (adSetRows.length === 0) return [];

  const adSetIds = adSetRows.map((s) => s.id);

  const adRows = await db
    .select({
      id: ads.id,
      metaAdId: ads.metaAdId,
      name: ads.name,
      status: ads.status,
      effectiveStatus: ads.effectiveStatus,
      adSetId: ads.adSetId,
    })
    .from(ads)
    .where(
      and(
        eq(ads.orgId, opts.orgId),
        inArray(ads.adSetId, adSetIds),
      ),
    );
  if (adRows.length === 0) return [];

  const adIdToGroupKey = new Map(adRows.map((a) => [a.id, a.id])); // group by self (ad level)
  const insightMap = await aggregateAdInsights({
    orgId: opts.orgId,
    adIds: adRows.map((a) => a.id),
    adIdToGroupKey,
    rangeStart: opts.rangeStart,
    rangeEnd: opts.rangeEnd,
  });

  const accountIndex = new Map(accounts.map((a) => [a.id, a]));
  const campaignIndex = new Map(campaignRows.map((c) => [c.id, c]));
  const adSetIndex = new Map(adSetRows.map((s) => [s.id, s]));

  const grouped = new Map<string, AdsByAdSet>();
  for (const s of adSetRows) {
    const campaign = campaignIndex.get(s.campaignId);
    const acct = campaign ? accountIndex.get(campaign.adAccountId) : undefined;
    grouped.set(s.id, {
      adSetId: s.id,
      adSetName: s.name,
      metaAdSetId: s.metaAdSetId,
      campaignName: campaign?.name ?? "—",
      adAccountName: acct?.name ?? "—",
      metaAccountId: acct?.metaAccountId ?? "",
      adItems: [],
    });
  }

  for (const a of adRows) {
    const ins = insightMap.get(a.id) ?? ZERO_INSIGHTS;
    const adSet = adSetIndex.get(a.adSetId);
    const campaign = adSet ? campaignIndex.get(adSet.campaignId) : undefined;
    const acct = campaign ? accountIndex.get(campaign.adAccountId) : undefined;
    grouped.get(a.adSetId)?.adItems.push({
      id: a.id,
      metaAdId: a.metaAdId,
      name: a.name,
      status: a.status,
      effectiveStatus: a.effectiveStatus ?? null,
      adSetId: a.adSetId,
      adSetName: adSet?.name ?? "—",
      metaAdSetId: adSet?.metaAdSetId ?? "",
      campaignId: campaign?.id ?? "",
      campaignName: campaign?.name ?? "—",
      metaCampaignId: campaign?.metaCampaignId ?? "",
      adAccountName: acct?.name ?? "—",
      metaAccountId: acct?.metaAccountId ?? "",
      spend: ins.spend,
      results: ins.results,
      costPerResult: ins.costPerResult,
      ctr: ins.ctr,
      purchaseRoas: ins.purchaseRoas,
      purchases: ins.purchases,
      webPurchases: ins.webPurchases,
      conversionValue: ins.conversionValue,
      impressions: ins.impressions,
      clicks: ins.clicks,
    });
  }

  for (const g of grouped.values()) {
    g.adItems.sort((a, b) => b.spend - a.spend);
  }

  return Array.from(grouped.values()).sort((a, b) => {
    const cmp = a.campaignName.localeCompare(b.campaignName);
    return cmp !== 0 ? cmp : a.adSetName.localeCompare(b.adSetName);
  });
}

function numOr0(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

// ─── GT1 ↔ GT2 campaign comparison (chat-driven bulk clone) ────────────────

export type Gt1Gt2CloneTarget = {
  localId: string;
  metaAdSetId: string;
  name: string;
  code: string;
  computedNewName: string;
  dailyBudgetMyr: number | null;
};

export type Gt1Gt2Comparison = {
  gt1: { localId: string; metaCampaignId: string; name: string; adSetCount: number };
  gt2: {
    localId: string;
    metaCampaignId: string;
    name: string;
    adSetCount: number;
  } | null;
  adAccount: { localId: string; metaAccountId: string; name: string } | null;
  toClone: Gt1Gt2CloneTarget[];
  /** GT1 ACTIVE adsets with no extractable ad-code — can't be deduped, skipped. */
  skippedNoCode: number;
  /** GT1 ACTIVE adsets whose code already exists in GT2. */
  alreadyInGt2: number;
  /** Set when GT1↔GT2 derivation would cross platforms (FB↔IG). */
  platformError?: string;
  /** Set when the GT1 name has no "- GT1 -" segment to swap. */
  deriveError?: string;
  /** Set when the GT2 mirror campaign doesn't exist locally yet. */
  notFoundError?: string;
};

/**
 * Compare a GT1 campaign against its GT2 sibling (same name, "- GT1 -" swapped
 * to "- GT2 -") and compute which GT1 ad sets are missing from GT2.
 *
 * Mirrors the resolution + platform-parity guard in gt2-scale-proposer.ts but
 * works at the whole-campaign level: `toClone` is every GT1 ad set that is
 * ACTIVE, carries an extractable ad-code, and whose code is absent from GT2.
 * Idempotent by ad-code so re-running after a clone returns an empty `toClone`.
 *
 * Returns soft errors (deriveError / platformError / notFoundError) rather than
 * throwing, so the agent tools can surface a friendly hint to the operator.
 */
export async function buildGt1Gt2Comparison(opts: {
  orgId: string;
  gt1CampaignId: string;
}): Promise<Gt1Gt2Comparison | null> {
  const [gt1] = await db
    .select({
      id: campaigns.id,
      metaCampaignId: campaigns.metaCampaignId,
      name: campaigns.name,
      adAccountId: campaigns.adAccountId,
    })
    .from(campaigns)
    .where(
      and(eq(campaigns.orgId, opts.orgId), eq(campaigns.id, opts.gt1CampaignId)),
    )
    .limit(1);
  if (!gt1) return null;

  const gt1AdSets = await listAdSetsForCampaign({
    orgId: opts.orgId,
    campaignId: gt1.id,
  });

  const base: Gt1Gt2Comparison = {
    gt1: {
      localId: gt1.id,
      metaCampaignId: gt1.metaCampaignId,
      name: gt1.name,
      adSetCount: gt1AdSets.length,
    },
    gt2: null,
    adAccount: null,
    toClone: [],
    skippedNoCode: 0,
    alreadyInGt2: 0,
  };

  if (!gt1.name.includes("- GT1 -")) {
    return {
      ...base,
      deriveError: `Campaign "${gt1.name}" has no "- GT1 -" segment — can't derive a GT2 mirror name.`,
    };
  }

  const gt2Name = gt1.name.replace("- GT1 -", "- GT2 -");

  // Platform parity: the swap only touches the GT1↔GT2 token, so the FB/IG
  // segment carries through unchanged. Assert it to catch any future drift.
  const platform = (n: string) =>
    n.includes("- FB -") ? "FB" : n.includes("- IG -") ? "IG" : null;
  const srcPlat = platform(gt1.name);
  const mirrorPlat = platform(gt2Name);
  if (!srcPlat || srcPlat !== mirrorPlat) {
    return {
      ...base,
      platformError: `Platform mismatch deriving GT2: "${gt1.name}" → "${gt2Name}" (${srcPlat ?? "?"} vs ${mirrorPlat ?? "?"}). GT1→GT2 must stay same-platform.`,
    };
  }

  // Ad account (for preview metadata + the executor's account-scoped calls).
  const [acct] = await db
    .select({
      id: adAccounts.id,
      metaAccountId: adAccounts.metaAccountId,
      name: adAccounts.name,
    })
    .from(adAccounts)
    .where(eq(adAccounts.id, gt1.adAccountId))
    .limit(1);
  base.adAccount = acct
    ? { localId: acct.id, metaAccountId: acct.metaAccountId, name: acct.name }
    : null;

  const [gt2] = await db
    .select({
      id: campaigns.id,
      metaCampaignId: campaigns.metaCampaignId,
      name: campaigns.name,
    })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.orgId, opts.orgId),
        eq(campaigns.adAccountId, gt1.adAccountId),
        eq(campaigns.name, gt2Name),
      ),
    )
    .limit(1);
  if (!gt2) {
    return {
      ...base,
      notFoundError: `GT2 mirror campaign "${gt2Name}" not found locally. Create it in Ads Manager and run a sync first.`,
    };
  }

  // Pull GT2 ad sets with budgets so we can dedupe by code + compute spend.
  const gt2AdSets = await db
    .select({
      name: adSets.name,
    })
    .from(adSets)
    .where(and(eq(adSets.orgId, opts.orgId), eq(adSets.campaignId, gt2.id)));
  const gt2Codes = new Set(
    gt2AdSets
      .map((a) => extractAdCode(a.name))
      .filter((c): c is string => c !== null),
  );

  // Need daily budgets from GT1 ad sets for the spend banner — refetch with
  // budget column (listAdSetsForCampaign omits it).
  const gt1Full = await db
    .select({
      id: adSets.id,
      metaAdSetId: adSets.metaAdSetId,
      name: adSets.name,
      effectiveStatus: adSets.effectiveStatus,
      dailyBudget: adSets.dailyBudget,
    })
    .from(adSets)
    .where(and(eq(adSets.orgId, opts.orgId), eq(adSets.campaignId, gt1.id)));

  const toClone: Gt1Gt2CloneTarget[] = [];
  let skippedNoCode = 0;
  let alreadyInGt2 = 0;
  for (const a of gt1Full) {
    if (a.effectiveStatus !== "ACTIVE") continue;
    const code = extractAdCode(a.name);
    if (!code) {
      skippedNoCode += 1;
      continue;
    }
    if (gt2Codes.has(code)) {
      alreadyInGt2 += 1;
      continue;
    }
    toClone.push({
      localId: a.id,
      metaAdSetId: a.metaAdSetId,
      name: a.name,
      code,
      computedNewName: a.name.replace("- GT1 -", "- GT2 -"),
      dailyBudgetMyr: a.dailyBudget != null ? a.dailyBudget / 100 : null,
    });
  }

  // Create GT2 ad sets in A→Z name order — matches the operator's manual
  // "copy yesterday's new GT1 ad sets into GT2, sorted A→Z" routine. The
  // executor clones in array order, so sorting here drives creation order.
  toClone.sort((a, b) => a.computedNewName.localeCompare(b.computedNewName));

  return {
    ...base,
    gt2: {
      localId: gt2.id,
      metaCampaignId: gt2.metaCampaignId,
      name: gt2.name,
      adSetCount: gt2AdSets.length,
    },
    toClone,
    skippedNoCode,
    alreadyInGt2,
  };
}

// ─── GT1 sibling-interest parity comparison (chat-driven bulk sync) ─────────

export type Gt1SiblingCloneTarget = {
  sourceLocalId: string;
  sourceMetaAdSetId: string;
  sourceName: string;
  sourceCampaignName: string;
  code: string;
  /** Source name rewritten to the destination campaign's interest. */
  computedNewName: string;
};

export type Gt1SiblingComparison = {
  campaign: {
    localId: string;
    metaCampaignId: string;
    name: string;
    adSetCount: number;
  };
  adAccount: { localId: string; metaAccountId: string; name: string } | null;
  temperature: string;
  platform: string;
  siblings: Array<{ localId: string; name: string; adSetCount: number }>;
  /** Ad sets present in ≥1 sibling but missing from this campaign (by code). */
  toClone: Gt1SiblingCloneTarget[];
  /** Per-new-ad-set daily budget (mirrored from a dest reference), MYR. */
  referenceDailyBudgetMyr: number | null;
  /** Sibling ACTIVE ad sets skipped — no extractable ad-code to match by. */
  skippedNoCode: number;
  /** Set when the campaign name has no "- GT1 -" segment. */
  notGt1Error?: string;
  /** Set when no sibling GT1 campaign shares this account+temperature+platform. */
  noSiblingsError?: string;
  /** Set when the destination campaign has no ad set to mirror name/targeting from. */
  noReferenceError?: string;
};

/**
 * Compare a GT1 campaign against its sibling GT1 campaigns — same ad account,
 * same temperature tier (1_Cold / 2_Warm / …), same platform (FB / IG), but a
 * different interest — and compute which ad sets (by ad-code) the siblings have
 * that this campaign is missing. The sync card fills THIS campaign up to the
 * union of its siblings, re-targeted to its own interest.
 *
 * Idempotent by ad-code: codes already present here are skipped, so re-running
 * after a sync returns an empty `toClone`. Returns soft errors rather than
 * throwing so the agent tools can surface a friendly hint.
 */
export async function buildGt1SiblingComparison(opts: {
  orgId: string;
  campaignId: string;
}): Promise<Gt1SiblingComparison | null> {
  const [camp] = await db
    .select({
      id: campaigns.id,
      metaCampaignId: campaigns.metaCampaignId,
      name: campaigns.name,
      adAccountId: campaigns.adAccountId,
    })
    .from(campaigns)
    .where(
      and(eq(campaigns.orgId, opts.orgId), eq(campaigns.id, opts.campaignId)),
    )
    .limit(1);
  if (!camp) return null;

  const temperature = temperatureFromCampaignName(camp.name);
  const platform = platformFromCampaignName(camp.name);

  const [acct] = await db
    .select({
      id: adAccounts.id,
      metaAccountId: adAccounts.metaAccountId,
      name: adAccounts.name,
    })
    .from(adAccounts)
    .where(eq(adAccounts.id, camp.adAccountId))
    .limit(1);
  const adAccount = acct
    ? { localId: acct.id, metaAccountId: acct.metaAccountId, name: acct.name }
    : null;

  // Destination ad sets — used for (a) the already-present code set, (b) a
  // reference ad-set name + budget to mirror onto the new ad sets.
  const destAdSets = await db
    .select({
      name: adSets.name,
      effectiveStatus: adSets.effectiveStatus,
      dailyBudget: adSets.dailyBudget,
    })
    .from(adSets)
    .where(and(eq(adSets.orgId, opts.orgId), eq(adSets.campaignId, camp.id)));

  const base: Gt1SiblingComparison = {
    campaign: {
      localId: camp.id,
      metaCampaignId: camp.metaCampaignId,
      name: camp.name,
      adSetCount: destAdSets.length,
    },
    adAccount,
    temperature,
    platform,
    siblings: [],
    toClone: [],
    referenceDailyBudgetMyr: null,
    skippedNoCode: 0,
  };

  if (!camp.name.includes("- GT1 -")) {
    return {
      ...base,
      notGt1Error: `Campaign "${camp.name}" has no "- GT1 -" segment — sibling parity only applies to GT1 campaigns.`,
    };
  }

  const destCodes = new Set(
    destAdSets
      .map((a) => extractAdCode(a.name))
      .filter((c): c is string => c !== null),
  );

  // Pick a destination reference ad set (prefer ACTIVE, must have a code) to
  // template the new ad-set names + budget. Deterministic by name.
  const referenceCandidate =
    [...destAdSets]
      .filter((a) => extractAdCode(a.name) !== null)
      .sort((a, b) => {
        const aActive = a.effectiveStatus === "ACTIVE" ? 0 : 1;
        const bActive = b.effectiveStatus === "ACTIVE" ? 0 : 1;
        return aActive - bActive || a.name.localeCompare(b.name);
      })[0] ?? null;
  if (!referenceCandidate) {
    return {
      ...base,
      noReferenceError: `Campaign "${camp.name}" has no ad set with an ad-code to mirror targeting + naming from. Add at least one ad set there first.`,
    };
  }
  const referenceName = referenceCandidate.name;
  base.referenceDailyBudgetMyr =
    referenceCandidate.dailyBudget != null
      ? referenceCandidate.dailyBudget / 100
      : null;

  // Sibling GT1 campaigns: same account, ACTIVE, same temperature + platform,
  // different interest (different name).
  const accountActiveCampaigns = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
    })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.orgId, opts.orgId),
        eq(campaigns.adAccountId, camp.adAccountId),
        eq(campaigns.effectiveStatus, "ACTIVE"),
      ),
    );
  const siblingCampaigns = accountActiveCampaigns
    .filter(
      (c) =>
        c.id !== camp.id &&
        c.name !== camp.name &&
        c.name.includes("- GT1 -") &&
        temperatureFromCampaignName(c.name) === temperature &&
        platformFromCampaignName(c.name) === platform,
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  if (siblingCampaigns.length === 0) {
    return {
      ...base,
      noSiblingsError: `No sibling GT1 campaign found in ${adAccount?.name ?? "this account"} for ${temperature} · ${platform}. Nothing to compare against.`,
    };
  }

  // Pull every sibling's ad sets in one query, then group.
  const siblingIds = siblingCampaigns.map((c) => c.id);
  const siblingAdSets = await db
    .select({
      campaignId: adSets.campaignId,
      localId: adSets.id,
      metaAdSetId: adSets.metaAdSetId,
      name: adSets.name,
      effectiveStatus: adSets.effectiveStatus,
    })
    .from(adSets)
    .where(
      and(
        eq(adSets.orgId, opts.orgId),
        inArray(adSets.campaignId, siblingIds),
      ),
    );
  const byCampaign = new Map<string, typeof siblingAdSets>();
  for (const a of siblingAdSets) {
    const arr = byCampaign.get(a.campaignId) ?? [];
    arr.push(a);
    byCampaign.set(a.campaignId, arr);
  }

  const siblings = siblingCampaigns.map((c) => ({
    localId: c.id,
    name: c.name,
    adSetCount: (byCampaign.get(c.id) ?? []).filter(
      (a) => a.effectiveStatus === "ACTIVE",
    ).length,
  }));

  // Union of ACTIVE sibling ad-codes missing from the destination. Walk
  // siblings (sorted by name) then their ad sets (sorted by name) so the
  // chosen source for each code is deterministic across re-runs.
  const toClone: Gt1SiblingCloneTarget[] = [];
  const chosen = new Set<string>();
  let skippedNoCode = 0;
  for (const c of siblingCampaigns) {
    const list = (byCampaign.get(c.id) ?? [])
      .filter((a) => a.effectiveStatus === "ACTIVE")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const a of list) {
      const code = extractAdCode(a.name);
      if (!code) {
        skippedNoCode += 1;
        continue;
      }
      if (destCodes.has(code) || chosen.has(code)) continue;
      chosen.add(code);
      toClone.push({
        sourceLocalId: a.localId,
        sourceMetaAdSetId: a.metaAdSetId,
        sourceName: a.name,
        sourceCampaignName: c.name,
        code,
        computedNewName: spliceAdSetName(referenceName, a.name) ?? a.name,
      });
    }
  }

  return {
    ...base,
    siblings,
    toClone,
    skippedNoCode,
  };
}
