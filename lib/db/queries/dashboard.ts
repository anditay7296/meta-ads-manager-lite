import { db, schema } from "@/lib/db/client";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

const { adAccounts, ads, adSets, campaigns, insightsDaily } = schema;

export type AdCardData = {
  id: string;
  metaAdId: string;
  name: string;
  status: string;
  effectiveStatus: string | null;
  adSetName: string;
  campaignName: string;
  adAccountName: string;
  spend: number;
  results: number;
  costPerResult: number | null;
  ctr: number | null;
  purchaseRoas: number | null;
  impressions: number;
  clicks: number;
};

/**
 * Reads cached ads + insights for every ad account in a project, aggregated
 * over the requested date range. One row per ad.
 *
 * When `adAccountId` is set, narrows the query to ads under that single
 * account (used by the per-account brief fan-out — Phase L).
 */
export async function listAdsForProjectDashboard(opts: {
  orgId: string;
  projectId: string;
  rangeStart: Date;
  rangeEnd: Date;
  /** Optional: scope to a single ad account inside the project. */
  adAccountId?: string;
  /**
   * Card ordering. "spend" (default) keeps biggest spenders first — used by the
   * brief fan-out. "newest" surfaces most-recently-created ads first within each
   * ad-account group, while keeping group order stable (by total account spend).
   */
  sort?: "newest" | "spend";
}): Promise<AdCardData[]> {
  const sort = opts.sort ?? "spend";
  const accountConds = [
    eq(adAccounts.orgId, opts.orgId),
    eq(adAccounts.projectId, opts.projectId),
  ];
  if (opts.adAccountId) accountConds.push(eq(adAccounts.id, opts.adAccountId));
  const accounts = await db
    .select({ id: adAccounts.id, name: adAccounts.name })
    .from(adAccounts)
    .where(and(...accountConds));
  if (accounts.length === 0) return [];
  const accountIds = accounts.map((a) => a.id);
  const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));

  // Pull all ads under those accounts (joined to ad_set + campaign).
  const adRows = await db
    .select({
      id: ads.id,
      metaAdId: ads.metaAdId,
      name: ads.name,
      status: ads.status,
      effectiveStatus: ads.effectiveStatus,
      adSetName: adSets.name,
      campaignName: campaigns.name,
      adAccountId: campaigns.adAccountId,
      metaCreatedTime: ads.metaCreatedTime,
      createdAt: ads.createdAt,
    })
    .from(ads)
    .innerJoin(adSets, eq(adSets.id, ads.adSetId))
    .innerJoin(campaigns, eq(campaigns.id, adSets.campaignId))
    .where(
      and(
        eq(ads.orgId, opts.orgId),
        inArray(campaigns.adAccountId, accountIds),
      ),
    );
  if (adRows.length === 0) return [];

  const adIds = adRows.map((a) => a.id);

  // Aggregate insights for those ads in the date range.
  const insightRows = await db
    .select({
      entityId: insightsDaily.entityId,
      spend: sql<string | null>`sum(${insightsDaily.spend})`,
      results: sql<number | null>`sum(${insightsDaily.results})`,
      impressions: sql<number | null>`sum(${insightsDaily.impressions})`,
      clicks: sql<number | null>`sum(${insightsDaily.clicks})`,
      // For derived metrics, weight by spend.
      costPerResult: sql<string | null>`
        case
          when sum(${insightsDaily.results}) > 0
            then sum(${insightsDaily.spend}) / sum(${insightsDaily.results})
          else null
        end
      `,
      ctr: sql<string | null>`
        case
          when sum(${insightsDaily.impressions}) > 0
            then sum(${insightsDaily.clicks})::numeric / sum(${insightsDaily.impressions}) * 100
          else null
        end
      `,
      purchaseRoas: sql<string | null>`avg(${insightsDaily.purchaseRoas})`,
    })
    .from(insightsDaily)
    .where(
      and(
        eq(insightsDaily.orgId, opts.orgId),
        eq(insightsDaily.level, "ad"),
        inArray(insightsDaily.entityId, adIds),
        gte(insightsDaily.date, opts.rangeStart),
        lte(insightsDaily.date, opts.rangeEnd),
      ),
    )
    .groupBy(insightsDaily.entityId);

  const insightMap = new Map(insightRows.map((r) => [r.entityId, r]));

  // Creation time per ad (Meta's own time, falling back to the DB row's), used
  // for the "newest" sort. createdAt is non-null; metaCreatedTime may be null
  // until backfilled by the next Meta sync.
  const createdEpochById = new Map(
    adRows.map((a) => [a.id, (a.metaCreatedTime ?? a.createdAt).getTime()]),
  );

  const cards: AdCardData[] = adRows.map((a) => {
    const ins = insightMap.get(a.id);
    return {
      id: a.id,
      metaAdId: a.metaAdId,
      name: a.name,
      status: a.status,
      effectiveStatus: a.effectiveStatus,
      adSetName: a.adSetName,
      campaignName: a.campaignName,
      adAccountName: accountNameById.get(a.adAccountId) ?? "—",
      spend: numOr0(ins?.spend),
      results: numOr0(ins?.results),
      costPerResult: ins?.costPerResult ? Number(ins.costPerResult) : null,
      ctr: ins?.ctr ? Number(ins.ctr) : null,
      purchaseRoas: ins?.purchaseRoas ? Number(ins.purchaseRoas) : null,
      impressions: numOr0(ins?.impressions),
      clicks: numOr0(ins?.clicks),
    };
  });

  if (sort === "newest") {
    // Keep account groups stable (ordered by total account spend desc) and
    // surface the most recently created ads first within each group. Ordering
    // cards this way lets AdGrid's first-appearance grouping yield one
    // contiguous, spend-ranked group per account.
    const spendByAccount = new Map<string, number>();
    for (const c of cards) {
      spendByAccount.set(
        c.adAccountName,
        (spendByAccount.get(c.adAccountName) ?? 0) + c.spend,
      );
    }
    // Final id tiebreak: the SQL has no ORDER BY, so without it rows with
    // identical creation times (bulk clones) come back in a different order
    // per request and the dashboard's "Load more" would reshuffle cards.
    return cards.sort((a, b) => {
      const sa = spendByAccount.get(a.adAccountName) ?? 0;
      const sb = spendByAccount.get(b.adAccountName) ?? 0;
      if (sb !== sa) return sb - sa;
      if (a.adAccountName !== b.adAccountName)
        return a.adAccountName < b.adAccountName ? -1 : 1;
      const tDiff =
        (createdEpochById.get(b.id) ?? 0) - (createdEpochById.get(a.id) ?? 0);
      if (tDiff !== 0) return tDiff;
      return a.id.localeCompare(b.id);
    });
  }

  // Default: sort by spend desc — biggest spenders surface first. Id
  // tiebreak keeps zero-spend ties in a stable order across requests.
  return cards.sort((a, b) => {
    if (b.spend !== a.spend) return b.spend - a.spend;
    return a.id.localeCompare(b.id);
  });
}

function numOr0(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

export type DashboardPageResult = {
  /** Paged cards after all filters (incl. view), sorted. */
  cards: AdCardData[];
  /** Count of ads matching all filters incl. view (the full set behind `cards`). */
  totalCount: number;
  /** Total ads in the project, ignoring every filter (subtitle denominator). */
  grandTotal: number;
  /** Metric totals over the post-view filtered set (KPI strip). */
  totals: { spend: number; results: number; clicks: number; impressions: number };
  /** Status tallies over the pre-view filtered set (toolbar All/Keep/Kill). */
  counts: { all: number; keep: number; kill: number };
  /** ad-account name → matching-ad count in the post-view filtered set (AdGrid headers). */
  groupTotals: Record<string, number>;
  /** Distinct campaign names in the project, unfiltered (filter dropdown). */
  campaignOptions: string[];
};

/**
 * Dashboard-page variant of {@link listAdsForProjectDashboard} that does ALL
 * filtering, status bucketing, aggregation, sorting, and the row cap in SQL —
 * so the page never pulls the project's whole ads table (~26k rows) into Node.
 * That JS-side approach timed out on Vercel; this mirrors the SQL push-down
 * done for `listCreativesForProject`.
 *
 * The heuristic status buckets duplicate `adStatus` in lib/dashboard/status.ts
 * — keep the CASE below in sync with that function.
 */
export async function listDashboardAdsPaged(opts: {
  orgId: string;
  projectId: string;
  rangeStart: Date;
  rangeEnd: Date;
  search?: string;
  campaign?: string;
  alertsOnly?: boolean;
  activeOnly?: boolean;
  view?: "all" | "keep" | "kill";
  sort?: "newest" | "spend";
  limit?: number;
}): Promise<DashboardPageResult> {
  const view = opts.view ?? "all";
  const sort = opts.sort ?? "newest";
  const search = opts.search?.trim() ?? "";
  // insights_daily.date is a DATE column; raw db.execute() won't serialize a
  // Date param for it, so pass calendar-date strings (the range boundaries
  // are UTC midnights).
  const startDate = opts.rangeStart.toISOString().slice(0, 10);
  const endDate = opts.rangeEnd.toISOString().slice(0, 10);

  // Pre-status filters (search / campaign / active) — shared by the page and
  // pre-view-count queries.
  const preConds = [
    sql`aa.org_id = ${opts.orgId}`,
    sql`aa.project_id = ${opts.projectId}`,
    sql`a.org_id = ${opts.orgId}`,
  ];
  if (search) preConds.push(sql`a.name ilike ${`%${search}%`}`);
  if (opts.campaign) preConds.push(sql`c.name = ${opts.campaign}`);
  if (opts.activeOnly) preConds.push(sql`a.effective_status = 'ACTIVE'`);
  const preWhere = sql.join(preConds, sql` and `);

  // Per-ad aggregate + traffic-light bucket. `acctSpend` (account-total spend
  // over the pre-view set) drives the "newest" account grouping order.
  const cte = sql`
    with agg as (
      select
        a.id, a.meta_ad_id as "metaAdId", a.name, a.status as "status",
        a.effective_status as "effectiveStatus",
        s.name as "adSetName", c.name as "campaignName",
        c.ad_account_id as "adAccountId", aa.name as "adAccountName",
        coalesce(a.meta_created_time, a.created_at) as "createdEpoch",
        coalesce(sum(i.spend), 0) as spend,
        coalesce(sum(i.results), 0) as results,
        coalesce(sum(i.impressions), 0) as impressions,
        coalesce(sum(i.clicks), 0) as clicks,
        case when sum(i.results) > 0 then sum(i.spend) / sum(i.results) else null end as "costPerResult",
        case when sum(i.impressions) > 0 then sum(i.clicks)::numeric / sum(i.impressions) * 100 else null end as ctr,
        avg(i.purchase_roas) as "purchaseRoas"
      from ads a
      join ad_sets s on s.id = a.ad_set_id
      join campaigns c on c.id = s.campaign_id
      join ad_accounts aa on aa.id = c.ad_account_id
      left join insights_daily i
        on i.entity_id = a.id and i.org_id = ${opts.orgId} and i.level = 'ad'
        and i.date >= ${startDate} and i.date <= ${endDate}
      where ${preWhere}
      group by a.id, s.id, c.id, aa.id
    ),
    statused as (
      select *,
        case
          when "effectiveStatus" in ('PAUSED','CAMPAIGN_PAUSED','ADSET_PAUSED','DISAPPROVED','ARCHIVED') then 'paused'
          when spend = 0 then 'neutral'
          when spend > 45 and results < 2 then 'red'
          when spend > 25 and results < 1 then 'yellow'
          else 'green'
        end as bucket,
        sum(spend) over (partition by "adAccountId") as "acctSpend"
      from agg
    )
  `;

  // Post-view status filter for the page + totals query.
  const postConds = [];
  if (opts.alertsOnly) postConds.push(sql`bucket in ('red','yellow')`);
  if (view === "keep") postConds.push(sql`bucket = 'green'`);
  else if (view === "kill") postConds.push(sql`bucket in ('red','yellow')`);
  const postWhere = postConds.length
    ? sql`where ${sql.join(postConds, sql` and `)}`
    : sql``;

  const orderBy =
    sort === "spend"
      ? sql`order by spend desc, id`
      : sql`order by "acctSpend" desc, "adAccountName" asc, "createdEpoch" desc, id`;

  // Page rows carry the post-view aggregates as window columns (computed over
  // the filtered set before LIMIT), so one query yields cards + totals +
  // totalCount + per-account counts.
  const cardsSql = sql`
    ${cte}
    select
      id, "metaAdId", name, status, "effectiveStatus",
      "adSetName", "campaignName", "adAccountName",
      spend, results, "costPerResult", ctr, "purchaseRoas", impressions, clicks,
      count(*) over () as "totalCount",
      sum(spend) over () as "totalSpend",
      sum(results) over () as "totalResults",
      sum(clicks) over () as "totalClicks",
      sum(impressions) over () as "totalImpressions",
      count(*) over (partition by "adAccountName") as "groupCount"
    from statused
    ${postWhere}
    ${orderBy}
    ${opts.limit ? sql`limit ${opts.limit}` : sql``}
  `;

  // Pre-view status tallies (excludes the view filter; keeps alertsOnly).
  const preViewWhere = opts.alertsOnly
    ? sql`where bucket in ('red','yellow')`
    : sql``;
  const countsSql = sql`
    ${cte}
    select
      count(*)::int as "all",
      count(*) filter (where bucket = 'green')::int as keep,
      count(*) filter (where bucket in ('red','yellow'))::int as kill
    from statused
    ${preViewWhere}
  `;

  // Unfiltered per-campaign counts → grand total + dropdown options.
  const campaignsSql = sql`
    select c.name as campaign, count(*)::int as cnt
    from ads a
    join ad_sets s on s.id = a.ad_set_id
    join campaigns c on c.id = s.campaign_id
    join ad_accounts aa on aa.id = c.ad_account_id
    where aa.org_id = ${opts.orgId} and aa.project_id = ${opts.projectId}
      and a.org_id = ${opts.orgId}
    group by c.name
  `;

  const [cardRows, countRows, campRows] = await Promise.all([
    db.execute(cardsSql),
    db.execute(countsSql),
    db.execute(campaignsSql),
  ]);

  const rows = cardRows as unknown as Array<Record<string, unknown>>;
  const cards: AdCardData[] = rows.map((r) => ({
    id: r.id as string,
    metaAdId: r.metaAdId as string,
    name: r.name as string,
    status: r.status as string,
    effectiveStatus: (r.effectiveStatus as string | null) ?? null,
    adSetName: r.adSetName as string,
    campaignName: r.campaignName as string,
    adAccountName: (r.adAccountName as string) ?? "—",
    spend: numOr0(r.spend as string),
    results: numOr0(r.results as string),
    costPerResult: r.costPerResult != null ? Number(r.costPerResult) : null,
    ctr: r.ctr != null ? Number(r.ctr) : null,
    purchaseRoas: r.purchaseRoas != null ? Number(r.purchaseRoas) : null,
    impressions: numOr0(r.impressions as string),
    clicks: numOr0(r.clicks as string),
  }));

  const first = rows[0];
  const totals = first
    ? {
        spend: numOr0(first.totalSpend as string),
        results: numOr0(first.totalResults as string),
        clicks: numOr0(first.totalClicks as string),
        impressions: numOr0(first.totalImpressions as string),
      }
    : { spend: 0, results: 0, clicks: 0, impressions: 0 };
  const totalCount = first ? Number(first.totalCount) : 0;

  const groupTotals: Record<string, number> = {};
  for (const r of rows) {
    groupTotals[r.adAccountName as string] = Number(r.groupCount);
  }

  const countRow = (countRows as unknown as Array<Record<string, unknown>>)[0];
  const counts = {
    all: Number(countRow?.all ?? 0),
    keep: Number(countRow?.keep ?? 0),
    kill: Number(countRow?.kill ?? 0),
  };

  const camps = campRows as unknown as Array<{ campaign: string | null; cnt: number }>;
  const grandTotal = camps.reduce((s, r) => s + Number(r.cnt), 0);
  const campaignOptions = camps
    .map((r) => r.campaign)
    .filter((n): n is string => Boolean(n))
    .sort();

  return { cards, totalCount, grandTotal, totals, counts, groupTotals, campaignOptions };
}

// adStatus moved to lib/dashboard/status.ts so client components can import it
// without dragging the postgres-js client into the client bundle.
export { adStatus } from "@/lib/dashboard/status";

export type DashboardRange = "today" | "yesterday" | "last_7d" | "last_30d" | "max";

/**
 * Translate UI date range presets into [start, end] in the org's timezone.
 * For now we assume Asia/Kuala_Lumpur (locked org default); will pull from
 * org_settings once multi-tz orgs exist.
 */
export function rangeForPreset(preset: DashboardRange): {
  start: Date;
  end: Date;
  metaPreset: "today" | "yesterday" | "last_7d" | "last_30d" | "maximum";
} {
  // Compute boundaries in KL. Date strings here are parsed as UTC midnights —
  // good enough for date-only insight rows since Meta returns date_start as
  // a calendar date in the ad account's tz, and we store it normalized at 00:00.
  const now = new Date();
  const klOffsetMs = 8 * 60 * 60 * 1000; // KL is UTC+8, no DST
  const klNow = new Date(now.getTime() + klOffsetMs);
  const todayStr = klNow.toISOString().slice(0, 10);
  const yesterdayStr = new Date(klNow.getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const sevenAgoStr = new Date(klNow.getTime() - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const thirtyAgoStr = new Date(klNow.getTime() - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  switch (preset) {
    case "today":
      return { start: parse(todayStr), end: parse(todayStr), metaPreset: "today" };
    case "yesterday":
      return { start: parse(yesterdayStr), end: parse(yesterdayStr), metaPreset: "yesterday" };
    case "last_7d":
      return { start: parse(sevenAgoStr), end: parse(yesterdayStr), metaPreset: "last_7d" };
    case "last_30d":
      return { start: parse(thirtyAgoStr), end: parse(yesterdayStr), metaPreset: "last_30d" };
    case "max":
      // Wide enough to encompass any historical insights row.
      return { start: parse("2015-01-01"), end: parse(todayStr), metaPreset: "maximum" };
  }
}

function parse(yyyymmdd: string): Date {
  return new Date(`${yyyymmdd}T00:00:00.000Z`);
}
