import { db, schema } from "@/lib/db/client";
import { and, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  compare,
  RuleConditionsSchema,
  type RuleConditions,
  type RuleMetric,
  type RuleWindow,
} from "./types";
import type { RuleRow } from "@/lib/db/queries/rules";

const { adAccounts, ads, adSets, campaigns, insightsDaily, projects } = schema;

export type RuleMatch = {
  adId: string;
  metaAdId: string;
  name: string;
  matched: boolean;
  /** Per-condition values that fed the eval — for journaling. */
  values: Array<{
    metric: RuleMetric;
    window: RuleWindow;
    value: number | null;
    op: string;
    threshold: number;
    pass: boolean;
  }>;
};

export type EvaluateResult = {
  matches: RuleMatch[];
  totalAdsConsidered: number;
};

/**
 * Evaluate a rule against the cached insights for the project (or all
 * accounts if appliesToProjectId is null) and return the list of ads that
 * match every condition.
 *
 * Pure read; no side effects.
 */
export async function evaluateRule(rule: RuleRow): Promise<EvaluateResult> {
  const conditions = RuleConditionsSchema.parse(rule.conditions);

  const accountIds = await resolveAccountIds(rule);
  if (accountIds.length === 0) {
    return { matches: [], totalAdsConsidered: 0 };
  }

  // Project-level ad-name code (e.g. "AIA" → only ads whose name contains
  // that token are eligible). Null when the project has no code set, or when
  // the rule is org-wide / scoped to an account whose project has no code —
  // in those cases no name filter is applied.
  const adNamingCode = await resolveAdNamingCode(rule);

  // Pull all ads under the in-scope accounts. Campaigns marked
  // `auto_pause_exempt` are filtered out at the join — the rules engine never
  // sees their ads, so neither the scheduled runner, the interval runner, nor
  // the 23:30 preview can act on them. CPL-spike alerts still come from AI
  // Guard (inline inside midday-status) and stay untouched.
  const adRows = await db
    .select({
      id: ads.id,
      metaAdId: ads.metaAdId,
      name: ads.name,
      status: ads.status,
      effectiveStatus: ads.effectiveStatus,
    })
    .from(ads)
    .innerJoin(adSets, eq(adSets.id, ads.adSetId))
    .innerJoin(campaigns, eq(campaigns.id, adSets.campaignId))
    .where(
      and(
        eq(ads.orgId, rule.orgId),
        inArray(campaigns.adAccountId, accountIds),
        eq(campaigns.autoPauseExempt, false),
        adNamingCode
          ? ilike(ads.name, `%${escapeLikePattern(adNamingCode)}%`)
          : sql`true`,
      ),
    );
  if (adRows.length === 0) {
    return { matches: [], totalAdsConsidered: 0 };
  }

  // For each unique window, pull aggregated insight metrics.
  const uniqueWindows = Array.from(new Set(conditions.map((c) => c.window)));
  const adIds = adRows.map((a) => a.id);

  // Shared with the ad-count keeper's "would a pause rule re-pause this?"
  // screen so both evaluate ads on the exact same aggregated numbers.
  const windowMetrics = await computeWindowMetrics(
    rule.orgId,
    adIds,
    uniqueWindows,
  );

  const matches: RuleMatch[] = [];
  for (const ad of adRows) {
    // Skip ads that are already paused — pausing them again is a no-op + noise.
    const isPaused =
      ad.effectiveStatus === "PAUSED" ||
      ad.effectiveStatus === "CAMPAIGN_PAUSED" ||
      ad.effectiveStatus === "ADSET_PAUSED" ||
      ad.effectiveStatus === "ARCHIVED" ||
      ad.effectiveStatus === "DISAPPROVED";
    if (isPaused) continue;

    const valueRows = conditions.map((c) => {
      const bag = windowMetrics.get(c.window)?.get(ad.id);
      const value = bag?.[c.metric] ?? null;
      const pass = compare(c.op, value, c.value);
      return {
        metric: c.metric,
        window: c.window,
        value,
        op: c.op,
        threshold: c.value,
        pass,
      };
    });
    const matched = valueRows.every((v) => v.pass);
    if (matched) {
      matches.push({
        adId: ad.id,
        metaAdId: ad.metaAdId,
        name: ad.name,
        matched,
        values: valueRows,
      });
    }
  }

  return { matches, totalAdsConsidered: adRows.length };
}

/**
 * Aggregate per-ad insight metrics for each requested window. Returns a
 * window → (adId → MetricBag) map. Exported so the ad-count keeper can screen
 * resume candidates against active pause rules using the identical numbers the
 * rule engine evaluates on — preventing the keeper from resuming an ad a
 * cut-loss rule would immediately re-pause. Pure read; no side effects.
 */
export async function computeWindowMetrics(
  orgId: string,
  adIds: string[],
  windows: RuleWindow[],
): Promise<Map<RuleWindow, Map<string, MetricBag>>> {
  const windowMetrics = new Map<RuleWindow, Map<string, MetricBag>>();
  if (adIds.length === 0) {
    for (const w of windows) windowMetrics.set(w, new Map());
    return windowMetrics;
  }
  for (const w of windows) {
    const range = rangeForWindow(w);
    if (!range) {
      windowMetrics.set(w, new Map());
      continue;
    }
    const rows = await db
      .select({
        entityId: insightsDaily.entityId,
        // Additive counts are coalesced to 0: an ad that DELIVERED that window
        // (it has at least one insight row, so it's in this grouped result)
        // but logged no leads has results = NULL in Meta's payload, not 0.
        // Without the coalesce, `results < 2` evaluates compare(<, null, 2) =
        // false and the cut-loss rule silently skips zero-lead burners while
        // still pausing 1-lead ads — backwards. Ads that did NOT deliver have
        // no row here at all, so they stay absent → metric null → rules don't
        // fire on them (unchanged; protects brand-new / unsynced ads). Derived
        // ratios below stay null when undefined (can't divide by zero leads).
        spend: sql<string | null>`coalesce(sum(${insightsDaily.spend}), 0)`,
        results: sql<number | null>`coalesce(sum(${insightsDaily.results}), 0)`,
        impressions: sql<number | null>`coalesce(sum(${insightsDaily.impressions}), 0)`,
        reach: sql<number | null>`coalesce(sum(${insightsDaily.reach}), 0)`,
        clicks: sql<number | null>`coalesce(sum(${insightsDaily.clicks}), 0)`,
        // Derived
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
        cpm: sql<string | null>`avg(${insightsDaily.cpm})`,
        cpc: sql<string | null>`avg(${insightsDaily.cpc})`,
        purchaseRoas: sql<string | null>`avg(${insightsDaily.purchaseRoas})`,
        frequency: sql<string | null>`
          case
            when sum(${insightsDaily.reach}) > 0
              then sum(${insightsDaily.impressions})::numeric / sum(${insightsDaily.reach})
            else null
          end
        `,
      })
      .from(insightsDaily)
      .where(
        and(
          eq(insightsDaily.orgId, orgId),
          eq(insightsDaily.level, "ad"),
          inArray(insightsDaily.entityId, adIds),
          gte(insightsDaily.date, range.start),
          lte(insightsDaily.date, range.end),
        ),
      )
      .groupBy(insightsDaily.entityId);
    const map = new Map<string, MetricBag>();
    for (const r of rows) {
      map.set(r.entityId, {
        spend: numOrNull(r.spend),
        results: numOrNull(r.results),
        impressions: numOrNull(r.impressions),
        clicks: numOrNull(r.clicks),
        cost_per_result: numOrNull(r.costPerResult),
        ctr: numOrNull(r.ctr),
        cpm: numOrNull(r.cpm),
        cpc: numOrNull(r.cpc),
        purchase_roas: numOrNull(r.purchaseRoas),
        frequency: numOrNull(r.frequency),
      });
    }
    windowMetrics.set(w, map);
  }
  return windowMetrics;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

export type MetricBag = Record<RuleMetric, number | null>;

export async function resolveAccountIds(rule: RuleRow): Promise<string[]> {
  if (rule.appliesToAdAccountId) return [rule.appliesToAdAccountId];
  const where = rule.appliesToProjectId
    ? and(
        eq(adAccounts.orgId, rule.orgId),
        eq(adAccounts.projectId, rule.appliesToProjectId),
      )
    : eq(adAccounts.orgId, rule.orgId);
  const rows = await db
    .select({ id: adAccounts.id })
    .from(adAccounts)
    .where(where);
  return rows.map((r) => r.id);
}

/**
 * Returns the project-level ad-name code (e.g. "AIA") that the rule should
 * filter ads by, or null when no filter applies. Project-scoped rules look
 * up the code directly; account-scoped rules resolve the code via the
 * account's parent project. Org-wide rules and orphan accounts return null
 * (no filter — back-compat default).
 */
async function resolveAdNamingCode(rule: RuleRow): Promise<string | null> {
  if (rule.appliesToProjectId) {
    const [proj] = await db
      .select({ code: projects.adNamingCode })
      .from(projects)
      .where(eq(projects.id, rule.appliesToProjectId))
      .limit(1);
    return normalizeCode(proj?.code);
  }
  if (rule.appliesToAdAccountId) {
    const [row] = await db
      .select({ code: projects.adNamingCode })
      .from(adAccounts)
      .innerJoin(projects, eq(projects.id, adAccounts.projectId))
      .where(eq(adAccounts.id, rule.appliesToAdAccountId))
      .limit(1);
    return normalizeCode(row?.code);
  }
  return null;
}

function normalizeCode(c: string | null | undefined): string | null {
  const trimmed = c?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Escape LIKE/ILIKE wildcards in a user-controlled substring so a code like
 * "10%" doesn't accidentally turn into a wildcard pattern.
 */
function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const KL_OFFSET_MS = 8 * 60 * 60 * 1000;

function rangeForWindow(
  w: RuleWindow,
): { start: Date; end: Date } | null {
  if (w === "lifetime") return null;
  const now = new Date();
  const klNow = new Date(now.getTime() + KL_OFFSET_MS);
  const todayStr = klNow.toISOString().slice(0, 10);
  const yesterdayStr = new Date(klNow.getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  switch (w) {
    case "today":
      return { start: parseDate(todayStr), end: parseDate(todayStr) };
    case "yesterday":
      return { start: parseDate(yesterdayStr), end: parseDate(yesterdayStr) };
    case "last_3d":
      return {
        start: parseDate(addDays(klNow, -3)),
        end: parseDate(yesterdayStr),
      };
    case "last_7d":
      return {
        start: parseDate(addDays(klNow, -7)),
        end: parseDate(yesterdayStr),
      };
    case "last_30d":
      return {
        start: parseDate(addDays(klNow, -30)),
        end: parseDate(yesterdayStr),
      };
  }
}

function addDays(d: Date, n: number): string {
  return new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

function parseDate(yyyymmdd: string): Date {
  return new Date(`${yyyymmdd}T00:00:00.000Z`);
}

function numOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}
