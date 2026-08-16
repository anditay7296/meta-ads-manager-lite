/**
 * One-off remediation for the "16× spend / inflated leads" bug surfaced on
 * 2026-05-12. Three steps, idempotent — safe to re-run.
 *
 *   1. Dedup `insights_daily` rows: for every (orgId, level, metaEntityId,
 *      date, breakdownDim, breakdownValue) group, keep the row with the
 *      latest `synced_at` and delete the rest.
 *
 *   2. Replace the broken unique index with a `NULLS NOT DISTINCT` variant
 *      so future syncs actually hit `onConflictDoUpdate` instead of always
 *      INSERT-ing a fresh duplicate row.
 *
 *   3. Backfill `results` + `cost_per_result` from the preserved `raw`
 *      column using the new `pickResults` / `pickCostPerResult` logic
 *      (drops link_click / post_engagement as fallbacks, adds custom-
 *      conversion second pass for "AIA - Registered Webinar" etc.).
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/fix-insights-dedup-and-backfill.ts
 *
 * The unique index migration is included here (raw SQL) because Drizzle's
 * NULLS NOT DISTINCT support is version-dependent in this codebase. The
 * schema.ts file is updated in the same commit so future `db:generate`
 * runs don't regenerate the old (broken) index.
 */

import postgres from "postgres";

type MetaAction = { action_type: string; value: string };

const RESULT_PRIORITY = [
  // Andi's primary signal — pixel website leads
  "offsite_conversion.fb_pixel_lead",
  "lead",
  "onsite_conversion.lead_grouped",
  // Purchases — highest business value
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
  "omni_purchase",
  // Registration / checkout funnel
  "complete_registration",
  "offsite_conversion.fb_pixel_complete_registration",
  "add_to_cart",
  "initiate_checkout",
  // WhatsApp click-to-chat
  "onsite_conversion.messaging_conversation_started_7d",
  "onsite_conversion.messaging_first_reply",
  // INTENTIONALLY DROPPED: "link_click", "post_engagement", "page_engagement",
  // "video_view" — these are NOT conversions and were inflating results.
];

function pickResultsFromActions(actions: MetaAction[] | undefined): number | null {
  if (!actions || actions.length === 0) return null;
  for (const t of RESULT_PRIORITY) {
    const hit = actions.find((a) => a.action_type === t);
    if (hit) return Number(hit.value);
  }
  // Second pass: pixel custom conversions (e.g. "AIA - Registered Webinar"
  // shows up as offsite_conversion.custom.<conversion_id>). These are real
  // conversions the operator configured in Meta.
  const customHit = actions.find((a) =>
    a.action_type.startsWith("offsite_conversion.custom."),
  );
  if (customHit) return Number(customHit.value);
  return null;
}

function pickCostPerResultFromCpa(
  cpa: MetaAction[] | undefined,
): string | null {
  if (!cpa || cpa.length === 0) return null;
  for (const t of RESULT_PRIORITY) {
    const hit = cpa.find((a) => a.action_type === t);
    if (hit) return hit.value;
  }
  const customHit = cpa.find((a) =>
    a.action_type.startsWith("offsite_conversion.custom."),
  );
  if (customHit) return customHit.value;
  return null;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  const sql = postgres(url, { ssl: "require" });

  try {
    // ── Step 1: Dedup ─────────────────────────────────────────────────
    console.log("\n[1/3] Counting duplicate insights_daily rows...");
    const dupCount = await sql<Array<{ groups: string; total_excess: string }>>`
      SELECT
        COUNT(*) AS groups,
        SUM(n - 1)::bigint AS total_excess
      FROM (
        SELECT COUNT(*) AS n
        FROM insights_daily
        GROUP BY org_id, level, meta_entity_id, date,
                 COALESCE(breakdown_dim, ''), COALESCE(breakdown_value, '')
        HAVING COUNT(*) > 1
      ) AS dups
    `;
    const groups = Number(dupCount[0]?.groups ?? 0);
    const excess = Number(dupCount[0]?.total_excess ?? 0);
    console.log(`  Found ${groups} duplicate groups, ${excess} excess rows to delete`);

    if (excess > 0) {
      console.log("[1/3] Deleting duplicates (keeping latest synced_at per group)...");
      const deleted = await sql`
        DELETE FROM insights_daily
        WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY org_id, level, meta_entity_id, date,
                           COALESCE(breakdown_dim, ''), COALESCE(breakdown_value, '')
              ORDER BY synced_at DESC NULLS LAST, id DESC
            ) AS rn
            FROM insights_daily
          ) ranked
          WHERE rn > 1
        )
        RETURNING 1
      `;
      console.log(`  Deleted ${deleted.length} rows`);
    } else {
      console.log("  No duplicates found, skipping delete");
    }

    // ── Step 2: Fix unique index (NULLS NOT DISTINCT) ────────────────
    console.log("\n[2/3] Recreating unique index with NULLS NOT DISTINCT...");
    await sql`DROP INDEX IF EXISTS insights_daily_uq`;
    await sql`
      CREATE UNIQUE INDEX insights_daily_uq
      ON insights_daily (
        org_id, level, meta_entity_id, date, breakdown_dim, breakdown_value
      )
      NULLS NOT DISTINCT
    `;
    console.log("  Index recreated with NULLS NOT DISTINCT");

    // ── Step 3: Backfill results + cost_per_result from raw ──────────
    console.log("\n[3/3] Backfilling results + cost_per_result from raw...");
    const PAGE_SIZE = 1000;
    let offset = 0;
    let totalUpdated = 0;
    let totalProcessed = 0;

    for (;;) {
      // Read a page of ad-level rows.
      const page = await sql<
        Array<{ id: string; raw: unknown; results: string | null; cost_per_result: string | null }>
      >`
        SELECT id, raw, results, cost_per_result
        FROM insights_daily
        WHERE level = 'ad'
        ORDER BY id
        LIMIT ${PAGE_SIZE} OFFSET ${offset}
      `;
      if (page.length === 0) break;

      const updates: Array<{ id: string; results: number | null; cpr: string | null }> = [];
      for (const row of page) {
        if (!row.raw || typeof row.raw !== "object") continue;
        const raw = row.raw as { actions?: MetaAction[]; cost_per_action_type?: MetaAction[] };
        const newResults = pickResultsFromActions(raw.actions);
        const newCpr = pickCostPerResultFromCpa(raw.cost_per_action_type);
        const oldResults = row.results === null ? null : Number(row.results);
        if (newResults !== oldResults || newCpr !== row.cost_per_result) {
          updates.push({ id: row.id, results: newResults, cpr: newCpr });
        }
      }

      if (updates.length > 0) {
        // Batch update via a single statement using unnest of arrays.
        const ids = updates.map((u) => u.id);
        const resultsArr = updates.map((u) => u.results);
        const cprArr = updates.map((u) => u.cpr);
        await sql`
          UPDATE insights_daily SET
            results = data.new_results,
            cost_per_result = data.new_cpr
          FROM (
            SELECT * FROM unnest(
              ${ids}::uuid[],
              ${resultsArr}::bigint[],
              ${cprArr}::numeric[]
            ) AS t(id, new_results, new_cpr)
          ) AS data
          WHERE insights_daily.id = data.id
        `;
        totalUpdated += updates.length;
      }
      totalProcessed += page.length;
      console.log(`  Processed ${totalProcessed} rows, updated ${totalUpdated} so far`);
      offset += PAGE_SIZE;
    }

    console.log(`\n✅ Done. Processed ${totalProcessed} rows total, updated ${totalUpdated}.`);

    // ── Verify ────────────────────────────────────────────────────────
    console.log("\n=== Verification ===");
    const verifyDups = await sql<Array<{ n: string }>>`
      SELECT COUNT(*) AS n FROM (
        SELECT COUNT(*) AS c
        FROM insights_daily
        GROUP BY org_id, level, meta_entity_id, date,
                 COALESCE(breakdown_dim, ''), COALESCE(breakdown_value, '')
        HAVING COUNT(*) > 1
      ) x
    `;
    console.log(`  Remaining duplicate groups: ${verifyDups[0]?.n ?? 0} (should be 0)`);

    const aiamy = await sql<Array<{ account: string; spend: number; results: string }>>`
      SELECT ad_acc.name AS account,
        SUM(i.spend::numeric)::float AS spend,
        SUM(i.results) AS results
      FROM insights_daily i
      JOIN ads ON ads.id = i.entity_id
      JOIN ad_sets ON ad_sets.id = ads.ad_set_id
      JOIN campaigns ON campaigns.id = ad_sets.campaign_id
      JOIN ad_accounts ad_acc ON ad_acc.id = campaigns.ad_account_id
      WHERE i.level = 'ad' AND ad_acc.name LIKE '%AIA%MY%'
        AND i.date >= CURRENT_DATE
      GROUP BY ad_acc.name
    `;
    console.log(`  AIA (MY) today after fix:`, aiamy);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
