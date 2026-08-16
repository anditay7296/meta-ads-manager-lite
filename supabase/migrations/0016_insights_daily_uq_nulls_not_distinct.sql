-- Drop and recreate the insights_daily unique index with NULLS NOT DISTINCT.
--
-- Why: PG's default NULLS DISTINCT means two rows with the same
--   (org_id, level, meta_entity_id, date, NULL, NULL) collide as different
--   keys. The upsert in lib/meta/sync.ts targets exactly those columns
--   including breakdown_dim and breakdown_value (which are NULL for the
--   common "total" insight rows). Without NULLS NOT DISTINCT, every
--   re-sync INSERTs a fresh duplicate row instead of UPDATE-ing.
--
-- Discovered 2026-05-12 after 107,004 duplicate rows had accumulated,
-- inflating spend and result totals in the evening recap by ~108×.
-- The remediation script `scripts/fix-insights-dedup-and-backfill.ts`
-- ran before this migration to clean up the existing dupes — this
-- migration just makes the fix permanent in the schema.
--
-- Drizzle 0.45.2 doesn't expose .nullsNotDistinct() in its TypeScript
-- API, so we ship this as a raw-SQL migration and document the override
-- in `lib/db/schema.ts`.

DROP INDEX IF EXISTS "insights_daily_uq";

CREATE UNIQUE INDEX "insights_daily_uq"
  ON "insights_daily" (
    "org_id",
    "level",
    "meta_entity_id",
    "date",
    "breakdown_dim",
    "breakdown_value"
  )
  NULLS NOT DISTINCT;
