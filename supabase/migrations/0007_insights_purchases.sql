-- Add purchase counts and conversion value to the insights cache.
-- All three columns are nullable — older rows keep null until re-synced.

ALTER TABLE insights_daily
  ADD COLUMN IF NOT EXISTS purchases        bigint,
  ADD COLUMN IF NOT EXISTS web_purchases    bigint,
  ADD COLUMN IF NOT EXISTS conversion_value numeric(18,4);
