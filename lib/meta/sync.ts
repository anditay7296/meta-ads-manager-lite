import { db, schema } from "@/lib/db/client";
import { MetaClient } from "@/lib/meta/client";
import { makeAuditWriter } from "@/lib/meta/get-client";
import { decryptToken } from "@/lib/crypto/tokens";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { MetaInsightsRow } from "@/lib/meta/types";
import { syncCreativesForAccount } from "@/lib/meta/creatives-sync";
import { filterToLiteAccounts } from "@/lib/lite/accounts";

/**
 * Returns the most recent `ad_accounts.last_synced_at` across the project's
 * accounts, or null if never synced. Used by the three "today-sync" watchers
 * (pace, midday, evening) to skip a redundant sync when another watcher just
 * refreshed the same project — eliminates the structural overlap where pace
 * at 12:00 UTC + midday at 06:00 UTC + evening at 10:00 UTC could otherwise
 * re-fetch identical numbers within 10 minutes.
 *
 * Reads the account-level stamp (bumped once per syncOneAccount) rather than
 * max(ads.last_synced_at): per-row stamps only advance when a row actually
 * changes now that the upserts skip unchanged rows.
 */
export async function getProjectLastSyncedAt(opts: {
  orgId: string;
  projectId: string;
}): Promise<Date | null> {
  const [row] = await db
    .select({
      latest: sql<Date | null>`max(${schema.adAccounts.lastSyncedAt})`,
    })
    .from(schema.adAccounts)
    .where(
      and(
        eq(schema.adAccounts.orgId, opts.orgId),
        eq(schema.adAccounts.projectId, opts.projectId),
      ),
    );
  return row?.latest ? new Date(row.latest) : null;
}

/**
 * True if the project was synced within the last `freshnessMs` (default 10
 * minutes). Cheap helper for the four watchers; falsey return = "go ahead
 * and sync".
 */
export async function isProjectSyncFresh(opts: {
  orgId: string;
  projectId: string;
  freshnessMs?: number;
}): Promise<boolean> {
  const freshness = opts.freshnessMs ?? 10 * 60 * 1000;
  const latest = await getProjectLastSyncedAt({
    orgId: opts.orgId,
    projectId: opts.projectId,
  });
  if (!latest) return false;
  return latest.getTime() >= Date.now() - freshness;
}

const { campaigns, adSets, ads, insightsDaily, adAccounts, metaConnections } =
  schema;

type StatusEnum =
  | "ACTIVE"
  | "PAUSED"
  | "DELETED"
  | "ARCHIVED"
  | "PENDING_REVIEW"
  | "DISAPPROVED"
  | "PREAPPROVED"
  | "PENDING_BILLING_INFO"
  | "CAMPAIGN_PAUSED"
  | "ADSET_PAUSED"
  | "WITH_ISSUES"
  | "IN_PROCESS";

const VALID_STATUSES = new Set<StatusEnum>([
  "ACTIVE",
  "PAUSED",
  "DELETED",
  "ARCHIVED",
  "PENDING_REVIEW",
  "DISAPPROVED",
  "PREAPPROVED",
  "PENDING_BILLING_INFO",
  "CAMPAIGN_PAUSED",
  "ADSET_PAUSED",
  "WITH_ISSUES",
  "IN_PROCESS",
]);

function status(s: string | undefined | null): StatusEnum {
  if (s && VALID_STATUSES.has(s as StatusEnum)) return s as StatusEnum;
  return "ARCHIVED";
}

// Postgres' wire protocol caps each query at 65 534 parameters. A single
// upsert of all rows from a multi-account / 7-day insights pull blows past
// that cap easily (insights_daily alone has ~20 columns — 3 200+ rows tips
// over). Chunk every bulk insert at 500 rows so even 30-column tables stay
// well under the limit.
const UPSERT_CHUNK_ROWS = 500;

// Local-only marker keys that clone/boost/factory flows stash inside
// ad_sets.raw / ads.raw (e.g. boostedFrom drives the GT2 proposer's dedup
// filter). The sync upserts merge these back over the fresh Meta payload so
// a routine re-sync can never erase them. jsonb_strip_nulls drops the keys
// that aren't present on the existing row, so synced-only rows merge `{}`.
const adSetRawMarkers = sql`jsonb_strip_nulls(jsonb_build_object(
  'boostedFrom', ${adSets.raw}->'boostedFrom',
  'clonedFrom', ${adSets.raw}->'clonedFrom',
  'cloned_from', ${adSets.raw}->'cloned_from',
  'synced_from', ${adSets.raw}->'synced_from',
  'factory', ${adSets.raw}->'factory',
  'fallback', ${adSets.raw}->'fallback',
  'referenceAdSetMetaId', ${adSets.raw}->'referenceAdSetMetaId',
  'needsManualIgFix', ${adSets.raw}->'needsManualIgFix'
))`;

const adRawMarkers = sql`jsonb_strip_nulls(jsonb_build_object(
  'boostedFrom', ${ads.raw}->'boostedFrom',
  'synced_from', ${ads.raw}->'synced_from',
  'factory', ${ads.raw}->'factory',
  'needsManualIgFix', ${ads.raw}->'needsManualIgFix'
))`;

function* chunked<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

export type SyncResult = {
  campaigns: number;
  adSets: number;
  ads: number;
  insightsRows: number;
  creatives: number;
};

/**
 * Sync a SINGLE ad account by its UUID. Resolves the connection, decrypts
 * the token, instantiates a per-account MetaClient + audit batch, calls
 * `syncOneAccount`, and flushes the batch. Returns the per-account
 * SyncResult on success, or null if the connection is missing/revoked.
 *
 * This is the per-account entry point introduced for Inngest's per-account
 * `step.run` checkpoint pattern (`insights-sync-daily-kl`): each account
 * is its own independent unit of work with its own ~300s Vercel budget,
 * its own retry, and its own alert. The previous project-level entry point
 * (`syncProject`) wrapped all 5 accounts of a project in a single 300s
 * Vercel function, so the slowest account dominated the budget and the
 * tail-end accounts silently skipped (2026-05-31 incident).
 *
 * Audit batching is now per-account — drops the cross-account batch-sharing
 * micro-optimization, gains independent failure units. The audit-write cost
 * of one extra bulk-INSERT per account is dwarfed by the Vercel-timeout
 * savings.
 *
 * Throws on Meta API failures so callers can decide to retry; returns null
 * only when there's nothing to sync (no connection / revoked token).
 */
export async function syncOneAccountById(opts: {
  orgId: string;
  adAccountId: string;
  datePreset?: "yesterday" | "today" | "last_7d" | "last_30d";
}): Promise<SyncResult | null> {
  const datePreset = opts.datePreset ?? "yesterday";

  const [acct] = await db
    .select({
      id: adAccounts.id,
      metaAccountId: adAccounts.metaAccountId,
      connectionId: adAccounts.connectionId,
      tokenEncrypted: metaConnections.tokenEncrypted,
      revokedAt: metaConnections.revokedAt,
    })
    .from(adAccounts)
    .leftJoin(
      metaConnections,
      eq(metaConnections.id, adAccounts.connectionId),
    )
    .where(
      and(
        eq(adAccounts.orgId, opts.orgId),
        eq(adAccounts.id, opts.adAccountId),
      ),
    );

  if (!acct) {
    console.warn(
      `[syncOneAccountById] ad account ${opts.adAccountId} not found for org ${opts.orgId}`,
    );
    return null;
  }
  if (!acct.connectionId || !acct.tokenEncrypted || acct.revokedAt) {
    console.warn(
      `[syncOneAccountById] skipping ${acct.metaAccountId} — connection ${acct.connectionId ?? "<null>"} is missing or revoked`,
    );
    return null;
  }

  const client = new MetaClient({
    accessToken: decryptToken(acct.tokenEncrypted),
    orgId: opts.orgId,
    connectionId: acct.connectionId,
    audit: makeAuditWriter({
      orgId: opts.orgId,
      connectionId: acct.connectionId,
    }),
  });
  client.beginAuditBatch();

  try {
    return await syncOneAccount({
      client,
      orgId: opts.orgId,
      adAccount: { id: acct.id, metaAccountId: acct.metaAccountId },
      datePreset,
    });
  } finally {
    try {
      await client.flushAudit();
    } catch (e) {
      console.warn(
        `[syncOneAccountById] audit flush failed for ${acct.metaAccountId}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}

/**
 * Pulls campaigns, ad sets, ads, and yesterday/today/last_7d insights for
 * every ad account assigned to the given project. Caches everything to the
 * insights_daily / campaigns / ad_sets / ads tables.
 *
 * Thin wrapper over `syncOneAccountById` — fan-out across the project's
 * accounts via Promise.all so non-Inngest callers (Settings UI "Sync now"
 * server action, dev/setup smoke test, dashboard refresh) get the
 * project-level aggregate they expect. Inngest's `insights-sync-daily-kl`
 * cron does NOT use this — it iterates per-account directly with its own
 * `step.run` per account so each account gets its own Vercel timeout
 * budget (see `lib/inngest/insights-sync.ts`).
 *
 * Connection routing: each ad account is queried using the MetaClient
 * derived from its own `connectionId`. Accounts with revoked connections
 * skip silently. Partial success beats total skip — one failing account
 * never aborts the others (the 2026-05-24 incident where AIA Ads Acc +
 * AIA (HK) silently went 3 days without insights is the canonical case
 * this guards against).
 */
export async function syncProject(opts: {
  orgId: string;
  projectId: string;
  datePreset?: "yesterday" | "today" | "last_7d" | "last_30d";
}): Promise<SyncResult> {
  const datePreset = opts.datePreset ?? "yesterday";

  const projectAccounts = await db
    .select({ id: adAccounts.id, metaAccountId: adAccounts.metaAccountId })
    .from(adAccounts)
    .where(
      and(
        eq(adAccounts.orgId, opts.orgId),
        eq(adAccounts.projectId, opts.projectId),
      ),
    );

  // Lite guard: never sync an account outside the allowlist, even if one
  // somehow ends up attached to the project. Keeps "only the allowlisted
  // accounts" true regardless of what is in the table.
  const accountRows = filterToLiteAccounts(projectAccounts);
  const skipped = projectAccounts.length - accountRows.length;
  if (skipped > 0) {
    console.warn(
      `[syncProject] skipped ${skipped} ad account(s) outside LITE_AD_ACCOUNT_IDS`,
    );
  }

  if (accountRows.length === 0) {
    return {
      campaigns: 0,
      adSets: 0,
      ads: 0,
      insightsRows: 0,
      creatives: 0,
    };
  }

  const totals: SyncResult = {
    campaigns: 0,
    adSets: 0,
    ads: 0,
    insightsRows: 0,
    creatives: 0,
  };

  const results = await Promise.all(
    accountRows.map(async ({ id }) => {
      try {
        return await syncOneAccountById({
          orgId: opts.orgId,
          adAccountId: id,
          datePreset,
        });
      } catch (acctErr) {
        console.warn(
          `[syncProject] account ${id} failed — continuing with next:`,
          acctErr instanceof Error ? acctErr.message : acctErr,
        );
        return null;
      }
    }),
  );
  for (const r of results) {
    if (!r) continue;
    totals.campaigns += r.campaigns;
    totals.adSets += r.adSets;
    totals.ads += r.ads;
    totals.insightsRows += r.insightsRows;
    totals.creatives += r.creatives;
  }

  return totals;
}

/**
 * Self-heal probe for a single ad account: detect the "today RM0 but
 * yesterday spent" pattern + narrow re-sync if it fires. Cheap (3 small
 * aggregation queries) so suitable for callers that don't already have the
 * brief data computed — e.g. the spend-pace-watch cron. midday + evening
 * use their own inline check based on the already-loaded brief totals.
 *
 * Returns whether a heal was attempted + the totals that drove the
 * decision so the caller can log diagnostics.
 */
export async function healSuspiciousZeroForAccount(opts: {
  orgId: string;
  adAccountId: string;
}): Promise<{
  healed: boolean;
  todaySpend: number;
  yesterdaySpend: number;
  activeAds: number;
  error?: string;
}> {
  // Local import to avoid a circular dependency at the top of the file —
  // dashboard imports nothing from sync, but if sync imports from dashboard
  // at module level it makes the resolution order brittle.
  const { rangeForPreset } = await import("@/lib/db/queries/dashboard");
  const todayRange = rangeForPreset("today");
  const yesterdayRange = rangeForPreset("yesterday");

  const adsInAccount = await db
    .select({ id: ads.id, status: ads.effectiveStatus })
    .from(ads)
    .innerJoin(adSets, eq(adSets.id, ads.adSetId))
    .innerJoin(campaigns, eq(campaigns.id, adSets.campaignId))
    .where(
      and(
        eq(ads.orgId, opts.orgId),
        eq(campaigns.adAccountId, opts.adAccountId),
      ),
    );
  if (adsInAccount.length === 0) {
    return { healed: false, todaySpend: 0, yesterdaySpend: 0, activeAds: 0 };
  }
  const adIds = adsInAccount.map((a) => a.id);
  const activeAds = adsInAccount.filter(
    (a) =>
      !["PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED", "ARCHIVED"].includes(
        a.status ?? "",
      ),
  ).length;

  const [todayRow] = await db
    .select({ s: sql<string | null>`sum(${insightsDaily.spend})` })
    .from(insightsDaily)
    .where(
      and(
        eq(insightsDaily.orgId, opts.orgId),
        eq(insightsDaily.level, "ad"),
        inArray(insightsDaily.entityId, adIds),
        eq(insightsDaily.date, todayRange.start),
      ),
    );
  const todaySpend = Number(todayRow?.s ?? 0);

  const [yesterdayRow] = await db
    .select({ s: sql<string | null>`sum(${insightsDaily.spend})` })
    .from(insightsDaily)
    .where(
      and(
        eq(insightsDaily.orgId, opts.orgId),
        eq(insightsDaily.level, "ad"),
        inArray(insightsDaily.entityId, adIds),
        eq(insightsDaily.date, yesterdayRange.start),
      ),
    );
  const yesterdaySpend = Number(yesterdayRow?.s ?? 0);

  if (todaySpend === 0 && activeAds > 0 && yesterdaySpend > 10) {
    const recover = await syncTodayInsightsForAccount({
      orgId: opts.orgId,
      adAccountId: opts.adAccountId,
    });
    return {
      healed: !recover.error && recover.insightsRows > 0,
      todaySpend,
      yesterdaySpend,
      activeAds,
      error: recover.error,
    };
  }
  return { healed: false, todaySpend, yesterdaySpend, activeAds };
}

/**
 * Narrow self-heal: re-pull just **today's** insights for a single ad account
 * and upsert into `insights_daily`. Skips the campaigns/adsets/ads pulls that
 * make `syncProject` slow (10+ min for a 13k-ad account) — this one Meta call
 * + one upsert finishes in seconds. Used by the midday brief to recover when
 * it detects a suspicious zero (today.spend === 0 but yesterday.spend > 10
 * and the account has active ads) before posting the 午检 to /telegram.
 *
 * Connection-aware: picks the MetaClient from the account's owning
 * `connectionId`, with its own audit writer so the recovery call shows up in
 * `meta_api_calls` for diagnosis. Returns the row count so the caller can
 * decide whether to log a "still zero after retry" warning.
 */
export async function syncTodayInsightsForAccount(opts: {
  orgId: string;
  adAccountId: string;
}): Promise<{ insightsRows: number; error?: string }> {
  const [acct] = await db
    .select({
      id: adAccounts.id,
      metaAccountId: adAccounts.metaAccountId,
      connectionId: adAccounts.connectionId,
      tokenEncrypted: metaConnections.tokenEncrypted,
      revokedAt: metaConnections.revokedAt,
    })
    .from(adAccounts)
    .leftJoin(metaConnections, eq(metaConnections.id, adAccounts.connectionId))
    .where(
      and(
        eq(adAccounts.orgId, opts.orgId),
        eq(adAccounts.id, opts.adAccountId),
      ),
    )
    .limit(1);
  if (!acct) return { insightsRows: 0, error: "account not found" };
  if (!acct.connectionId || !acct.tokenEncrypted || acct.revokedAt) {
    return { insightsRows: 0, error: "connection missing or revoked" };
  }

  const client = new MetaClient({
    accessToken: decryptToken(acct.tokenEncrypted),
    orgId: opts.orgId,
    connectionId: acct.connectionId,
    audit: makeAuditWriter({
      orgId: opts.orgId,
      connectionId: acct.connectionId,
    }),
  });

  let insightsRes;
  try {
    insightsRes = await client.insights(acct.metaAccountId, {
      level: "ad",
      datePreset: "today",
      fields: [
        "ad_id",
        "ad_name",
        "campaign_id",
        "adset_id",
        "impressions",
        "reach",
        "spend",
        "clicks",
        "ctr",
        "cpm",
        "cpc",
        "actions",
        "action_values",
        "cost_per_action_type",
        "purchase_roas",
        "date_start",
      ],
    });
  } catch (err) {
    return {
      insightsRows: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (insightsRes.data.length === 0) {
    return { insightsRows: 0 };
  }

  // Only need ad UUIDs that belong to THIS account — narrower than the
  // syncOneAccount full-org map. Keeps the lookup query tight.
  const adsForAccount = await db
    .select({ id: ads.id, metaId: ads.metaAdId })
    .from(ads)
    .innerJoin(adSets, eq(adSets.id, ads.adSetId))
    .innerJoin(campaigns, eq(campaigns.id, adSets.campaignId))
    .where(
      and(
        eq(ads.orgId, opts.orgId),
        eq(campaigns.adAccountId, opts.adAccountId),
      ),
    );
  const adIdMap = new Map(adsForAccount.map((a) => [a.metaId, a.id]));

  const rows = insightsRes.data
    .map((row) => coerceAdInsightRow(row, adIdMap, opts.orgId))
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length === 0) return { insightsRows: 0 };

  for (const chunk of chunked(rows, UPSERT_CHUNK_ROWS)) {
    await db
      .insert(insightsDaily)
      .values(chunk)
      .onConflictDoUpdate({
        target: [
          insightsDaily.orgId,
          insightsDaily.level,
          insightsDaily.metaEntityId,
          insightsDaily.date,
          insightsDaily.breakdownDim,
          insightsDaily.breakdownValue,
        ],
        set: {
          impressions: sql`excluded.impressions`,
          reach: sql`excluded.reach`,
          spend: sql`excluded.spend`,
          clicks: sql`excluded.clicks`,
          results: sql`excluded.results`,
          costPerResult: sql`excluded.cost_per_result`,
          ctr: sql`excluded.ctr`,
          cpm: sql`excluded.cpm`,
          cpc: sql`excluded.cpc`,
          purchaseRoas: sql`excluded.purchase_roas`,
          purchases: sql`excluded.purchases`,
          webPurchases: sql`excluded.web_purchases`,
          conversionValue: sql`excluded.conversion_value`,
          raw: sql`excluded.raw`,
          syncedAt: sql`now()`,
        },
        // Metrics-only guard — same reasoning as the syncOneAccount insights
        // upsert below (raw excluded so the 3-day prune can't retrigger writes).
        setWhere: sql`(${insightsDaily.impressions}, ${insightsDaily.reach}, ${insightsDaily.spend}, ${insightsDaily.clicks}, ${insightsDaily.results}, ${insightsDaily.costPerResult}, ${insightsDaily.ctr}, ${insightsDaily.cpm}, ${insightsDaily.cpc}, ${insightsDaily.purchaseRoas}, ${insightsDaily.purchases}, ${insightsDaily.webPurchases}, ${insightsDaily.conversionValue}) IS DISTINCT FROM (excluded.impressions, excluded.reach, excluded.spend, excluded.clicks, excluded.results, excluded.cost_per_result, excluded.ctr, excluded.cpm, excluded.cpc, excluded.purchase_roas, excluded.purchases, excluded.web_purchases, excluded.conversion_value)`,
      });
  }

  try {
    await client.flushAudit();
  } catch {
    // Audit flush failures don't block the recovery.
  }
  return { insightsRows: rows.length };
}

async function syncOneAccount(opts: {
  client: MetaClient;
  orgId: string;
  adAccount: { id: string; metaAccountId: string };
  datePreset: "yesterday" | "today" | "last_7d" | "last_30d";
}): Promise<SyncResult> {
  const result: SyncResult = {
    campaigns: 0,
    adSets: 0,
    ads: 0,
    insightsRows: 0,
    creatives: 0,
  };

  const [campaignsRes, adSetsRes, adsRes, insightsRes] = await Promise.all([
    opts.client.listCampaigns(opts.adAccount.metaAccountId),
    opts.client.listAdSets(opts.adAccount.metaAccountId),
    opts.client.listAds(opts.adAccount.metaAccountId),
    opts.client.insights(opts.adAccount.metaAccountId, {
      level: "ad",
      datePreset: opts.datePreset,
      fields: [
        "ad_id",
        "ad_name",
        "campaign_id",
        "adset_id",
        "impressions",
        "reach",
        "spend",
        "clicks",
        "ctr",
        "cpm",
        "cpc",
        "actions",
        "action_values",
        "cost_per_action_type",
        "purchase_roas",
        "date_start",
      ],
    }),
  ]);

  // Creatives sync runs AFTER listAds returns because we batch-fetch
  // creatives by the IDs the ads reference (instead of the account-wide
  // `/{ad_account}/adcreatives` which trips Meta's "reduce data" guard on
  // mature accounts). Idempotent upsert — failures surface as throws,
  // caught by the per-account try/catch in the caller.
  const creativesRes = await syncCreativesForAccount({
    client: opts.client,
    orgId: opts.orgId,
    adAccount: opts.adAccount,
    ads: adsRes.data,
  });
  result.creatives = creativesRes.upserted;

  // Campaigns upsert
  if (campaignsRes.data.length > 0) {
    const campaignRows = campaignsRes.data.map((c) => ({
      orgId: opts.orgId,
      adAccountId: opts.adAccount.id,
      metaCampaignId: c.id,
      name: c.name,
      objective: c.objective ?? null,
      status: status(c.status),
      effectiveStatus: status(c.effective_status),
      dailyBudget: c.daily_budget ? Number(c.daily_budget) : null,
      lifetimeBudget: c.lifetime_budget ? Number(c.lifetime_budget) : null,
      raw: c as unknown,
      lastSyncedAt: new Date(),
    }));
    for (const chunk of chunked(campaignRows, UPSERT_CHUNK_ROWS)) {
      await db
        .insert(campaigns)
        .values(chunk)
        .onConflictDoUpdate({
          target: [campaigns.orgId, campaigns.metaCampaignId],
          set: {
            name: sql`excluded.name`,
            objective: sql`excluded.objective`,
            status: sql`excluded.status`,
            effectiveStatus: sql`excluded.effective_status`,
            dailyBudget: sql`excluded.daily_budget`,
            lifetimeBudget: sql`excluded.lifetime_budget`,
            // Only rewrite raw when the payload actually changed — an
            // unconditional excluded.raw re-TOASTs the jsonb blob on every
            // sync even when identical, which was burning the Supabase
            // disk-IO budget (same guard on ad_sets/ads below).
            raw: sql`CASE WHEN ${campaigns.raw} IS DISTINCT FROM excluded.raw THEN excluded.raw ELSE ${campaigns.raw} END`,
            lastSyncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
          // Skip the row entirely when nothing material changed — an
          // unconditional DO UPDATE rewrites the heap tuple + indexes + WAL
          // for every row on every sync tick just to bump lastSyncedAt,
          // which was the residual Supabase disk-IO burner after the raw
          // guard landed. Freshness now lives on ad_accounts.last_synced_at.
          setWhere: sql`(${campaigns.name}, ${campaigns.objective}, ${campaigns.status}, ${campaigns.effectiveStatus}, ${campaigns.dailyBudget}, ${campaigns.lifetimeBudget}) IS DISTINCT FROM (excluded.name, excluded.objective, excluded.status, excluded.effective_status, excluded.daily_budget, excluded.lifetime_budget) OR ${campaigns.raw} IS DISTINCT FROM excluded.raw`,
        });
    }
    result.campaigns = campaignsRes.data.length;
  }

  // Ad sets — need a lookup of meta_campaign_id → local campaign UUID
  let campaignIdMap = new Map<string, string>();
  if (adSetsRes.data.length > 0) {
    const metaCampaignIds = Array.from(
      new Set(adSetsRes.data.map((s) => s.campaign_id)),
    );
    const camps = await db
      .select({ id: campaigns.id, metaId: campaigns.metaCampaignId })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.orgId, opts.orgId),
          inArray(campaigns.metaCampaignId, metaCampaignIds),
        ),
      );
    campaignIdMap = new Map(camps.map((c) => [c.metaId, c.id]));

    const rows = adSetsRes.data
      .filter((s) => campaignIdMap.has(s.campaign_id))
      .map((s) => ({
        orgId: opts.orgId,
        campaignId: campaignIdMap.get(s.campaign_id)!,
        metaAdSetId: s.id,
        name: s.name,
        status: status(s.status),
        effectiveStatus: status(s.effective_status),
        dailyBudget: s.daily_budget ? Number(s.daily_budget) : null,
        lifetimeBudget: s.lifetime_budget ? Number(s.lifetime_budget) : null,
        optimizationGoal: s.optimization_goal ?? null,
        billingEvent: s.billing_event ?? null,
        bidAmount: s.bid_amount ? Number(s.bid_amount) : null,
        targeting: s.targeting ?? null,
        metaCreatedTime: s.created_time ? new Date(s.created_time) : null,
        raw: s as unknown,
        lastSyncedAt: new Date(),
      }));
    if (rows.length > 0) {
      for (const chunk of chunked(rows, UPSERT_CHUNK_ROWS)) {
        await db
          .insert(adSets)
          .values(chunk)
          .onConflictDoUpdate({
            target: [adSets.orgId, adSets.metaAdSetId],
            set: {
              name: sql`excluded.name`,
              status: sql`excluded.status`,
              effectiveStatus: sql`excluded.effective_status`,
              dailyBudget: sql`excluded.daily_budget`,
              lifetimeBudget: sql`excluded.lifetime_budget`,
              optimizationGoal: sql`excluded.optimization_goal`,
              billingEvent: sql`excluded.billing_event`,
              bidAmount: sql`excluded.bid_amount`,
              targeting: sql`excluded.targeting`,
              metaCreatedTime: sql`coalesce(excluded.meta_created_time, ${adSets.metaCreatedTime})`,
              // Merge local marker keys (boostedFrom / clonedFrom / synced_from
              // / factory / …) back over the fresh Meta payload — a bare
              // excluded.raw was silently clobbering them on the next sync,
              // breaking the GT2 proposer's raw->'boostedFrom' filter. The
              // CASE guard skips the TOAST rewrite when nothing changed.
              raw: sql`CASE WHEN ${adSets.raw} IS DISTINCT FROM (excluded.raw || ${adSetRawMarkers}) THEN excluded.raw || ${adSetRawMarkers} ELSE ${adSets.raw} END`,
              lastSyncedAt: sql`now()`,
              updatedAt: sql`now()`,
            },
            // Skip unchanged rows — see campaigns upsert for why.
            setWhere: sql`(${adSets.name}, ${adSets.status}, ${adSets.effectiveStatus}, ${adSets.dailyBudget}, ${adSets.lifetimeBudget}, ${adSets.optimizationGoal}, ${adSets.billingEvent}, ${adSets.bidAmount}, ${adSets.targeting}) IS DISTINCT FROM (excluded.name, excluded.status, excluded.effective_status, excluded.daily_budget, excluded.lifetime_budget, excluded.optimization_goal, excluded.billing_event, excluded.bid_amount, excluded.targeting) OR coalesce(excluded.meta_created_time, ${adSets.metaCreatedTime}) IS DISTINCT FROM ${adSets.metaCreatedTime} OR ${adSets.raw} IS DISTINCT FROM (excluded.raw || ${adSetRawMarkers})`,
          });
      }
      result.adSets = rows.length;
    }
  }

  // Ads — lookup meta_ad_set_id → local ad_set UUID
  let adSetIdMap = new Map<string, string>();
  if (adsRes.data.length > 0) {
    const metaAdSetIds = Array.from(
      new Set(adsRes.data.map((a) => a.adset_id)),
    );
    const sets = await db
      .select({ id: adSets.id, metaId: adSets.metaAdSetId })
      .from(adSets)
      .where(
        and(
          eq(adSets.orgId, opts.orgId),
          inArray(adSets.metaAdSetId, metaAdSetIds),
        ),
      );
    adSetIdMap = new Map(sets.map((s) => [s.metaId, s.id]));

    const rows = adsRes.data
      .filter((a) => adSetIdMap.has(a.adset_id))
      .map((a) => ({
        orgId: opts.orgId,
        adSetId: adSetIdMap.get(a.adset_id)!,
        metaAdId: a.id,
        name: a.name,
        status: status(a.status),
        effectiveStatus: status(a.effective_status),
        // Link to local ad_creatives.id when the creative is known to this
        // account's sync. Falls back to null on cross-account creatives or
        // first-sync ads whose creative row hasn't appeared yet — the next
        // sync pass picks it up.
        creativeId: a.creative?.id
          ? (creativesRes.idMap.get(a.creative.id) ?? null)
          : null,
        // Meta returns ISO 8601 in `created_time` when the field is in the
        // request. Older sync rows have it null; the daily sync backfills.
        metaCreatedTime: a.created_time ? new Date(a.created_time) : null,
        raw: a as unknown,
        lastSyncedAt: new Date(),
      }));
    if (rows.length > 0) {
      for (const chunk of chunked(rows, UPSERT_CHUNK_ROWS)) {
        await db
          .insert(ads)
          .values(chunk)
          .onConflictDoUpdate({
            target: [ads.orgId, ads.metaAdId],
            set: {
              name: sql`excluded.name`,
              status: sql`excluded.status`,
              effectiveStatus: sql`excluded.effective_status`,
              // COALESCE keeps a previously-populated creativeId when the
              // current sync pass returned null (cross-account creative or
              // race where creatives finished after ads). Same for
              // metaCreatedTime — only overwrites null with a real value.
              creativeId: sql`coalesce(excluded.creative_id, ${ads.creativeId})`,
              metaCreatedTime: sql`coalesce(excluded.meta_created_time, ${ads.metaCreatedTime})`,
              // Same marker-preserving + changed-only guard as ad_sets above.
              raw: sql`CASE WHEN ${ads.raw} IS DISTINCT FROM (excluded.raw || ${adRawMarkers}) THEN excluded.raw || ${adRawMarkers} ELSE ${ads.raw} END`,
              lastSyncedAt: sql`now()`,
              updatedAt: sql`now()`,
            },
            // Skip unchanged rows — see campaigns upsert for why.
            setWhere: sql`(${ads.name}, ${ads.status}, ${ads.effectiveStatus}) IS DISTINCT FROM (excluded.name, excluded.status, excluded.effective_status) OR coalesce(excluded.creative_id, ${ads.creativeId}) IS DISTINCT FROM ${ads.creativeId} OR coalesce(excluded.meta_created_time, ${ads.metaCreatedTime}) IS DISTINCT FROM ${ads.metaCreatedTime} OR ${ads.raw} IS DISTINCT FROM (excluded.raw || ${adRawMarkers})`,
          });
      }
      result.ads = rows.length;
    }
  }

  // Insights — one row per ad per day in the result window.
  if (insightsRes.data.length > 0) {
    // Need ad UUIDs for the entity_id column.
    const adsForOrg = await db
      .select({ id: ads.id, metaId: ads.metaAdId })
      .from(ads)
      .where(eq(ads.orgId, opts.orgId));
    const adIdMap = new Map(adsForOrg.map((a) => [a.metaId, a.id]));

    const rows = insightsRes.data
      .map((row) => coerceAdInsightRow(row, adIdMap, opts.orgId))
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length > 0) {
      for (const chunk of chunked(rows, UPSERT_CHUNK_ROWS)) {
        await db
          .insert(insightsDaily)
          .values(chunk)
          .onConflictDoUpdate({
            target: [
              insightsDaily.orgId,
              insightsDaily.level,
              insightsDaily.metaEntityId,
              insightsDaily.date,
              insightsDaily.breakdownDim,
              insightsDaily.breakdownValue,
            ],
            set: {
              impressions: sql`excluded.impressions`,
              reach: sql`excluded.reach`,
              spend: sql`excluded.spend`,
              clicks: sql`excluded.clicks`,
              results: sql`excluded.results`,
              costPerResult: sql`excluded.cost_per_result`,
              ctr: sql`excluded.ctr`,
              cpm: sql`excluded.cpm`,
              cpc: sql`excluded.cpc`,
              purchaseRoas: sql`excluded.purchase_roas`,
              purchases: sql`excluded.purchases`,
              webPurchases: sql`excluded.web_purchases`,
              conversionValue: sql`excluded.conversion_value`,
              raw: sql`excluded.raw`,
              syncedAt: sql`now()`,
            },
            // Skip rows whose metrics didn't change (finalized past days).
            // raw is intentionally NOT in this guard: audit-prune NULLs it
            // after 3 days, and treating that as a diff would re-write (and
            // re-prune) every historical row in the sync window forever.
            setWhere: sql`(${insightsDaily.impressions}, ${insightsDaily.reach}, ${insightsDaily.spend}, ${insightsDaily.clicks}, ${insightsDaily.results}, ${insightsDaily.costPerResult}, ${insightsDaily.ctr}, ${insightsDaily.cpm}, ${insightsDaily.cpc}, ${insightsDaily.purchaseRoas}, ${insightsDaily.purchases}, ${insightsDaily.webPurchases}, ${insightsDaily.conversionValue}) IS DISTINCT FROM (excluded.impressions, excluded.reach, excluded.spend, excluded.clicks, excluded.results, excluded.cost_per_result, excluded.ctr, excluded.cpm, excluded.cpc, excluded.purchase_roas, excluded.purchases, excluded.web_purchases, excluded.conversion_value)`,
          });
      }
      result.insightsRows = rows.length;
    }
  }

  // Account-level freshness stamp — the only row guaranteed to be written
  // every sync now that unchanged entity rows are skipped. One tiny row per
  // account per sync; getProjectLastSyncedAt and the page headers read this.
  await db
    .update(adAccounts)
    .set({ lastSyncedAt: new Date() })
    .where(eq(adAccounts.id, opts.adAccount.id));

  return result;
}

function coerceAdInsightRow(
  row: MetaInsightsRow & { ad_id?: string; campaign_id?: string; adset_id?: string },
  adIdMap: Map<string, string>,
  orgId: string,
):
  | (typeof insightsDaily.$inferInsert)
  | null {
  const metaAdId = (row as unknown as { ad_id?: string }).ad_id;
  if (!metaAdId) return null;
  const localId = adIdMap.get(metaAdId);
  if (!localId) return null;

  // Pick the best "results" actions count — prefer purchases, then leads,
  // then any standard conversion. Falls back to total clicks if nothing.
  const results = pickResults(row);
  const costPerResult = pickCostPerResult(row);
  const purchaseRoas = pickRoas(row);
  const purchases = pickAction(row.actions, ["purchase", "omni_purchase"]);
  const webPurchases = pickAction(row.actions, [
    "offsite_conversion.fb_pixel_purchase",
  ]);
  const conversionValue = pickActionValue(row.action_values, [
    "offsite_conversion.fb_pixel_purchase",
    "purchase",
    "omni_purchase",
  ]);

  return {
    orgId,
    level: "ad",
    entityId: localId,
    metaEntityId: metaAdId,
    date: new Date(row.date_start),
    impressions: row.impressions ? Number(row.impressions) : null,
    reach: row.reach ? Number(row.reach) : null,
    spend: row.spend ?? null,
    clicks: row.clicks ? Number(row.clicks) : null,
    results,
    costPerResult,
    ctr: row.ctr ?? null,
    cpm: row.cpm ?? null,
    cpc: row.cpc ?? null,
    purchaseRoas,
    purchases,
    webPurchases,
    conversionValue,
    breakdownDim: null,
    breakdownValue: null,
    raw: row as unknown,
    syncedAt: new Date(),
  };
}

/**
 * Priority order for which Meta action_type counts as a "result" in our
 * brief / dashboard / agent surfaces. Walked top-down, first match wins.
 *
 * Tuned 2026-05-12 against Andi's actual ad mix:
 *   - Primary objective: pixel-tracked Website lead (`offsite_conversion.fb_pixel_lead`)
 *   - Some Engagement campaigns track custom conversions like "AIA - Registered
 *     Webinar" — those surface as `offsite_conversion.custom.<id>` and are
 *     caught in the second-pass below (NOT in this list — there's a separate
 *     prefix match further down).
 *
 * INTENTIONALLY DROPPED (used to be here, polluted `results` with 100s of
 * page-engagement / click events when no real conversion existed):
 *   - link_click
 *   - post_engagement
 *   - page_engagement
 *   - video_view
 *
 * Keep this in sync with `scripts/fix-insights-dedup-and-backfill.ts` —
 * that script's `RESULT_PRIORITY` is what was used to backfill historical
 * rows. If you change one, change the other.
 */
const RESULT_PRIORITY = [
  // Lead form submissions — Andi's primary signal
  "offsite_conversion.fb_pixel_lead",
  "lead",
  "onsite_conversion.lead_grouped",
  // Purchases
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
  "omni_purchase",
  // Registration / checkout funnel
  "complete_registration",
  "offsite_conversion.fb_pixel_complete_registration",
  "add_to_cart",
  "initiate_checkout",
  // WhatsApp click-to-chat — kept for orgs that run messaging campaigns
  "onsite_conversion.messaging_conversation_started_7d",
  "onsite_conversion.messaging_first_reply",
];

function pickResults(row: MetaInsightsRow): number | null {
  if (!row.actions || row.actions.length === 0) return null;
  for (const t of RESULT_PRIORITY) {
    const hit = row.actions.find((a) => a.action_type === t);
    if (hit) return Number(hit.value);
  }
  // Second pass: pixel custom conversions (e.g. "AIA - Registered Webinar"
  // surfaces as offsite_conversion.custom.<conversion_id>). These ARE real
  // conversions configured by the operator in Meta, so we count them when
  // no first-pass action type matched.
  const customHit = row.actions.find((a) =>
    a.action_type.startsWith("offsite_conversion.custom."),
  );
  if (customHit) return Number(customHit.value);
  return null;
}

function pickCostPerResult(row: MetaInsightsRow): string | null {
  if (!row.cost_per_action_type || row.cost_per_action_type.length === 0)
    return null;
  for (const t of RESULT_PRIORITY) {
    const hit = row.cost_per_action_type.find((a) => a.action_type === t);
    if (hit) return hit.value;
  }
  const customHit = row.cost_per_action_type.find((a) =>
    a.action_type.startsWith("offsite_conversion.custom."),
  );
  if (customHit) return customHit.value;
  return null;
}

function pickRoas(row: MetaInsightsRow): string | null {
  if (!row.purchase_roas || row.purchase_roas.length === 0) return null;
  return row.purchase_roas[0]?.value ?? null;
}

/** Sum all matching action_type entries from actions[]. Returns null if none found. */
function pickAction(
  actions: Array<{ action_type: string; value: string }> | undefined,
  types: string[],
): number | null {
  if (!actions || actions.length === 0) return null;
  const typeSet = new Set(types);
  let total = 0;
  let found = false;
  for (const a of actions) {
    if (typeSet.has(a.action_type)) {
      total += Number(a.value);
      found = true;
    }
  }
  return found ? total : null;
}

/** Sum matching action_type entries from action_values[] (monetary). Returns null if none found. */
function pickActionValue(
  actionValues: Array<{ action_type: string; value: string }> | undefined,
  types: string[],
): string | null {
  if (!actionValues || actionValues.length === 0) return null;
  const typeSet = new Set(types);
  let total = 0;
  let found = false;
  for (const a of actionValues) {
    if (typeSet.has(a.action_type)) {
      total += Number(a.value);
      found = true;
    }
  }
  return found ? total.toFixed(4) : null;
}
